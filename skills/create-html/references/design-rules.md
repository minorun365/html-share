# Design rules behind the template

The template stylesheet already follows these rules. Read this when adding components, so the additions follow them too. Most rules here prevent failures that render without any error: the page opens, but text disappears or a band vanishes.

## Where color goes

| # | Place | Treatment |
|---|---|---|
| 1 | Hero | Full-width 135° gradient, outside the content container. The strongest surface on the page |
| 2 | Section divider | Full-width hairline with a 72 px gradient bar over its left end |
| 3 | Section number | `01`, `02` as gradient text (`background-clip: text`), with a solid `color` fallback |
| 4 | Table header | One gradient on `thead` |
| 5 | Card header band | Full-width band at the top of the card, clipped by the card's rounded corners |

Everything else stays neutral: quotes, tags, card bodies, column labels. A light blue surface or a single 3 px line is the most a component gets.

- Two band colors only: the blue gradient for normal, primary, or "after" cards, and the gray gradient for the side you want to sink (before, rejected option, reference). If you need a third kind, split the section instead.
- **Bands never nest.** A component inside a card (a table, a Before/After pair) uses a white header with a bottom hairline and a small pill label. Distinguish roles with pill color, border color, and a faint shadow on the primary side, not with more filled surfaces.
- No square filled number badges, no vertical table rules, no per-section hues, no gradient on individual `th` cells (it restarts in each cell and looks striped).

## Hero

- Put the hero outside `.wrap` so it spans the viewport; align its text with an inner `.hero-in` container.
- Top padding is `calc(64px + env(safe-area-inset-top, 0px))`. On phones the delivered page overlays page tools at the top left whose lower edge sits at 52 px; less padding puts the title under them.
- The delivered page overlays two 44 px buttons, one in the top left and one in the top right (about 9 to 53 px from each side, 8 to 52 px from the top). A page that brings its own header or fixed bar instead of the hero still has to keep that strip clear: leave at least 64 px on both sides, and measure the overlap in the rendered page before publishing, because `check-html.mjs` only looks at the hero padding.
- Write `.hero, .hero * { color: #fff; }`. A parent's color is only inherited, so any later bare rule such as `p { color: ... }` wins over it. Listing tags (`.hero h1, .hero p, ...`) leaves holes the moment a new tag appears.
- Under white text in the hero, only darkening underlays are safe (`rgba(0,0,0,.35)`). A light underlay, even a translucent white one, disappears where the gradient turns bright. Best of all, keep `code` and long paths out of the hero and put them in the body or footer.
- Keep the hero to a kicker, the title, one subtitle line, and a short meta block. Do not fill it with pill-shaped chips or button-like links.

## Scoping and specificity

- Scope body styles under `.wrap` (`.wrap p`, `.wrap table`, `.wrap td`). Bare selectors also hit the hero: a zebra-striped `tbody tr:nth-child(even)` or a white card background turns hero text invisible.
- Set text color and background in the same rule, at the same specificity. `.wrap code` (0,1,1) beats a bare `pre code` (0,0,2), so a dark code block written that way ends up with a pale background and white text. Write `.wrap pre code` and state `color` explicitly.
- Style parts through child selectors (`.card > h4`, `.ba > section > h5`). A descendant selector also paints the headings of components nested inside, and a more specific variant (`.card.muted h4`) turns them into gray bands.
- Scope calendar rules under `.cal-grid` and time-axis events under their column (`.gc-col .ev`). Generic names like `.day` and `.ev` collide with tables and chips elsewhere on the page.

## Tables

- Write `<thead>` explicitly. `<table><tr><th>` makes the browser create only `<tbody>`, and a header gradient on `thead` silently disappears.
- No `min-width` on tables. It declares that the table overflows on a phone. If columns are too narrow to read, the table is too wide by design: drop columns or move long text into the body.
- `white-space: nowrap` is for short headings and numbers only.
- On phones the delivered page folds tables that overflow into stacked label-and-value cards. Tables with merged cells and numeric matrices keep their shape with a sticky first column. Add `data-mb-tables="off"` to a table that must never fold.
- For "show X for each Y" comparisons, put Y across the columns and X in the cells. Group rows under a vertically merged category cell, and merge cells with `colspan` where a value repeats across columns: merged cells read as "nothing to consider here", split cells as "look closely".

## Cards

- The card has `overflow: hidden` and no padding; the band is its first child and the text sits in `.card-body`. Padding on the card makes the band float like a label stuck inside; negative margins break as soon as padding changes.
- Put only text and a small `<span>` (a count or a date) in the band. Checkboxes, tags, and `code` in the band repeat the white-on-light failure of the hero.
- With three cards or fewer whose headings are a single word, write a list instead. Cards are for repeated parts.

## Spacing

- Sections are separated by a top hairline and padding, with at least 36 px of bottom padding. A thin bottom padding lets the next divider touch the preceding figure or card.
- Give adjacent blocks (a card grid followed by a table, a figure followed by a note) 16 to 24 px between them. Grid `gap` works only inside the grid, not between the grid and the next element.
- No accent edges. Do not draw one side of a card or box (a top or left stripe of 3px or more) in a color to mark its type or state. Build cards from a white surface, rounded corners and a soft shadow, and mark state with a small dot, a word or a pill label. Headings may keep their left rule.
- One enclosure per level. Do not nest a tinted, left-ruled, rounded quote box inside a card; separate supporting text with either a light surface or a thin rule.

## Images

- Images meant to be read (documents, pages, screenshots) go full width, stacked, one per row with a caption. Thumbnails in a grid cannot be zoomed in a page.
- Images in a two-column Before/After need about 760 px of width.
- Export each image as both reduced-palette PNG and JPEG and keep the smaller one. Keep the whole page around 1 MB by embedding fewer images, not by lowering the resolution of images people must read.
- For product comparisons, give every item an image, an official link, and a purchase link from the start. Check that an `og:image` is not a site-wide logo shared by several items.
