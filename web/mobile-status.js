(() => {
  if (!matchMedia('(max-width: 46rem)').matches) return;
  // v2 のページ（<html data-brief>）は帯の無い淡い地で、上端は html の背景が受け持つ。青い上端を塗らない
  if (document.documentElement.getAttribute?.('data-brief') != null) return;

  // 共有くんが配るページの上端色はここ1か所に固定する。ダッシュボード（app/index.html）と
  // インボックス（review/index.html）の --safe-top と同じ値。
  // ページごとの theme-color を尊重していた頃は、トップ #0a4695 → 個別ページ #0e0d6a と
  // 画面を移った瞬間に Dynamic Island の色が変わって継ぎはぎに見えた（2026-08-13 実機で発覚）。
  const safeTop = '#0a4695';
  const rootStyle = getComputedStyle(document.documentElement);
  // theme-color は配信時に同じ値へ揃える。
  // ここでJSから書き換えない（PWAは追加時点のHTMLの値を使うので実行時では間に合わない）。
  const isTransparent = (color) => !color
    || color === 'transparent'
    || /^rgba\([^)]*,\s*0(?:\.0+)?\)$/.test(color);
  const hero = document.querySelector(
    '.hero, [data-hero], body > header, .wrap > header, .top, .doc-head, #title-block-header',
  );
  const originalBodyBackground = getComputedStyle(document.body).backgroundColor;
  const originalRootBackground = rootStyle.backgroundColor;

  function firstContentElement() {
    let element = hero?.nextElementSibling ?? document.querySelector('main, .wrap, article');
    while (element && ['SCRIPT', 'STYLE', 'TEMPLATE'].includes(element.tagName)) {
      element = element.nextElementSibling;
    }
    return element;
  }

  function pageBackground() {
    const contentColor = firstContentElement()
      ? getComputedStyle(firstContentElement()).backgroundColor
      : '';
    if (!isTransparent(contentColor)) return contentColor;

    const declaredSoft = rootStyle.getPropertyValue('--soft').trim();
    if (declaredSoft) return declaredSoft;
    if (!isTransparent(originalBodyBackground)) return originalBodyBackground;
    if (!isTransparent(originalRootBackground)) return originalRootBackground;
    return '#fff';
  }

  const contentBackground = pageBackground();
  const heroStyle = hero ? getComputedStyle(hero) : null;
  const heroEnd = () => hero
    ? Math.max(0, hero.getBoundingClientRect().bottom + scrollY)
    : 0;

  document.documentElement.style.setProperty('--mybriefs-safe-top', safeTop);
  document.documentElement.style.setProperty('--mybriefs-page-bg', contentBackground);

  // Safari 26は、画面上端に接する実際のfixed面の色をシステム領域へ延長する。
  // 最小限の実要素を接点にして本文を覆わず、ヒーロー側だけを同色から元の背景へなだらかにつなぐ。
  const safeAreaSurface = document.createElement('div');
  safeAreaSurface.className = 'mybriefs-safe-area-surface';
  safeAreaSurface.setAttribute('aria-hidden', 'true');
  document.body.append(safeAreaSurface);
  if (hero && heroStyle && heroStyle.backgroundImage !== 'none') {
    hero.classList.add('mybriefs-safe-area-hero');
    hero.style.setProperty('--mybriefs-original-hero-padding-top', heroStyle.paddingTop);
    hero.style.backgroundImage = `linear-gradient(to bottom, ${safeTop} 0, color-mix(in srgb, ${safeTop} 74%, transparent) 3rem, transparent 7rem), ${heroStyle.backgroundImage}`;
  }
  const style = document.createElement('style');
  style.textContent = `
    @media (max-width: 46rem) {
      /* iOSで上下に引っ張ったとき（オーバースクロール）にのぞくのは html の背景。
         白のままだと下端でびょんと白が出る。ダッシュボード（app/index.html）と同じく
         上端の青にして、引っ張っても地色が変わらないようにする。
         本文末尾までの白は body 側の背景が受け持つので、ここを青にしても本文は白のまま */
      /* ホーム画面Webアプリ（PWA）で下に引っ張ると、上端に body の background-color が広がる。
         html だけ青にしても白のままで、Safariのタブでは再現しない（2026-08-13 実機で確認）。
         ダッシュボード（app/index.html）はスマホ幅で html と body の両方を --safe-top にしてあり、
         だから同じ症状が出ていなかった。ここも両方そろえる。
         本文の白は下の background-image（ヒーロー下端から page-bg）が受け持つので、
         background-color を青にしても本文の見た目は変わらない */
      html { background-color: var(--mybriefs-safe-top, #0a4695) !important; }
      body {
        background-color: var(--mybriefs-safe-top, #0a4695) !important;
        background-image: linear-gradient(
          to bottom,
          var(--mybriefs-safe-top, #0a4695) 0,
          var(--mybriefs-safe-top, #0a4695) var(--mybriefs-hero-end, 0px),
          var(--mybriefs-page-bg, #fff) var(--mybriefs-hero-end, 0px),
          var(--mybriefs-page-bg, #fff) 100%
        ) !important;
        background-repeat: no-repeat !important;
      }
      .mybriefs-safe-area-surface {
        position: fixed;
        z-index: 2147483000;
        inset: 0 0 auto;
        height: 0.5rem;
        background-color: var(--mybriefs-safe-top, #0a4695);
        pointer-events: none;
      }
      .mybriefs-safe-area-surface[hidden] { display: none; }
      /* 浮いている操作ボタンの下端は safe-area + 0.5rem(top) + 2.75rem(高さ) = safe + 3.25rem。
         見出しがそこへ潜らない「最低ライン」を保証する。
         足し算にすると、元から余白のあるページでおでこだけ間延びする（2026-08-13 に実機で発覚）。
         max なので、元の padding が足りているページは1pxも増えない。
         env() が Safari のタブとホーム画面アプリの差を吸収するので、standalone 用の分岐は要らない */
      .mybriefs-safe-area-hero {
        padding-top: max(
          var(--mybriefs-original-hero-padding-top, 0px),
          calc(env(safe-area-inset-top, 0px) + 3.75rem)
        ) !important;
      }
    }
  `;
  document.head.append(style);

  function syncDocumentBackground() {
    document.documentElement.style.setProperty('--mybriefs-hero-end', `${heroEnd()}px`);
    const surfaceHeight = safeAreaSurface.getBoundingClientRect().height;
    safeAreaSurface.style.backgroundColor = safeTop;
    safeAreaSurface.hidden = hero
      ? hero.getBoundingClientRect().bottom <= surfaceHeight
      : scrollY > 24;
  }

  syncDocumentBackground();
  addEventListener('scroll', syncDocumentBackground, { passive: true });
  addEventListener('pageshow', () => requestAnimationFrame(syncDocumentBackground));
  addEventListener('resize', syncDocumentBackground, { passive: true });
  requestAnimationFrame(() => requestAnimationFrame(syncDocumentBackground));
})();
