import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildSite, bundleHtml, resolveStreamLabels, slugify } from '../src/bundle.js';
import type { HtmlShareConfig } from '../src/config.js';

test('bundles local assets and adds privacy metadata', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'html-share-bundle-'));
  writeFileSync(path.join(root, 'pixel.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(path.join(root, 'page.html'), '<!doctype html><html><head><title>Demo</title></head><body><img src="pixel.png"></body></html>');
  const bundled = bundleHtml(path.join(root, 'page.html'), [realpathSync(root)], 1024);
  assert.match(bundled, /data:image\/png;base64,/);
  assert.match(bundled, /name="robots" content="noindex/);
  assert.match(bundled, /name="referrer" content="no-referrer"/);
  assert.match(bundled, /table\[data-mb-view="card"\]/);
  assert.match(bundled, /\.mb-cardhead \{[\s\S]{0,400}linear-gradient/);
  assert.match(bundled, /data-mb-tables/);
  assert.match(bundled, /\.cal-grid\[data-mb-cal="list"\]/);
});

test('rejects pages outside approved roots, including symlinks', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'html-share-root-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'html-share-outside-'));
  const secret = path.join(outside, 'secret.html');
  writeFileSync(secret, '<p>outside</p>');
  const link = path.join(root, 'linked.html');
  symlinkSync(secret, link);
  assert.throws(() => bundleHtml(link, [realpathSync(root)], 1024), /outside content\.roots/);
});

test('creates stable ASCII slugs', () => {
  assert.equal(slugify('Release Notes 2026'), 'release-notes-2026');
  assert.match(slugify('共有結果'), /^page-[a-f0-9]{8}$/);
});

test('includes share capabilities in the generated manifest without exposing CIDRs', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'html-share-manifest-'));
  const page = path.join(root, 'page.html');
  writeFileSync(page, '<h1>Demo</h1>');
  const config = {
    ownerEmail: 'owner@example.com',
    aws: {
      region: 'ap-northeast-1',
      consoleDomain: 'console.example.com',
      contentDomain: 'content.example.com',
      certificateArn: 'arn:aws:acm:us-east-1:111122223333:certificate/00000000-0000-4000-8000-000000000000',
      cognitoDomainPrefix: 'html-share-test',
      publicKeyPath: '.html-share/keys/public.pem',
      privateKeyPath: '.html-share/keys/private.pem',
      privateKeyParameterName: '/html-share/test/private-key',
    },
    content: {
      roots: ['.'],
      pages: [{ path: 'page.html' }],
      ownerLinkDays: 7,
      maximumShareDays: 30,
      maximumAssetBytes: 1024,
      allowedInternalCidrs: ['203.0.113.0/24'],
      siteName: '#HTML共有くん',
    },
    configFile: path.join(root, 'html-share.config.yaml'),
    baseDir: root,
  } satisfies HtmlShareConfig;

  const manifest = buildSite(config, path.join(root, 'build'));
  assert.equal(manifest.internalSharing, true);
  assert.equal(manifest.maximumShareDays, 30);
  assert.doesNotMatch(JSON.stringify(manifest), /203\.0\.113/);
});

test('gives every page its theme chip and names untitled shelf items after it', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'html-share-chip-'));
  for (const name of ['a', 'b', 'c', 'd']) writeFileSync(path.join(root, `${name}.html`), `<h1>${name}</h1>`);
  const config = {
    ownerEmail: 'owner@example.com',
    aws: {
      region: 'ap-northeast-1',
      consoleDomain: 'console.example.com',
      contentDomain: 'content.example.com',
      certificateArn: 'arn:aws:acm:us-east-1:111122223333:certificate/00000000-0000-4000-8000-000000000000',
      cognitoDomainPrefix: 'html-share-test',
      publicKeyPath: '.html-share/keys/public.pem',
      privateKeyPath: '.html-share/keys/private.pem',
      privateKeyParameterName: '/html-share/test/private-key',
    },
    content: {
      roots: ['.'],
      pages: [
        { path: 'a.html', stream: 'release', streamLabel: '新機能リリースの準備と告知' },
        { path: 'b.html', stream: 'release', streamLabel: '新機能リリースの準備と告知', streamChip: '新機能リリース' },
        { path: 'c.html', stream: 'weekly', streamLabel: '週次レポート' },
        { path: 'd.html', stream: 'misc' },
      ],
      ownerLinkDays: 7,
      maximumShareDays: 30,
      maximumAssetBytes: 1024,
      allowedInternalCidrs: [],
      siteName: '#HTML共有くん',
      ogImageUrl: false,
      shelf: [{ id: 'release', stream: 'release', done: false }],
    },
    configFile: path.join(root, 'html-share.config.yaml'),
    baseDir: root,
  } satisfies HtmlShareConfig;

  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message: string) => { warnings.push(message); };
  try {
    const manifest = buildSite(config, path.join(root, 'build'));
    // チップ名 → 見出し → 一番古いページの題名の順で決まり、同じテーマの全ページに同じ名前が付く
    assert.deepEqual(manifest.pages.map((item) => item.streamChip), ['新機能リリース', '新機能リリース', '週次レポート', 'd']);
    assert.equal(manifest.shelf[0].title, '新機能リリース');
  } finally {
    console.warn = original;
  }
  // 見出しの無いテーマと、見出しはあるのにチップ名が無いテーマは警告するが、ビルドは止めない
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /streamLabel（一覧の見出し）が無いテーマ: misc（仮の見出し「d」）$/);
  assert.match(warnings[1], /が無いテーマ: weekly$/);
});

test('uses the bundled card image unless the config opts out or overrides it', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'html-share-ogcard-'));
  writeFileSync(path.join(root, 'page.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Demo</title></head><body></body></html>');
  const base = {
    ownerEmail: 'owner@example.com',
    aws: {
      region: 'ap-northeast-1',
      consoleDomain: 'console.example.com',
      contentDomain: 'content.example.com',
      certificateArn: 'arn:aws:acm:us-east-1:111122223333:certificate/00000000-0000-4000-8000-000000000000',
      cognitoDomainPrefix: 'html-share-test',
      publicKeyPath: '.html-share/keys/public.pem',
      privateKeyPath: '.html-share/keys/private.pem',
      privateKeyParameterName: '/html-share/test/private-key',
    },
    content: {
      roots: ['.'],
      pages: [{ path: 'page.html' }],
      ownerLinkDays: 7,
      maximumShareDays: 30,
      maximumAssetBytes: 1024,
      allowedInternalCidrs: [],
      siteName: '#HTML共有くん',
    },
    configFile: path.join(root, 'html-share.config.yaml'),
    baseDir: root,
  } satisfies HtmlShareConfig;
  const pageHtml = (build: string) => readFileSync(path.join(build, 'content', 'pages', 'page', 'index.html'), 'utf8');

  // 既定：同梱の画像を配信先の og/card.jpg へ置き、中身から作った ?v= 付きで指す。
  const build = path.join(root, 'build');
  buildSite(base, build);
  assert.ok(existsSync(path.join(build, 'content', 'og', 'card.jpg')), '同梱の画像が配信物に入っていません');
  assert.match(pageHtml(build), /property="og:image" content="https:\/\/content\.example\.com\/og\/card\.jpg\?v=[0-9a-f]{8}"/);

  // 自前の画像を指定したら、そちらを使い、同梱の画像は置かない。
  const custom = path.join(root, 'build-custom');
  buildSite({ ...base, content: { ...base.content, ogImageUrl: 'https://example.com/og.png' } }, custom);
  assert.match(pageHtml(custom), /property="og:image" content="https:\/\/example\.com\/og\.png"/);
  assert.ok(!existsSync(path.join(custom, 'content', 'og')));

  // false なら画像を出さない。
  const none = path.join(root, 'build-none');
  buildSite({ ...base, content: { ...base.content, ogImageUrl: false } }, none);
  assert.doesNotMatch(pageHtml(none), /og:image/);
});

test('adds link preview tags after the charset declaration', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'html-share-ogp-'));
  writeFileSync(
    path.join(root, 'page.html'),
    '<!doctype html><html><head><meta charset="utf-8"><title>四半期の振り返り</title></head>'
      + '<body><div class="hero"><p class="sub">売上と稼働を1枚にまとめました</p></div>'
      + '<p>本文の最初の段落です</p></body></html>',
  );
  const bundled = bundleHtml(path.join(root, 'page.html'), [realpathSync(root)], 1024, {
    siteName: '#HTML共有くん',
  });

  assert.match(bundled, /<meta property="og:site_name" content="#HTML共有くん">/);
  assert.match(bundled, /<meta property="og:title" content="四半期の振り返り">/);
  // 説明文はヒーローのリード文から拾う
  assert.match(bundled, /<meta property="og:description" content="売上と稼働を1枚にまとめました">/);
  // 画像を設定していないので og:image は出さず、カードは小さいほうを指定する
  assert.doesNotMatch(bundled, /og:image/);
  assert.match(bundled, /<meta name="twitter:card" content="summary">/);

  // 文字コード宣言より後ろに入っていること。日本語が charset より前に出ると
  // クローラー側が文字化けしうる（文字コードは先頭1024バイトまでに宣言する決まり）。
  assert.ok(bundled.indexOf('charset') < bundled.indexOf('og:title'));
  assert.ok(Buffer.byteLength(bundled.slice(0, bundled.indexOf('charset'))) < 1024);
});

test('uses the configured image and title for link previews', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'html-share-ogp-image-'));
  writeFileSync(
    path.join(root, 'page.html'),
    '<!doctype html><html><head><meta charset="utf-8"><title>もとの題</title></head><body><p>本文</p></body></html>',
  );
  const bundled = bundleHtml(path.join(root, 'page.html'), [realpathSync(root)], 1024, {
    siteName: 'My Share',
    title: '設定で付けた題',
    imageUrl: 'https://example.com/og.png',
  });

  assert.match(bundled, /<meta property="og:title" content="設定で付けた題">/);
  assert.match(bundled, /<meta property="og:image" content="https:\/\/example\.com\/og\.png">/);
  // 画像があっても既定は小さいカード。large_image は横長画像を前提にした見せ方で、
  // 正方形やロゴを渡すと引き伸ばされる（2026-09-20 に既定を変更）。
  assert.match(bundled, /<meta name="twitter:card" content="summary">/);
  // X は og:* へフォールバックする仕様だが、実測では twitter:* を明示したほうが安定する
  assert.match(bundled, /<meta name="twitter:title" content="設定で付けた題">/);
  assert.match(bundled, /<meta name="twitter:image" content="https:\/\/example\.com\/og\.png">/);
  assert.match(bundled, /<meta property="og:image:alt" content="My Share">/);
});

test('uses the large card only when it is asked for', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'html-share-ogp-large-'));
  writeFileSync(
    path.join(root, 'page.html'),
    '<!doctype html><html><head><meta charset="utf-8"><title>題</title></head><body><p>本文</p></body></html>',
  );
  const bundled = bundleHtml(path.join(root, 'page.html'), [realpathSync(root)], 1024, {
    siteName: 'My Share',
    imageUrl: 'https://example.com/og.png',
    cardType: 'summary_large_image',
  });

  assert.match(bundled, /<meta name="twitter:card" content="summary_large_image">/);
});

test('keeps the small card when there is no image, even if the large card is asked for', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'html-share-ogp-large-noimage-'));
  writeFileSync(
    path.join(root, 'page.html'),
    '<!doctype html><html><head><meta charset="utf-8"><title>題</title></head><body><p>本文</p></body></html>',
  );
  const bundled = bundleHtml(path.join(root, 'page.html'), [realpathSync(root)], 1024, {
    siteName: 'My Share',
    cardType: 'summary_large_image',
  });

  // 画像が無いのに large_image を名乗ると、X は画像を探しに行って空振りする
  assert.match(bundled, /<meta name="twitter:card" content="summary">/);
  assert.doesNotMatch(bundled, /og:image/);
});

test('leaves pages that already declare their own link preview alone', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'html-share-ogp-own-'));
  writeFileSync(
    path.join(root, 'page.html'),
    '<!doctype html><html><head><meta charset="utf-8">'
      + '<meta property="og:title" content="自前の題"><title>別の題</title></head><body><p>本文</p></body></html>',
  );
  const bundled = bundleHtml(path.join(root, 'page.html'), [realpathSync(root)], 1024, {
    siteName: '#HTML共有くん',
  });

  assert.match(bundled, /<meta property="og:title" content="自前の題">/);
  assert.doesNotMatch(bundled, /og:site_name/);
});

test('adds nothing when link previews are not configured', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'html-share-ogp-off-'));
  writeFileSync(
    path.join(root, 'page.html'),
    '<!doctype html><html><head><meta charset="utf-8"><title>題</title></head><body><p>本文</p></body></html>',
  );
  const bundled = bundleHtml(path.join(root, 'page.html'), [realpathSync(root)], 1024);
  assert.doesNotMatch(bundled, /og:/);
});

test('テーマに見出しが無いときは、キーでなく一番古いページの題名を仮の見出しにする', () => {
  const { labels, warnings } = resolveStreamLabels([
    { stream: 'release', streamLabel: '新機能リリース', title: 'リリース告知｜下書き', updatedAt: '2026-03-02T00:00:00Z' },
    { stream: 'release', title: 'リリース告知｜第2版', updatedAt: '2026-03-01T00:00:00Z' },
    { stream: 'vendor-review', title: 'ベンダー比較｜第2回', updatedAt: '2026-03-05T00:00:00Z' },
    { stream: 'vendor-review', title: 'ベンダー選定の観点｜初回', updatedAt: '2026-03-01T00:00:00Z' },
    { stream: 'untitled', title: '', updatedAt: '2026-03-01T00:00:00Z' },
  ]);
  assert.equal(labels.get('release'), '新機能リリース');
  assert.equal(labels.get('vendor-review'), 'ベンダー選定の観点');
  assert.equal(labels.get('untitled'), 'untitled');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /vendor-review/);
  assert.doesNotMatch(warnings[0], /release（/);
});
