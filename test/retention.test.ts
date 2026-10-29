import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildSite } from '../src/bundle.js';
import { loadConfig } from '../src/config.js';
import { assertNotShrinking, revive, share } from '../src/publish.js';
import { keepReason } from '../src/retention.js';

const NOW = new Date('2026-03-31T03:00:00.000Z');
const DAY_MS = 86400e3;

function fixture(extra = '', pages = `
    - path: pages/fresh.html
    - path: pages/old.html
      title: 古いページ
    - path: pages/kept.html
      keep: 2026-04-10
    - path: pages/pinned.html
      stream: launch
`): { root: string; configFile: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'html-share-retention-'));
  mkdirSync(path.join(root, 'pages'));
  const ages: Record<string, number> = { fresh: 3, old: 45, kept: 45, pinned: 45 };
  for (const [name, days] of Object.entries(ages)) {
    const file = path.join(root, 'pages', `${name}.html`);
    writeFileSync(file, `<title>${name}</title><h1>${name}</h1>`);
    const at = new Date(NOW.getTime() - days * DAY_MS);
    utimesSync(file, at, at);
  }
  const configFile = path.join(root, 'html-share.config.yaml');
  writeFileSync(configFile, `ownerEmail: owner@example.com
aws:
  region: ap-northeast-1
  consoleDomain: console.example.com
  contentDomain: content.example.com
  certificateArn: arn:aws:acm:us-east-1:111122223333:certificate/00000000-0000-4000-8000-000000000000
  cognitoDomainPrefix: html-share-test
  publicKeyPath: .html-share/keys/public.pem
  privateKeyPath: .html-share/keys/private.pem
  privateKeyParameterName: /html-share/test/private-key
content:
  roots: [pages]
  # ページの一覧（このコメントは revive で消えない）
  pages:${pages}
  ogImageUrl: false
${extra}`);
  return { root, configFile };
}

test('keeps pages that are fresh, have a future keep date, or belong to an in-progress theme', () => {
  const context = { retainDays: 30, today: '2026-03-31', now: NOW.getTime(), shelfStreams: new Set(['launch']) };
  const updatedAt = new Date(NOW.getTime() - 45 * DAY_MS).toISOString();
  assert.equal(keepReason({ updatedAt: NOW.toISOString(), stream: 'x' }, context), 'fresh');
  assert.equal(keepReason({ updatedAt, keep: '2026-03-31', stream: 'x' }, context), 'keep', '見直し日の当日はまだ配信する');
  assert.equal(keepReason({ updatedAt, keep: '2026-03-30', stream: 'x' }, context), null);
  assert.equal(keepReason({ updatedAt, stream: 'launch' }, context), 'shelf');
  assert.equal(keepReason({ updatedAt, stream: 'x' }, context), null);
  assert.equal(keepReason({ updatedAt: 'not-a-date', stream: 'x' }, context), 'fresh', '更新日時が読めないページは外さない');
});

test('archives nothing when retainDays is not set', () => {
  const { configFile, root } = fixture();
  const manifest = buildSite(loadConfig(configFile), path.join(root, 'build'), NOW);
  assert.equal(manifest.retainDays, null);
  assert.equal(manifest.pages.length, 4);
  assert.deepEqual(manifest.archived, []);
});

test('moves stale pages to the archive and stops serving them', () => {
  const { configFile, root } = fixture(`  retainDays: 30
  shelf:
    - id: launch
      stream: launch
`);
  const buildRoot = path.join(root, 'build');
  const manifest = buildSite(loadConfig(configFile), buildRoot, NOW);
  assert.equal(manifest.retainDays, 30);
  assert.deepEqual(manifest.pages.map((page) => page.slug).sort(), ['fresh', 'kept', 'pinned']);
  assert.deepEqual(manifest.archived.map((page) => [page.slug, page.title]), [['old', '古いページ']]);
  // 保管庫のページは配信物に書き出さない（同期で配信先からも消える）
  assert.equal(existsSync(path.join(buildRoot, 'content', 'pages', 'old', 'index.html')), false);
  assert.equal(existsSync(path.join(buildRoot, 'content', 'pages', 'fresh', 'index.html')), true);
});

test('refuses to share an archived page and points to revive', () => {
  const { configFile, root } = fixture('  retainDays: 30\n');
  const config = loadConfig(configFile);
  buildSite(config, path.join(root, '.html-share', 'build'), NOW);
  writeFileSync(path.join(root, '.html-share', 'outputs.json'), JSON.stringify({
    Stack: {
      ConsoleBucketName: 'console', ContentBucketName: 'content', ConsoleUrl: 'https://console.example.com',
      ContentUrl: 'https://content.example.com', CloudFrontPublicKeyId: 'K123',
    },
  }));
  assert.throws(() => share(config, 'old', 7), /in the archive[\s\S]*page revive old/);
});

test('revive writes a keep date into the config without dropping comments, and the next build serves the page', () => {
  const { configFile, root } = fixture('  retainDays: 30\n');
  const buildRoot = path.join(root, '.html-share', 'build');
  buildSite(loadConfig(configFile), buildRoot, NOW);
  const { page, keep } = revive(loadConfig(configFile), 'old', 14, NOW);
  assert.equal(page.slug, 'old');
  assert.equal(keep, '2026-04-14');
  const written = readFileSync(configFile, 'utf8');
  assert.match(written, /# ページの一覧（このコメントは revive で消えない）/);
  assert.match(written, /path: pages\/old\.html\n\s+title: 古いページ\n\s+keep: 2026-04-14/);
  const rebuilt = buildSite(loadConfig(configFile), buildRoot, NOW);
  // 戻したページだけが配信へ戻る（進行中フィルターが無いので pinned は保管庫のまま）
  assert.deepEqual(rebuilt.archived.map((item) => item.slug), ['pinned']);
  assert.equal(rebuilt.pages.find((item) => item.slug === 'old')?.title, '古いページ');
});

test('revive turns a bare path entry into a map and rejects pages that are not archived', () => {
  const { configFile, root } = fixture('  retainDays: 30\n', `
    - pages/fresh.html
    - pages/old.html
`);
  buildSite(loadConfig(configFile), path.join(root, '.html-share', 'build'), NOW);
  assert.throws(() => revive(loadConfig(configFile), 'fresh', 14, NOW), /No archived page matches fresh/);
  revive(loadConfig(configFile), 'old', 7, NOW);
  assert.match(readFileSync(configFile, 'utf8'), /- path: pages\/old\.html\n\s+keep: 2026-04-07/);
});

test('rejects a non-positive retainDays and an unreadable keep date', () => {
  assert.throws(() => loadConfig(fixture('  retainDays: 0\n').configFile), /content\.retainDays must be a positive integer/);
  assert.throws(() => loadConfig(fixture('', '\n    - path: pages/old.html\n      keep: someday\n').configFile), /content\.pages\[0\]\.keep must be a date/);
});

test('counts archived pages as intended removals in the shrink check', () => {
  assert.throws(() => assertNotShrinking(100, 60));
  assert.doesNotThrow(() => assertNotShrinking(100, 60 + 30));
});
