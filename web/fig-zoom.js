// 大きな図を、クリックでブラウザの窓いっぱいに広げる。
// 表・列・線の多い全体図は、本文の幅では文字が小さすぎる。本文の幅を超えて広げると
// ページの流れが崩れる。本文では普通の大きさのまま見せ、クリックで窓いっぱいの重ね画面に出す。
//
// 使い方（ページ側）：広げたい図の囲みに data-zoom を付ける。
//   <figure data-zoom data-zoom-min="1400"><svg viewBox=…>…</svg><figcaption>…</figcaption></figure>
//   data-zoom-min は、重ね画面で図を最低この幅（px）で描く値。窓がそれより狭いと横にスクロールする。
//
// ページが同じオリジンの iframe の中で開かれているときは、開いている間だけ iframe を
// 親の窓いっぱいへ広げる。別オリジンなら iframe の中だけを覆う。
// bundle.ts が data-zoom のあるページにだけ中身をインラインで埋め込む。
(() => {
  const targets = document.querySelectorAll('[data-zoom]');
  if (!targets.length) return;

  const css = `
.mbz-row{display:flex;justify-content:flex-end;margin:0 0 10px}
.mbz-hint{display:inline-flex;align-items:center;gap:6px;
  padding:6px 12px;border:0;border-radius:999px;background:rgba(20,28,48,.78);color:#fff;
  font:600 12.5px/1.2 -apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;cursor:pointer;
  box-shadow:0 4px 14px rgba(20,28,48,.25)}
.mbz-hint:hover{background:rgba(20,28,48,.92)}
[data-zoom]{cursor:zoom-in}
.mbz-over{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;
  background:#f6f8fc;color:#1f2433}
.mbz-bar{flex:none;display:flex;align-items:center;gap:12px;padding:10px 16px;
  padding-top:max(10px,env(safe-area-inset-top));border-bottom:1px solid #dde3ef;background:#fff;
  font:600 14px/1.4 -apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif}
.mbz-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mbz-close{flex:none;border:0;border-radius:999px;padding:7px 16px;background:#1f2433;color:#fff;
  font:600 13px/1 -apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;cursor:pointer}
.mbz-body{flex:1;overflow:auto;-webkit-overflow-scrolling:touch;padding:16px;overscroll-behavior:contain}
.mbz-body svg{display:block;width:100%;height:auto;max-width:none!important;margin:0!important}
html.mbz-open,html.mbz-open body{overflow:hidden}`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  let open = null;   // { over, frame, frameStyle, parentOverflow }

  const close = (fromHistory) => {
    if (!open) return;
    const { over, frame, frameStyle, parentOverflow, focus } = open;
    open = null;
    over.remove();
    document.documentElement.classList.remove('mbz-open');
    if (frame) {
      frame.setAttribute('style', frameStyle || '');
      if (!frameStyle) frame.removeAttribute('style');
      try { frame.ownerDocument.documentElement.style.overflow = parentOverflow; } catch (e) { /* 親に触れなければそのまま */ }
    }
    if (!fromHistory && history.state && history.state.mbz) history.back();
    if (focus) focus.focus({ preventScroll: true });
  };

  const show = (fig) => {
    if (open) return;
    const svg = fig.querySelector('svg');
    if (!svg) return;
    const over = document.createElement('div');
    over.className = 'mbz-over';
    over.setAttribute('role', 'dialog');
    over.setAttribute('aria-modal', 'true');
    const cap = fig.querySelector('figcaption');
    const title = fig.getAttribute('data-zoom-title') || svg.getAttribute('aria-label') || (cap ? cap.textContent : '図');
    const bar = document.createElement('div');
    bar.className = 'mbz-bar';
    const t = document.createElement('div');
    t.className = 'mbz-title';
    t.textContent = title.trim();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mbz-close';
    btn.textContent = '閉じる（Esc）';
    btn.addEventListener('click', () => close(false));
    bar.append(t, btn);
    const body = document.createElement('div');
    body.className = 'mbz-body';
    const copy = svg.cloneNode(true);
    copy.removeAttribute('style');            // 本文側で付いた幅の上限を外す
    copy.removeAttribute('width');
    copy.removeAttribute('height');
    const min = parseFloat(fig.getAttribute('data-zoom-min'));
    if (min > 0) copy.style.minWidth = `${min}px`;
    body.appendChild(copy);
    over.append(bar, body);

    // iframe の中なら、開いている間だけ iframe を親の窓いっぱいへ広げる
    let frame = null;
    let frameStyle = null;
    let parentOverflow = '';
    try {
      frame = window.frameElement;
      if (frame) {
        frameStyle = frame.getAttribute('style');
        parentOverflow = frame.ownerDocument.documentElement.style.overflow;
        frame.style.cssText += ';position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;'
          + 'z-index:2147483000;border:0;margin:0;border-radius:0';
        frame.ownerDocument.documentElement.style.overflow = 'hidden';
      }
    } catch (e) { frame = null; }

    open = { over, frame, frameStyle, parentOverflow, focus: fig };
    document.documentElement.classList.add('mbz-open');
    document.body.appendChild(over);
    btn.focus({ preventScroll: true });
    // スマホの「戻る」で閉じられるように、履歴を1つ積む
    try { history.pushState({ mbz: 1 }, ''); } catch (e) { /* file:// などで積めなくても動く */ }
  };

  for (const fig of targets) {
    const hint = document.createElement('button');
    hint.type = 'button';
    hint.className = 'mbz-hint';
    hint.textContent = '⤢ 画面いっぱいに表示';
    // 図の上に1行を足して置く（図の上へ重ねると、図の端の文字や箱を隠す）
    const row = document.createElement('div');
    row.className = 'mbz-row';
    row.appendChild(hint);
    fig.insertBefore(row, fig.firstChild);
    fig.tabIndex = fig.tabIndex >= 0 ? fig.tabIndex : 0;
    fig.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;      // 図の中のリンクはそのまま開く
      show(fig);
    });
    fig.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(fig); }
    });
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(false); });
  window.addEventListener('popstate', () => close(true));
})();
