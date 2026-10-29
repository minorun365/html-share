import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { isMap, isSeq, parse, parseDocument, stringify } from 'yaml';

export interface PageConfig {
  path: string;
  title?: string;
  slug?: string;
  repository?: string;
  stream?: string;
  streamLabel?: string;
  /** 進行中チップに出すテーマの短い名前。同じテーマのどれか1ページに書けばよい */
  streamChip?: string;
  /** 見直し日（YYYY-MM-DD）。content.retainDays を過ぎても、この日までは配信を続ける */
  keep?: string;
}

/**
 * 進行中フィルターの1項目。ページではなく「まだ終わっていない仕事」の単位で持つ。
 * stream を書けばチップでそのテーマに絞り込み、url は絞り込み中の見出しにリンクとして出す（少なくとも一方）。
 */
export interface ShelfItemConfig {
  id: string;
  /** 省略すると、テーマの項目はテーマのチップ名（streamChip）、url だけの項目は id を名前にする */
  title?: string;
  stream?: string;
  url?: string;
  /**
   * url だけの項目の締切（YYYY-MM-DD）。翌日を過ぎると進行中フィルターから自動で消える。
   * テーマの項目は content.streamDues が正本で、そちらがあれば due は使わない
   */
  due?: string;
  note?: string;
  /** url 項目を進行中フィルターへ載せた日（YYYY-MM-DD）。締切なしの並び順と「◯日動きなし」に使う */
  added?: string;
  /** 書いておくと進行中フィルターに出さない */
  done: boolean;
}

/** テーマの期限の1件。what は「リハーサル」「本番」のような何の日か */
export interface StreamDue {
  date: string;
  what: string | null;
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
    /**
     * 最終更新からこの日数を過ぎたページを配信から外し、一覧の保管庫へ移す。
     * 省略すると保管庫へは移さない（すべて配信を続ける）
     */
    retainDays?: number;
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
    /** 進行中フィルター。省略すると進行中フィルターを出さない */
    shelf?: ShelfItemConfig[];
    /**
     * テーマキー → 期限の一覧。進行中フィルターの項目にも、画面の押しピンで足したテーマにも同じ期限が出る。
     * 画面が今日以降でいちばん近い日を選ぶので、節目が複数あれば全部並べる
     */
    streamDues?: Record<string, StreamDue[]>;
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

/** 進行中フィルターの締切や追加日。YAML が日付として読んだ値も文字列へ戻す */
function isoDate(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const result = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(result))) {
    throw new Error(`${name} must be a date like 2026-01-31`);
  }
  return result;
}

/** 進行中フィルターのリンク。画面から開く先なので http(s) だけを許す */
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

/**
 * content.streamDues を読む。書式は { テーマキー: { 日付: 何の日 } }。日付だけの配列も受ける。
 * 空の {} は「期限なし」として受け、日付順に並べ直す
 */
function streamDuesConfig(value: unknown): Record<string, StreamDue[]> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('content.streamDues must be a map of theme keys');
  const out: Record<string, StreamDue[]> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const name = `content.streamDues.${key}`;
    const pairs: [unknown, unknown][] = raw === null || raw === undefined
      ? []
      : Array.isArray(raw)
        ? raw.map((date) => [date, null])
        : typeof raw === 'object'
          ? Object.entries(raw as Record<string, unknown>)
          : [[raw, null]];
    out[key] = pairs
      .map(([date, what]) => ({
        date: isoDate(date, name) ?? '',
        what: what === null || what === undefined || String(what).trim() === '' ? null : String(what).trim(),
      }))
      .filter((due) => due.date !== '')
      .sort((left, right) => left.date.localeCompare(right.date));
  }
  return out;
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
    if (!stream && !url) throw new Error(`${name} needs stream or url`);
    return {
      id,
      title: typeof record.title === 'string' && record.title.trim() ? record.title.trim() : undefined,
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
          streamChip: typeof page.streamChip === 'string' && page.streamChip.trim() ? page.streamChip.trim() : undefined,
          keep: isoDate(page.keep, `content.pages[${index}].keep`),
        };
      }),
      ownerLinkDays: positiveInteger(content.ownerLinkDays, 30, 'content.ownerLinkDays'),
      maximumShareDays: positiveInteger(content.maximumShareDays, 30, 'content.maximumShareDays'),
      maximumAssetBytes: positiveInteger(content.maximumAssetBytes, 10 * 1024 * 1024, 'content.maximumAssetBytes'),
      retainDays: content.retainDays === undefined || content.retainDays === null
        ? undefined
        : positiveInteger(content.retainDays, 30, 'content.retainDays'),
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
      streamDues: streamDuesConfig(content.streamDues),
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

/**
 * 設定ファイルの content.pages のうち path が一致する1件に keep（見直し日）を書く。
 * コメントと並びを残すため、文書として読んで該当の値だけ差し替える
 */
export function setPageKeep(file: string | undefined, pagePath: string, keep: string): void {
  const configFile = configPath(file);
  const document = parseDocument(readFileSync(configFile, 'utf8'));
  const pages = document.getIn(['content', 'pages']);
  if (!isSeq(pages)) throw new Error('content.pages must be an array');
  const index = pages.items.findIndex((item) => {
    const value = isMap(item) ? item.get('path') : (item as { value?: unknown })?.value;
    return value === pagePath;
  });
  if (index < 0) throw new Error(`content.pages has no entry for ${pagePath}`);
  if (!isMap(pages.items[index])) {
    // 文字列だけで書いたページは、path を持つ形へ書き直してから keep を足す
    pages.items[index] = document.createNode({ path: pagePath });
  }
  document.setIn(['content', 'pages', index, 'keep'], keep);
  writeFileSync(configFile, document.toString({ lineWidth: 120 }));
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
