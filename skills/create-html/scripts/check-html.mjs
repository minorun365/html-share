#!/usr/bin/env node
// Static checks for pages built with the create-html skill.
//   node skills/create-html/scripts/check-html.mjs <file.html> [...]
// Prints NG lines for defects and WARN lines for things to review. Exits 1 when any NG is found.
// Each check targets a failure that renders silently: the page still opens, but text vanishes,
// a band disappears, an image breaks, or everything below a point loses its container.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Heading text of the closest <h2> before `index`, so a warning names the section it belongs to.
function sectionAt(body, index) {
  const heads = [...body.slice(0, index).matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)];
  const title = heads.at(-1)?.[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return title ? title.slice(0, 40) : 'top of page';
}

// Item count of every list, counting only its own <li> and not those of nested lists.
function listSizes(body) {
  const stack = [];
  const sizes = [];
  for (const m of body.matchAll(/<(\/?)(ul|ol|li)\b[^>]*>/gi)) {
    const [closing, tag] = [m[1] === '/', m[2].toLowerCase()];
    if (tag === 'li') {
      if (!closing && stack.length) stack.at(-1).items += 1;
    } else if (!closing) {
      stack.push({ index: m.index, items: 0 });
    } else if (stack.length) {
      sizes.push(stack.pop());
    }
  }
  return sizes;
}

// Relative image paths that do not exist next to the file. A wrong digit in a generated file name
// (page-9.png against page-09.png) passes every other check and shows up only as a broken image.
export function missingImages(source, baseDir) {
  return [...source.matchAll(/<img\b[^>]*?\ssrc=["']([^"']+)["']/gi)]
    .map((m) => m[1].trim())
    .filter((src) => src && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(src))
    .filter((src) => {
      const file = src.split(/[?#]/)[0];
      let decoded = file;
      try { decoded = decodeURI(file); } catch { /* keep the raw path */ }
      return !existsSync(path.join(baseDir, decoded));
    });
}

export function checkHtml(source, { baseDir } = {}) {
  const ng = [];
  const warn = [];
  const css = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const body = (source.split(/<body\b[^>]*>/i)[1] ?? '').split(/<\/body>/i)[0];
  const text = body.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), decl: m[2] }));
  const has = (re) => re.test(source);

  // Document skeleton. A fragment without meta charset is decoded as Latin-1 once it is served.
  if (!/^\s*<!doctype html>/i.test(source)) ng.push('missing <!doctype html>');
  if (!/<html\b[^>]*\blang=/i.test(source)) ng.push('<html> has no lang attribute');
  if (!/<meta\s+charset=["']?utf-8/i.test(source)) ng.push('missing <meta charset="utf-8">');
  if (!/name=["']viewport["']/i.test(source)) ng.push('missing viewport meta');
  if (!/name=["']robots["'][^>]*noindex/i.test(source)) ng.push('missing robots noindex meta');
  if (/\{\{[A-Z0-9_]+\}\}/.test(source)) ng.push('unresolved {{PLACEHOLDER}}');

  // Stylesheet structure. Copying CSS together with its <style> tags closes the sheet early.
  const opens = (source.match(/<style\b/gi) ?? []).length;
  const closes = (source.match(/<\/style>/gi) ?? []).length;
  if (opens !== closes) ng.push(`<style> open/close mismatch (${opens}/${closes})`);
  if (/<style\b[^>]*>(?:(?!<\/style>)[\s\S])*<style\b/i.test(source)) ng.push('<style> nested inside <style>');

  // Markdown habits leaking into HTML: the asterisks render as-is.
  if (/\*\*[^*\s][^*]*\*\*/.test(text)) ng.push('Markdown **bold** in page text; use <b>');

  // Hero: inherited white loses to any later bare `p{color:...}`, so paint every descendant.
  if (has(/class=["'][^"']*\bhero\b/) && !/\.hero\s*,\s*\.hero\s*\*\s*\{[^}]*color\s*:\s*#fff/i.test(css)) {
    ng.push('hero text is not forced white with `.hero, .hero * { color: #fff }`');
  }
  const hero = rules.find((r) => /^\.hero$/.test(r.sel));
  const heroPad = hero?.decl.match(/padding(?:-top)?\s*:\s*([^;]+)/)?.[1] ?? '';
  if (hero && heroPad) {
    const px = Number(heroPad.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 0);
    if (!heroPad.includes('safe-area-inset-top') || px < 64) {
      ng.push('hero top padding must be calc(64px + env(safe-area-inset-top, 0px)) or more; the floating page tools cover 52px');
    }
  }

  // Tables: without an explicit <thead> the browser builds only <tbody> and the header band vanishes.
  if (has(/<table\b/i) && has(/<th\b/i) && !has(/<thead\b/i)) ng.push('<table> uses <th> without an explicit <thead>');
  if (rules.some((r) => /(^|[\s,>])th\b/.test(r.sel) && /gradient|--[\w-]*grad\b/.test(r.decl))) ng.push('gradient on th restarts per cell; put it on thead');
  if (rules.some((r) => /(^|[\s,>])table\b/.test(r.sel) && /min-width\s*:\s*[1-9]/.test(r.decl))) ng.push('table has min-width; it forces horizontal overflow on phones');
  if (has(/class=["'][^"']*\bcard\b/) && has(/<table\b/i) && !/\.card\s+thead\s*\{[^}]*background-image\s*:\s*none/i.test(css)) {
    ng.push('tables inside cards need `.card thead { background-image: none }` so bands do not nest');
  }

  // Code blocks: `.wrap code` (0,1,1) beats a bare `pre code` (0,0,2) and paints white text on a pale background.
  if (rules.some((r) => /^(pre|code|pre\s+code)$/.test(r.sel)) && has(/class=["'][^"']*\bwrap\b/)) {
    ng.push('bare pre/code rule next to .wrap; scope it as `.wrap pre` / `.wrap pre code` with explicit color');
  }

  // A decorated quote box: tinted background + thick left rule + rounded corners + padding in one rule.
  for (const r of rules) {
    const d = r.decl;
    if (/background(-color)?\s*:\s*(?!transparent|none)/.test(d) && /border-left\s*:\s*([3-9]|\d\d)px/.test(d)
      && /border-radius/.test(d) && /padding/.test(d)) {
      ng.push(`decorated quote box in \`${r.sel}\`; use either a light surface or a thin rule, not both`);
    }
  }

  // An accent edge: one side of a card or box drawn as a thick colored rule (a top or left stripe).
  // It reads as a stock AI-generated layout. Headings (the default h3 rule) are exempt.
  for (const r of rules) {
    const d = r.decl;
    if (/border-(top|left|right|bottom)(-width)?\s*:\s*([3-9]|\d\d)px/.test(d)
      && /border-radius|padding|background/.test(d) && !/(^|[\s,>+~])h[1-6]\b/.test(r.sel)) {
      ng.push(`accent edge on \`${r.sel}\`; build cards from a white surface, radius and shadow, and mark state with a small dot or label`);
    }
  }

  // Unbalanced <div>: an extra close ends .wrap early and every later section runs full width.
  const divDelta = (body.match(/<div\b/gi) ?? []).length - (body.match(/<\/div>/gi) ?? []).length;
  if (divDelta) ng.push(`<div> open/close delta ${divDelta > 0 ? '+' : ''}${divDelta}`);

  // Stray characters from another script. They look like the intended glyphs and pass proofreading.
  if (/<html\b[^>]*\blang=["']ja/i.test(source)) {
    const stray = [...new Set(text.match(/[Ѐ-ӿᄀ-ᇿ㄰-㆏가-힯]/g) ?? [])];
    if (stray.length) ng.push(`unexpected Hangul/Cyrillic characters in Japanese text: ${stray.join(' ')}`);
  }

  // SVG shapes outside the viewBox are clipped and disappear without an error.
  let fig = 0;
  for (const m of source.matchAll(/<svg\b[^>]*viewBox=["']\s*0\s+0\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)["'][^>]*>([\s\S]*?)<\/svg>/gi)) {
    fig += 1;
    const [w, h] = [Number(m[1]), Number(m[2])];
    const over = [];
    for (const r of m[3].matchAll(/<rect\b[^>]*?\bx=["'](-?[\d.]+)["'][^>]*?\by=["'](-?[\d.]+)["'][^>]*?\bwidth=["']([\d.]+)["'][^>]*?\bheight=["']([\d.]+)["']/gi)) {
      const [x, y, rw, rh] = r.slice(1).map(Number);
      if (x < 0 || y < 0 || x + rw > w || y + rh > h) over.push(`rect(${x},${y},${rw},${rh})`);
    }
    for (const t of m[3].matchAll(/<text\b[^>]*?\bx=["'](-?[\d.]+)["'][^>]*?\by=["'](-?[\d.]+)["']/gi)) {
      const [x, y] = t.slice(1).map(Number);
      if (x < 0 || y < 0 || x > w || y > h) over.push(`text(${x},${y})`);
    }
    if (over.length) ng.push(`svg #${fig} (viewBox ${w}x${h}) has shapes outside: ${over.slice(0, 5).join(' ')}`);
  }

  // Images: checked only when the caller knows where the file lives.
  if (baseDir) {
    for (const src of missingImages(source, baseDir)) ng.push(`image not found: ${src}`);
  }

  // A page made only of text and tables is hard to take in, so no figure is a defect.
  // Pages that truly need none (a reproduced message, for example) opt out explicitly.
  const optOut = /<meta\s+name=["']brief-figures["']\s+content=["']none["']/i.test(source);
  if (!optOut && !has(/<svg\b/i) && !has(/<img\b/i)) ng.push('no figure on the page; draw the comparisons, flows, breakdowns, or structure (pages that need none: <meta name="brief-figures" content="none">)');

  // Review items, not defects.
  // A handful of figures with the rest in text cards still reads as text-heavy, so name the sections without one.
  const sections = body.split(/<section\b/i).slice(1);
  const bare = sections
    .filter((sec) => !/<svg\b|<img\b/i.test(sec))
    .map((sec, i) => (sec.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1] ?? `section ${i + 1}`).replace(/<[^>]+>/g, '').trim().slice(0, 30));
  if (!optOut && sections.length >= 3 && bare.length * 2 >= sections.length) {
    warn.push(`${bare.length} of ${sections.length} sections have no figure (${bare.join(', ')}); redraw their cards or lists as a flow, contrast, or breakdown`);
  }
  // The opposite imbalance: a section with figures but almost no prose leaves the reader to guess what each figure means.
  const thin = sections
    .filter((sec) => /<svg\b|<img\b/i.test(sec))
    .filter((sec) => sec
      .replace(/<(svg|figure|h2|h3)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, '').length < 150)
    .map((sec, i) => (sec.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1] ?? `section ${i + 1}`).replace(/<[^>]+>/g, '').trim().slice(0, 30));
  if (thin.length) warn.push(`sections with figures but under 150 characters of prose (${thin.join(', ')}); add a two-to-four-sentence paragraph saying what each figure shows and what follows from it`);
  // The upper bound: two or more paragraphs after one figure turn the page back into a wall of text.
  const heavy = [...body.matchAll(/<\/figure>((?:\s*(?:<!--[\s\S]*?-->\s*)*<p\b(?![^>]*class="(?:note|lead)")[^>]*>[\s\S]*?<\/p>)+)/gi)]
    .filter((m) => (m[1].match(/<p\b/gi) ?? []).length >= 2)
    .map((m) => sectionAt(body, m.index));
  if (heavy.length) warn.push(`two or more paragraphs follow a figure (${heavy.join(', ')}); keep one paragraph of two or three sentences per figure`);
  const tables = (source.match(/<table\b/gi) ?? []).length;
  if (tables > 5) warn.push(`${tables} tables; more than five usually means the structure, not the content, is heavy`);
  // Busy sections: a long table or list usually means rows were appended after each round of feedback.
  for (const m of body.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    const rows = (m[0].replace(/<thead\b[\s\S]*?<\/thead>/gi, '').match(/<tr\b/gi) ?? []).length;
    if (rows >= 10) warn.push(`"${sectionAt(body, m.index)}" has a ${rows}-row table; regroup it into category boxes of up to three items, or a figure`);
  }
  for (const list of listSizes(body)) {
    if (list.items >= 8) warn.push(`"${sectionAt(body, list.index)}" has a list of ${list.items} items; split it into category boxes, or draw a sequence as a figure`);
  }
  // List items that open with a bold label and a colon read as a filled-in template.
  const labelled = body.match(/<li\b[^>]*>\s*<(b|strong)\b[^>]*>[^<]{1,30}[：:]\s*<\/\1>/gi) ?? [];
  if (labelled.length) warn.push(`${labelled.length} list item(s) start with a bold label and a colon; rewrite each as one plain sentence at the same level of detail`);
  const kb = Buffer.byteLength(source) / 1024;
  if (kb > 1024) warn.push(`page is ${Math.round(kb)} KB; embedded images above about 1 MB slow every later check`);

  return { ng, warn };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: check-html.mjs <file.html> [...]');
    process.exit(2);
  }
  let failed = false;
  for (const file of files) {
    const { ng, warn } = checkHtml(readFileSync(file, 'utf8'), { baseDir: path.dirname(path.resolve(file)) });
    for (const line of ng) console.log(`NG   ${file}: ${line}`);
    for (const line of warn) console.log(`WARN ${file}: ${line}`);
    if (!ng.length) console.log(`OK   ${file}`);
    failed ||= ng.length > 0;
  }
  process.exit(failed ? 1 : 0);
}
