import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { BuiltPage } from '../src/bundle.js';
import type { HtmlShareConfig } from '../src/config.js';
import {
  acquirePublishLock, assertNotShrinking, buildOnly, consoleListViews, hasUnpulledConfigChanges, matchingPages, mergeRemotePages,
  writeConsoleList,
} from '../src/publish.js';

function page(slug: string, title = slug): BuiltPage {
  return {
    slug,
    title,
    source: `${slug}.html`,
    updatedAt: '2026-08-27T00:00:00.000Z',
    date: '2026-08-27T00:00:00.000Z',
    repository: 'test',
    stream: 'test',
    streamLabel: 'Test',
    streamChip: 'Test',
    objectKey: `pages/${slug}/index.html`,
  };
}

test('prefers an exact slug over prefix and title matches', () => {
  const exact = page('report-2026-08-04-141049');
  const longer = page('report-2026-08-04-141049-ja');
  assert.deepEqual(matchingPages([exact, longer], exact.slug), [exact]);
});

test('prefers a unique exact title over partial title matches', () => {
  const exact = page('weekly', 'Weekly review');
  const longer = page('weekly-team', 'Weekly review for the team');
  assert.deepEqual(matchingPages([exact, longer], 'Weekly review'), [exact]);
});

test('keeps partial matching when there is no exact slug', () => {
  const first = page('release-notes', 'Release notes');
  const second = page('roadmap', 'Release roadmap');
  assert.deepEqual(matchingPages([first, second], 'Release'), [first, second]);
});

// publish の排他。build は生成物をまるごと作り直し、送信は「ローカルに無いキーを消す」ので、
// 2つの publish が重なると、まだ生成されていないページがバケットから消える。どちらの
// コマンドも成功して終わるため、テストで押さえておかないと壊れたことに気づけない。
function lockConfig(): HtmlShareConfig {
  return { baseDir: mkdtempSync(path.join(tmpdir(), 'html-share-lock-')) } as HtmlShareConfig;
}

test('refuses a second publish while one holds the lock', () => {
  const config = lockConfig();
  const release = acquirePublishLock(config);
  assert.throws(() => acquirePublishLock(config), /Another publish is in progress/);
  release();
  const again = acquirePublishLock(config);  // 解放後は取れる
  again();
});

test('releasing twice is harmless', () => {
  const config = lockConfig();
  const release = acquirePublishLock(config);
  release();
  release();
  assert.equal(existsSync(path.join(config.baseDir, '.html-share', 'publish.lock')), false);
});

test('takes over a lock left behind by a dead process', () => {
  const config = lockConfig();
  const lock = path.join(config.baseDir, '.html-share', 'publish.lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(path.join(lock, 'pid'), '2147483647\n');  // 存在しない pid
  const release = acquirePublishLock(config);
  assert.equal(readFileSync(path.join(lock, 'pid'), 'utf8').trim(), String(process.pid));
  release();
});

test('does not steal a lock that has no pid file yet', () => {
  const config = lockConfig();
  mkdirSync(path.join(config.baseDir, '.html-share', 'publish.lock'), { recursive: true });
  assert.throws(() => acquirePublishLock(config), /Another publish is in progress/);
});

test('buildOnly acquires the same lock', () => {
  const config = lockConfig();
  const release = acquirePublishLock(config);
  assert.throws(() => buildOnly(config), /Another publish is in progress/);
  release();
});

test('refuses a publish that would delete most of the bucket', () => {
  assert.throws(() => assertNotShrinking(1000, 3, false), /Refusing to publish/);
  assert.doesNotThrow(() => assertNotShrinking(1000, 950, false));
  assert.doesNotThrow(() => assertNotShrinking(1000, 3, true));
  assert.doesNotThrow(() => assertNotShrinking(20, 0, false));
});

function fakeGit(responses: Record<string, string | Error>): (args: string[]) => string {
  return (args) => {
    const answer = responses[args[0]];
    if (answer instanceof Error) throw answer;
    return answer ?? '';
  };
}

test('keeps deleting when the config is not tracked against an upstream', () => {
  assert.equal(hasUnpulledConfigChanges('/repo/html-share.config.yaml', fakeGit({ 'rev-parse': new Error('no upstream') })), false);
});

test('keeps deleting when the upstream has not touched the config', () => {
  assert.equal(hasUnpulledConfigChanges('/repo/html-share.config.yaml', fakeGit({ diff: '' })), false);
});

test('stops deleting when the upstream added pages that are not pulled yet', () => {
  assert.equal(hasUnpulledConfigChanges('/repo/html-share.config.yaml', fakeGit({ diff: 'html-share.config.yaml\n' })), true);
});

test('stops deleting when the upstream cannot be fetched', () => {
  assert.equal(hasUnpulledConfigChanges('/repo/html-share.config.yaml', fakeGit({ fetch: new Error('offline') })), true);
});

test('keeps pages another device published when uploading without removals', () => {
  const local = { pages: [{ slug: 'mine', objectKey: 'pages/mine/index.html', date: '2026-01-01' }], archived: [] };
  const remote = {
    pages: [
      { slug: 'mine', objectKey: 'pages/mine/index.html', date: '2026-01-01' },
      { slug: 'from-laptop', objectKey: 'pages/from-laptop/index.html', date: '2026-01-03' },
      { slug: 'removed', objectKey: 'pages/removed/index.html', date: '2026-01-02' },
    ],
    archived: [{ slug: 'old', date: '2025-01-01' }],
  };
  const added = mergeRemotePages(local, remote, new Set(['pages/mine/index.html', 'pages/from-laptop/index.html']));
  assert.deepEqual(added, ['from-laptop', 'old']);
  assert.deepEqual(local.pages.map((page) => page.slug), ['from-laptop', 'mine']);
});

test('does not add pages back when the bucket list cannot be read', () => {
  const local = { pages: [], archived: [] };
  assert.deepEqual(mergeRemotePages(local, null, new Set()), []);
});

test('splits the dashboard list into the top list and the archive', () => {
  const manifest = {
    generatedAt: '2026-01-05T00:00:00.000Z',
    internalSharing: false,
    pages: [{ slug: 'current', title: 'Current page' }],
    archived: [{ slug: 'old-1', title: 'Old page 1' }, { slug: 'old-2', title: 'Old page 2' }],
    shelf: [],
  };
  const views = consoleListViews(manifest);
  const list = JSON.parse(views.list);
  assert.equal(list.archived, undefined, 'list.json は保管庫の行を持たない');
  assert.equal(list.archivedCount, 2);
  assert.deepEqual(list.pages, manifest.pages);
  assert.equal(list.generatedAt, manifest.generatedAt);
  assert.ok(Buffer.byteLength(views.list) < Buffer.byteLength(JSON.stringify(manifest)), 'list.json は保管庫の分だけ小さい');
  assert.doesNotMatch(views.list, /old-1/);
  const archive = JSON.parse(views.archive);
  assert.deepEqual(archive, { archived: manifest.archived });
  assert.equal(archive.generatedAt, undefined, '保管庫が同じならファイルも同じになる');
  assert.equal(consoleListViews({ ...manifest, generatedAt: 'later' }).archive, views.archive);
  assert.equal(JSON.parse(consoleListViews({ pages: [] }).list).archivedCount, 0);
});

test('writes the full manifest and both views side by side, and rewrites them after a merge', () => {
  const appDir = path.join(mkdtempSync(path.join(tmpdir(), 'html-share-views-')), 'app');
  const local = { pages: [{ slug: 'mine', objectKey: 'pages/mine/index.html', date: '2026-01-01' }], archived: [] };
  writeConsoleList(appDir, local);
  assert.deepEqual(JSON.parse(readFileSync(path.join(appDir, 'manifest.json'), 'utf8')), local);
  assert.equal(JSON.parse(readFileSync(path.join(appDir, 'list.json'), 'utf8')).archivedCount, 0);
  mergeRemotePages(local, { pages: [], archived: [{ slug: 'old', date: '2025-01-01' }] }, new Set());
  writeConsoleList(appDir, local);
  assert.equal(JSON.parse(readFileSync(path.join(appDir, 'list.json'), 'utf8')).archivedCount, 1);
  assert.deepEqual(JSON.parse(readFileSync(path.join(appDir, 'archive.json'), 'utf8')).archived.map((item: { slug: string }) => item.slug), ['old']);
  assert.equal(JSON.parse(readFileSync(path.join(appDir, 'manifest.json'), 'utf8')).archived.length, 1, 'manifest.json は台帳として保管庫も持つ');
});
