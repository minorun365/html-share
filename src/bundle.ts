import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HtmlShareConfig, PageConfig, ShelfItemConfig } from './config.js';
import { resolveFromConfig, validatedRoots } from './config.js';

function packageRoot(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (directory !== path.dirname(directory)) {
    if (existsSync(path.join(directory, 'package.json'))) return directory;
    directory = path.dirname(directory);
  }
  throw new Error('package.json not found');
}

const MIME: Record<string, string> = {
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

export interface BuiltPage {
  slug: string;
  title: string;
  source: string;
  updatedAt: string;
  date: string;
  repository: string;
  stream: string;
  streamLabel: string;
  objectKey: string;
}

/** 棚の1行。stream 項目は最新ページの slug・件数・最終更新、url 項目はリンクと追加日を持つ */
export interface ShelfEntry {
  id: string;
  title: string;
  due: string | null;
  note: string | null;
  stream?: string;
  slug?: string;
  count?: number;
  url?: string;
  last: string | null;
}

export interface BuildManifest {
  generatedAt: string;
  internalSharing: boolean;
  maximumShareDays: number;
  pages: BuiltPage[];
  shelf: ShelfEntry[];
}

const DAY_MS = 86400e3;

/** 棚の日付は JST の暦日で比べる */
function jstToday(now: Date): string {
  return new Date(now.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
}

/**
 * 進行中の棚を manifest 用に解決する。
 * done を書いた項目と、締切の翌日を過ぎた項目はここで落とす（台帳から消し忘れても棚に残らない）。
 * 締切の近い順に並べ、締切の無いものは後ろで最近動いた順にする。
 */
export function buildShelf(items: ShelfItemConfig[], pages: BuiltPage[], now = new Date()): ShelfEntry[] {
  const today = Date.parse(jstToday(now));
  const out: ShelfEntry[] = [];
  for (const item of items) {
    if (item.done) continue;
    if (item.due && Date.parse(item.due) + DAY_MS < today) continue;
    const entry: ShelfEntry = { id: item.id, title: item.title, due: item.due ?? null, note: item.note ?? null, last: null };
    if (item.stream) {
      const inStream = pages
        .filter((page) => page.stream === item.stream)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      if (inStream.length === 0) {
        console.warn(`content.shelf: ${item.id} のテーマ ${item.stream} にページがないので、棚に出しません`);
        continue;
      }
      Object.assign(entry, {
        stream: item.stream,
        slug: inStream[0].slug,
        count: inStream.length,
        last: inStream[0].updatedAt,
      });
    } else if (item.url) {
      Object.assign(entry, { url: item.url, last: item.added ?? null });
    } else {
      continue;
    }
    out.push(entry);
  }
  out.sort((left, right) => {
    if (left.due && right.due) return left.due.localeCompare(right.due);
    if (left.due || right.due) return left.due ? -1 : 1;
    return String(right.last ?? '').localeCompare(String(left.last ?? ''));
  });
  return out;
}

export function slugify(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || `page-${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
}

function inside(file: string, roots: string[]): boolean {
  return roots.some((root) => file === root || file.startsWith(`${root}${path.sep}`));
}

function extractTitle(html: string, fallback: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?? html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  return title?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || fallback;
}

function addMeta(html: string): string {
  const tags = [
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    '<meta name="referrer" content="no-referrer">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  ].filter((tag) => !html.toLowerCase().includes(tag.split(' content=')[0].toLowerCase()));
  if (tags.length === 0) return html;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (head) => `${head}\n${tags.join('\n')}`);
  return `${tags.join('\n')}\n${html}`;
}

/** カードの大きさ。summary は各媒体でいちばん小さいカード、large は横長の大きなカード。 */
export type OgCardType = 'summary' | 'summary_large_image';

/** リンクプレビュー（OGP）の設定。共有したURLをSlackやTeamsへ貼ったときのカードを決める。 */
export interface OgOptions {
  /** カードに出すアプリ名 */
  siteName: string;
  /** 設定で上書きしたページ名。省略するとHTMLの <title> から拾う */
  title?: string;
  /** 画像の絶対URL。省略すると og:image を出さない */
  imageUrl?: string;
  /**
   * カードの大きさ。既定は summary（小さいカード）。
   *
   * 画像を指定したら自動で summary_large_image にする作りだったが、それをやめた。
   * large_image は 1200x630 前後の横長画像が前提で、正方形やロゴ1枚を渡すと
   * 引き伸ばされる。しかもページごとに違う画像を用意しない運用では、
   * 大きなカードにする意味がほとんどない（2026-09-20）。
   */
  cardType?: OgCardType;
}

function attributeValue(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * og:description に使う1文。ヒーローのリード文 → lead → 最初の段落の順に拾う。
 * 同梱スキル create-html が作るHTMLは、ヒーローに1文サマリを置く作りになっている。
 */
function extractDescription(html: string, limit = 110): string {
  const pick = (pattern: RegExp): string => {
    const matched = html.match(pattern);
    if (!matched) return '';
    return matched[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  };
  const text = pick(/<p[^>]*class\s*=\s*["\'][^"\']*\bsub\b[^"\']*["\'][^>]*>([\s\S]*?)<\/p>/i)
    || pick(/<p[^>]*class\s*=\s*["\'][^"\']*\blead\b[^"\']*["\'][^>]*>([\s\S]*?)<\/p>/i)
    || pick(/<p(?![^>]*\bclass\s*=)[^>]*>([\s\S]*?)<\/p>/i);
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * OGPタグを <meta charset> の「後ろ」へ入れる。
 *
 * 文字コードは先頭1024バイトまでに宣言する決まりなので、日本語のタイトルと説明文が
 * charset より前に出るとクローラー側が文字化けしうる。head の直後へ積むと、
 * このファイルが足す他のメタタグのぶん charset が押し下がる。
 */
function addOgp(html: string, og: OgOptions | undefined): string {
  // siteName が無い呼ばれ方（bundleHtml を直接使う場合など）では、何も足さない。
  if (!og?.siteName) return html;
  if (/<meta[^>]+property\s*=\s*["\']og:title["\']/i.test(html)) return html;
  const title = og.title?.trim() || extractTitle(html, og.siteName);
  const description = extractDescription(html);
  const cardType: OgCardType = og.cardType ?? 'summary';
  const tags = [
    '<meta property="og:type" content="article">',
    `<meta property="og:site_name" content="${attributeValue(og.siteName)}">`,
    `<meta property="og:title" content="${attributeValue(title)}">`,
    description ? `<meta property="og:description" content="${attributeValue(description)}">` : '',
    og.imageUrl ? `<meta property="og:image" content="${attributeValue(og.imageUrl)}">` : '',
    // 画像に説明を添えておくと、読み上げでもカードが意味を持つ。
    og.imageUrl ? `<meta property="og:image:alt" content="${attributeValue(og.siteName)}">` : '',
    `<meta name="twitter:card" content="${og.imageUrl ? cardType : 'summary'}">`,
    // X は og:* へフォールバックする仕様だが、実測では twitter:* を明示したほうが安定する。
    `<meta name="twitter:title" content="${attributeValue(title)}">`,
    description ? `<meta name="twitter:description" content="${attributeValue(description)}">` : '',
    og.imageUrl ? `<meta name="twitter:image" content="${attributeValue(og.imageUrl)}">` : '',
    og.imageUrl ? `<meta name="twitter:image:alt" content="${attributeValue(og.siteName)}">` : '',
  ].filter(Boolean).join('\n');
  const charset = html.match(/<meta[^>]*charset[^>]*>/i);
  if (charset) return html.replace(charset[0], `${charset[0]}\n${tags}`);
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (head) => `${head}\n${tags}`);
  return `${tags}\n${html}`;
}

function dataUrl(file: string, maxBytes: number): string {
  const extension = path.extname(file).toLowerCase();
  const mime = MIME[extension];
  if (!mime) throw new Error(`Local asset type is not allowed: ${extension || '(none)'}`);
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error(`Local asset is not a file: ${file}`);
  if (stat.size > maxBytes) throw new Error(`Local asset exceeds ${maxBytes} bytes: ${file}`);
  return `data:${mime};base64,${readFileSync(file).toString('base64')}`;
}

export function bundleHtml(sourceFile: string, roots: string[], maxAssetBytes: number, og?: OgOptions): string {
  const source = realpathSync(sourceFile);
  if (!inside(source, roots)) throw new Error(`Page is outside content.roots: ${sourceFile}`);
  const sourceDirectory = path.dirname(source);
  let html = readFileSync(source, 'utf8');
  const reference = /\b(src|href)\s*=\s*(["'])([^"']+)\2/gi;
  html = html.replace(reference, (full, attribute: string, quote: string, raw: string) => {
    const value = raw.trim();
    if (!value || /^(?:https?:|data:|blob:|mailto:|tel:|javascript:|#|\/\/)/i.test(value)) return full;
    const pathname = decodeURIComponent(value.split(/[?#]/, 1)[0]);
    const candidate = path.resolve(sourceDirectory, pathname);
    if (!existsSync(candidate)) throw new Error(`Local asset not found: ${value} in ${sourceFile}`);
    const resolved = realpathSync(candidate);
    if (!inside(resolved, roots)) throw new Error(`Local asset escapes content.roots: ${value}`);
    return `${attribute}=${quote}${dataUrl(resolved, maxAssetBytes)}${quote}`;
  });
  return injectMobileHelpers(addOgp(addMeta(html), og));
}

function injectMobileHelpers(html: string): string {
  // 閲覧面は script-src が 'unsafe-inline' data: だけなので、相対パスのJSは読めない。
  // 表とカレンダーの畳み込みはAPIを呼ばない（connect-src 'none' のまま）ので、
  // 中身をインラインで埋め込む。
  const tag = ['mobile-tables.js', 'mobile-calendar.js', 'pull-to-refresh.js']
    .map((file) => `<script>${readFileSync(path.join(packageRoot(), 'web', file), 'utf8').trim()}</script>`)
    .join('\n');
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${tag}\n</body>`);
  return `${html}\n${tag}\n`;
}

function pagePath(config: HtmlShareConfig, page: PageConfig): string {
  const absolute = resolveFromConfig(config, page.path);
  if (!existsSync(absolute)) throw new Error(`Page not found: ${absolute}`);
  return absolute;
}

function defaultGroup(page: PageConfig): string {
  const parent = path.basename(path.dirname(page.path));
  return parent && parent !== '.' ? parent : 'pages';
}

/** 同梱のカード画像を置く場所。配信側はこのパスだけ署名なしで開ける（infra の og/*）。 */
export const OG_CARD_KEY = 'og/card.jpg';

/**
 * リンクプレビューの画像URLを決める。
 *
 *   ogImageUrl を書いていなければ、同梱の画像を配信先の /og/card.jpg へ置いて使う。
 *   配信面は署名付きURLでしか開けないが、og/* だけは署名なしで開ける設定にしてあるので、
 *   Slack や X のクローラーも取りに来られる。
 *   末尾の ?v= は画像の中身から作る。SNSは画像をURLの文字列で覚えるので、
 *   これが無いと画像を差し替えても古いカードが出続ける。
 */
function resolveOgImage(config: HtmlShareConfig, contentRoot: string): string | undefined {
  const configured = config.content.ogImageUrl;
  if (configured === false) return undefined;
  if (configured) return configured;
  const card = readFileSync(path.join(packageRoot(), 'assets', 'og-card.jpg'));
  const target = path.join(contentRoot, OG_CARD_KEY);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, card);
  const version = createHash('sha256').update(card).digest('hex').slice(0, 8);
  return `https://${config.aws.contentDomain}/${OG_CARD_KEY}?v=${version}`;
}

export function buildSite(config: HtmlShareConfig, buildRoot: string): BuildManifest {
  const roots = validatedRoots(config);
  const contentRoot = path.join(buildRoot, 'content');
  rmSync(buildRoot, { recursive: true, force: true });
  mkdirSync(contentRoot, { recursive: true });
  const ogImageUrl = resolveOgImage(config, contentRoot);
  const used = new Set<string>();
  const pages = config.content.pages.map((page) => {
    const source = pagePath(config, page);
    const sourceReal = realpathSync(source);
    const html = bundleHtml(sourceReal, roots, config.content.maximumAssetBytes, {
      siteName: config.content.siteName,
      title: page.title,
      imageUrl: ogImageUrl,
      cardType: config.content.ogCardType,
    });
    const fallback = path.basename(source, path.extname(source));
    let slug = slugify(page.slug || fallback);
    if (used.has(slug)) slug = `${slug}-${createHash('sha256').update(sourceReal).digest('hex').slice(0, 6)}`;
    used.add(slug);
    const directory = path.join(contentRoot, 'pages', slug);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'index.html'), html);
    const updatedAt = statSync(sourceReal).mtime.toISOString();
    const repository = page.repository || defaultGroup(page);
    const stream = page.stream || repository;
    return {
      slug,
      title: page.title || extractTitle(html, fallback),
      source: page.path,
      updatedAt,
      date: updatedAt,
      repository,
      stream,
      streamLabel: page.streamLabel || stream,
      objectKey: `pages/${slug}/index.html`,
    };
  });
  const manifest = {
    generatedAt: new Date().toISOString(),
    internalSharing: config.content.allowedInternalCidrs.length > 0,
    maximumShareDays: config.content.maximumShareDays,
    pages,
    shelf: buildShelf(config.content.shelf ?? [], pages),
  };
  writeFileSync(path.join(buildRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
