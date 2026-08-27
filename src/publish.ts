import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildManifest, BuiltPage } from './bundle.js';
import { buildSite } from './bundle.js';
import type { HtmlShareConfig, StackOutputs } from './config.js';
import { loadOutputs, resolveFromConfig } from './config.js';
import { signUrl } from './sign.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function files(root: string, current = root): string[] {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(current, entry.name);
    return entry.isDirectory() ? files(root, full) : [path.relative(root, full)];
  });
}

function copyConsole(buildRoot: string, manifest: object): void {
  const consoleRoot = path.join(buildRoot, 'console');
  mkdirSync(consoleRoot, { recursive: true });
  for (const relative of files(path.join(PACKAGE_ROOT, 'web'))) {
    const source = path.join(PACKAGE_ROOT, 'web', relative);
    const target = path.join(consoleRoot, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(source));
  }
  mkdirSync(path.join(consoleRoot, 'app'), { recursive: true });
  writeFileSync(path.join(consoleRoot, 'app', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(consoleRoot, 'app.webmanifest'), `${JSON.stringify({
    name: 'HTML共有くん',
    short_name: '共有くん',
    lang: 'ja',
    start_url: '/app/index.html',
    scope: '/',
    display: 'standalone',
    background_color: '#f6f7f9',
    theme_color: '#0e0d6a',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }, null, 2)}\n`);
}

/** バケットにいま入っているオブジェクトを Key → ETag で集める */
async function remoteObjects(client: S3Client, bucket: string): Promise<Map<string, string>> {
  const objects = new Map<string, string>();
  let continuationToken: string | undefined;
  do {
    const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }));
    for (const item of listed.Contents ?? []) {
      if (item.Key) objects.set(item.Key, (item.ETag ?? '').replace(/"/g, ''));
    }
    continuationToken = listed.NextContinuationToken;
  } while (continuationToken);
  return objects;
}

async function deleteKeys(client: S3Client, bucket: string, keys: string[]): Promise<void> {
  for (let index = 0; index < keys.length; index += 1000) {
    const batch = keys.slice(index, index + 1000).map((Key) => ({ Key }));
    await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch } }));
  }
}

/**
 * ローカルの生成物とバケットの中身を突き合わせ、変わったものだけ送る。
 *
 *   毎回まるごと消して上げ直すと、1ページ直しただけでもサイト全体が
 *   上がり直す。ページ数が増えるほど publish の待ち時間そのものになるので、
 *   中身のハッシュで比べて差分だけを送り、消えたものだけを消す。
 *   バケットは SSE-S3 なので、単一パートで上げた分の ETag は中身の MD5 と一致する。
 */
async function syncTree(client: S3Client, bucket: string, root: string): Promise<void> {
  const remote = await remoteObjects(client, bucket);
  const kept = new Set<string>();
  for (const relative of files(root)) {
    const file = path.join(root, relative);
    const key = relative.split(path.sep).join('/');
    kept.add(key);
    const body = readFileSync(file);
    if (remote.get(key) === createHash('md5').update(body).digest('hex')) continue;
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      CacheControl: 'no-store, max-age=0',
    }));
  }
  await deleteKeys(client, bucket, [...remote.keys()].filter((key) => !kept.has(key)));
}

/**
 * publish 全体を1プロセスだけに絞る。
 *
 *   build は .html-share/build をまるごと作り直すので、生成の途中はページが欠けた
 *   状態になる。syncTree は「ローカルに無いキーは消す」ので、その欠けた状態を正として
 *   バケット側のページを消してしまう。publish が2つ重なるだけで起きるうえ、
 *   どちらのコマンドも成功して終わるため、消えたことに気づく手がかりが残らない。
 *
 *   「開始時に他の publish が無いこと」を確認するだけでは足りない。確認から送信完了までの
 *   あいだに始まった build を止められないので、送り終えるまでロックを持ち続ける。
 */
export function acquirePublishLock(config: HtmlShareConfig): () => void {
  const lock = path.resolve(config.baseDir, '.html-share', 'publish.lock');
  mkdirSync(path.dirname(lock), { recursive: true });
  if (!takeLock(lock)) {
    throw new Error(`Another publish is in progress. Wait for it to finish, or remove ${lock} if no process owns it.`);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    rmSync(lock, { recursive: true, force: true });
  };
}

/**
 * ロックの取得は mkdir のアトミック性だけで判定する（既存なら EEXIST で失敗する）。
 * 既にあるディレクトリへ自分の pid を書いて所有を主張してはいけない。他のプロセスが
 * 持っているロックを黙って奪うことになる。
 */
function takeLock(lock: string): boolean {
  const pidFile = path.join(lock, 'pid');
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // 落ちたプロセスが残したロックは引き取る。放置すると publish が二度と通らない。
    // pid が読めないロックは「作られた直後」の可能性があるので、奪わず持ち主として扱う。
    let owner = 0;
    try {
      owner = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    } catch {
      return false;
    }
    if (!Number.isInteger(owner) || owner <= 0 || isAlive(owner)) return false;
    rmSync(lock, { recursive: true, force: true });
    try {
      mkdirSync(lock);
    } catch {
      return false;
    }
  }
  writeFileSync(pidFile, `${process.pid}\n`);
  return true;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM は「他ユーザーのプロセスだが存在する」。生きている扱いにする。
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function ownerManifest(manifest: BuildManifest, outputs: StackOutputs, config: HtmlShareConfig): object {
  const privateKeyPath = resolveFromConfig(config, config.aws.privateKeyPath);
  return {
    generatedAt: manifest.generatedAt,
    internalSharing: manifest.internalSharing,
    maximumShareDays: manifest.maximumShareDays,
    pages: manifest.pages.map((page: BuiltPage) => ({
      ...page,
      href: signUrl({
        url: `${outputs.ContentUrl}/${page.objectKey}`,
        keyPairId: outputs.CloudFrontPublicKeyId,
        privateKeyPath,
        days: config.content.ownerLinkDays,
      }),
    })),
  };
}

/** publish から呼ぶ用。ロックは呼び出し側が持っている（二重取得するとその場で失敗する）。 */
function buildUnlocked(config: HtmlShareConfig): { buildRoot: string; manifest: BuildManifest } {
  const buildRoot = path.resolve(config.baseDir, '.html-share', 'build');
  const manifest = buildSite(config, buildRoot);
  copyConsole(buildRoot, { ...manifest, pages: manifest.pages.map((page) => ({ ...page, href: null })) });
  return { buildRoot, manifest };
}

export function buildOnly(config: HtmlShareConfig): { buildRoot: string; manifest: BuildManifest } {
  const release = acquirePublishLock(config);
  try {
    return buildUnlocked(config);
  } finally {
    release();
  }
}

export async function publish(config: HtmlShareConfig): Promise<{ consoleUrl: string; pages: number }> {
  const outputsFile = path.resolve(config.baseDir, '.html-share', 'outputs.json');
  const outputs = loadOutputs(outputsFile);
  // build と送信の両方を1つのロックで囲む。送信も .html-share/build を読む区間なので、
  // ここを外すと「送信中に別の build が生成物を作り直す」状態が起きる。
  const release = acquirePublishLock(config);
  try {
    const { buildRoot, manifest } = buildUnlocked(config);
    copyConsole(buildRoot, ownerManifest(manifest, outputs, config));
    const client = new S3Client({ region: config.aws.region });
    await syncTree(client, outputs.ContentBucketName, path.join(buildRoot, 'content'));
    await syncTree(client, outputs.ConsoleBucketName, path.join(buildRoot, 'console'));
    return { consoleUrl: `${outputs.ConsoleUrl}/app/index.html`, pages: manifest.pages.length };
  } finally {
    release();
  }
}

export function share(config: HtmlShareConfig, query: string, days: number): string {
  if (days > config.content.maximumShareDays) {
    throw new Error(`Share duration exceeds the configured maximum of ${config.content.maximumShareDays} days`);
  }
  const buildRoot = path.resolve(config.baseDir, '.html-share', 'build');
  const manifest = JSON.parse(readFileSync(path.join(buildRoot, 'manifest.json'), 'utf8')) as BuildManifest;
  const outputs = loadOutputs(path.resolve(config.baseDir, '.html-share', 'outputs.json'));
  const matches = matchingPages(manifest.pages, query);
  if (matches.length !== 1) throw new Error(matches.length ? `Multiple pages match ${query}: ${matches.map((p) => p.slug).join(', ')}` : `Page not found: ${query}`);
  return signUrl({
    url: `${outputs.ContentUrl}/${matches[0].objectKey}`,
    keyPairId: outputs.CloudFrontPublicKeyId,
    privateKeyPath: resolveFromConfig(config, config.aws.privateKeyPath),
    days,
  });
}

export function matchingPages(pages: BuiltPage[], query: string): BuiltPage[] {
  const exact = pages.filter((page) => page.slug === query);
  if (exact.length > 0) return exact;
  return pages.filter((page) => page.slug.includes(query) || page.title.includes(query));
}
