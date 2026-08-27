import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('ships the full dashboard UI and inbox wording', () => {
  const dashboard = readFileSync(path.join(root, 'web', 'app', 'index.html'), 'utf8');
  const review = readFileSync(path.join(root, 'web', 'review', 'index.html'), 'utf8');
  const list = readFileSync(path.join(root, 'web', 'page-list.js'), 'utf8');
  const shell = readFileSync(path.join(root, 'web', 'mobile-page-shell.js'), 'utf8');

  assert.match(dashboard, /HTML共有くん/);
  assert.match(dashboard, /インボックス/);
  assert.match(dashboard, /未読に戻す/);
  assert.match(dashboard, /groupByStream/);
  assert.match(dashboard, /削除済み/);
  assert.match(dashboard, /api\/owner\/shares/);
  assert.match(list, /function markUnread/);
  assert.match(list, /v: null/);
  assert.match(shell, /class="action star-action"/);
  assert.match(shell, /class="action unread-action"/);
  assert.match(review, /Claudeへの依頼/);
  assert.match(review, /\/inbox/);
  assert.match(review, /PCへ渡す依頼はありません/);
  assert.match(review, /id="compose-target" type="text"/);
  assert.doesNotMatch(review, /<select[^>]*id="compose-target"/);
  assert.match(review, /id="target-list"/);
  assert.match(review, /function renderTargetOptions/);
  assert.match(review, /JSON\.stringify\(\{ question: text, target \}\)/);
  assert.match(review, /targetField\.value = '';/);
  assert.match(dashboard, /id="review-dot"/);
  assert.match(dashboard, /function refreshInboxDot/);
  assert.match(dashboard, /\/api\/owner\/reviews/);
  assert.match(dashboard, /function configureShareOptions/);
  assert.match(dashboard, /manifest\.internalSharing/);
  assert.match(dashboard, /manifest\.maximumShareDays/);
  assert.match(shell, /function configureShareOptions/);
  assert.match(shell, /manifest\.internalSharing/);
  assert.match(shell, /manifest\.maximumShareDays/);
});

test('loads iframe pages without adding child-frame history entries', () => {
  const dashboard = readFileSync(path.join(root, 'web', 'app', 'index.html'), 'utf8');
  assert.match(dashboard, /function loadFrame/);
  assert.match(dashboard, /view\.location\.replace\(url\)/);
  assert.doesNotMatch(dashboard, /frame\.src = current\.href/);
  assert.doesNotMatch(dashboard, /frame\.removeAttribute\('src'\)/);
});

test('keeps generated report sections within the mobile viewport', () => {
  const template = readFileSync(path.join(root, 'skills', 'create-html', 'assets', 'brief-template.html'), 'utf8');
  assert.match(template, /main > \* \{ min-width: 0; \}/);
});

test('provisions managed login branding and the CloudFront payload hash header', () => {
  const stack = readFileSync(path.join(root, 'infra', 'lib', 'html-share-stack.ts'), 'utf8');
  const client = readFileSync(path.join(root, 'src', 'review-client.ts'), 'utf8');
  assert.match(stack, /new cognito\.CfnManagedLoginBranding/);
  assert.match(stack, /useCognitoProvidedValues: true/);
  assert.match(client, /'x-amz-content-sha256'/);
  assert.doesNotMatch(client, /'x-content-sha256'/);
});

test('folds overflowing tables on the viewing origin without network access', () => {
  const tables = readFileSync(path.join(root, 'web', 'mobile-tables.js'), 'utf8');
  const handler = readFileSync(path.join(root, 'functions', 'review-handler.ts'), 'utf8');
  assert.match(tables, /data-mb-tables="off"/);
  assert.doesNotMatch(tables, /\bfetch\s*\(/);
  assert.doesNotMatch(tables, /XMLHttpRequest/);
  assert.match(handler, /target: clean\(body\.target, 'target', 60\)/);
  assert.doesNotMatch(handler, /target: clean\(body\.target[\s\S]{0,80}device/);
});

test('closes share popovers from an overlay, Escape, and a timed toast', () => {
  for (const file of [['web', 'app', 'index.html'], ['web', 'mobile-page-shell.js']]) {
    const source = readFileSync(path.join(root, ...file), 'utf8');
    assert.match(source, /toast-meta/);
    assert.match(source, /popover-dismiss|page-popover-dismiss/);
    assert.match(source, /event\.key !== 'Escape'/);
    assert.match(source, /aria-haspopup="menu"/);
  }
});

test('keeps mobile input fields at 16px so iOS Safari does not zoom in', () => {
  // iOS Safari は 16px 未満の input / textarea / select にフォーカスすると
  // ページごと拡大する。戻すにはピンチ操作が要るので、補助的な欄でも下回らせない
  for (const file of [['web', 'review', 'index.html'], ['web', 'app', 'index.html']]) {
    const html = readFileSync(path.join(root, ...file), 'utf8');
    const classes = new Set<string>();
    for (const match of html.matchAll(/<(?:input|textarea|select)\b[^>]*class="([^"]+)"/g)) {
      for (const name of match[1].split(/\s+/)) classes.add(name);
    }
    for (const match of html.matchAll(/(?:input|textarea|select)\.className\s*=\s*['"]([^'"]+)/g)) {
      for (const name of match[1].split(/\s+/)) classes.add(name);
    }
    for (const name of classes) {
      for (const rule of html.matchAll(new RegExp(`\\.${name}(?![\\w-])[^{}]*\\{([^}]*)\\}`, 'g'))) {
        const size = /font-size:\s*([\d.]+)(rem|px|em)/.exec(rule[1]);
        if (!size) continue;
        const px = size[2] === 'px' ? Number(size[1]) : Number(size[1]) * 16;
        assert.ok(px >= 16, `${file.join('/')} の .${name} は入力欄なので 16px 以上に保つ（現在 ${px}px）`);
      }
    }
  }
});

test('refreshes the dashboard, inbox, and every bundled page by pulling down at the top', () => {
  const dashboard = readFileSync(path.join(root, 'web', 'app', 'index.html'), 'utf8');
  const review = readFileSync(path.join(root, 'web', 'review', 'index.html'), 'utf8');
  const pull = readFileSync(path.join(root, 'web', 'pull-to-refresh.js'), 'utf8');
  const bundle = readFileSync(path.join(root, 'src', 'bundle.ts'), 'utf8');

  assert.match(dashboard, /pull-to-refresh\.js/);
  assert.match(review, /pull-to-refresh\.js/);
  assert.match(pull, /document\.scrollingElement\?\.scrollTop/);
  assert.match(pull, /Math\.abs\(deltaX\) > Math\.abs\(deltaY\)/);
  assert.match(pull, /touchmove[\s\S]{0,520}event\.preventDefault\(\)/);
  assert.match(pull, /distance >= TRIGGER_DISTANCE/);
  assert.match(pull, /location\.reload\(\)/);
  assert.match(bundle, /\['mobile-tables\.js', 'mobile-calendar\.js', 'pull-to-refresh\.js'\]/);
});

test('folds monthly calendars into a single column on narrow screens', () => {
  const calendar = readFileSync(path.join(root, 'web', 'mobile-calendar.js'), 'utf8');
  assert.match(calendar, /max-width: 46rem/);
  assert.match(calendar, /data-mb-cal/);
  assert.doesNotMatch(calendar, /\bfetch\s*\(/);
});

test('does not ship the discarded simplified dashboard files', () => {
  for (const file of ['app.css', 'app.js', 'review.html', 'review.js']) {
    assert.throws(() => readFileSync(path.join(root, 'web', 'app', file), 'utf8'));
  }
});
