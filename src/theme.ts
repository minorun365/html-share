import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HtmlShareConfig } from './config.js';
import { resolveFromConfig } from './config.js';

/** 何も書かなければこのテーマ。淡い地にグラデを敷き、上バーを帯にしない */
export const DEFAULT_SITE_THEME = 'light';
/** テーマを差し込まず、画面の元の配色（濃い青の上バー）のまま配る */
export const CLASSIC_SITE_THEME = 'classic';

/** テーマを当てる管理面の画面。web/ からの相対パス。入口（index.html）は独自の淡い配色なので当てない */
export const THEMED_SCREENS = ['app/index.html', 'review/index.html'];

export interface SiteTheme {
  name: string;
  /** 画面の <style> の末尾へ足す CSS（テーマの変数＋_base.css）。classic は null */
  css: string | null;
  /** 上端の色。theme-color と Web アプリのマニフェストへ入れる */
  base: string;
  /** マニフェストの background_color */
  background: string;
}

function packageRoot(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (directory !== path.dirname(directory)) {
    if (existsSync(path.join(directory, 'package.json'))) return directory;
    directory = path.dirname(directory);
  }
  throw new Error('package.json not found');
}

/** 同梱のテーマのファイル（themes/site/<名前>.css） */
export function themeFile(name: string): string {
  return path.join(packageRoot(), 'themes', 'site', `${name}.css`);
}

/**
 * content.siteTheme からテーマを読む。
 *   省略 … light
 *   classic … 差し込まない（元の配色）
 *   英小文字の名前 … 同梱の themes/site/<名前>.css
 *   .css で終わる値 … 設定ファイルからの相対パスにある自前のテーマ
 */
export function loadSiteTheme(config: Pick<HtmlShareConfig, 'content' | 'baseDir'>): SiteTheme {
  const name = config.content.siteTheme ?? DEFAULT_SITE_THEME;
  if (name === CLASSIC_SITE_THEME) {
    return { name, css: null, base: '#0e0d6a', background: '#f6f7f9' };
  }
  const file = name.endsWith('.css') ? resolveFromConfig(config as HtmlShareConfig, name) : themeFile(name);
  if (!existsSync(file)) {
    throw new Error(`content.siteTheme: theme not found: ${name} (${file})`);
  }
  const vars = readFileSync(file, 'utf8');
  // テーマは <style> の中へ入れるので、閉じタグの文字列があるとそこで CSS が終わり、残りが本文に文字で出る
  if (/<\/style/i.test(vars)) throw new Error(`content.siteTheme: ${name} contains "</style"; remove it (a comment counts too)`);
  const base = vars.match(/--t-base\s*:\s*(#[0-9a-f]{6})\b/i)?.[1];
  if (!base) throw new Error(`content.siteTheme: ${name} has no --t-base color (#rrggbb)`);
  const shared = readFileSync(path.join(packageRoot(), 'themes', 'site', '_base.css'), 'utf8');
  if (/<\/style/i.test(shared)) throw new Error('themes/site/_base.css contains "</style"');
  return { name, css: `${vars.trim()}\n${shared.trim()}`, base, background: base };
}

/**
 * 画面の HTML にテーマを当てる。最後の </style> の直前へ入れ、元の CSS を後ろから上書きする。
 * theme-color もテーマの上端色へ揃える（ホーム画面に追加したアプリは、追加した時点の HTML の値を使う）
 */
export function themeShell(html: string, theme: SiteTheme, name = 'screen'): string {
  if (!theme.css) return html;
  const at = html.lastIndexOf('</style>');
  if (at < 0) throw new Error(`${name} has no <style> element to append the site theme to`);
  const themed = `${html.slice(0, at)}\n/* ── site theme: ${theme.name} ── */\n${theme.css}\n${html.slice(at)}`;
  return themed.replace(/<meta name="theme-color" content="#[0-9a-f]{3,8}">/i, `<meta name="theme-color" content="${theme.base}">`);
}
