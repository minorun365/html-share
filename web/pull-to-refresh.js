(() => {
  'use strict';

  if (window.self !== window.top || window.__myBriefsPullToRefresh) return;
  window.__myBriefsPullToRefresh = true;

  const TRIGGER_DISTANCE = 72;
  const MAX_DISTANCE = 112;
  const RESISTANCE = 0.55;
  let startX = 0;
  let startY = 0;
  let distance = 0;
  let tracking = false;
  let refreshing = false;

  const host = document.createElement('div');
  host.id = 'mybriefs-pull-to-refresh';
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  host.setAttribute('aria-label', '下へ引っ張って更新');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host {
        position: fixed;
        z-index: 2147483001;
        top: calc(max(.55rem, env(safe-area-inset-top, 0px) + .35rem));
        left: 50%;
        width: 2.35rem;
        height: 2.35rem;
        display: grid;
        place-items: center;
        border: 1px solid rgba(28, 35, 51, .10);
        border-radius: 999px;
        background: rgba(255, 255, 255, .92);
        color: #0a4695;
        box-shadow: 0 .45rem 1.4rem rgba(14, 13, 106, .18);
        opacity: 0;
        pointer-events: none;
        transform: translate3d(-50%, -4rem, 0);
        transition: opacity .14s ease, transform .14s ease;
        backdrop-filter: blur(18px) saturate(170%);
        -webkit-backdrop-filter: blur(18px) saturate(170%);
      }
      :host([data-active]) { opacity: 1; }
      svg {
        width: 1.05rem;
        height: 1.05rem;
        fill: none;
        stroke: currentColor;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
        transition: transform .14s ease;
      }
      :host([data-ready]) svg { transform: rotate(180deg); }
      :host([data-refreshing]) svg { animation: spin .65s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-transparency: reduce) {
        :host { background: #fff; backdrop-filter: none; -webkit-backdrop-filter: none; }
      }
      @media (prefers-reduced-motion: reduce) {
        :host, svg { transition: none; }
      }
    </style>
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4v13m0 0-5-5m5 5 5-5" />
    </svg>
  `;

  const mount = () => {
    if (!host.isConnected) document.documentElement.append(host);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }

  const scrollTop = () => Math.max(
    document.scrollingElement?.scrollTop ?? 0,
    window.scrollY ?? 0,
  );

  const reset = () => {
    tracking = false;
    distance = 0;
    host.removeAttribute('data-active');
    host.removeAttribute('data-ready');
    host.removeAttribute('data-refreshing');
    host.style.transform = 'translate3d(-50%, -4rem, 0)';
  };

  const update = (nextDistance) => {
    distance = Math.min(MAX_DISTANCE, nextDistance * RESISTANCE);
    host.setAttribute('data-active', '');
    host.toggleAttribute('data-ready', distance >= TRIGGER_DISTANCE);
    host.setAttribute(
      'aria-label',
      distance >= TRIGGER_DISTANCE ? '指を離して更新' : '下へ引っ張って更新',
    );
    host.style.transform = `translate3d(-50%, ${distance - 56}px, 0)`;
  };

  document.addEventListener('touchstart', (event) => {
    if (refreshing || event.touches.length !== 1 || scrollTop() > 0) return;
    if (event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    const touch = event.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    tracking = true;
  }, { passive: true });

  document.addEventListener('touchmove', (event) => {
    if (!tracking || refreshing || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;
    if (Math.abs(deltaX) > Math.abs(deltaY)) {
      reset();
      return;
    }
    if (deltaY <= 0 || scrollTop() > 0) {
      reset();
      return;
    }
    if (event.cancelable) event.preventDefault();
    update(deltaY);
  }, { passive: false });

  const finish = () => {
    if (!tracking || refreshing) return;
    const shouldRefresh = distance >= TRIGGER_DISTANCE;
    if (!shouldRefresh) {
      reset();
      return;
    }
    tracking = false;
    refreshing = true;
    host.removeAttribute('data-ready');
    host.setAttribute('data-refreshing', '');
    host.setAttribute('aria-label', '更新しています');
    host.style.transform = 'translate3d(-50%, 0, 0)';
    location.reload();
  };

  document.addEventListener('touchend', finish, { passive: true });
  document.addEventListener('touchcancel', reset, { passive: true });
})();
