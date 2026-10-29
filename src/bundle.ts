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
import type { HtmlShareConfig, PageConfig, ShelfItemConfig, StreamDue } from './config.js';
import { resolveFromConfig, validatedRoots } from './config.js';
import { keepReason } from './retention.js';

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
  /** 進行中チップに出す短い名前。streamChip → streamLabel → テーマキーの順で決める */
  streamChip: string;
  objectKey: string;
}

/**
 * 進行中フィルターの1行。stream 項目は最新ページの slug・件数・最終更新、url だけの項目はリンクと追加日を持つ。
 * stream と url の両方を持つ項目は、url を絞り込み中の見出しのリンクに使う
 */
export interface ShelfEntry {
  id: string;
  title: string;
  /** build 時点の直近の期限。画面は dues から開くたびに選び直す */
  due: string | null;
  dues: StreamDue[];
  note: string | null;
  stream?: string;
  slug?: string;
  count?: number;
  url?: string;
  last: string | null;
}

/**
 * 保管庫のページ。配信から外したので開けない。一覧にタイトルを残し、revive で戻すための手がかりだけを持つ
 */
export interface ArchivedPage {
  slug: string;
  title: string;
  source: string;
  updatedAt: string;
  date: string;
  repository: string;
  stream: string;
  streamLabel: string;
  /** 書いてあった見直し日（過ぎているので保管庫にある） */
  keep: string | null;
}

export interface BuildManifest {
  generatedAt: string;
  internalSharing: boolean;
  maximumShareDays: number;
  /** 保持期限の日数。null なら保管庫へ移さない */
  retainDays: number | null;
  pages: BuiltPage[];
  /** 保持期限を過ぎて配信から外したページ。新しい順 */
  archived: ArchivedPage[];
  shelf: ShelfEntry[];
  /** テーマキー → まだ生きている期限。押しピンで足したテーマもここから期限を引く */
  streamDues: Record<string, StreamDue[]>;
}

const DAY_MS = 86400e3;

/** 進行中フィルターの日付は JST の暦日で比べる */
export function jstToday(now: Date): string {
  return new Date(now.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** まだ生きている期限。締切当日の翌日までは「昨日まで」として残す */
export function liveDues(dues: StreamDue[], now = new Date()): StreamDue[] {
  const cutoff = addDays(jstToday(now), -1);
  return dues.filter((due) => due.date >= cutoff);
}

/**
 * 直近の期限。今日以降の最初の日、無ければ昨日の日。web/app/index.html の nextDue と同じ規則で、
 * 選ぶのを画面側にしているので、節目を過ぎた翌朝には publish し直さなくても次の日へ繰り上がる
 */
export function nextDue(dues: StreamDue[], now = new Date()): StreamDue | null {
  const today = jstToday(now);
  const upcoming = dues.find((due) => due.date >= today);
  if (upcoming) return upcoming;
  const yesterday = addDays(today, -1);
  return [...dues].reverse().find((due) => due.date === yesterday) ?? null;
}

/**
 * 進行中フィルターを manifest 用に解決する。
 * done を書いた項目と、締切の翌日を過ぎた項目はここで外す（台帳から消し忘れても進行中フィルターに残らない）。
 * 締切の近い順に並べ、締切の無いものは後ろで最近動いた順にする。
 */
export function buildShelf(
  items: ShelfItemConfig[],
  pages: BuiltPage[],
  now = new Date(),
  streamDues: Record<string, StreamDue[]> = {},
): ShelfEntry[] {
  const out: ShelfEntry[] = [];
  for (const item of items) {
    if (item.done) continue;
    // テーマの項目はテーマの期限が正本。テーマ側に無いときだけ項目の due を読む
    const fromStream = item.stream !== undefined && Object.hasOwn(streamDues, item.stream);
    if (fromStream && item.due) {
      console.warn(`content.shelf: ${item.id} の due は使いません。期限は content.streamDues.${item.stream} に書いてください`);
    }
    const allDues = fromStream ? streamDues[item.stream as string] : item.due ? [{ date: item.due, what: null }] : [];
    const dues = liveDues(allDues, now);
    // 期限を持っていた項目は、最後の日の翌日を過ぎたら落とす
    if (allDues.length > 0 && dues.length === 0) continue;
    const entry: ShelfEntry = {
      id: item.id,
      title: item.title ?? item.id,
      due: nextDue(dues, now)?.date ?? null,
      dues,
      note: item.note ?? null,
      last: null,
    };
    if (item.stream) {
      const inStream = pages
        .filter((page) => page.stream === item.stream)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      if (inStream.length === 0) {
        console.warn(`content.shelf: ${item.id} のテーマ ${item.stream} にページがないので、進行中フィルターに出しません`);
        continue;
      }
      // テーマの項目は title を書かなければテーマのチップ名を使う（名前を二重に管理しない）
      if (!item.title) entry.title = inStream[0].streamChip;
      Object.assign(entry, {
        stream: item.stream,
        slug: inStream[0].slug,
        count: inStream.length,
        last: inStream[0].updatedAt,
        ...(item.url ? { url: item.url } : {}),
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

/** チップ名の長さの上限。全角1・半角0.5で数える */
export const CHIP_MAX_WIDTH = 11;

/** チップ名の長さ。全角1・半角0.5で数える。「Q3ロードマップ説明会」が10 */
export function chipWidth(value: string): number {
  return [...value].reduce((width, char) => width + (char.charCodeAt(0) < 0x80 ? 0.5 : 1), 0);
}

export interface StreamChipSource {
  stream: string;
  streamLabel?: string;
  streamChip?: string;
}

/**
 * テーマごとのチップ名を決める。同じテーマで最初に書かれた streamChip を使う。
 * 見出し（streamLabel）はあるのにチップ名が無いテーマと、チップ名が長すぎるテーマは警告にする（失敗にはしない）
 */
export function resolveStreamChips(sources: StreamChipSource[]): { chips: Map<string, string>; warnings: string[] } {
  const chips = new Map<string, string>();
  const labeled = new Set<string>();
  for (const source of sources) {
    if (source.streamLabel) labeled.add(source.stream);
    if (source.streamChip && !chips.has(source.stream)) chips.set(source.stream, source.streamChip);
  }
  const warnings: string[] = [];
  const missing = [...labeled].filter((stream) => !chips.has(stream));
  if (missing.length > 0) {
    warnings.push(`content.pages: streamChip（進行中チップの短い名前）が無いテーマ: ${missing.join(' / ')}`);
  }
  const long = [...chips].filter(([, name]) => chipWidth(name) > CHIP_MAX_WIDTH);
  if (long.length > 0) {
    warnings.push(`content.pages: streamChip が長すぎるテーマ（全角${CHIP_MAX_WIDTH}字まで）: ${long.map(([stream, name]) => `${stream}「${name}」`).join(' / ')}`);
  }
  return { chips, warnings };
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

export function buildSite(config: HtmlShareConfig, buildRoot: string, now = new Date()): BuildManifest {
  const roots = validatedRoots(config);
  const contentRoot = path.join(buildRoot, 'content');
  rmSync(buildRoot, { recursive: true, force: true });
  mkdirSync(contentRoot, { recursive: true });
  const ogImageUrl = resolveOgImage(config, contentRoot);
  // slug は保管庫のページも含めた全ページで決める。保管庫から戻したときに同じURLへ戻すため
  const used = new Set<string>();
  const drafts = config.content.pages.map((page) => {
    const source = pagePath(config, page);
    const sourceReal = realpathSync(source);
    if (!inside(sourceReal, roots)) throw new Error(`Page is outside content.roots: ${source}`);
    const fallback = path.basename(source, path.extname(source));
    let slug = slugify(page.slug || fallback);
    if (used.has(slug)) slug = `${slug}-${createHash('sha256').update(sourceReal).digest('hex').slice(0, 6)}`;
    used.add(slug);
    const updatedAt = statSync(sourceReal).mtime.toISOString();
    const repository = page.repository || defaultGroup(page);
    const stream = page.stream || repository;
    return {
      page,
      sourceReal,
      built: {
        slug,
        title: page.title || extractTitle(readFileSync(sourceReal, 'utf8'), fallback),
        source: page.path,
        updatedAt,
        date: updatedAt,
        repository,
        stream,
        streamLabel: page.streamLabel || stream,
        objectKey: `pages/${slug}/index.html`,
      },
    };
  });
  const { chips, warnings } = resolveStreamChips(drafts.map(({ page, built }) => ({
    stream: built.stream,
    streamLabel: page.streamLabel,
    streamChip: page.streamChip,
  })));
  for (const warning of warnings) console.warn(warning);
  const resolved = drafts.map((draft) => ({
    ...draft,
    built: { ...draft.built, streamChip: chips.get(draft.built.stream) ?? draft.built.streamLabel } as BuiltPage,
  }));
  const streamDues = config.content.streamDues ?? {};

  // 保持期限：retainDays を過ぎ、続ける理由（keep の日付・進行中フィルターのテーマ）が無いページは保管庫へ
  const retainDays = config.content.retainDays;
  const archivedSet = new Set<number>();
  if (retainDays !== undefined) {
    const shelfStreams = new Set(buildShelf(config.content.shelf ?? [], resolved.map((item) => item.built), now, streamDues)
      .flatMap((entry) => (entry.stream ? [entry.stream] : [])));
    const context = { retainDays, today: jstToday(now), now: now.getTime(), shelfStreams };
    resolved.forEach((item, index) => {
      if (keepReason({ updatedAt: item.built.updatedAt, keep: item.page.keep, stream: item.built.stream }, context) === null) {
        archivedSet.add(index);
      }
    });
  }

  const pages: BuiltPage[] = [];
  const archived: ArchivedPage[] = [];
  resolved.forEach(({ page, sourceReal, built }, index) => {
    if (archivedSet.has(index)) {
      archived.push({
        slug: built.slug,
        title: built.title,
        source: built.source,
        updatedAt: built.updatedAt,
        date: built.date,
        repository: built.repository,
        stream: built.stream,
        streamLabel: built.streamLabel,
        keep: page.keep ?? null,
      });
      return;
    }
    const html = bundleHtml(sourceReal, roots, config.content.maximumAssetBytes, {
      siteName: config.content.siteName,
      title: page.title,
      imageUrl: ogImageUrl,
      cardType: config.content.ogCardType,
    });
    const directory = path.join(contentRoot, 'pages', built.slug);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'index.html'), html);
    pages.push(built);
  });
  archived.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  const manifest: BuildManifest = {
    generatedAt: now.toISOString(),
    internalSharing: config.content.allowedInternalCidrs.length > 0,
    maximumShareDays: config.content.maximumShareDays,
    retainDays: retainDays ?? null,
    pages,
    archived,
    shelf: buildShelf(config.content.shelf ?? [], pages, now, streamDues),
    streamDues: Object.fromEntries(Object.entries(streamDues)
      .map(([key, dues]) => [key, liveDues(dues, now)] as const)
      .filter(([, dues]) => dues.length > 0)),
  };
  writeFileSync(path.join(buildRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
