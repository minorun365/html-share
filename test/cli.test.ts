import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('page add can create the first content.pages entry', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'html-share-cli-'));
  const config = path.join(directory, 'html-share.config.yaml');
  writeFileSync(config, 'content:\n  pages: []\n');

  const result = spawnSync(process.execPath, [
    '--import',
    'tsx',
    path.join(root, 'src', 'cli.ts'),
    'page',
    'add',
    'pages/first.html',
    '--title',
    'First',
    '--config',
    config,
  ], { cwd: root, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"added":true/);
  assert.match(readFileSync(config, 'utf8'), /pages\/first\.html/);
});
