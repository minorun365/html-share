import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
// @ts-expect-error plain ESM script without type declarations
import { checkHtml } from '../skills/create-html/scripts/check-html.mjs';

const template = readFileSync(new URL('../skills/create-html/assets/brief-template.html', import.meta.url), 'utf8');
// Prose placeholders get sentence-length text, so the filled template is a realistic page rather than a row of labels.
const filled = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key: string) =>
  /LEAD|EXPLANATION|BODY/.test(key) ? `サンプル ${key.toLowerCase()} の説明文がここに入る。`.repeat(4) : `サンプル ${key.toLowerCase()}`);

test('the filled template passes every check', () => {
  const { ng, warn } = checkHtml(filled);
  assert.deepEqual(ng, []);
  assert.deepEqual(warn, []);
});

test('the untouched template reports its placeholders', () => {
  assert.ok(checkHtml(template).ng.some((line: string) => line.includes('PLACEHOLDER')));
});

const breakages: Array<[string, (html: string) => string, RegExp]> = [
  ['missing charset', (h) => h.replace('<meta charset="utf-8">', ''), /charset/],
  ['missing robots', (h) => h.replace(/<meta name="robots"[^>]*>/, ''), /robots/],
  ['style tags copied into the sheet', (h) => h.replace(':root {', '<style>\n:root {'), /<style>/],
  ['Markdown bold in text', (h) => h.replace('<p class="sub">', '<p class="sub">**重要**'), /Markdown/],
  ['hero relies on inheritance', (h) => h.replace('.hero, .hero * { color: #fff; }', '.hero { color: #fff; }'), /forced white/],
  ['hero hidden under the page tools', (h) => h.replace('calc(64px + env(safe-area-inset-top, 0px)) 0 46px', '40px 0 46px'), /top padding/],
  ['table without thead', (h) => h.replace(/<thead>([\s\S]*?)<\/thead>/, '$1'), /thead/],
  ['gradient on th', (h) => h.replace('.wrap th { padding', '.wrap th { background-image: var(--blue-grad); padding'), /restarts per cell/],
  ['table min-width', (h) => h.replace('.wrap table { width: 100%;', '.wrap table { width: 100%; min-width: 600px;'), /min-width/],
  ['band nested in a card', (h) => h.replace('.card thead { background-image: none; background: var(--soft); }', ''), /nest/],
  ['bare pre code', (h) => h.replace('.wrap pre code {', 'pre code {'), /bare pre\/code/],
  ['decorated quote box', (h) => h.replace('.callout { margin: 22px 0;', '.callout { border-left: 5px solid var(--gold); margin: 22px 0;'), /decorated quote/],
  ['accent edge on a card', (h) => h.replace('</style>', '.card.waiting { border-top: 3px solid var(--gold); border-radius: 12px; }</style>'), /accent edge/],
  ['extra closing div', (h) => h.replace('<footer>', '</div><footer>'), /<div> open\/close/],
  ['stray Hangul character', (h) => h.replace('<p class="sub">', '<p class="sub">설명'), /Hangul/],
  ['shape outside the viewBox', (h) => h.replace('<rect x="460" y="30" width="170"', '<rect x="560" y="30" width="170"'), /outside/],
];

for (const [name, breakIt, expected] of breakages) {
  test(`detects: ${name}`, () => {
    const { ng } = checkHtml(breakIt(filled));
    assert.ok(ng.some((line: string) => expected.test(line)), `expected ${expected} in ${JSON.stringify(ng)}`);
  });
}

test('fails when a page has no figure', () => {
  const { ng } = checkHtml(filled.replace(/<figure[\s\S]*?<\/figure>/, ''));
  assert.ok(ng.some((line: string) => line.includes('no figure')));
});

test('a page can opt out of the figure check explicitly', () => {
  const noFigure = filled.replace(/<figure[\s\S]*?<\/figure>/, '').replace('<head>', '<head><meta name="brief-figures" content="none">');
  assert.ok(!checkHtml(noFigure).ng.some((line: string) => line.includes('no figure')));
});

test('warns when half or more of the sections have no figure', () => {
  const textSection = (n: number) => `<section id="t${n}"><h2>Text only ${n}</h2><p>Plain text.</p></section>`;
  const html = filled.replace('<footer>', [1, 2, 3, 4, 5, 6].map(textSection).join('') + '<footer>');
  assert.ok(checkHtml(html).warn.some((line: string) => line.includes('have no figure')));
});

test('warns when a section has a figure but almost no prose', () => {
  const figureOnly = '<section id="f1"><h2>Figure only</h2><figure><svg viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8"/></svg></figure></section>';
  const html = filled.replace('<footer>', figureOnly + '<footer>');
  assert.ok(checkHtml(html).warn.some((line: string) => line.includes('under 150 characters of prose')));
});

test('warns when two or more paragraphs follow one figure', () => {
  const html = filled.replace(/(<p>サンプル figure_explanation[^<]*<\/p>)/, '$1\n<p>Another paragraph about the same figure.</p>');
  assert.ok(checkHtml(html).warn.some((line: string) => line.includes('two or more paragraphs follow a figure')));
});

const breads = ['Sourdough', 'Rye', 'Baguette', 'Brioche', 'Ciabatta', 'Focaccia', 'Bagel', 'Croissant', 'Pretzel', 'Challah'];
const insertInSection2 = (html: string, markup: string) => html.replace('<div class="table-wrap">', `${markup}<div class="table-wrap">`);

test('warns about a long table and names its section', () => {
  const rows = breads.map((name, i) => `<tr><td>${name}</td><td>${12 + i}</td></tr>`).join('');
  const { ng, warn } = checkHtml(filled.replace(/<tbody>[\s\S]*?<\/tbody>/, `<tbody>${rows}</tbody>`));
  assert.deepEqual(ng, []);
  assert.ok(warn.some((line: string) => /10-row table/.test(line) && line.includes('サンプル section_2_title')), JSON.stringify(warn));
});

test('warns about a long list but counts nested items separately', () => {
  const long = `<ul>${breads.slice(0, 8).map((name) => `<li>${name}</li>`).join('')}</ul>`;
  assert.ok(checkHtml(insertInSection2(filled, long)).warn.some((line: string) => /list of 8 items/.test(line)));
  const nested = `<ul><li>Breads<ul>${breads.slice(0, 5).map((name) => `<li>${name}</li>`).join('')}</ul></li><li>Cakes</li><li>Drinks</li></ul>`;
  assert.deepEqual(checkHtml(insertInSection2(filled, nested)).warn, []);
});

test('warns about list items that open with a bold label and a colon', () => {
  const labelled = '<ul><li><b>Opening hours:</b> 7:00 to 15:00 on weekdays.</li><li>Rye loaves sell out by noon on Saturdays.</li></ul>';
  assert.ok(checkHtml(insertInSection2(filled, labelled)).warn.some((line: string) => /bold label and a colon/.test(line)));
  const plain = '<ul><li><b>Rye</b> sells out by noon on Saturdays.</li></ul>';
  assert.deepEqual(checkHtml(insertInSection2(filled, plain)).warn, []);
});

test('reports relative images that do not exist next to the file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'create-html-'));
  mkdirSync(path.join(dir, 'photos'));
  writeFileSync(path.join(dir, 'photos', 'shelf 9.png'), '');
  const images = [
    '<img src="photos/shelf%209.png" alt="Bread shelf at opening">',
    '<img src="photos/shelf-09.png" alt="Bread shelf at closing">',
    '<img src="https://example.com/oven.png" alt="Oven">',
    '<img src="data:image/png;base64,AAAA" alt="Dot">',
  ].join('');
  const html = insertInSection2(filled, images);
  const { ng } = checkHtml(html, { baseDir: dir });
  assert.deepEqual(ng, ['image not found: photos/shelf-09.png']);
  assert.deepEqual(checkHtml(html).ng, [], 'image paths are checked only when the file location is known');
});
