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
import type { HtmlShareConfig, PageConfig } from './config.js';
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

export interface BuildManifest {
  generatedAt: string;
  internalSharing: boolean;
  maximumShareDays: number;
  pages: BuiltPage[];
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

function dataUrl(file: string, maxBytes: number): string {
  const extension = path.extname(file).toLowerCase();
  const mime = MIME[extension];
  if (!mime) throw new Error(`Local asset type is not allowed: ${extension || '(none)'}`);
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error(`Local asset is not a file: ${file}`);
  if (stat.size > maxBytes) throw new Error(`Local asset exceeds ${maxBytes} bytes: ${file}`);
  return `data:${mime};base64,${readFileSync(file).toString('base64')}`;
}

export function bundleHtml(sourceFile: string, roots: string[], maxAssetBytes: number): string {
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
  return injectMobileHelpers(addMeta(html));
}

function injectMobileHelpers(html: string): string {
  // 閲覧面は script-src が 'unsafe-inline' data: だけなので、相対パスのJSは読めない。
  // 表とカレンダーの畳み込みはAPIを呼ばない（connect-src 'none' のまま）ので、
  // 中身をインラインで埋め込む。
  const tag = ['mobile-tables.js', 'mobile-calendar.js']
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

export function buildSite(config: HtmlShareConfig, buildRoot: string): BuildManifest {
  const roots = validatedRoots(config);
  const contentRoot = path.join(buildRoot, 'content');
  rmSync(buildRoot, { recursive: true, force: true });
  mkdirSync(contentRoot, { recursive: true });
  const used = new Set<string>();
  const pages = config.content.pages.map((page) => {
    const source = pagePath(config, page);
    const sourceReal = realpathSync(source);
    const html = bundleHtml(sourceReal, roots, config.content.maximumAssetBytes);
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
  };
  writeFileSync(path.join(buildRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
