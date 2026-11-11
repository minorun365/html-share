import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { BuiltPage } from '../src/bundle.js';
import type { HtmlShareConfig } from '../src/config.js';
import { acquirePublishLock, assertNotShrinking, buildOnly, hasUnpulledConfigChanges, matchingPages } from '../src/publish.js';

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
