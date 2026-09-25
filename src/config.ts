import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';

export interface PageConfig {
  path: string;
  title?: string;
  slug?: string;
  repository?: string;
  stream?: string;
  streamLabel?: string;
}

/**
 * 進行中の棚の1項目。ページではなく「まだ終わっていない仕事」の単位で持つ。
 * stream を書けばそのテーマの最新ページへ、url を書けばそのリンクへ飛ぶ（どちらか一方）。
 */
export interface ShelfItemConfig {
  id: string;
  title: string;
  stream?: string;
  url?: string;
  /** 締切（YYYY-MM-DD）。翌日を過ぎると棚から自動で消える */
  due?: string;
  note?: string;
  /** url 項目を棚へ載せた日（YYYY-MM-DD）。締切なしの並び順と「◯日動きなし」に使う */
  added?: string;
  /** 書いておくと棚に出さない */
  done: boolean;
}

export interface HtmlShareConfig {
  ownerEmail: string;
  aws: {
    region: string;
    consoleDomain: string;
    contentDomain: string;
    certificateArn: string;
    cognitoDomainPrefix: string;
    publicKeyPath: string;
    privateKeyPath: string;
    privateKeyParameterName: string;
  };
  content: {
    roots: string[];
    pages: PageConfig[];
    ownerLinkDays: number;
    maximumShareDays: number;
    maximumAssetBytes: number;
    allowedInternalCidrs: string[];
    /** リンクプレビュー（OGP）で名乗るアプリ名 */
    siteName: string;
    /**
     * リンクプレビューに出す画像の絶対URL。省略すると同梱の画像（assets/og-card.jpg）を使う。
     * false にすると og:image を出さない
     */
    ogImageUrl?: string | false;
    /** カードの大きさ。省略すると summary（各媒体でいちばん小さいカード） */
    ogCardType?: 'summary' | 'summary_large_image';
    /** 進行中の棚。省略すると棚を出さない */
    shelf?: ShelfItemConfig[];
  };
  configFile: string;
  baseDir: string;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function positiveInteger(value: unknown, fallback: number, name: string): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`);
  return number;
}

function hostname(value: unknown, name: string): string {
  const result = text(value, name).toLowerCase();
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(result)) {
    throw new Error(`${name} must be a hostname without a scheme or path`);
  }
  return result;
}

/** リンクプレビューの画像URL。クローラーが認証なしで取れる先だけを許す。 */
function httpsUrl(value: unknown, name: string): string {
  const result = text(value, name);
  let parsed: URL;
  try {
    parsed = new URL(result);
  } catch {
    throw new Error(`${name} must be an absolute https URL`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`${name} must use https`);
  return parsed.toString();
}

/** 棚の締切や追加日。YAML が日付として読んだ値も文字列へ戻す */
function isoDate(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const result = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(result))) {
    throw new Error(`${name} must be a date like 2026-01-31`);
  }
  return result;
}

/** 棚のリンク。画面から開く先なので http(s) だけを許す */
function linkUrl(value: unknown, name: string): string {
  const result = text(value, name);
  let parsed: URL;
  try {
    parsed = new URL(result);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(`${name} must use http or https`);
  return parsed.toString();
}

function shelfItems(value: unknown): ShelfItemConfig[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('content.shelf must be an array');
  const seen = new Set<string>();
  return value.map((item: unknown, index: number) => {
    const name = `content.shelf[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${name} must be an object`);
    const record = item as Record<string, unknown>;
    const id = text(record.id, `${name}.id`);
    if (seen.has(id)) throw new Error(`${name}.id is duplicated: ${id}`);
    seen.add(id);
    const stream = typeof record.stream === 'string' && record.stream.trim() ? record.stream.trim() : undefined;
    const url = record.url === undefined || record.url === null ? undefined : linkUrl(record.url, `${name}.url`);
    if (Boolean(stream) === Boolean(url)) throw new Error(`${name} needs exactly one of stream or url`);
    return {
      id,
      title: typeof record.title === 'string' && record.title.trim() ? record.title.trim() : id,
      stream,
      url,
      due: isoDate(record.due, `${name}.due`),
      note: typeof record.note === 'string' && record.note.trim() ? record.note.trim() : undefined,
      added: isoDate(record.added, `${name}.added`),
      done: Boolean(record.done),
    };
  });
}

function cidr(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(result)) throw new Error(`${name} must be an IPv4 CIDR`);
  const [address, prefix] = result.split('/');
  if (Number(prefix) > 32 || address.split('.').some((part) => Number(part) > 255)) {
    throw new Error(`${name} must be an IPv4 CIDR`);
  }
  return result;
}

export function resolveFromConfig(config: HtmlShareConfig, value: string): string {
  return path.resolve(config.baseDir, value);
}

function configPath(file?: string): string {
  if (file) return path.resolve(file);
  if (process.env.HTML_SHARE_CONFIG) return path.resolve(process.env.HTML_SHARE_CONFIG);
  const local = path.resolve('html-share.config.yaml');
  if (existsSync(local)) return local;
  const global = path.join(homedir(), '.config', 'html-share', 'config.yaml');
  return existsSync(global) ? global : local;
}

export function loadConfig(file?: string): HtmlShareConfig {
  const configFile = configPath(file);
  if (!existsSync(configFile)) {
    throw new Error(`Config file not found: ${configFile}. Copy html-share.config.example.yaml first.`);
  }
  const raw = parse(readFileSync(configFile, 'utf8')) as Record<string, any>;
  const aws = raw?.aws ?? {};
  const content = raw?.content ?? {};
  const pages = Array.isArray(content.pages) ? content.pages : [];
  const roots = Array.isArray(content.roots) ? content.roots.map((item: unknown) => text(item, 'content.roots[]')) : [];
  const allowedInternalCidrs = Array.isArray(content.allowedInternalCidrs)
    ? content.allowedInternalCidrs.map((item: unknown) => cidr(item, 'content.allowedInternalCidrs[]'))
    : [];
  if (roots.length === 0) throw new Error('content.roots must contain at least one directory');
  if (pages.length === 0) throw new Error('content.pages must contain at least one page');
  const ownerEmail = text(raw?.ownerEmail, 'ownerEmail');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) throw new Error('ownerEmail must be an email address');
  const consoleDomain = hostname(aws.consoleDomain, 'aws.consoleDomain');
  const contentDomain = hostname(aws.contentDomain, 'aws.contentDomain');
  if (consoleDomain === contentDomain) throw new Error('aws.consoleDomain and aws.contentDomain must be different security origins');
  const certificateArn = text(aws.certificateArn, 'aws.certificateArn');
  if (!/^arn:aws:acm:us-east-1:\d{12}:certificate\/[0-9a-f-]+$/i.test(certificateArn)) {
    throw new Error('aws.certificateArn must be an ACM certificate ARN from us-east-1 for CloudFront');
  }

  return {
    ownerEmail,
    aws: {
      region: text(aws.region, 'aws.region'),
      consoleDomain,
      contentDomain,
      certificateArn,
      cognitoDomainPrefix: text(aws.cognitoDomainPrefix, 'aws.cognitoDomainPrefix'),
      publicKeyPath: text(aws.publicKeyPath, 'aws.publicKeyPath'),
      privateKeyPath: text(aws.privateKeyPath, 'aws.privateKeyPath'),
      privateKeyParameterName: text(aws.privateKeyParameterName, 'aws.privateKeyParameterName'),
    },
    content: {
      roots,
      pages: pages.map((item: unknown, index: number) => {
        const page = typeof item === 'string' ? { path: item } : item as Record<string, unknown>;
        return {
          path: text(page.path, `content.pages[${index}].path`),
          title: typeof page.title === 'string' ? page.title.trim() : undefined,
          slug: typeof page.slug === 'string' ? page.slug.trim() : undefined,
          repository: typeof page.repository === 'string' ? page.repository.trim() : undefined,
          stream: typeof page.stream === 'string' ? page.stream.trim() : undefined,
          streamLabel: typeof page.streamLabel === 'string' ? page.streamLabel.trim() : undefined,
        };
      }),
      ownerLinkDays: positiveInteger(content.ownerLinkDays, 30, 'content.ownerLinkDays'),
      maximumShareDays: positiveInteger(content.maximumShareDays, 30, 'content.maximumShareDays'),
      maximumAssetBytes: positiveInteger(content.maximumAssetBytes, 10 * 1024 * 1024, 'content.maximumAssetBytes'),
      allowedInternalCidrs,
      siteName: typeof content.siteName === 'string' && content.siteName.trim()
        ? content.siteName.trim()
        : '#HTML共有くん',
      ogImageUrl: content.ogImageUrl === undefined || content.ogImageUrl === null
        ? undefined
        : content.ogImageUrl === false || content.ogImageUrl === 'none'
          ? false
          : httpsUrl(content.ogImageUrl, 'content.ogImageUrl'),
      ogCardType: content.ogCardType === 'summary_large_image' ? 'summary_large_image'
        : content.ogCardType === undefined || content.ogCardType === null || content.ogCardType === 'summary'
          ? undefined
          : (() => { throw new Error('content.ogCardType must be "summary" or "summary_large_image"'); })(),
      shelf: shelfItems(content.shelf),
    },
    configFile,
    baseDir: path.dirname(configFile),
  };
}

export function addPageToConfig(file: string | undefined, pagePath: string, title?: string): boolean {
  const configFile = configPath(file);
  const raw = parse(readFileSync(configFile, 'utf8')) as Record<string, any>;
  raw.content ??= {};
  raw.content.pages ??= [];
  if (!Array.isArray(raw.content.pages)) throw new Error('content.pages must be an array');
  const storedPath = path.isAbsolute(pagePath) || path.dirname(configFile) === process.cwd()
    ? pagePath
    : path.resolve(pagePath);
  const exists = raw.content.pages.some((item: unknown) =>
    (typeof item === 'string' ? item : (item as Record<string, unknown>)?.path) === storedPath,
  );
  if (exists) return false;
  raw.content.pages.push(title ? { path: storedPath, title } : { path: storedPath });
  writeFileSync(configFile, stringify(raw, { lineWidth: 120 }));
  return true;
}

export function validatedRoots(config: HtmlShareConfig): string[] {
  return config.content.roots.map((root) => {
    const absolute = resolveFromConfig(config, root);
    if (!existsSync(absolute)) throw new Error(`Content root not found: ${absolute}`);
    return realpathSync(absolute);
  });
}

export interface StackOutputs {
  ConsoleBucketName: string;
  ContentBucketName: string;
  ConsoleUrl: string;
  ContentUrl: string;
  CloudFrontPublicKeyId: string;
}

export function loadOutputs(file: string): StackOutputs {
  const source = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, string>>;
  const candidate = Object.values(source).find((value) =>
    value.ConsoleBucketName && value.ContentBucketName && value.ContentUrl && value.CloudFrontPublicKeyId,
  );
  if (!candidate) throw new Error(`CDK outputs are incomplete: ${file}`);
  return candidate as unknown as StackOutputs;
}
