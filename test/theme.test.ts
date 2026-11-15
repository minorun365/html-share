import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { HtmlShareConfig } from '../src/config.js';
import { pageTheme } from '../src/new-page.js';
import { loadSiteTheme, THEMED_SCREENS, themeShell } from '../src/theme.js';

const root = path.resolve(import.meta.dirname, '..');
const config = (siteTheme?: string, baseDir = root) =>
  ({ baseDir, content: { siteTheme } }) as unknown as Pick<HtmlShareConfig, 'content' | 'baseDir'>;

test('defaults to the light theme and reads its top color', () => {
  const theme = loadSiteTheme(config());
  assert.equal(theme.name, 'light');
  assert.equal(theme.base, '#f1fafc');
  assert.match(theme.css ?? '', /--t-wash/);
  assert.match(theme.css ?? '', /html body::before/, 'the shared rules follow the theme variables');
  assert.doesNotMatch(theme.css ?? '', /<\/style/i, 'the bundled theme never closes the stylesheet');
});

test('themes every console screen: vars after the original CSS, theme-color set to the top color', () => {
  const theme = loadSiteTheme(config());
  for (const screen of THEMED_SCREENS) {
    const original = readFileSync(path.join(root, 'web', screen), 'utf8');
    const themed = themeShell(original, theme, screen);
    const marker = themed.indexOf('/* ── site theme: light ── */');
    assert.ok(marker > themed.indexOf(':root {'), `${screen}: theme comes after the screen's own :root`);
    assert.ok(marker < themed.lastIndexOf('</style>'), `${screen}: theme stays inside the stylesheet`);
    assert.match(themed, /<meta name="theme-color" content="#f1fafc">/, screen);
    assert.doesNotMatch(themed, /<meta name="theme-color" content="#0a4695">/, screen);
  }
});

test('classic leaves the screens untouched', () => {
  const theme = loadSiteTheme(config('classic'));
  const original = readFileSync(path.join(root, 'web', 'app', 'index.html'), 'utf8');
  assert.equal(theme.css, null);
  assert.equal(themeShell(original, theme), original);
});

test('reads a custom theme file relative to the config', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'html-share-theme-'));
  writeFileSync(path.join(dir, 'mine.css'), ':root { --t-base: #fafaf5; --t-wash: #fafaf5; }');
  const theme = loadSiteTheme(config('mine.css', dir));
  assert.equal(theme.base, '#fafaf5');
  writeFileSync(path.join(dir, 'broken.css'), ':root { --t-wash: #fff; }');
  assert.throws(() => loadSiteTheme(config('broken.css', dir)), /--t-base/);
  assert.throws(() => loadSiteTheme(config('nope')), /theme not found/);
  // A closing tag in a comment would end the screen's stylesheet early and print the rest as text.
  writeFileSync(path.join(dir, 'closing.css'), '/* goes before </style> */ :root { --t-base: #fafaf5; }');
  assert.throws(() => loadSiteTheme(config('closing.css', dir)), /<\/style/);
});

test('refuses a screen without a stylesheet', () => {
  assert.throws(() => themeShell('<html><body></body></html>', loadSiteTheme(config())), /no <style>/);
});

test('the starter page follows the site theme when a page theme of that name exists', async () => {
  assert.equal(await pageTheme(undefined, config('light')), 'light');
  assert.equal(await pageTheme(undefined, config('classic')), 'light');
  assert.equal(await pageTheme(undefined), 'light');
  assert.equal(await pageTheme('light', config('classic')), 'light');
});
