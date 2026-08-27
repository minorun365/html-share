import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import type { HtmlShareConfig } from './config.js';

interface DeviceCredentials {
  deviceToken: string;
  deviceName: string;
  apiBase: string;
}

export interface ReviewCard {
  id?: string;
  sessionId?: string;
  title: string;
  question: string;
  context?: string;
  recommendation?: string;
  status?: string;
  source?: string;
  target?: string | null;
  responseText?: string;
  updatedAt?: string;
  createdAt?: string;
}

function credentialsPath(): string {
  return process.env.HTML_SHARE_CREDENTIALS
    ?? path.join(homedir(), '.config', 'html-share', 'review-device.json');
}

function apiBase(config: HtmlShareConfig): string {
  return `https://${config.aws.consoleDomain}/api`;
}

function loadCredentials(): DeviceCredentials | null {
  const file = credentialsPath();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as DeviceCredentials;
    return parsed.deviceToken ? parsed : null;
  } catch {
    return null;
  }
}

function saveCredentials(value: DeviceCredentials): void {
  const file = credentialsPath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

async function request(config: HtmlShareConfig, pathname: string, options: {
  method?: string;
  body?: unknown;
  authenticated?: boolean;
} = {}): Promise<any> {
  const authenticated = options.authenticated !== false;
  const saved = loadCredentials();
  if (authenticated && !saved) throw new Error('This computer is not paired. Run `html-share review pair <code>`.');
  if (authenticated && saved!.apiBase !== apiBase(config)) {
    throw new Error('The paired console does not match this config. Pair this computer again before sending credentials.');
  }
  const serialized = options.body === undefined ? undefined : JSON.stringify(options.body);
  const response = await fetch(`${apiBase(config)}${pathname}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(serialized ? {
        'content-type': 'application/json',
        'x-amz-content-sha256': createHash('sha256').update(serialized).digest('hex'),
      } : {}),
      ...(authenticated ? { 'x-review-device-token': saved!.deviceToken } : {}),
    },
    body: serialized,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Review API returned ${response.status}`);
  return payload;
}

export async function pair(config: HtmlShareConfig, code: string, name = `Computer / ${hostname()}`): Promise<string> {
  const result = await request(config, '/pairings/claim', {
    method: 'POST',
    authenticated: false,
    body: { code, deviceName: name },
  });
  saveCredentials({ deviceToken: result.deviceToken, deviceName: result.deviceName, apiBase: apiBase(config) });
  return result.deviceName;
}

export async function pushReviews(config: HtmlShareConfig, sessionId: string, cards: ReviewCard[]): Promise<ReviewCard[]> {
  const created: ReviewCard[] = [];
  for (const card of cards) {
    const result = await request(config, '/device/reviews', {
      method: 'POST',
      body: { ...card, sessionId },
    });
    created.push(result.item);
  }
  return created;
}

export async function pullReviews(config: HtmlShareConfig, sessionId?: string): Promise<ReviewCard[]> {
  const query = new URLSearchParams({ status: 'answered' });
  if (sessionId) query.set('sessionId', sessionId);
  const result = await request(config, `/device/reviews?${query}`);
  return result.items ?? [];
}

export async function listInbox(config: HtmlShareConfig): Promise<ReviewCard[]> {
  const result = await request(config, `/device/reviews?${new URLSearchParams({ status: 'waiting', sessionId: 'inbox' })}`);
  return [...(result.items ?? [])]
    .filter((item) => item.source === 'owner' || item.sessionId === 'inbox')
    .sort((left, right) => String(left.updatedAt ?? '').localeCompare(String(right.updatedAt ?? '')))
    .map((item) => ({
      ...item,
      target: item.target || null,
    }));
}

export async function completeReviews(config: HtmlShareConfig, ids: string[]): Promise<void> {
  for (const id of ids) {
    await request(config, `/device/reviews/${encodeURIComponent(id)}/complete`, { method: 'POST', body: {} });
  }
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const pidFile = (sessionId: string) => path.join(
  homedir(),
  '.cache',
  'html-share',
  `review-watch-${sessionId.replace(/[^A-Za-z0-9_-]/g, '')}.pid`,
);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function watchReviews(config: HtmlShareConfig, sessionId: string, timeoutMinutes = 240): Promise<ReviewCard[]> {
  const file = pidFile(sessionId);
  if (existsSync(file)) {
    const previous = Number(readFileSync(file, 'utf8').trim());
    if (Number.isInteger(previous) && alive(previous)) throw new Error(`This session is already being watched by PID ${previous}`);
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${process.pid}\n`);
  const cleanup = () => { if (existsSync(file)) rmSync(file); };
  process.once('SIGINT', () => { cleanup(); process.exit(0); });
  process.once('SIGTERM', () => { cleanup(); process.exit(0); });
  const deadline = Date.now() + timeoutMinutes * 60_000;
  try {
    while (Date.now() < deadline) {
      const items = await pullReviews(config, sessionId);
      if (items.length) return items;
      await sleep(20_000);
    }
    return [];
  } finally {
    cleanup();
  }
}

export function stopWatching(sessionId: string): boolean {
  const file = pidFile(sessionId);
  if (!existsSync(file)) return false;
  const pid = Number(readFileSync(file, 'utf8').trim());
  if (Number.isInteger(pid) && alive(pid)) process.kill(pid, 'SIGTERM');
  if (existsSync(file)) rmSync(file);
  return true;
}
