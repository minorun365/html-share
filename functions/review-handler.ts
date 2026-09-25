import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { getSignedUrl } from '@aws-sdk/cloudfront-signer';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const ssm = new SSMClient({});
const TASK_TTL_SECONDS = 90 * 24 * 60 * 60;
const PAIR_TTL_SECONDS = 10 * 60;
const PREFERENCES_KEY = { pk: 'OWNER', sk: 'PREFERENCES' };
const OWNER_DEVICE_ID = 'OWNER';
const INBOX_SESSION_ID = 'inbox';
let privateKeyPromise: Promise<string> | undefined;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function json(statusCode: number, body: unknown): any {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
    body: JSON.stringify(body),
  };
}

function parseBody(event: any): Record<string, any> {
  if (!event.body) return {};
  const source = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    return JSON.parse(source);
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 });
  }
}

function clean(value: unknown, name: string, maximum: number, needed = false): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (needed && !result) throw Object.assign(new Error(`${name} is required`), { statusCode: 400 });
  if (result.length > maximum) throw Object.assign(new Error(`${name} is too long`), { statusCode: 400 });
  return result;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function privateKey(): Promise<string> {
  if (!privateKeyPromise) {
    privateKeyPromise = ssm.send(new GetParameterCommand({
      Name: required('PRIVATE_KEY_PARAMETER_NAME'),
      WithDecryption: true,
    })).then((result) => {
      const value = result.Parameter?.Value;
      if (!value) throw new Error('CloudFront private key is empty');
      return value;
    });
  }
  return privateKeyPromise;
}

function cleanSourceList(value: unknown, name: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw Object.assign(new Error(`${name} is invalid`), { statusCode: 400 });
  }
  return [...new Set(value.map((item) => clean(item, name, 500, true)))];
}

/**
 * 進行中の棚から ✓ で下ろした項目の id。
 * 棚を知らない古いクライアントは shelfDone を送らないので、そのときは保存済みの値を残す。
 */
export function cleanShelfDone(value: unknown, stored: unknown): string[] {
  if (value === undefined) {
    return Array.isArray(stored) ? stored.filter((item): item is string => typeof item === 'string') : [];
  }
  return cleanSourceList(value, 'shelfDone', 300);
}

function isoOrNull(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && !Number.isNaN(Date.parse(text)) ? text : null;
}

export function cleanReadMark(value: unknown): { v: string | null; at: string } | null {
  const legacy = typeof value === 'string' ? isoOrNull(value) : null;
  if (legacy) return { v: legacy, at: legacy };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { v?: unknown; at?: unknown };
  const at = isoOrNull(record.at);
  return at ? { v: isoOrNull(record.v), at } : null;
}

export function cleanReadMarks(value: unknown, maximum: number): Record<string, { v: string | null; at: string }> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('readMarks is invalid'), { statusCode: 400 });
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > maximum) throw Object.assign(new Error('readMarks is too large'), { statusCode: 400 });
  const marks: Record<string, { v: string | null; at: string }> = {};
  for (const [source, mark] of entries) {
    const key = clean(source, 'source', 500);
    const cleaned = cleanReadMark(mark);
    if (!key || !cleaned) continue;
    marks[key] = cleaned;
  }
  return marks;
}

function titleFromBody(text: string): string {
  const firstLine = text.split('\n').find((line) => line.trim()) ?? '';
  const trimmed = firstLine.trim();
  return trimmed.length > 28 ? `${trimmed.slice(0, 28)}…` : trimmed;
}

function internalCidrs(): string[] {
  try {
    const values = JSON.parse(required('ALLOWED_INTERNAL_CIDRS'));
    return Array.isArray(values) ? values.filter((value) => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function normalizeCode(value: unknown): string {
  return String(value ?? '').replace(/[^A-Z2-9]/gi, '').toUpperCase();
}

function pairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  const text = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
  return `${text.slice(0, 4)}-${text.slice(4)}`;
}

function method(event: any): string {
  return event.requestContext?.http?.method ?? event.httpMethod ?? 'GET';
}

function pathname(event: any): string {
  return event.rawPath ?? event.requestContext?.http?.path ?? '';
}

function validOrigin(event: any): boolean {
  return String(event.headers?.origin ?? '') === required('CONSOLE_ORIGIN');
}

async function device(event: any): Promise<{ id: string; name: string } | null> {
  const token = String(event.headers?.['x-review-device-token'] ?? '');
  if (!/^[A-Za-z0-9_-]{40,}$/.test(token)) return null;
  const id = hash(token);
  const result = await ddb.send(new GetCommand({
    TableName: required('REVIEW_TABLE_NAME'),
    Key: { pk: 'DEVICE', sk: id },
    ConsistentRead: true,
  }));
  if (!result.Item || result.Item.revokedAt) return null;
  return { id, name: result.Item.name ?? 'Computer' };
}

async function tasks(): Promise<any[]> {
  const result = await ddb.send(new QueryCommand({
    TableName: required('REVIEW_TABLE_NAME'),
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': 'TASK' },
    ConsistentRead: true,
  }));
  return result.Items ?? [];
}

function publicTask(item: any): any {
  const { pk: _pk, sk: _sk, deviceId: _deviceId, expiresAt: _expiresAt, ...rest } = item;
  return rest;
}

export async function handler(event: any): Promise<any> {
  try {
    const verb = method(event);
    const path = pathname(event);
    const now = Math.floor(Date.now() / 1000);
    const table = required('REVIEW_TABLE_NAME');

    if (verb === 'POST' && path === '/api/pairings/claim') {
      const body = parseBody(event);
      const code = normalizeCode(body.code);
      if (code.length !== 8) return json(400, { error: 'Invalid pairing code' });
      const token = randomBytes(32).toString('base64url');
      const deviceId = hash(token);
      const name = clean(body.deviceName, 'deviceName', 80) || 'Computer';
      await ddb.send(new TransactWriteCommand({ TransactItems: [
        {
          Update: {
            TableName: table,
            Key: { pk: 'PAIR', sk: hash(code) },
            UpdateExpression: 'SET claimedAt = :now',
            ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(claimedAt) AND expiresAt > :now',
            ExpressionAttributeValues: { ':now': now },
          },
        },
        {
          Put: {
            TableName: table,
            Item: { pk: 'DEVICE', sk: deviceId, name, createdAt: new Date().toISOString() },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
      ] }));
      return json(200, { deviceToken: token, deviceName: name });
    }

    if (path.startsWith('/api/owner/')) {
      if (!validOrigin(event) && verb !== 'GET') return json(403, { error: 'Invalid origin' });
      if (verb === 'POST' && path === '/api/owner/pairings') {
        const code = pairingCode();
        await ddb.send(new PutCommand({
          TableName: table,
          Item: { pk: 'PAIR', sk: hash(normalizeCode(code)), createdAt: new Date().toISOString(), expiresAt: now + PAIR_TTL_SECONDS },
        }));
        return json(201, { code, expiresAt: now + PAIR_TTL_SECONDS });
      }
      if (verb === 'GET' && path === '/api/owner/reviews') {
        const items = (await tasks())
          .filter((item) => item.status !== 'deleted')
          .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
          .map(publicTask);
        return json(200, { items });
      }
      if (verb === 'POST' && path === '/api/owner/reviews') {
        const body = parseBody(event);
        const question = clean(body.question, 'question', 2000, true);
        const id = randomUUID();
        const iso = new Date().toISOString();
        const item = {
          pk: 'TASK', sk: id, id,
          source: 'owner',
          deviceId: OWNER_DEVICE_ID,
          sessionId: INBOX_SESSION_ID,
          title: clean(body.title, 'title', 120) || titleFromBody(question),
          question,
          // Nickname hint for the starting project. The ingesting agent resolves it to a path.
          target: clean(body.target, 'target', 60),
          context: '',
          recommendation: '',
          status: 'waiting',
          createdAt: iso,
          updatedAt: iso,
          expiresAt: now + TASK_TTL_SECONDS,
        };
        await ddb.send(new PutCommand({ TableName: table, Item: item, ConditionExpression: 'attribute_not_exists(pk)' }));
        return json(201, { item: publicTask(item) });
      }
      if (verb === 'GET' && path === '/api/owner/preferences') {
        const result = await ddb.send(new GetCommand({
          TableName: table,
          Key: PREFERENCES_KEY,
          ConsistentRead: true,
        }));
        return json(200, {
          exists: Boolean(result.Item),
          starredSources: result.Item?.starredSources ?? [],
          recentSources: result.Item?.recentSources ?? [],
          hiddenSources: result.Item?.hiddenSources ?? [],
          readMarks: result.Item?.readMarks ?? null,
          shelfDone: result.Item?.shelfDone ?? [],
          updatedAt: result.Item?.updatedAt ?? null,
        });
      }
      if (verb === 'PUT' && path === '/api/owner/preferences') {
        const body = parseBody(event);
        const starredSources = cleanSourceList(body.starredSources ?? [], 'starredSources', 200);
        const recentSources = cleanSourceList(body.recentSources ?? [], 'recentSources', 6);
        const hiddenSources = cleanSourceList(body.hiddenSources ?? [], 'hiddenSources', 500);
        const readMarks = cleanReadMarks(body.readMarks ?? {}, 800);
        const stored = body.shelfDone === undefined
          ? (await ddb.send(new GetCommand({ TableName: table, Key: PREFERENCES_KEY, ConsistentRead: true }))).Item?.shelfDone
          : undefined;
        const shelfDone = cleanShelfDone(body.shelfDone, stored);
        const updatedAt = new Date().toISOString();
        await ddb.send(new PutCommand({
          TableName: table,
          Item: { ...PREFERENCES_KEY, starredSources, recentSources, hiddenSources, readMarks, shelfDone, updatedAt },
        }));
        return json(200, { starredSources, recentSources, hiddenSources, readMarks, shelfDone, updatedAt });
      }
      if (verb === 'POST' && path === '/api/owner/shares') {
        const body = parseBody(event);
        const slug = clean(body.slug, 'slug', 128, true);
        if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return json(400, { error: 'Invalid slug' });
        const scope = body.scope === 'internal' ? 'internal' : body.scope === 'public' ? 'public' : '';
        if (!scope) return json(400, { error: 'Invalid share scope' });
        const days = Number(body.days);
        const maximumDays = Number(required('MAXIMUM_SHARE_DAYS'));
        if (!Number.isInteger(days) || days < 1 || days > maximumDays) {
          return json(400, { error: `Share duration must be between 1 and ${maximumDays} days` });
        }
        const expiresAt = now + days * 24 * 60 * 60;
        const url = `${required('CONTENT_ORIGIN')}/pages/${slug}/index.html`;
        const credentials = {
          keyPairId: required('CLOUDFRONT_KEY_PAIR_ID'),
          privateKey: await privateKey(),
        };
        let signedUrl: string;
        if (scope === 'internal') {
          const cidrs = internalCidrs();
          if (cidrs.length === 0) return json(400, { error: 'Internal sharing is not configured' });
          const policy = JSON.stringify({ Statement: cidrs.map((sourceIp) => ({
            Resource: url,
            Condition: {
              DateLessThan: { 'AWS:EpochTime': expiresAt },
              IpAddress: { 'AWS:SourceIp': sourceIp },
            },
          })) });
          signedUrl = getSignedUrl({ ...credentials, url, policy });
        } else {
          signedUrl = getSignedUrl({ ...credentials, url, dateLessThan: new Date(expiresAt * 1000) });
        }
        return json(201, { url: signedUrl, expiresAt });
      }
      const remove = path.match(/^\/api\/owner\/reviews\/([^/]+)$/);
      if (verb === 'DELETE' && remove) {
        await ddb.send(new DeleteCommand({
          TableName: table,
          Key: { pk: 'TASK', sk: remove[1] },
          ConditionExpression: 'attribute_exists(pk)',
        }));
        return json(200, { ok: true });
      }
      const answer = path.match(/^\/api\/owner\/reviews\/([^/]+)\/answer$/);
      if (verb === 'POST' && answer) {
        const body = parseBody(event);
        const responseText = clean(body.responseText, 'responseText', 4000);
        const approved = body.approved === true;
        if (!approved && !responseText) return json(400, { error: 'Approval or comment is required' });
        const result = await ddb.send(new UpdateCommand({
          TableName: table,
          Key: { pk: 'TASK', sk: answer[1] },
          UpdateExpression: 'SET #status = :status, approved = :approved, responseText = :response, updatedAt = :updatedAt',
          ConditionExpression: 'attribute_exists(pk) AND #status = :waiting',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':status': 'answered', ':waiting': 'waiting', ':approved': approved, ':response': responseText,
            ':updatedAt': new Date().toISOString(),
          },
          ReturnValues: 'ALL_NEW',
        }));
        return json(200, { item: publicTask(result.Attributes) });
      }
      return json(404, { error: 'Not found' });
    }

    if (path.startsWith('/api/device/')) {
      const current = await device(event);
      if (!current) return json(401, { error: 'Device authentication is required' });
      if (verb === 'POST' && path === '/api/device/reviews') {
        const body = parseBody(event);
        const id = randomUUID();
        const item = {
          pk: 'TASK', sk: id, id, deviceId: current.id,
          source: 'claude-code',
          sessionId: clean(body.sessionId, 'sessionId', 180, true),
          title: clean(body.title, 'title', 160, true),
          question: clean(body.question, 'question', 1000, true),
          context: clean(body.context, 'context', 3000),
          recommendation: clean(body.recommendation, 'recommendation', 1000),
          status: 'waiting',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          expiresAt: now + TASK_TTL_SECONDS,
        };
        await ddb.send(new PutCommand({ TableName: table, Item: item, ConditionExpression: 'attribute_not_exists(pk)' }));
        return json(201, { item: publicTask(item) });
      }
      if (verb === 'GET' && path === '/api/device/reviews') {
        const status = event.queryStringParameters?.status;
        const sessionId = event.queryStringParameters?.sessionId;
        const items = (await tasks())
          .filter((item) => item.deviceId === current.id || item.deviceId === OWNER_DEVICE_ID)
          .filter((item) => !status || item.status === status)
          .filter((item) => !sessionId || item.sessionId === sessionId)
          .map(publicTask);
        return json(200, { items });
      }
      const complete = path.match(/^\/api\/device\/reviews\/([^/]+)\/complete$/);
      if (verb === 'POST' && complete) {
        await ddb.send(new UpdateCommand({
          TableName: table,
          Key: { pk: 'TASK', sk: complete[1] },
          UpdateExpression: 'SET #status = :completed, completedAt = :now, updatedAt = :now',
          ConditionExpression: 'attribute_exists(pk) AND (deviceId = :deviceId OR deviceId = :owner)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':completed': 'completed',
            ':deviceId': current.id,
            ':owner': OWNER_DEVICE_ID,
            ':now': new Date().toISOString(),
          },
        }));
        return json(200, { ok: true });
      }
      return json(404, { error: 'Not found' });
    }

    return json(404, { error: 'Not found' });
  } catch (error: any) {
    console.error(JSON.stringify({ level: 'error', message: error instanceof Error ? error.message : 'Unknown error' }));
    return json(error?.statusCode ?? (error?.name === 'ConditionalCheckFailedException' ? 409 : 500), {
      error: error?.name === 'ConditionalCheckFailedException' ? 'This request is expired or already used' : 'Request failed',
    });
  }
}
