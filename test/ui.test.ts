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
  assert.match(dashboard, /const STREAM_STAR_PREFIX = '@stream:'/, 'カードスターを個別ページと区別する');
  assert.match(dashboard, /head\.append\(count, last, streamStarButton\(stream\)\)/, 'カード見出しにスターを置く');
  assert.match(dashboard, /const pageIsStarred = \(page\) => isStarred\(page\) \|\| starred\.has\(streamStarId\(pageStream\(page\)\)\)/, 'カードのスターはテーマ丸ごとスターの絞り込みに入れる');
  assert.match(dashboard, /shelfFilter === STAR_FILTER[\s\S]{0,40}visiblePages\(\)\.filter\(pageIsStarred\)/, 'スターのチップで一覧を絞り込む');
  assert.doesNotMatch(dashboard, /appendDateGroup\('スター'/, 'スター段は一覧に出さない');
  assert.match(dashboard, /削除済み/);
  assert.match(dashboard, /api\/owner\/shares/);
  assert.match(list, /function markUnread/);
  assert.match(list, /v: null/);
  assert.match(shell, /class="action star-action"/);
  assert.match(shell, /const STREAM_STAR_PREFIX = '@stream:'/, '個別ページ側もカードスターを識別する');
  assert.match(shell, /starredSources = starredSources\.filter\(isValidStarValue\)/, '個別ページから保存してもカードスターを残す');
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
  assert.doesNotMatch(dashboard, /function appendShelf/, '進行中の段は一覧に出さない');
  assert.match(dashboard, /<nav class="chips" id="chips" aria-label="一覧の絞り込み"><\/nav>\s*<div class="chip-picker" id="chip-picker" hidden><\/div>\s*<\/header>/, '絞り込みチップはヘッダーの2段目、追加の候補はその下に置く');
  assert.match(dashboard, /const SHELF_DONE_KEY = 'mb_shelf_done'/);
  assert.match(dashboard, /shelfDone: \[\.\.\.shelfDone\]/, '✕で下ろした印を本人設定として同期する');
  assert.match(dashboard, /let shelfFilter = null;/);
  assert.match(dashboard, /chip\('すべて', \{ on: shelfFilter === null/, '「すべて」は絞り込みなしで選択状態');
  assert.match(dashboard, /if \(starCount > 0\) \{\s*bar\.append\(chip\('★ スター'/, 'スター付きが1件以上のときだけスターのチップを出す');
  assert.match(dashboard, /const select = \(key\) => \(\) => \{ shelfFilter = shelfFilter === key \? null : key; renderHome\(\); \};/, 'チップは押すたびに絞り込みを切り替える');
  assert.match(dashboard, /onClick: select\(item\.stream\),\s*onDone: \(\) => doneShelfItem\(item\)/, 'テーマのチップで絞り込み、選択中の✕で棚から下ろす');
  assert.match(dashboard, /if \(onDone && \(on \|\| chipEditing\)\)/, '✕は選択中のチップと、編集中の全チップに出す');
  assert.match(dashboard, /window\.open\(item\.url, '_blank', 'noopener,noreferrer'\)/, 'リンクのチップは新しいタブで開く');
  assert.match(dashboard, /\.chip\.link \.n::after \{ content: " ↗"; \}/);
  assert.match(dashboard, /const text = diff < 0 \? '昨日まで' : diff === 0 \? '今日' : diff === 1 \? '明日' : `\$\{diff\}日`;/, 'チップの締切は短い表記');
  assert.match(dashboard, /if \(showingTrash \|\| filterText\.trim\(\)\) return;/, '削除済みと検索中はチップを出さない');
  assert.match(dashboard, /body\.searching \.chips \{ display: none; \}/);
  assert.match(dashboard, /if \(open && shelfFilter !== null\) \{\s*shelfFilter = null;/, '検索を開いたら絞り込みを解除する');
  assert.match(dashboard, /@media \(max-width: 46rem\) \{\s*[^\n]*\n\s*\.chips \{ flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none;/, 'スマホ幅はチップを横スクロールにする');
  assert.match(dashboard, /id="filter-note" hidden/, '絞り込み中の1行を置く');
  assert.match(dashboard, /aria-pressed/);
  assert.match(dashboard, /visiblePages\(\)\.filter\(\(page\) => pageStream\(page\) === shelfFilter\)/, '一覧を選んだテーマに絞る');
  assert.match(dashboard, /filterText\.trim\(\) === '' && shelfFilter === null && \(hidden > 0 \|\| expanded\)/, '絞り込み中は「他N件」を出さない');
  assert.match(dashboard, /manifest\.internalSharing/);
  assert.match(dashboard, /manifest\.maximumShareDays/);
  assert.match(shell, /function configureShareOptions/);
  assert.match(shell, /manifest\.internalSharing/);
  assert.match(shell, /manifest\.maximumShareDays/);
});

test('lets the owner add and remove in-progress chips from the dashboard', () => {
  const dashboard = readFileSync(path.join(root, 'web', 'app', 'index.html'), 'utf8');
  // 編集モード：鉛筆のゴーストチップ → 全チップに ✕、並びの最後に「＋ 追加」と「完了」
  assert.match(dashboard, /edit\.className = `chip ghost edit\$\{chipEditing \? ' on' : ''\}`/, '鉛筆はゴーストのチップ');
  assert.match(dashboard, /chipEditing\s*\? '<svg[^']*<\/svg>完了'/, '編集中はチェックマーク付きの「完了」で抜ける');
  // 「完了」と開いた「＋ 追加」は白塗りにしない（選択中のチップと見分けるため）
  assert.match(dashboard, /\.chip\.edit\.on \{[^}]*background: transparent;[^}]*color: #fff;[^}]*font-weight: 700;/, '「完了」は塗りも枠も無い文字ボタン');
  assert.match(dashboard, /\.chip\.ghost:not\(\.edit\)\.on \{[^}]*background: rgba\(255, 255, 255, \.22\);[^}]*inset 0 0 0 1px rgba\(255, 255, 255, \.7\)/, '開いた「＋ 追加」は淡い面と明るい枠');
  assert.match(dashboard, /if \(chipEditing\) \{[\s\S]{0,200}add\.textContent = '＋ 追加';/, '編集中だけ「＋ 追加」を出す');
  assert.match(dashboard, /onClick: \(\) => window\.open\(item\.url, '_blank', 'noopener,noreferrer'\),\s*onDone: \(\) => doneShelfItem\(item\)/, 'リンクのチップも編集中は ✕ で外せる');
  assert.match(dashboard, /bar\.classList\.toggle\('editing', chipEditing\)/);
  // ✕：台帳の項目は shelfDone へ、自分で足したテーマは shelfAdded から消す
  assert.match(dashboard, /if \(item\.added\) shelfAdded = shelfAdded\.filter\(\(key\) => key !== item\.stream\);\s*else shelfDone\.add\(item\.id\);/);
  // 追加：台帳にあって下ろしていたら戻し、無ければ shelfAdded に足す
  assert.match(dashboard, /if \(ledger && shelfDone\.has\(ledger\.id\)\) shelfDone\.delete\(ledger\.id\);\s*else if \(!ledger && !shelfAdded\.includes\(streamKey\)\) shelfAdded\.push\(streamKey\);/);
  // 候補は進行中に無いテーマを最近動いた順に最大24件
  assert.match(dashboard, /\.filter\(\(summary\) => !onShelf\.has\(summary\.key\)\)\s*\.sort\(\(a, b\) => Date\.parse\(b\.last\) - Date\.parse\(a\.last\)\)\s*\.slice\(0, 24\)/);
  assert.match(dashboard, /sub\.textContent = `\$\{summary\.count\}件・\$\{shortTime\(summary\.last\)\}`/);
  assert.match(dashboard, /\.picker-item > span:first-child \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; \}/, '長い名前は省略記号');
  assert.match(dashboard, /\.chip-picker \{[\s\S]{0,400}max-height: 50vh; overflow-y: auto;/, '候補パネルは縦スクロール');
  // 並び：台帳の項目のあとに自分で足したテーマ
  assert.match(dashboard, /return \[\.\.\.ledger, \.\.\.added\];/);
  // 保存：本人設定に載せ、端末間は保存値を正とする（和集合にしない）
  assert.match(dashboard, /const SHELF_ADDED_KEY = 'mb_shelf_added'/);
  assert.match(dashboard, /shelfDone: \[\.\.\.shelfDone\],\s*shelfAdded,/, '足したテーマも本人設定として同期する');
  assert.match(dashboard, /shelfDone = new Set\(\(saved\.shelfDone \?\? \[\]\)/);
  assert.match(dashboard, /shelfAdded = \[\.\.\.new Set\(\(saved\.shelfAdded \?\? \[\]\)/);
  assert.doesNotMatch(dashboard, /\.\.\.remoteShelf, \.\.\.shelfDone/, '進行中の印を和集合で合わせない');
  // スマホ幅：鉛筆は列の右端に sticky、編集中は折り返す
  assert.match(dashboard, /\.chip\.edit \{\s*position: sticky; right: 0;/);
  assert.match(dashboard, /\.chips\.editing \{ flex-wrap: wrap; overflow: visible;/);
});

test('shows only the update time before the toolbar icons', () => {
  const dashboard = readFileSync(path.join(root, 'web', 'app', 'index.html'), 'utf8');
  assert.match(dashboard, /<div class="topbar-actions">\s*<span class="brand-meta" id="brand-meta"><\/span>/, '更新時刻は右のアイコン群の直前');
  assert.match(dashboard, /brandMeta\.textContent = `\$\{shortTime\(meta\.generatedAt\)\} 更新`;/);
  assert.match(dashboard, /brandMeta\.title = `最終更新 \$\{fmtDateTime\(meta\.generatedAt\)\}`;/);
  assert.doesNotMatch(dashboard, /ページ ／ \$\{fmtDateTime/, 'ページ件数は出さない');
  assert.match(dashboard, /body\.searching \.brand-meta \{ display: none; \}/);
  assert.match(dashboard, /\.brand-meta \{[^}]*border-right: 1px solid/, '右に細い区切り線');
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
  // ページごと拡大する。戻すにはピンチ操作が要るので、拡大したまま横幅が画面から
  // はみ出し続ける。補助的な欄でも下回らせない。
  //
  // ⚠️ font-size を「自分で明示していること」まで要求する。継承任せを許すと、親が
  // 小さいときに黙って小さくなる。実際に踏んだのは次の2系統:
  //   - 検索欄 #q が .82rem（13.1px）。class を持たないので旧検査が見逃していた
  //   - 共有パネルの select が font: inherit で、親 label の .68rem を継承して 10.9px
  const INPUT_TAGS = ['input', 'textarea', 'select'];
  let scanned = 0;
  for (const file of [
    ['web', 'review', 'index.html'],
    ['web', 'app', 'index.html'],
    ['web', 'mobile-page-shell.js'],
  ]) {
    const source = readFileSync(path.join(root, ...file), 'utf8');
    const label = file.join('/');

    // ① 入力欄そのものを集める（HTML の属性と、JS で組み立てる場合の両方）
    const fields: { tag: string; id: string | null; classes: string[] }[] = [];
    for (const m of source.matchAll(/<(input|textarea|select)\b([^>]*)>/g)) {
      fields.push({
        tag: m[1],
        id: /\bid="([^"]+)"/.exec(m[2])?.[1] ?? null,
        classes: (/\bclass="([^"]+)"/.exec(m[2])?.[1] ?? '').split(/\s+/).filter(Boolean),
      });
    }
    for (const m of source.matchAll(/(input|textarea|select)\.className\s*=\s*['"]([^'"]+)/g)) {
      fields.push({ tag: m[1], id: null, classes: m[2].split(/\s+/).filter(Boolean) });
    }

    // ② font-size を与えている CSS ルールを、どの入力欄に効くかで振り分ける
    const rules: { last: string; px: number; sel: string }[] = [];
    for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const size = /font-size:\s*([\d.]+)(rem|px|em)/.exec(m[2]);
      if (!size) continue;
      const px = size[2] === 'px' ? Number(size[1]) : Number(size[1]) * 16;
      for (const sel of m[1].split(',')) {
        // 末尾の単純セレクタだけがその要素自身を指す（`.share-panel select` なら select）
        const last = sel.trim().split(/[\s>+~]+/).filter(Boolean).pop()?.replace(/:{1,2}[\w-]+(\([^)]*\))?/g, '');
        if (last) rules.push({ last, px, sel: sel.trim() });
      }
    }

    for (const field of fields) {
      scanned += 1;
      const hits = rules.filter((r) =>
        r.last === field.tag ||
        (field.id !== null && r.last === `#${field.id}`) ||
        field.classes.some((c) => r.last === `.${c}`));
      const name = field.id ? `#${field.id}` : field.classes.length ? `.${field.classes.join('.')}` : `<${field.tag}>`;
      assert.ok(hits.length > 0,
        `${label} の ${name} は font-size を自分で明示する（継承任せだと親の縮小に引きずられ、iOS Safari が拡大する）`);
      for (const hit of hits) {
        assert.ok(hit.px >= 16,
          `${label} の ${name} に効く \`${hit.sel}\` が ${hit.px}px（16px 未満。iOS Safari が入力欄フォーカス時にページごと拡大する）`);
      }
    }
    assert.ok(INPUT_TAGS.length === 3);
  }
  assert.ok(scanned >= 7, `入力欄を ${scanned} 件しか走査していない（検査が対象を読めていない疑い）`);
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

test('serves only the link preview image without a signature', () => {
  const stack = readFileSync(path.join(root, 'infra', 'lib', 'html-share-stack.ts'), 'utf8');
  const behavior = stack.match(/'og\/\*': \{[\s\S]*?\n {8}\}/)?.[0];
  assert.ok(behavior, 'og/* の配信ルールがありません');
  // 署名なしで開けるのは og/* だけ。ページ本体（既定の配信）は署名付きのまま。
  assert.doesNotMatch(behavior, /trustedKeyGroups/);
  assert.match(stack, /defaultBehavior: \{[\s\S]*?trustedKeyGroups: \[keyGroup\][\s\S]*?additionalBehaviors/);
});
