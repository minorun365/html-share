import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { HtmlShareConfig } from './config.js';

interface StarterModule {
  DEFAULT_BRIEF_THEME: string;
  briefThemes(): string[];
  briefSkeleton(options: { title: string; theme?: string }): string;
}

function packageRoot(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (directory !== path.dirname(directory)) {
    if (existsSync(path.join(directory, 'package.json'))) return directory;
    directory = path.dirname(directory);
  }
  throw new Error('package.json not found');
}

/** 雛形の本体は同梱スキル create-html の new-page.mjs。スキル単体でも CLI からでも同じものが出る */
async function starter(): Promise<StarterModule> {
  const file = path.join(packageRoot(), 'skills', 'create-html', 'scripts', 'new-page.mjs');
  return import(pathToFileURL(file).href) as Promise<StarterModule>;
}

/**
 * ページのテーマを決める。--theme が無ければ content.siteTheme と同じ名前のページテーマを使い、
 * 無ければ（classic や自前の .css など）既定の light にする
 */
export async function pageTheme(requested: string | undefined, config?: Pick<HtmlShareConfig, 'content'>): Promise<string> {
  const module = await starter();
  if (requested) return requested;
  const site = config?.content.siteTheme;
  return site && module.briefThemes().includes(site) ? site : module.DEFAULT_BRIEF_THEME;
}

export async function newPage(out: string, title: string, theme: string, force = false): Promise<string> {
  const module = await starter();
  const target = path.resolve(out);
  if (existsSync(target) && !force) throw new Error(`Already exists (pass --force to overwrite): ${target}`);
  const html = module.briefSkeleton({ title, theme });
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, html);
  return target;
}
