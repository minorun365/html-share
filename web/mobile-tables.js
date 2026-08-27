(() => {
  // スマホ幅のときだけ働く。PCでは1行も触らず、元のHTMLの見た目をそのまま残す。
  const narrow = matchMedia('(max-width: 46rem)');

  // 表を横スクロールさせても、スマホでは読めない。行の見出しを見失うし、
  // 左右に振りながら1行を追うのは実用にならない。
  //
  // 扱いは3段階。上から順に試して、通ったところで止める（2026-08-21 に再設計）。
  //
  //   ① そのまま収める … 幅を押し広げている指定（min-width・white-space:nowrap・
  //      固定幅・広い余白）を打ち消して測り直す。収まれば表のまま置く。PCと同じ形で
  //      読めるので、これがいちばん良い。
  //   ② カードへ畳む   … ①で収まらない表と、長文セルを抱えた表。
  //   ③ 横スクロール   … 本体に結合セルがあって畳めない表だけ。最後の手段。
  //
  // 以前は①が無く、②の可否を列数で決めていた（4列まで、長文があれば6列まで）。
  // その結果、「5〜6列だが各セルは短い」表が②からも外れて③へ落ち、いちばん収まりやすい
  // はずの表がいちばん読めない形で出ていた。全1035個のうち63個がこれに当たる
  // （2026-08-21 実測）。
  // 幅を押し広げているのは列数ではなく nowrap と min-width なので、そこを外す①を先に置く。
  // ①が数値マトリクスを救うため、②の列数の上限は撤廃した。
  const LONG_CELL_CHARS = 40;
  // 端数の丸めでスクロールバー1px分がはみ出しに見えることがあるので、少し余裕を持たせる
  const OVERFLOW_TOLERANCE = 4;

  /* JSの判定を待たずに効かせる土台。表の min-width は、375px の画面に対して
     「必ずはみ出す」と宣言しているのと同じで、共有くんの表が読めない原因のほぼ全部が
     これだった（2026-08-21 実測。既定スタイルシートの min-width:600px が全ページへ
     コピーされていた）。ここで打ち消しておけば、下の判定が走る前から表は収まる。
     スクリプトの起動は fonts.ready と rAF に乗るので、タブが背面にある間は進まない。
     いちばん効く対処をそこへ乗せない */
  const baseStyleText = `
    @media (max-width: 46rem) {
      table { min-width: 0 !important; }
    }
  `;

  const styleText = `
    /* ── 共通 ───────────────────────────────────────────── */
    .mb-tools {
      display: flex;
      justify-content: flex-end;
      margin: 0 0 .375rem;
    }
    .mb-toggle {
      -webkit-appearance: none;
      appearance: none;
      display: inline-flex;
      align-items: center;
      gap: .25rem;
      padding: .3rem .6rem;
      border: 1px solid var(--mb-line);
      border-radius: 999px;
      background: var(--mb-panel);
      color: var(--mb-mut);
      font: inherit;
      font-size: .75rem;
      line-height: 1.2;
      -webkit-tap-highlight-color: transparent;
    }
    .mb-toggle:active { transform: scale(.96); }
    .mb-toggle svg {
      width: .85rem;
      height: .85rem;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.9;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    /* ── そのまま収める表示 ─────────────────────────────── */
    /* 幅を押し広げている指定だけを打ち消す。列の並びも配色も元のまま残るので、
       読み手にとってはPCと同じ表に見える */
    table[data-mb-view="fit"] {
      min-width: 0 !important;
      width: 100% !important;
      max-width: 100% !important;
      table-layout: auto !important;
    }
    table[data-mb-view="fit"] > * > tr > th,
    table[data-mb-view="fit"] > * > tr > td {
      min-width: 0 !important;
      width: auto !important;
      max-width: none !important;
      padding-left: .4375rem !important;
      padding-right: .4375rem !important;
      font-size: .78125rem !important;
      line-height: 1.6 !important;
    }
    /* 折り返しを許すのは長いセルだけ。日付・数値・短い語まで折り返せるようにすると、
       ブラウザはその列を1文字幅まで詰めてよいと判断し、「8/14」が3行に割れる
       （2026-08-21、Simulatorで実際にそうなった）。overflow-wrap:anywhere は
       最小幅の計算まで変えてしまうので使わない */
    table[data-mb-view="fit"] > * > tr > [data-mb-wrap] {
      white-space: normal !important;
      overflow-wrap: break-word;
    }
    /* セル内の要素が固有幅を持っていても、表の外へはみ出させない */
    table[data-mb-view="fit"] > * > tr > * > * { max-width: 100% !important; }

    /* ── カード表示 ─────────────────────────────────────── */
    /* 元ページのCSSは表として書かれているので、display から色まで上書きが要る。
       解除できるよう属性セレクタ1本に閉じ込め、元のCSSは書き換えない */
    table[data-mb-view="card"] {
      display: block !important;
      width: 100% !important;
      max-width: 100% !important;
      min-width: 0 !important;
      margin-left: 0 !important;
      margin-right: 0 !important;
      border: 0 !important;
      border-spacing: 0 !important;
      background: none !important;
      box-shadow: none !important;
      overflow: visible !important;
      white-space: normal !important;
    }
    table[data-mb-view="card"] > thead,
    table[data-mb-view="card"] > colgroup { display: none !important; }
    table[data-mb-view="card"] > tbody { display: block !important; }
    table[data-mb-view="card"] > tbody > tr {
      display: block !important;
      width: auto !important;
      margin: 0 0 .625rem !important;
      padding: 0 !important;
      border: 1px solid var(--mb-line) !important;
      border-radius: .75rem !important;
      background: var(--mb-panel) !important;
      overflow: hidden !important;
    }
    table[data-mb-view="card"] > tbody > tr:last-child { margin-bottom: 0 !important; }
    table[data-mb-view="card"] > tbody > tr > th,
    table[data-mb-view="card"] > tbody > tr > td {
      display: block !important;
      width: auto !important;
      max-width: none !important;
      min-width: 0 !important;
      text-align: left !important;
      white-space: normal !important;
      overflow-wrap: anywhere;
      border: 0 !important;
      border-top: 1px solid var(--mb-line) !important;
      padding: .5rem .75rem !important;
      background: none !important;
      font-size: .8125rem !important;
      line-height: 1.65 !important;
    }
    /* 1列目は項目名であることが多いので、カードの見出しとして扱う。
       ここへラベルを重ねると「項目: 項目名」と二重になるので出さない */
    table[data-mb-view="card"] > tbody > tr > :first-child {
      border-top: 0 !important;
      padding: .5rem .75rem !important;
      background: var(--mb-head) !important;
      color: var(--mb-ink) !important;
      font-weight: 700 !important;
      font-size: .875rem !important;
    }
    table[data-mb-view="card"] > tbody > tr > :not(:first-child)::before {
      content: attr(data-mb-label);
      display: block;
      margin-bottom: .125rem;
      color: var(--mb-mut);
      font-size: .6875rem;
      font-weight: 600;
      line-height: 1.4;
      letter-spacing: .02em;
    }
    /* 見出しのない列（thead が無い表など）は、ラベル行のぶんだけ空けない */
    table[data-mb-view="card"] > tbody > tr > [data-mb-label=""]::before { content: none; }
    /* セル内の要素が固有幅を持っていても、カードの外へはみ出させない */
    table[data-mb-view="card"] > tbody > tr > * > * { max-width: 100% !important; }

    /* ── 横スクロール表示（列が多い表） ─────────────────── */
    .mb-scroll-outer { position: relative; }
    .mb-scroll {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior-x: contain;
    }
    .mb-scroll > table {
      margin: 0 !important;
      /* iOS Safari は「ビューポートより広いブロック」の文字を勝手に拡大する。
         スクロール面へ入れた表がこれに当たり、位置づけ列だけ倍近い字になった
         （2026-08-15、Simulatorで発覚）。拡大を止めて元の字送りを保つ */
      -webkit-text-size-adjust: 100%;
      text-size-adjust: 100%;
    }
    /* min-width: max-content で「潰れ」を防ごうとすると、長文セルが1行に伸びて
       かえって横長になる。表の自然な幅に任せ、はみ出した分だけ送れれば足りる */
    /* 1列目を残したまま右の列を送れるようにする。どの行を見ているか見失わない */
    .mb-scroll table > * > tr > :first-child {
      position: sticky;
      left: 0;
      z-index: 1;
    }
    /* まだ右に続くことを示す。スクロール面の外に置かないと一緒に流れてしまう。
       白へ向かうグラデーションだと、白い表の上では何も見えない（2026-08-15 に実機で確認）。
       内容を隠さず、端が陰っていることだけが伝わる濃さにする */
    .mb-scroll-outer::after {
      content: "";
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      width: 2rem;
      pointer-events: none;
      opacity: 0;
      transition: opacity .18s ease;
      background: linear-gradient(to right, rgba(26, 26, 31, 0), rgba(26, 26, 31, .2));
    }
    .mb-scroll-outer[data-mb-more="1"]::after { opacity: 1; }
  `;

  /** 元ページの配色に関係なく読める最低限の色。共有くんのパレットに合わせる */
  const palette = {
    '--mb-line': '#e5e5ea',
    '--mb-panel': '#fff',
    '--mb-head': '#f0f3f7',
    '--mb-ink': '#1a1a1f',
    '--mb-mut': '#6b6b73',
  };

  let baseStyleEl = null;
  function ensureBaseStyle() {
    if (baseStyleEl) return;
    baseStyleEl = document.createElement('style');
    baseStyleEl.textContent = baseStyleText;
    (document.head ?? document.documentElement).append(baseStyleEl);
  }

  let styleEl = null;
  function ensureStyle() {
    if (styleEl) return;
    for (const [name, value] of Object.entries(palette)) {
      document.documentElement.style.setProperty(name, value);
    }
    styleEl = document.createElement('style');
    styleEl.textContent = styleText;
    document.head.append(styleEl);
  }

  const isTransparent = (color) => !color
    || color === 'transparent'
    || /^rgba\([^)]*,\s*0(?:\.0+)?\)$/.test(color);

  /** 判定はすべて表の本体を見る。見出しの結合セルで列数が水増しされないようにするため */
  const bodyRows = (table) => [...table.tBodies].flatMap((body) => [...body.rows]);

  /** 見出し行から各列のラベルを読む。thead が無い表は空文字で埋める。
   *  グループ見出しを持つ表は thead が2行あり、1行目は colspan でまとめた大見出しなので、
   *  列と1対1で対応する「セル数が最も多い行」を選ぶ */
  function columnLabels(table) {
    const headRows = table.tHead
      ? [...table.tHead.rows]
      : [...table.rows].filter((row) => [...row.cells].every((cell) => cell.tagName === 'TH'));
    if (headRows.length === 0) return [];
    const headRow = headRows.reduce((best, row) => (row.cells.length > best.cells.length ? row : best));
    return [...headRow.cells].map((cell) => cell.textContent.trim().replace(/\s+/g, ' '));
  }

  /** カード1枚に何項目載るかは本体の列数で決まる */
  function columnCount(table) {
    const rows = bodyRows(table);
    if (rows.length === 0) return 0;
    return Math.max(...rows.map((row) => row.cells.length));
  }

  /** 結合セルのある本体は、縦積みにすると値と見出しの対応が崩れるのでカードにしない。
   *  見出し側の結合は見ない。グループ見出しを載せただけの表はカードにできるし、
   *  ラベルは columnLabels がセル数の合う行から読む */
  function hasMergedCells(table) {
    return bodyRows(table).some((row) =>
      [...row.cells].some((cell) => cell.colSpan > 1 || cell.rowSpan > 1));
  }

  /** 説明文を抱えた表かどうか。長文が1つでもあれば、横に並べても読み切れない */
  function hasProse(table) {
    return bodyRows(table).some((row) =>
      [...row.cells].some((cell) => cell.textContent.trim().length >= LONG_CELL_CHARS));
  }

  /** 縦積みのカードへ畳んでよい表か。
   *  畳めないのは本体に結合セルがある表だけ。列数では切らない——列が多い表ほど
   *  横スクロールでは読めないので、縦に長くなってでもカードのほうが実用になる。
   *  短い語が並ぶマトリクスは①で収まるので、そもそもここへ来ない */
  function canFold(table) {
    return columnCount(table) > 0 && !hasMergedCells(table);
  }

  /** 折り返してよいセルへ印を付ける。短いセルは元の nowrap のまま残す。
   *  ここを一律に折り返し可にすると、表の列が1文字幅まで詰められる */
  const WRAPPABLE_CHARS = 8;
  function markWrappable(table) {
    for (const row of table.rows) {
      for (const cell of row.cells) {
        if (cell.textContent.trim().length >= WRAPPABLE_CHARS) cell.dataset.mbWrap = '1';
      }
    }
  }

  function clearWrappable(table) {
    for (const row of table.rows) {
      for (const cell of row.cells) delete cell.dataset.mbWrap;
    }
  }

  /** 素の状態で右へどれだけはみ出しているか。ラッパーの有無に関わらず測れる形にする */
  function overflowAmount(table) {
    const own = table.scrollWidth - table.clientWidth;
    const parent = table.parentElement;
    const inParent = parent ? table.scrollWidth - parent.clientWidth : 0;
    return Math.max(own, inParent);
  }

  const entries = [];
  /** ①で収めた表。teardown で戻せるよう控える */
  const fitted = [];

  function applyCard(entry) {
    const { table } = entry;
    const labels = columnLabels(table);
    for (const row of bodyRows(table)) {
      [...row.cells].forEach((cell, index) => {
        cell.dataset.mbLabel = index === 0 ? '' : (labels[index] ?? '');
      });
    }
    table.dataset.mbView = 'card';
  }

  function applyScroll(entry) {
    const { table } = entry;
    // sticky にした1列目が透けると、送った右の列が下に重なって読めなくなる。
    // 元の背景が透明なセルにだけ地色を敷き、色を持つセル（見出し帯など）はそのまま活かす
    for (const row of table.rows) {
      const cell = row.cells[0];
      if (!cell) continue;
      if (isTransparent(getComputedStyle(cell).backgroundColor)) {
        cell.style.backgroundColor = row.parentElement?.tagName === 'THEAD'
          ? palette['--mb-head']
          : palette['--mb-panel'];
      }
    }
    entry.scroller.addEventListener('scroll', () => updateFade(entry), { passive: true });
    updateFade(entry);
  }

  function updateFade(entry) {
    const { scroller, outer } = entry;
    const remaining = scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft;
    outer.dataset.mbMore = remaining > OVERFLOW_TOLERANCE ? '1' : '0';
  }

  // 畳めない表にはトグルを付けないので、ボタンが無くても動く形にしておく
  function toCard(entry) {
    entry.view = 'card';
    entry.outer.dataset.mbMore = '0';
    entry.scroller.style.overflowX = 'visible';
    applyCard(entry);
    entry.button?.setAttribute('aria-pressed', 'true');
    if (entry.label) entry.label.textContent = '表で見る';
  }

  function toTable(entry) {
    entry.view = 'table';
    delete entry.table.dataset.mbView;
    entry.scroller.style.overflowX = '';
    updateFade(entry);
    entry.button?.setAttribute('aria-pressed', 'false');
    if (entry.label) entry.label.textContent = 'カードで見る';
  }

  function buildToggle(entry) {
    const tools = document.createElement('div');
    tools.className = 'mb-tools';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mb-toggle';
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
      + '<rect x="3" y="4" width="18" height="16" rx="2"></rect>'
      + '<path d="M3 10h18M9 10v10"></path></svg><span></span>';
    entry.button = button;
    entry.label = button.querySelector('span');
    button.addEventListener('click', () => {
      // 一度でも自分で切り替えたら、画面回転などで勝手に戻さない
      entry.userChose = true;
      if (entry.view === 'card') toTable(entry);
      else toCard(entry);
    });
    tools.append(button);
    entry.outer.before(tools);
    entry.tools = tools;
  }

  /** 表を1つ、スクロール面で包む。既に包まれていれば作り直さない */
  function wrap(table) {
    const outer = document.createElement('div');
    outer.className = 'mb-scroll-outer';
    const scroller = document.createElement('div');
    scroller.className = 'mb-scroll';
    table.before(outer);
    outer.append(scroller);
    scroller.append(table);
    return { outer, scroller };
  }

  function setup() {
    ensureStyle();
    const tables = [...document.querySelectorAll('table')].filter((table) =>
      // 入れ子の表は外側だけを見る。二重にラップすると内側の判定が狂う
      !table.parentElement?.closest('table')
      // ページ側が明示的に外したいときの逃げ道
      && table.dataset.mbTables !== 'off'
      && !table.closest('[data-mb-tables="off"]'));

    for (const table of tables) {
      // 収まっている表はPCと同じ見た目のまま残す。触る理由がない
      if (overflowAmount(table) <= OVERFLOW_TOLERANCE) continue;

      // ① 幅を押し広げている指定を外して測り直す。これで収まるなら表のまま置く。
      //    長文セルを抱えた表だけは、収まってもカードへ回す——列が細って
      //    1列だけ何行にも伸びた表は、収まってはいても読めた形にならない
      markWrappable(table);
      table.dataset.mbView = 'fit';
      if (overflowAmount(table) <= OVERFLOW_TOLERANCE && !hasProse(table)) {
        fitted.push(table);
        continue;
      }
      delete table.dataset.mbView;
      clearWrappable(table);

      const canCard = canFold(table);
      const { outer, scroller } = wrap(table);
      const entry = { table, outer, scroller, view: 'table', userChose: false };
      entries.push(entry);
      applyScroll(entry);
      if (!canCard) {
        // 畳めない表に切り替えボタンを出すと、押した先が崩れる。横スクロールのまま置く
        toTable(entry);
        continue;
      }
      buildToggle(entry);
      toCard(entry);
    }
  }

  function teardown() {
    for (const entry of entries) {
      delete entry.table.dataset.mbView;
      entry.scroller.style.overflowX = '';
      for (const row of entry.table.rows) {
        if (row.cells[0]) row.cells[0].style.backgroundColor = '';
        for (const cell of row.cells) delete cell.dataset.mbLabel;
      }
      entry.outer.before(entry.table);
      entry.tools?.remove();
      entry.outer.remove();
    }
    entries.length = 0;
    for (const table of fitted) {
      delete table.dataset.mbView;
      clearWrappable(table);
    }
    fitted.length = 0;
  }

  // 横向きにすると 844px になり、狭幅の前提が外れる。素のページへ戻す
  narrow.addEventListener('change', () => {
    if (narrow.matches) {
      if (entries.length === 0 && fitted.length === 0) setup();
    } else {
      teardown();
    }
  });

  // 土台のCSSは幅に関係なく先に入れておく。中身がメディアクエリなので、
  // PC幅では何も起きない。画面を回して狭くなった直後にも取りこぼさない
  ensureBaseStyle();

  if (!narrow.matches) return;

  // 幅の判定はフォントが確定してから。読み込み前の代替フォントで測ると、
  // 収まる表をはみ出しと誤判定する
  const ready = document.fonts?.ready ?? Promise.resolve();
  ready.then(() => requestAnimationFrame(() => requestAnimationFrame(setup)));
})();
