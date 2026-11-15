#!/usr/bin/env node
// Write a starter page with the v2 stylesheet (assets/brief.css) inlined.
//   node skills/create-html/scripts/new-page.mjs <out.html> --title "Title" [--theme light] [--force]
// The page is complete and passes check-html.mjs; replace the sample body with the real content.
// An existing file is overwritten only with --force.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BRIEF_THEME = 'light';

export function briefCss() {
  return readFileSync(path.join(here, '..', 'assets', 'brief.css'), 'utf8');
}

/** Theme names defined in brief.css, from its :root[data-brief="..."] blocks. */
export function briefThemes(css = briefCss()) {
  return [...new Set([...css.matchAll(/:root\[data-brief="([a-z0-9-]+)"\]\s*\{/g)].map((m) => m[1]))];
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Definitions the figure parts point at (the .s-deep gradient and the tile shadow). One line, so it adds no text to the page. */
export const BRIEF_DEFS = '<svg class="brief-defs" aria-hidden="true" focusable="false"><defs>'
  + '<linearGradient id="brief-deep" x1="0" y1="0" x2="1" y2="0"><stop offset="0" style="stop-color:var(--fig-deep-a)"/><stop offset=".5" style="stop-color:var(--fig-deep-b)"/><stop offset="1" style="stop-color:var(--fig-deep-c)"/></linearGradient>'
  + '<filter id="brief-sh" x="-10%" y="-25%" width="120%" height="160%"><feDropShadow dx="0" dy="4" stdDeviation="5" style="flood-color:var(--fig-shadow)" flood-opacity=".2"/></filter>'
  + '</defs></svg>';

/** The starter page. The body is a sample to replace: context, contents, one section with cards, a figure and a table. */
export function briefSkeleton({ title, theme = DEFAULT_BRIEF_THEME }) {
  const css = briefCss();
  if (!briefThemes(css).includes(theme)) throw new Error(`unknown theme: ${theme} (available: ${briefThemes(css).join(', ')})`);
  const t = esc(title);
  return `<!doctype html>
<html lang="ja" data-brief="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>${t}</title>
<style>
${css.trim()}
</style>
</head>
<body>
${BRIEF_DEFS}
<div class="hero">
  <div class="hero-in">
    <span class="kicker">案件名 ／ ページの種類</span>
    <h1>${t}</h1>
    <p class="sub">このページの結論を一文で書く。</p>
    <div class="meta">作成：YYYY-MM-DD（曜）</div>
  </div>
</div>

<div class="wrap">
  <div class="callout blue">
    <p><b>このページの経緯</b></p>
    <p>いつ何を頼まれ、なぜこの形にしたかを書く。結論と次にすることもここに置く。</p>
  </div>

  <nav class="toc">
    <h2>目次</h2>
    <ol>
      <li><a href="#s1"><span class="num">01</span>節の名前</a></li>
    </ol>
  </nav>

  <section id="s1">
    <span class="eyebrow">01</span>
    <h2>節の見出し</h2>
    <p class="lead">この節で言いたいことを一文で書く。</p>
    <div class="grid">
      <div class="card"><h4>カードの題</h4><div class="card-body"><p>カードの本文を一文で書く。</p></div></div>
      <div class="card"><h4>カードの題</h4><div class="card-body"><p>カードの本文を一文で書く。</p></div></div>
    </div>
    <figure class="fig">
      <svg viewBox="0 0 640 132" role="img" aria-label="見本の流れ図">
        <rect class="s-tile" x="8" y="20" width="180" height="92" rx="12"/>
        <text class="on-light" x="98" y="72" font-size="16" font-weight="700" text-anchor="middle">脇役は白いタイル</text>
        <path class="s-arrow" d="M200,58 L214,66 L200,74 Z"/>
        <rect class="s-2" x="226" y="20" width="180" height="92" rx="12"/>
        <text class="on-light" x="316" y="72" font-size="16" font-weight="700" text-anchor="middle">段階は淡→濃</text>
        <path class="s-arrow" d="M418,58 L432,66 L418,74 Z"/>
        <rect class="s-deep" x="444" y="20" width="188" height="92" rx="12"/>
        <text class="on-deep" x="538" y="72" font-size="16" font-weight="700" text-anchor="middle">主役は濃い面</text>
      </svg>
      <figcaption>図の題</figcaption>
    </figure>
    <p><span class="sent">図が何を示し、そこから何が言えるかを二、三文で書く。</span><span class="sent">たとえば三つの段のうち、読み手に届く最後の段だけを濃く塗り、そこが結論だと一目で分かるようにする。</span><span class="sent">前の二段は淡い面と白いタイルにして、主役より目立たせない。</span></p>
    <div class="table-wrap"><table>
      <thead><tr><th>項目</th><th>内容</th></tr></thead>
      <tbody><tr><td>案A</td><td>42</td></tr><tr><td>案B</td><td>24</td></tr></tbody>
    </table></div>
  </section>

  <footer><p>出典・元資料へのリンク</p></footer>
</div>
</body>
</html>
`;
}

function main(argv) {
  const args = [...argv];
  const take = (name) => {
    const i = args.indexOf(name);
    if (i < 0) return null;
    const [, value] = args.splice(i, 2);
    return value ?? null;
  };
  const force = args.includes('--force');
  if (force) args.splice(args.indexOf('--force'), 1);
  const title = take('--title');
  const theme = take('--theme') ?? DEFAULT_BRIEF_THEME;
  const out = args[0];
  if (!out || !title) {
    console.error('usage: new-page.mjs <out.html> --title "Title" [--theme light] [--force]');
    process.exit(2);
  }
  const target = path.resolve(process.env.INIT_CWD || process.cwd(), out);
  if (existsSync(target) && !force) {
    console.error(`already exists (pass --force to overwrite): ${target}`);
    process.exit(1);
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, briefSkeleton({ title, theme }));
  console.log(`wrote ${target} (theme: ${theme})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
