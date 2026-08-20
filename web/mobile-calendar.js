(() => {
  // スマホ幅のときだけ働く。PCでは1行も触らない。
  const narrow = matchMedia('(max-width: 46rem)');

  // 月別カレンダー（.cal-grid）を、予定のある日だけの縦リストへ畳む。
  //
  // 畳み込み自体は各ページのCSSが `@media (max-width:760px)` で持っていることが多い。
  // 同じことを配信側からも掛けるのは、ページ側のセレクタが効かなくても
  // スマホの見た目が壊れないようにするため。CSSは存在しないセレクタを書いても
  // エラーを出さず黙って無視するので、ページ単位のCSSだけに頼ると
  // 「publishするまで気づけない崩れ」が繰り返し起きる。
  //
  // 正しく書けているページに二重に掛かっても、結論は同じ縦リストなので衝突しない。
  const styleText = `
    /* 7列を捨てて縦1列へ。390px ÷ 7 = 55px では予定名が入らない */
    .cal-grid[data-mb-cal="list"] {
      display: flex !important;
      flex-direction: column !important;
      gap: .5rem !important;
    }
    /* 曜日ヘッダ・月初の空きマス・予定のない日は、縦リストでは意味を持たない */
    .cal-grid[data-mb-cal="list"] > .dow,
    .cal-grid[data-mb-cal="list"] > .day.pad,
    .cal-grid[data-mb-cal="list"] > .day:not(.has) {
      display: none !important;
    }
    /* 日付を左、予定を右に置く1行。.day.has の min-height:96px を明示的に打ち消す */
    .cal-grid[data-mb-cal="list"] > .day.has {
      display: flex !important;
      flex-direction: row !important;
      flex-wrap: wrap !important;
      align-items: flex-start !important;
      min-height: 0 !important;
      gap: .625rem !important;
      padding: .625rem .75rem !important;
    }
    .cal-grid[data-mb-cal="list"] > .day.has .dn {
      font-size: .8125rem !important;
      flex: none !important;
      min-width: 2.75rem !important;
    }
    /* 曜日は7列表示では列の位置で分かるが、縦リストでは日付に添えないと分からない */
    .cal-grid[data-mb-cal="list"] > .day.has .dn i {
      display: inline !important;
      font-style: normal !important;
      font-size: .6875rem !important;
      margin-left: .1875rem !important;
      opacity: .75 !important;
    }
    .cal-grid[data-mb-cal="list"] > .day.has .chip {
      flex: 1 1 11.875rem !important;
      font-size: .75rem !important;
      padding: .4375rem .5625rem .5rem !important;
    }
    /* 2枚目以降を日付幅ぶん字下げして、予定の左端をそろえる */
    .cal-grid[data-mb-cal="list"] > .day.has .chip ~ .chip {
      margin-left: 3.375rem !important;
    }
  `;

  let styleEl = null;
  function ensureStyle() {
    if (styleEl) return;
    styleEl = document.createElement('style');
    styleEl.textContent = styleText;
    document.head.append(styleEl);
  }

  function setup() {
    const grids = document.querySelectorAll('.cal-grid');
    if (grids.length === 0) return;
    ensureStyle();
    for (const grid of grids) grid.dataset.mbCal = 'list';
  }

  // 横向きにすると 844px になり、狭幅の前提が外れる。素のページへ戻す
  function teardown() {
    for (const grid of document.querySelectorAll('.cal-grid[data-mb-cal]')) {
      delete grid.dataset.mbCal;
    }
  }

  narrow.addEventListener('change', () => {
    if (narrow.matches) setup();
    else teardown();
  });

  if (!narrow.matches) return;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup, { once: true });
  } else {
    setup();
  }
})();
