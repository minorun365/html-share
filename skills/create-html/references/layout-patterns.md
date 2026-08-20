# Layout patterns

Choose the smallest pattern that explains the material. A page may combine two or three patterns, but every section must earn its space.

## Narrative brief

Use for reports, recommendations, and meeting summaries.

1. Hero: title, one-sentence purpose, date or scope.
2. Executive summary: three to five sentences.
3. Main sections: one claim per section with evidence directly below it.
4. Closing: decision, conclusion, or next action only when the source material calls for it.

## Comparison

Use a table when the same fields repeat across three or more options. Put evaluation criteria in the first column and options across the remaining columns. Highlight one recommendation only when the source supports it.

Wrap every table in `.table-wrap` so it scrolls inside its own container. On phones the delivered page folds a table with few columns into stacked cards automatically, so do not hand-write a second mobile-only markup for the same data.

## Timeline or workflow

Use an ordered vertical timeline for events, phases, or dependent steps. Each entry should contain a short label, a date or state when available, and no more than one compact paragraph.

## Paired question and answer

Use a two-column pair when the page distinguishes source material from commentary, a problem from a response, or a request from a decision. On mobile, stack each pair while preserving its left-to-right reading order.

## Monthly calendar

Render one month per full-width block and put each entry inside its own day cell. Use this class contract, because the delivered page folds the grid into a dated vertical list on phones and keys off these names:

- `.cal-grid` on the seven-column grid, starting on Monday
- `.dow` on the weekday header cells
- `.day` on every date cell, plus `.pad` for leading and trailing blanks and `.has` for a day that holds an entry
- `.dn` for the date number, with a nested `<i>` for the weekday letter
- `.chip` for each entry inside a day

Scope every calendar rule under `.cal-grid`; a bare `.day` or `.dn` selector collides with ordinary tables elsewhere on the page.

## Before and after

When the page shows a revision, place the previous version on the left and the new one on the right so the reader compares at the same eye level. Stack them only below roughly 46 rem, and highlight the changed passage rather than the whole block.

## Key figures

Use metric cards only when the numbers are independently meaningful. Keep the number large, the label short, and the explanation to one line. Do not turn ordinary prose into artificial metrics.

## Content rules

- Preserve source attribution and distinguish observed content from inference.
- Keep headings concrete; avoid generic labels such as “Overview” when a more specific claim is available.
- Remove empty-state filler, decorative status badges, redundant navigation, and “next steps” the user did not request.
- When information is dense, use a short lead followed by a table or list. Do not solve density by shrinking text.
