import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildSite, bundleHtml, slugify } from '../src/bundle.js';
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
    },
    configFile: path.join(root, 'html-share.config.yaml'),
    baseDir: root,
  } satisfies HtmlShareConfig;

  const manifest = buildSite(config, path.join(root, 'build'));
  assert.equal(manifest.internalSharing, true);
  assert.equal(manifest.maximumShareDays, 30);
  assert.doesNotMatch(JSON.stringify(manifest), /203\.0\.113/);
});
