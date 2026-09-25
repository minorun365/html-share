import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { addPageToConfig, loadConfig } from '../src/config.js';

function fixture(): { root: string; config: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'html-share-config-'));
  mkdirSync(path.join(root, 'pages'));
  writeFileSync(path.join(root, 'pages', 'demo.html'), '<h1>Demo</h1>');
  const config = path.join(root, 'html-share.config.yaml');
  writeFileSync(config, `ownerEmail: owner@example.com
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
  allowedInternalCidrs: [203.0.113.0/24]
  pages:
    - path: pages/demo.html
      repository: examples
      stream: release-notes
      streamLabel: リリースノート
  ownerLinkDays: 7
  maximumShareDays: 30
  maximumAssetBytes: 1024
`);
  return { root, config };
}

test('loads a valid config and resolves its base directory', () => {
  const { root, config } = fixture();
  const loaded = loadConfig(config);
  assert.equal(loaded.baseDir, root);
  assert.equal(loaded.content.pages[0].path, 'pages/demo.html');
  assert.equal(loaded.content.pages[0].repository, 'examples');
  assert.equal(loaded.content.pages[0].stream, 'release-notes');
  assert.equal(loaded.content.pages[0].streamLabel, 'リリースノート');
  assert.deepEqual(loaded.content.allowedInternalCidrs, ['203.0.113.0/24']);
});

test('adds a page only once', () => {
  const { config } = fixture();
  assert.equal(addPageToConfig(config, 'pages/second.html', 'Second'), true);
  assert.equal(addPageToConfig(config, 'pages/second.html', 'Second'), false);
  assert.equal((readFileSync(config, 'utf8').match(/pages\/second\.html/g) ?? []).length, 1);
});

test('requires separate console and content origins', () => {
  const { config } = fixture();
  const source = readFileSync(config, 'utf8').replace('content.example.com', 'console.example.com');
  writeFileSync(config, source);
  assert.throws(() => loadConfig(config), /must be different security origins/);
});

test('rejects invalid internal CIDRs', () => {
  const { config } = fixture();
  const invalid = '999' + '.0.0.1/40';
  const source = readFileSync(config, 'utf8').replace('203.0.113.0/24', invalid);
  writeFileSync(config, source);
  assert.throws(() => loadConfig(config), /must be an IPv4 CIDR/);
});

test('defaults the link preview name and rejects unsafe image URLs', () => {
  const { config } = fixture();

  // 既定のアプリ名。設定を書かなくてもカードに名前が出る。
  assert.equal(loadConfig(config).content.siteName, '#HTML共有くん');
  assert.equal(loadConfig(config).content.ogImageUrl, undefined);

  const base = readFileSync(config, 'utf8');

  writeFileSync(config, `${base}\n  siteName: Team Share\n  ogImageUrl: https://example.com/og.png\n`);
  assert.equal(loadConfig(config).content.siteName, 'Team Share');
  assert.equal(loadConfig(config).content.ogImageUrl, 'https://example.com/og.png');

  // 画像URLはクローラーが取りに行く先なので https だけを許す。
  writeFileSync(config, `${base}\n  ogImageUrl: http://example.com/og.png\n`);
  assert.throws(() => loadConfig(config), /must use https/);

  writeFileSync(config, `${base}\n  ogImageUrl: "javascript:alert(1)"\n`);
  assert.throws(() => loadConfig(config), /must use https/);

  writeFileSync(config, `${base}\n  ogImageUrl: "/relative/og.png"\n`);
  assert.throws(() => loadConfig(config), /must be an absolute https URL/);
  // false（または none）で画像を出さない。省略時の undefined は「同梱の画像を使う」。
  writeFileSync(config, `${base}\n  ogImageUrl: false\n`);
  assert.equal(loadConfig(config).content.ogImageUrl, false);
  writeFileSync(config, `${base}\n  ogImageUrl: none\n`);
  assert.equal(loadConfig(config).content.ogImageUrl, false);
});

test('loads shelf items and rejects ambiguous ones', () => {
  const { config } = fixture();
  const base = readFileSync(config, 'utf8');
  assert.deepEqual(loadConfig(config).content.shelf, []);

  writeFileSync(config, `${base}  shelf:
    - id: plan
      title: Launch plan
      stream: release-notes
      due: 2026-01-31
    - id: thread
      title: Reply to the thread
      url: https://example.com/thread
      added: 2026-01-20
      note: waiting for a reply
`);
  const shelf = loadConfig(config).content.shelf ?? [];
  assert.equal(shelf[0].due, '2026-01-31');
  assert.equal(shelf[0].stream, 'release-notes');
  assert.equal(shelf[1].url, 'https://example.com/thread');
  assert.equal(shelf[1].note, 'waiting for a reply');
  assert.equal(shelf[1].done, false);

  writeFileSync(config, `${base}  shelf:\n    - id: both\n      stream: a\n      url: https://example.com/\n`);
  assert.throws(() => loadConfig(config), /exactly one of stream or url/);
  writeFileSync(config, `${base}  shelf:\n    - id: dup\n      url: https://example.com/\n    - id: dup\n      url: https://example.com/\n`);
  assert.throws(() => loadConfig(config), /duplicated/);
  writeFileSync(config, `${base}  shelf:\n    - id: bad\n      url: "javascript:alert(1)"\n`);
  assert.throws(() => loadConfig(config), /must use http or https/);
  writeFileSync(config, `${base}  shelf:\n    - id: bad\n      url: https://example.com/\n      due: next week\n`);
  assert.throws(() => loadConfig(config), /must be a date/);
});
