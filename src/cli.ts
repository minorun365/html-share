#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { buildOnly, publish, share } from './publish.js';
import { initializeKeys, storePrivateKey } from './keys.js';
import { addPageToConfig, loadConfig } from './config.js';
import {
  completeReviews,
  listInbox,
  pair,
  pullReviews,
  pushReviews,
  stopWatching,
  watchReviews,
  type ReviewCard,
} from './review-client.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

async function stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function usage(): never {
  console.error(`HTML共有くん

Usage:
  html-share build [--config file]
  html-share publish [--config file]
  html-share share <slug> [--days 7]
  html-share page add <path> [--title title]
  html-share keys init [--overwrite]
  html-share keys store [--overwrite]
  html-share review pair <code> [--name name]
  html-share review push --session <id> [--file cards.json]
  html-share review pull [--session <id>]
  html-share review inbox
  html-share review complete <id...>
  html-share review watch --session <id> [--timeout-minutes 240]
  html-share review stop --session <id>`);
  process.exit(2);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || flag('--help') || flag('-h')) usage();

  // page add is the command that creates the first content.pages entry, so it must
  // be able to run before the complete config passes normal publish validation.
  if (command === 'page') {
    const action = process.argv[3];
    const pagePath = process.argv[4];
    if (action !== 'add' || !pagePath) usage();
    const added = addPageToConfig(option('--config'), pagePath, option('--title'));
    console.log(JSON.stringify({ ok: true, added, path: pagePath }));
    return;
  }

  const config = loadConfig(option('--config'));

  if (command === 'build') {
    const result = buildOnly(config);
    console.log(JSON.stringify({ ok: true, pages: result.manifest.pages.length, buildRoot: result.buildRoot }, null, 2));
    return;
  }
  if (command === 'publish') {
    console.log(JSON.stringify({ ok: true, ...(await publish(config)) }, null, 2));
    return;
  }
  if (command === 'share') {
    const query = process.argv[3];
    if (!query) usage();
    const days = Number(option('--days') ?? 7);
    console.log(share(config, query, days));
    return;
  }
  if (command === 'keys') {
    const action = process.argv[3];
    if (action === 'init') {
      const result = initializeKeys(config, flag('--overwrite'));
      console.log(JSON.stringify({ ok: true, publicKeyPath: result.publicKeyPath, privateKeyPath: result.privateKeyPath }, null, 2));
      return;
    }
    if (action === 'store') {
      await storePrivateKey(config, flag('--overwrite'));
      console.log(JSON.stringify({ ok: true, parameterName: config.aws.privateKeyParameterName }));
      return;
    }
    usage();
  }
  if (command === 'review') {
    const action = process.argv[3];
    if (action === 'pair') {
      const code = process.argv[4];
      if (!code) usage();
      console.log(JSON.stringify({ ok: true, deviceName: await pair(config, code, option('--name')) }));
      return;
    }
    if (action === 'push') {
      const sessionId = option('--session');
      if (!sessionId) usage();
      const source = option('--file') ? readFileSync(option('--file')!, 'utf8') : await stdin();
      const input = JSON.parse(source) as ReviewCard | ReviewCard[];
      const cards = Array.isArray(input) ? input : [input];
      console.log(JSON.stringify({ ok: true, items: await pushReviews(config, sessionId, cards) }, null, 2));
      return;
    }
    if (action === 'pull') {
      console.log(JSON.stringify({ ok: true, items: await pullReviews(config, option('--session')) }, null, 2));
      return;
    }
    if (action === 'inbox') {
      const requests = await listInbox(config);
      // The hint travels with the data so an agent that skipped the skill still closes what it
      // picked up. A request left open is indistinguishable from one no computer has taken yet.
      const next = requests.length
        ? 'Oldest first. Close them all with `html-share review complete <id...>` before starting,'
          + ' then identify each request\'s working folder and work through them in order.'
          + ' `target` is a nickname hint, not a filesystem path — verify it before using it.'
          + ' The inbox is a handover box, not a progress tracker, so do not wait for the work to finish.'
          + ' Report progress and results in chat.'
        : undefined;
      console.log(JSON.stringify({ ok: true, requests, ...(next ? { next } : {}) }, null, 2));
      return;
    }
    if (action === 'complete') {
      const ids = process.argv.slice(4).filter((value) => !value.startsWith('--'));
      if (!ids.length) usage();
      await completeReviews(config, ids);
      console.log(JSON.stringify({ ok: true, completed: ids }));
      return;
    }
    if (action === 'watch') {
      const sessionId = option('--session');
      if (!sessionId) usage();
      const timeoutMinutes = Number(option('--timeout-minutes') ?? 240);
      console.log(JSON.stringify({ ok: true, items: await watchReviews(config, sessionId, timeoutMinutes) }, null, 2));
      return;
    }
    if (action === 'stop') {
      const sessionId = option('--session');
      if (!sessionId) usage();
      console.log(JSON.stringify({ ok: true, stopped: stopWatching(sessionId) }));
      return;
    }
    usage();
  }
  usage();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
