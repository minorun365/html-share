(() => {
  const script = document.currentScript;
  const currentSlug = script?.dataset.slug ?? '';
  // 画面幅では絞らない。本体URL（/pages/<slug>/index.html）を直に開いたときは、
  // PCでもホームと「…」が無いとトップへ戻る手段が消え、共有URLも発行できない。
  // 絞るのは iframe の中だけ。PCでトップから開いた場合は app/index.html が同じ操作を
  // 自前で重ねるので、ここでも出すと操作が2組ぶら下がる。
  if (!currentSlug || window.self !== window.top) return;

  // 一覧の見た目と描画は page-list.js が唯一の実装。ここへ写しを作らないこと
  const L = window.MyBriefsList;
  if (!L) {
    console.error('page-list.js が読み込まれていないため、ページ一覧を表示できません');
    return;
  }

  const host = document.createElement('div');
  host.id = 'mybriefs-mobile-page-shell';
  document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });

  root.innerHTML = `
    <style>${L.styleText(':host')}</style>
    <style>
      :host {
        --blue-deep: #0e0d6a;
        --blue: #0a4695;
        --blue-soft: #eaf2fb;
        --line: #e5e5ea;
        --panel: #fff;
        --ink: #1a1a1f;
        --sub: #45454d;
        --mut: #6b6b73;
        --gold: #f0b21f;
        --gold-deep: #8a5a00;
        --gold-soft: #fdf3d2;
        --blue-line: #cfe0f2;
        --chip: #f0f3f7;
        --danger: #d92d20;
        --blue-grad: linear-gradient(135deg, #0e0d6a 0%, #0a4695 45%, #0862aa 68%, #01b6ec 100%);
        --glass: rgba(255, 255, 255, .78);
        --glass-border: rgba(255, 255, 255, .62);
        --shadow: 0 2px 8px rgba(26, 26, 31, .10), 0 14px 34px rgba(14, 13, 106, .18);
        color: var(--ink);
        font-family: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif;
      }
      *, *::before, *::after { box-sizing: border-box; }
      button, input, select { font: inherit; }
      button { -webkit-tap-highlight-color: transparent; }
      .toolbar {
        position: fixed;
        z-index: 2147483004;
        top: calc(.5rem + env(safe-area-inset-top, 0px));
        left: max(.55rem, env(safe-area-inset-left, 0px));
        right: max(.55rem, env(safe-area-inset-right, 0px));
        display: flex;
        justify-content: space-between;
        pointer-events: none;
        transition: transform .24s ease, opacity .18s ease;
      }
      /* PCはホイールを少し戻せば出したいので、消さずに上へ逃がして滑らかに戻す */
      .toolbar.reading {
        transform: translateY(-5rem);
        opacity: 0;
      }
      .toolbar.reading .tool { pointer-events: none; }
      @media (max-width: 46rem) {
        /* スマホは backdrop-filter を載せたまま流すとスクロールが重くなる。描画から外す */
        .toolbar.reading { display: none; }
      }
      .tool {
        width: 2.75rem;
        height: 2.75rem;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid var(--glass-border);
        border-radius: 50%;
        background: var(--glass);
        color: var(--sub);
        box-shadow: var(--shadow);
        backdrop-filter: blur(22px) saturate(180%);
        -webkit-backdrop-filter: blur(22px) saturate(180%);
        pointer-events: auto;
      }
      .tool svg { width: 1.15rem; height: 1.15rem; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
      .tool.more svg { fill: currentColor; stroke: none; }
      .tool:active { transform: scale(.94); }
      /* iframe 越しのトップ（app/index.html の #home-btn / #page-more）と同じ角丸にする。
         同じPCで入口によって丸と角丸が入れ替わると継ぎはぎに見える */
      @media (min-width: 46.0625rem) {
        .tool { border-radius: 1rem; }
      }
      @media (hover: hover) {
        .tool, .action, .issue, .share-panel select { cursor: pointer; }
        .tool:hover { background: var(--panel); color: var(--ink); }
        .action:hover { background: rgba(10, 70, 149, .08); }
        .action.delete:hover { background: rgba(217, 45, 32, .08); }
        .action:disabled { cursor: default; }
        .action:disabled:hover { background: transparent; }
      }
      /* display を持つ要素は hidden 属性だけでは隠れないので、明示的に落とす */
      .action-menu[hidden], .share-panel[hidden], .share-toast[hidden], .popover-dismiss[hidden] { display: none; }
      .popover-dismiss {
        position: fixed; inset: 0; z-index: 2147483002;
        background: transparent;
      }
      .action-menu,
      .share-panel,
      .share-toast {
        position: fixed;
        z-index: 2147483003;
        top: calc(3.65rem + env(safe-area-inset-top, 0px));
        right: max(.55rem, env(safe-area-inset-right, 0px));
        border: 1px solid rgba(28, 35, 51, .10);
        background: rgba(255, 255, 255, .92);
        box-shadow: var(--shadow);
        backdrop-filter: blur(26px) saturate(180%);
        -webkit-backdrop-filter: blur(26px) saturate(180%);
      }
      .action-menu {
        width: min(15rem, calc(100vw - 1.1rem));
        padding: .38rem; border-radius: 1rem;
      }
      .action {
        width: 100%; min-height: 2.75rem; padding: .55rem .7rem;
        display: flex; align-items: center; justify-content: flex-start; gap: .7rem;
        border: 0; border-radius: .72rem; background: transparent; color: var(--ink); text-align: left;
        font: inherit; font-size: .82rem; line-height: 1.35;
      }
      .action + .action { border-top: 1px solid rgba(229, 229, 234, .72); border-radius: 0; }
      .action svg { width: 1.05rem; height: 1.05rem; flex: none; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
      .action:active { background: rgba(10, 70, 149, .08); }
      .action.starred { color: var(--gold-deep); }
      .action.starred svg { fill: currentColor; }
      .action:disabled { opacity: .5; }
      .action.delete { color: var(--danger); }
      .share-panel {
        width: min(21rem, calc(100vw - 1.1rem));
        padding: .75rem; display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, .8fr); gap: .55rem;
        border-radius: 1rem;
      }
      .share-panel label { display: grid; gap: .25rem; color: var(--mut); font-size: .68rem; }
      /* ⚠️ font-size 16px は必須。上の label の .68rem を継承すると 10.9px になり、
         iOS Safari が入力欄フォーカス時にページごと拡大する（app/index.html の
         #page-share-panel select と対で直すこと） */
      .share-panel select, .issue {
        min-width: 0; min-height: 2.4rem; padding: .4rem .55rem;
        border: 1px solid var(--line); border-radius: .6rem; background: #f6f7f9; color: var(--ink);
        font-size: 16px;
      }
      .issue { grid-column: 1 / -1; border-color: var(--blue); background: var(--blue); color: #fff; font-weight: 600; }
      .issue:disabled { opacity: .72; }
      .share-toast {
        width: min(18rem, calc(100vw - 1.1rem));
        padding: .7rem .85rem;
        color: var(--ink); font-size: .82rem; line-height: 1.4;
        border-radius: 1rem;
      }
      .share-toast strong { display: block; font-weight: 650; }
      .share-toast .toast-meta {
        display: block; margin-top: .15rem;
        color: var(--mut); font-size: .72rem; font-weight: 400;
      }
      @media (prefers-reduced-transparency: reduce) {
        .tool, .action-menu, .share-panel, .share-toast { background: #fff; backdrop-filter: none; -webkit-backdrop-filter: none; }
      }
      @media (prefers-reduced-motion: reduce) {
        .toolbar { transition: none; }
      }
    </style>
    <div class="toolbar" aria-label="共有くんのページ操作">
      <button class="tool nav" type="button" aria-label="トップへ戻る" title="トップへ戻る">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11.2 12 4.5l8 6.7M6.4 9.6V19h11.2V9.6"/></svg>
      </button>
      <button class="tool more" type="button" aria-label="ページ操作を開く" aria-haspopup="menu" aria-expanded="false" aria-controls="page-menu">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>
      </button>
    </div>
    <div class="popover-dismiss" hidden></div>
    <div class="action-menu" id="page-menu" role="menu" aria-label="ページ操作" hidden>
      <button class="action star-action" type="button" role="menuitem" disabled>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z"/></svg><span>スターを付ける</span>
      </button>
      <button class="action unread-action" type="button" role="menuitem" disabled>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5h17v11h-17zM3.5 7.5 12 14l8.5-6.5"/></svg><span>未読に戻す</span>
      </button>
      <button class="action refresh" type="button" role="menuitem">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6v5h-5M19 11a7 7 0 1 0 .2 5"/></svg><span>更新</span>
      </button>
      <button class="action share" type="button" role="menuitem">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4M8 8l4-4 4 4M5 13v6h14v-6"/></svg><span>共有URLを発行</span>
      </button>
      <button class="action delete" type="button" role="menuitem">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg><span>一覧から削除</span>
      </button>
    </div>
    <div class="share-panel" aria-label="共有URLの発行" hidden>
      <label>公開範囲<select class="scope"><option value="i">社内限定</option><option value="p">IP制限なし</option></select></label>
      <label>有効日数<select class="days"><option>1</option><option>3</option><option selected>7</option><option>14</option><option>30</option><option>90</option></select></label>
      <button class="issue" type="button">発行してコピー</button>
    </div>
    <div class="share-toast" role="status" hidden>
      <strong>コピーしました</strong>
      <span class="toast-meta"></span>
    </div>
  `;

  const $ = (selector) => root.querySelector(selector);
  const toolbar = $('.toolbar');
  const nav = $('.nav');
  const more = $('.more');
  const actionMenu = $('.action-menu');
  const sharePanel = $('.share-panel');
  const shareToast = $('.share-toast');
  const popoverDismiss = $('.popover-dismiss');
  const issue = $('.issue');
  let shareToastTimer = 0;
  const STAR_KEY = 'mb_starred_pages';
  const STREAM_STAR_PREFIX = '@stream:';
  const HIDDEN_KEY = 'mb_hidden_pages';
  const READ_KEY = 'mb_read_marks';
  // 開かないまま放置したページが延々と黄色く残らないよう、新着表示はこの日数までに限る
  const NEW_WINDOW_DAYS = 30;
  // 生成HTMLは管理画面と別オリジンで配信するため、端末内の表示設定だけを使う。
  const CAN_SYNC = false;
  let allPages = [];
  let currentPage = null;
  let starredSources = [];
  let hiddenSources = new Set();
  let preferencesReady = false;
  // { ページの source: 開いたときの更新日時 }。更新日時ごと持つので、再更新で自動的に未読へ戻る
  let readMarks = {};
  let knowsReadMarks = false;

  function configureShareOptions(manifest) {
    const scope = $('.scope');
    if (!manifest.internalSharing) {
      scope.querySelector('option[value="i"]')?.remove();
      scope.value = 'p';
    }

    const maximumDays = Number(manifest.maximumShareDays);
    const days = $('.days');
    if (Number.isInteger(maximumDays) && maximumDays > 0) {
      for (const option of [...days.options]) {
        if (Number(option.value) > maximumDays) option.remove();
      }
      const available = [...days.options].map((option) => Number(option.value));
      days.value = String(available.includes(7) ? 7 : available.at(-1));
    }
  }
  function readList(key, max) {
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? '[]');
      return Array.isArray(value) ? value.filter((item) => typeof item === 'string').slice(0, max) : [];
    } catch {
      return [];
    }
  }

  function readMarksFromStorage() {
    try {
      const raw = localStorage.getItem(READ_KEY);
      const saved = raw === null ? null : JSON.parse(raw);
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        readMarks = saved;
        knowsReadMarks = true;
      }
    } catch { /* 壊れた保存値は未記録として扱う */ }
  }

  function saveLocalPreferences() {
    try {
      localStorage.setItem(STAR_KEY, JSON.stringify(starredSources));
      localStorage.removeItem('mb_recent_pages');
      localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hiddenSources]));
      localStorage.setItem(READ_KEY, JSON.stringify(readMarks));
      knowsReadMarks = true;
    } catch { /* noop */ }
  }

  // 既読の記録・マージ・書き戻し判定はすべて page-list.js が正本。ここは呼ぶだけにする
  const seedReadMarks = () => L.seedReadMarks(allPages, readMarks);

  async function sha256(value) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function preferencesApi(options = {}) {
    const body = options.body;
    const headers = { ...(options.headers ?? {}) };
    if (body) {
      headers['content-type'] = 'application/json';
      headers['x-amz-content-sha256'] = await sha256(body);
    }
    const response = await fetch('/api/owner/preferences', { cache: 'no-store', ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? '表示設定の保存に失敗しました');
    return payload;
  }

  // 読み込み直後の書き戻しと、メニュー操作の保存がぶつかると、
  // どちらが後に届くか分からず古い状態で上書きされる。直列に流して順序を保つ
  let pendingSync = Promise.resolve();

  function persistPreferences() {
    saveLocalPreferences();
    if (!CAN_SYNC) return Promise.resolve();
    pendingSync = pendingSync.catch(() => {}).then(() => {
      const body = JSON.stringify({
        starredSources,
        recentSources: [],
        hiddenSources: [...hiddenSources],
        readMarks,
      });
      return preferencesApi({ method: 'PUT', body });
    });
    return pendingSync;
  }

  function setToolbarHidden(hidden) {
    if (!actionMenu.hidden || !sharePanel.hidden || !shareToast.hidden) hidden = false;
    toolbar.classList.toggle('reading', hidden);
  }

  function closePopovers() {
    actionMenu.hidden = true;
    sharePanel.hidden = true;
    shareToast.hidden = true;
    popoverDismiss.hidden = true;
    more.setAttribute('aria-expanded', 'false');
    clearTimeout(shareToastTimer);
  }

  function syncMenu() {
    const button = $('.star-action');
    const on = Boolean(currentPage && starredSources.includes(currentPage.source));
    button.disabled = !currentPage || !preferencesReady;
    button.classList.toggle('starred', on);
    button.querySelector('span').textContent = on ? 'スターを外す' : 'スターを付ける';
    $('.unread-action').disabled = !currentPage || !preferencesReady;
  }

  nav.addEventListener('click', () => { location.href = '/app/index.html'; });

  more.addEventListener('click', () => {
    const willOpen = actionMenu.hidden && sharePanel.hidden;
    closePopovers();
    if (!willOpen) return;
    syncMenu();
    actionMenu.hidden = false;
    popoverDismiss.hidden = false;
    more.setAttribute('aria-expanded', 'true');
    setToolbarHidden(false);
  });
  $('.star-action').addEventListener('click', async () => {
    if (!currentPage) return;
    const previousStarred = [...starredSources];
    const on = starredSources.includes(currentPage.source);
    starredSources = on
      ? starredSources.filter((sourceValue) => sourceValue !== currentPage.source)
      : [...starredSources, currentPage.source];
    syncMenu();
    closePopovers();
    try {
      await persistPreferences();
    } catch (error) {
      starredSources = previousStarred;
      saveLocalPreferences();
      syncMenu();
      alert(error.message);
    }
  });
  $('.unread-action').addEventListener('click', async () => {
    if (!currentPage) return;
    closePopovers();
    const previousMark = readMarks[currentPage.source];
    if (!L.markUnread(currentPage, readMarks)) return;
    try {
      await persistPreferences();
      // ここに留まると、読み込み直した拍子にまた既読へ倒れる。
      // 一覧へ戻して、黄色い「新着」に戻ったことをその場で見せる
      location.href = '/app/index.html';
    } catch (error) {
      if (previousMark === undefined) delete readMarks[currentPage.source];
      else readMarks[currentPage.source] = previousMark;
      saveLocalPreferences();
      alert(error.message);
    }
  });
  $('.refresh').addEventListener('click', () => location.reload());
  $('.share').addEventListener('click', () => {
    actionMenu.hidden = true;
    sharePanel.hidden = false;
    shareToast.hidden = true;
    popoverDismiss.hidden = false;
    more.setAttribute('aria-expanded', 'true');
  });
  $('.delete').addEventListener('click', async () => {
    if (!currentPage) return;
    closePopovers();
    if (!confirm(`「${currentPage.title}」を共有くんの一覧から削除します。\n\n原本と発行済みURLは残り、左の「削除済み」から戻せます。`)) return;
    const previousHidden = new Set(hiddenSources);
    const previousStarred = [...starredSources];
    hiddenSources.add(currentPage.source);
    starredSources = starredSources.filter((sourceValue) => sourceValue !== currentPage.source);
    try {
      await persistPreferences();
      location.href = '/';
    } catch (error) {
      hiddenSources = previousHidden;
      starredSources = previousStarred;
      saveLocalPreferences();
      alert(error.message);
    }
  });

  issue.addEventListener('click', async () => {
    if (!currentPage) return;
    const mode = $('.scope').value;
    const days = Number($('.days').value);
    if (
      mode === 'p' &&
      !confirm(`「${currentPage.title}」をIP制限なしで${days}日間共有します。よろしいですか？`)
    ) return;
    issue.disabled = true;
    issue.textContent = '発行中…';
    let generatedUrl = '';
    try {
      const response = await fetch('/api/owner/shares', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: currentPage.slug,
          scope: mode === 'i' ? 'internal' : 'public',
          days,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.url) throw new Error(payload.error ?? '共有URLを発行できませんでした');
      generatedUrl = payload.url;
      await navigator.clipboard.writeText(generatedUrl);
      const expires = new Date(payload.expiresAt * 1000).toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
      sharePanel.hidden = true;
      more.setAttribute('aria-expanded', 'false');
      shareToast.querySelector('strong').textContent = 'コピーしました';
      shareToast.querySelector('.toast-meta').textContent = `${expires}まで有効`;
      shareToast.hidden = false;
      popoverDismiss.hidden = false;
      clearTimeout(shareToastTimer);
      shareToastTimer = setTimeout(closePopovers, 2500);
    } catch (error) {
      console.error(error);
      if (generatedUrl) {
        prompt('このURLをコピーしてください', generatedUrl);
      } else {
        sharePanel.hidden = true;
        more.setAttribute('aria-expanded', 'false');
        shareToast.querySelector('strong').textContent = '発行できませんでした';
        shareToast.querySelector('.toast-meta').textContent = error instanceof Error ? error.message : String(error);
        shareToast.hidden = false;
        popoverDismiss.hidden = false;
        clearTimeout(shareToastTimer);
        shareToastTimer = setTimeout(closePopovers, 5000);
      }
    } finally {
      issue.disabled = false;
      issue.textContent = '発行してコピー';
    }
  });

  popoverDismiss.addEventListener('pointerdown', closePopovers);
  document.addEventListener('pointerdown', (event) => {
    if (event.composedPath().includes(host)) return;
    closePopovers();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (actionMenu.hidden && sharePanel.hidden && shareToast.hidden) return;
    event.preventDefault();
    closePopovers();
  });
  // スマホは画面が短く、指1本で上端まで戻せるので、下へ読む間は隠したままでよい。
  // PCはページが長いので、上へ少し戻した時点で出す。判定の向きと閾値は
  // app/index.html の watchFrameScroll と同じにしてある（入口で挙動を変えない）。
  const narrow = matchMedia('(max-width: 46rem)');
  let lastScrollY = scrollY;
  addEventListener('scroll', () => {
    const nextY = scrollY;
    if (narrow.matches) setToolbarHidden(nextY > 24);
    else if (nextY <= 24 || nextY < lastScrollY - 6) setToolbarHidden(false);
    else if (nextY > lastScrollY + 6) setToolbarHidden(true);
    lastScrollY = nextY;
  }, { passive: true });

  starredSources = readList(STAR_KEY, 200);
  hiddenSources = new Set(readList(HIDDEN_KEY, 500));
  readMarksFromStorage();
  const hadLocalReadMarks = knowsReadMarks;

  fetch('/app/manifest.json', { cache: 'no-store' }).then((response) => response.json()).then(async (manifest) => {
    configureShareOptions(manifest);
    allPages = manifest.pages ?? [];
    const validSources = new Set(allPages.map((page) => page.source));
    const validStreams = new Set(allPages.map((page) => page.stream ?? L.pageRepository(page)));
    const isValidStarValue = (value) => validSources.has(value) || (
      value.startsWith(STREAM_STAR_PREFIX)
      && validStreams.has(value.slice(STREAM_STAR_PREFIX.length))
    );
    starredSources = starredSources.filter(isValidStarValue);
    hiddenSources = new Set([...hiddenSources].filter((sourceValue) => validSources.has(sourceValue)));
    currentPage = allPages.find((page) => page.slug === currentSlug) ?? null;

    const pruneReadMarks = () => {
      readMarks = Object.fromEntries(
        Object.entries(readMarks).filter(([sourceValue]) => validSources.has(sourceValue)),
      );
    };
    let needsPush = false;
    pruneReadMarks();

    if (CAN_SYNC) {
      try {
        const saved = await preferencesApi();
        if (saved.exists) {
          starredSources = (saved.starredSources ?? []).filter(isValidStarValue);
          hiddenSources = new Set((saved.hiddenSources ?? []).filter((value) => validSources.has(value)));
          needsPush = L.hasUnsyncedReadMarks(readMarks, saved.readMarks);
          readMarks = L.mergeReadMarks(readMarks, saved.readMarks ?? {});
          pruneReadMarks();
          if (!hadLocalReadMarks && saved.readMarks === null) {
            seedReadMarks();
            needsPush = true;
          }
        } else {
          if (!hadLocalReadMarks) seedReadMarks();
          needsPush = true;
        }
      } catch (error) {
        console.warn(error);
      }
    } else if (!hadLocalReadMarks) {
      seedReadMarks();
    }

    preferencesReady = true;
    syncMenu();
    // いま開いている当のページは読んだ状態にする。トップを経由せず
    // 共有URLやホーム画面から直接来たときも、これで新着が外れる
    if (L.markRead(currentPage, readMarks)) needsPush = true;
    saveLocalPreferences();
    if (needsPush) persistPreferences().catch((error) => console.warn(error));
  }).catch((error) => {
    console.error(error);
  });
})();
