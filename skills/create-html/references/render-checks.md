# Render checks

The static checker cannot tell which of two CSS rules wins or whether a shape overlaps another. Run these in the browser when a page uses something the template does not have: a calendar, a new grid, a table or code inside the hero, or after someone reports a display problem. Serve the file over a local HTTP server (`python3 -m http.server`), run the snippets in the page, and then look at one screenshot yourself.

## Contrast across the whole page

`lowContrast` must be 0. Text on a gradient is skipped because white is correct there.

```javascript
(() => {
  const lum = (c) => { const m = (c.match(/[\d.]+/g) || [0, 0, 0]).map(Number); return 0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]; };
  const alpha = (c) => { const m = c.match(/[\d.]+/g) || []; return m.length > 3 ? Number(m[3]) : 1; };
  const effectiveBg = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage.includes('gradient')) return null;
      if (alpha(cs.backgroundColor) > 0.05) return lum(cs.backgroundColor);
    }
    return 255;
  };
  const bad = [];
  document.querySelectorAll('.wrap *, .hero *').forEach((el) => {
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) return;
    const bg = effectiveBg(el);
    if (bg === null) return;
    if (Math.abs(lum(getComputedStyle(el).color) - bg) < 60) bad.push({ tag: el.tagName, cls: el.className, text: el.textContent.trim().slice(0, 40) });
  });
  return { lowContrast: bad.length, bad };
})();
```

## Nested gradient bands

`nested` must be an empty array.

```javascript
const g = [...document.querySelectorAll('*')].filter((e) => getComputedStyle(e).backgroundImage.includes('gradient'));
const nested = g.filter((e) => g.some((o) => o !== e && o.contains(e)));
nested.map((e) => `${e.tagName.toLowerCase()}.${e.className}`);
```

## Horizontal overflow at phone width

The root must not scroll sideways, and the content should read with vertical scrolling alone. Measure inside a 390 × 844 iframe of the same page:

```javascript
const f = document.createElement('iframe');
f.style.cssText = 'position:fixed;left:0;top:0;width:390px;height:844px;z-index:99999;border:0';
f.src = location.href;
document.body.appendChild(f);
await new Promise((r) => (f.onload = r));
const de = f.contentDocument.documentElement;
({ width: de.clientWidth, scrollWidth: de.scrollWidth, ok: de.scrollWidth <= de.clientWidth + 1 });
```

If it overflows, find the element whose `getBoundingClientRect().right` exceeds the viewport and fix the cause: `nowrap`, fixed widths, too many fixed grid columns, or a missing `min-width: 0` on a flex or grid child. Do not hide the overflow with `overflow-x: hidden` on `html` or `body`.

## Labels in SVG figures

`issues` must be an empty array. It lists labels that overlap each other, leave the `viewBox`, or stick out of the smallest box around them. Run the next snippet as well for labels that sit on lines or dark fills. Branches that stick out without touching a label are not detected, so look at each figure in a screenshot at desktop width and at 390 px as well.

```javascript
(() => {
  const issues = [];
  document.querySelectorAll('svg').forEach((svg, i) => {
    const vb = svg.viewBox.baseVal;
    const labels = [...svg.querySelectorAll('text')].map((t) => ({ text: t.textContent.trim().slice(0, 24), b: t.getBBox() }));
    const boxes = [...svg.querySelectorAll('rect')].map((r) => r.getBBox());
    labels.forEach(({ text, b }) => {
      if (vb && vb.width && (b.x < vb.x || b.y < vb.y || b.x + b.width > vb.x + vb.width || b.y + b.height > vb.y + vb.height)) {
        issues.push(`figure ${i + 1}: outside the viewBox "${text}"`);
      }
      const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
      const around = boxes.filter((r) => cx > r.x && cx < r.x + r.width && cy > r.y && cy < r.y + r.height);
      if (around.length) {
        const r = around.reduce((m, x) => (x.width * x.height < m.width * m.height ? x : m));
        if (b.x < r.x - 1 || b.x + b.width > r.x + r.width + 1) issues.push(`figure ${i + 1}: sticks out of its box "${text}"`);
      }
    });
    for (let a = 0; a < labels.length; a += 1) {
      for (let c = a + 1; c < labels.length; c += 1) {
        const A = labels[a].b, B = labels[c].b;
        if (A.x < B.x + B.width - 1 && B.x < A.x + A.width - 1 && A.y < B.y + B.height - 1 && B.y < A.y + A.height - 1) {
          issues.push(`figure ${i + 1}: "${labels[a].text}" overlaps "${labels[c].text}"`);
        }
      }
    }
  });
  return issues;
})();
```

`getBBox()` ignores `transform`. If a figure positions groups with `transform`, compare `getBoundingClientRect()` instead.

Typical causes of the issues these checks find, and fixes:

- A band meant to be pale is drawn with the dark gradient. When the code that picks a fill tests for the gradient before the pale variant, passing the pale flag still yields the dark band and dark text sinks into it. Test for the pale variant first.
- A long label in a narrow band. Merge the band with its neighbor or shorten the label; do not let the text run outside the band.
- Timeline headings with leader lines. Centered headings on alternating rows get crossed by the neighboring line. Put each heading to the right of its own line and assign rows from the rightmost entry, each taking the lowest free row, so headings on the left move up and lines never cross them. Leave room to the right of the last entry, and when no row is free, stop generating the figure instead of letting labels overlap.

## Labels on dark lines and dark fills

`issues` must be an empty array. It samples points inside each label and finds the topmost shape drawn before it at each point. Only dark shapes count (relative luminance below 0.5), so light grid lines and pale cards do not trigger it. A label on a dark stroke is reported. A label on a dark fill is reported only when the text is darker than the fill and the contrast ratio is below 4.5, so white text on a dark shape passes. Text with a white halo (`paint-order: stroke` and a stroke of 2 or more) may sit on a line and is skipped. Semi-transparent paint is evaluated as if composited on white; gradients are checked stop by stop.

```javascript
(() => {
  const issues = [];
  const rgb = (c) => { const m = c && c.match(/^rgba?\(([^)]+)\)/); if (!m) return null; const v = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const dark = (c) => lum(c) < 0.5;
  const onWhite = (c, a) => ({ r: c.r * a + 255 * (1 - a), g: c.g * a + 255 * (1 - a), b: c.b * a + 255 * (1 - a) });
  document.querySelectorAll('svg').forEach((svg, i) => {
    const opacity = (el) => { let o = 1; for (let e = el; e && e !== svg.parentNode; e = e.parentNode) o *= +getComputedStyle(e).opacity; return o; };
    const hidden = (el) => { for (let e = el; e && e !== svg.parentNode; e = e.parentNode) { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return true; } return false; };
    const paint = (el, prop) => {
      const cs = getComputedStyle(el), v = cs[prop];
      if (!v || v === 'none') return null;
      const a = opacity(el) * +cs[prop + 'Opacity'];
      if (a < 0.05) return null;
      const u = v.match(/url\(["']?#([^"')]+)/);
      if (u) {
        const g = document.getElementById(u[1]);
        if (!g) return null;
        const cols = [...g.querySelectorAll('stop')].map((st) => { const c = rgb(getComputedStyle(st).stopColor); return c && onWhite(c, a * c.a * +getComputedStyle(st).stopOpacity); }).filter(Boolean);
        return cols.length ? cols : null;
      }
      const c = rgb(v);
      return c && c.a > 0 ? [onWhite(c, a * c.a)] : null;
    };
    const shapes = [...svg.querySelectorAll('rect,circle,ellipse,line,polyline,polygon,path')]
      .filter((e) => !e.closest('defs,marker,clipPath,mask,pattern,symbol') && e.getScreenCTM() && !hidden(e))
      .map((e) => ({ e, st: paint(e, 'stroke'), fi: paint(e, 'fill'), sw: parseFloat(getComputedStyle(e).strokeWidth) || 0, m: e.getScreenCTM().inverse(), bb: e.getBoundingClientRect() }))
      .filter((x) => x.st || x.fi);
    const runs = [...svg.querySelectorAll('text,tspan')].filter((e) => e.closest('svg') === svg && !hidden(e) && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
    runs.forEach((run) => {
      const cs = getComputedStyle(run), tc = paint(run, 'fill');
      if (!tc) return;
      const halo = cs.stroke !== 'none' && parseFloat(cs.strokeWidth) >= 2 && cs.paintOrder.startsWith('stroke');
      const R = run.getBoundingClientRect();
      if (R.width < 2 || R.height < 2) return;
      // The box includes line spacing; trim 20% top and bottom to stay on the glyphs.
      const x0 = R.left + 1, x1 = R.right - 1, y0 = R.top + R.height * 0.2, y1 = R.bottom - R.height * 0.2;
      const cand = shapes.filter((x) => { const pad = x.sw * 2; return (run.compareDocumentPosition(x.e) & Node.DOCUMENT_POSITION_PRECEDING) && !x.e.contains(run) && x.bb.left - pad < x1 && x.bb.right + pad > x0 && x.bb.top - pad < y1 && x.bb.bottom + pad > y0; }).reverse();
      if (!cand.length) return;
      const hits = new Map();
      for (let y = y0; y <= y1 + 0.01; y += (y1 - y0) / 4) {
        for (let x = x0; x <= x1; x += 2) {
          for (const c of cand) {
            const pt = new DOMPoint(x, y).matrixTransform(c.m);
            const k = c.st && c.e.isPointInStroke(pt) ? 'line' : c.fi && c.e.isPointInFill(pt) ? 'fill' : null;
            if (!k) continue;
            const key = cand.indexOf(c) + k;
            hits.set(key, { c, k, n: (hits.get(key)?.n || 0) + 1 });
            break;
          }
        }
      }
      const label = (run.tagName === 'tspan' ? run.closest('text') : run).textContent.trim().slice(0, 24);
      hits.forEach(({ c, k, n }) => {
        if (n < 2) return;
        if (k === 'line') {
          if (!halo && c.st.some(dark)) issues.push(`figure ${i + 1}: "${label}" sits on a dark ${c.e.tagName}`);
        } else {
          const f = c.fi.find((f) => dark(f) && lum(tc[0]) <= lum(f) && ratio(f, tc[0]) < 4.5);
          if (f) issues.push(`figure ${i + 1}: dark text "${label}" on a dark fill (contrast ${ratio(f, tc[0]).toFixed(1)})`);
        }
      });
    });
  });
  return [...new Set(issues)];
})();
```

## Calendar

- Leading blank cells match the first weekday of the month, and dates run from 1 to the last day.
- Chips stay inside their day cell:

```javascript
[...document.querySelectorAll('.cal-grid .chip')].filter((c) => {
  const p = c.parentElement.getBoundingClientRect(), r = c.getBoundingClientRect();
  return r.right > p.right + 1 || r.bottom > p.bottom + 1;
}).map((c) => c.textContent.slice(0, 16)); // must be []
```

- The number of weekend and holiday cells matches what the generator counted. A holiday color showing up on a weekday means a rule is hitting some other element.
- On a time-axis calendar, compute the expected `top` and `height` of one block from its `--s` and `--e` values and compare them with the measured box.

## Checking transitions in a background tab

Background tabs do not advance CSS transitions, so `getComputedStyle` returns the starting value. Set `style.transition = 'none'` on the element before reading the final value.

## Spacing inside cards and cells

Whenever you place an element inside a frame (an illustration in a card, a badge in a table cell), print the gaps as numbers before you look at a screenshot. A screenshot alone lets a card with a tight top and a loose bottom pass as "it fits".

- Measure in the real renderer. For content another service renders (a repository README, a post on a publishing site), open the live page in headless Chrome, swap in your converted HTML, and measure there. A stylesheet you wrote to imitate it gets heading margins and cell padding wrong.
- Per frame, print six numbers on one line: top, bottom, left, right, the offset between the tops of elements that sit side by side, and the narrowest gap between the element and the text. Use `getBoundingClientRect()` for boxes and `Range.getClientRects()` for text.
- Pass when top and bottom match within 4px, side-by-side tops line up, and the element stays at least 14px from the text. An element in a corner keeps the same distance from both edges of that corner.
- Cells in one row share a height, so the cell with less text gets extra space at the bottom. If that exceeds one line, pair up items with similar amounts of text.
- A margin the renderer fixes cannot be changed, so match the opposite side to it.
- Trim images to their visible pixels before placing them on a shared canvas. Transparent borders differ per image and make the distance from the frame uneven.
- After adding an element that narrows the text, check that no paragraph or title ends with one or two characters alone on the last line.
- Keep the measurement as a script next to the deliverable and show the page only when it reports zero failures.
