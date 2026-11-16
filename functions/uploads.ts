import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

// スマホからPCへ画像を渡す API。
//
// 画像の中身は Lambda を通さない。CloudFront → Function URL の経路は本文のハッシュ
// （x-amz-content-sha256）と大きさの都合で重い画像に向かないので、ここでは1枚ずつの
// アップロード許可証（署名付き POST）だけを発行し、ブラウザが一時置き場のバケットへ直接送る。
//
//   本人（署名Cookie）: POST /api/owner/uploads              許可証を枚数分もらう（text: true で全文の .txt も1つ）
//                       POST /api/owner/uploads/<id>/commit  送り終えた印（届いた枚数を数え直す）
//   端末（端末トークン）: GET  /api/device/uploads            届いた束と、取り出し用の署名付きURL
//                       POST /api/device/uploads/<id>/done   取り込んだので消す
//
// 画像は一時置き場に長居させない。PCが取り込んだらその場で消し、取り込み忘れは
// バケットのライフサイクルと DynamoDB の TTL が7日で消す。

const UPLOAD_PK = 'UPLOAD';
export const UPLOAD_TTL_SECONDS = 7 * 24 * 60 * 60;
export const MAX_UPLOAD_FILES = 20;
// ブラウザで長辺2000pxのJPEGへ縮めてから送るので、1枚は数百KB〜2MB程度。上限は余裕を持たせる
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const POST_EXPIRES_SECONDS = 10 * 60;
const GET_EXPIRES_SECONDS = 10 * 60;
const BATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTE_MAX = 2000;
// 長い依頼文（音声メモの文字起こしなど）は、画面が .txt に詰めて束へ1つ添える。
// 依頼の表に全文を入れず、画像と同じく取り込んだら消える一時置き場を通す。
export const TEXT_KEY_NAME = 'text.txt';
export const TEXT_CONTENT_TYPE = 'text/plain;charset=utf-8';
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/** 一時置き場を触る小さな窓口。テストでは偽物に差し替える */
export interface UploadStore {
  presignPost(input: { key: string; maxBytes: number; expiresIn: number; contentType: string }): Promise<{ url: string; fields: Record<string, string> }>;
  exists(key: string): Promise<boolean>;
  presignGet(input: { key: string; expiresIn: number }): Promise<string>;
  remove(keys: string[]): Promise<void>;
}

export interface UploadContext {
  ddb: { send(command: any): Promise<any> };
  table: string;
  store: UploadStore;
  now: number;
  uuid: () => string;
}

function reply(statusCode: number, body: unknown): { statusCode: number; body: unknown } {
  return { statusCode, body };
}

export function isBatchId(value: unknown): boolean {
  return BATCH_ID.test(String(value ?? ''));
}

export function uploadKey(batchId: string, index: number): string {
  return `inbox/${batchId}/${String(index + 1).padStart(2, '0')}.jpg`;
}

export function textKey(batchId: string): string {
  return `inbox/${batchId}/${TEXT_KEY_NAME}`;
}

const isTextKey = (key: string): boolean => key.endsWith(`/${TEXT_KEY_NAME}`);

function publicBatch(item: any): any {
  const { pk: _pk, sk: _sk, expiresAt: _expiresAt, ...rest } = item;
  return rest;
}

/**
 * S3 を使う既定の窓口。署名付きPOSTの宛先は、CSP の connect-src と CORS にそろえた
 * UPLOAD_BUCKET_ORIGIN を使う（署名はポリシー文書に掛かるので、宛先のホスト名には依存しない）。
 */
export function s3UploadStore(): UploadStore {
  let client: S3Client | undefined;
  const s3 = () => (client ??= new S3Client({}));
  const bucket = () => {
    const value = process.env.UPLOAD_BUCKET_NAME;
    if (!value) throw new Error('UPLOAD_BUCKET_NAME is not configured');
    return value;
  };
  return {
    async presignPost({ key, maxBytes, expiresIn, contentType }) {
      const { url, fields } = await createPresignedPost(s3(), {
        Bucket: bucket(),
        Key: key,
        Conditions: [['content-length-range', 1, maxBytes], ['eq', '$Content-Type', contentType]],
        Fields: { 'Content-Type': contentType },
        Expires: expiresIn,
      });
      return { url: process.env.UPLOAD_BUCKET_ORIGIN ? `${process.env.UPLOAD_BUCKET_ORIGIN}/` : url, fields };
    },
    async exists(key) {
      try {
        await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
        return true;
      } catch (error: any) {
        if (error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) return false;
        throw error;
      }
    },
    presignGet({ key, expiresIn }) {
      return getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucket(), Key: key }), { expiresIn });
    },
    async remove(keys) {
      if (keys.length === 0) return;
      await s3().send(new DeleteObjectsCommand({
        Bucket: bucket(),
        Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
      }));
    },
  };
}

/**
 * 依頼（POST /api/owner/reviews）に添える束を確かめる。送り終えた印（ready）の付いた束だけを受け付ける。
 * 添付が無ければ null。
 */
export async function attachableBatch(
  context: Pick<UploadContext, 'ddb' | 'table'>,
  batchId: unknown,
): Promise<{ batchId: string; count: number; hasText: boolean } | null> {
  if (batchId === undefined || batchId === null || batchId === '') return null;
  if (!isBatchId(batchId)) throw Object.assign(new Error('Invalid attachment'), { statusCode: 400 });
  const item = (await context.ddb.send(new GetCommand({
    TableName: context.table,
    Key: { pk: UPLOAD_PK, sk: String(batchId) },
    ConsistentRead: true,
  }))).Item;
  if (!item || item.status !== 'ready') {
    throw Object.assign(new Error('Attachment is not ready'), { statusCode: 400 });
  }
  // count は添付のうち画像の枚数。全文の .txt は数えず、hasText で知らせる
  const keys: string[] = item.keys ?? [];
  return { batchId: String(batchId), count: keys.filter((key) => !isTextKey(key)).length, hasText: keys.some(isTextKey) };
}

/** 依頼に添えた束へ、その依頼の ID を書いておく（PCが束と依頼を結び付けられるように） */
export async function linkBatchToTask(context: Pick<UploadContext, 'ddb' | 'table'>, batchId: string, taskId: string): Promise<void> {
  await context.ddb.send(new UpdateCommand({
    TableName: context.table,
    Key: { pk: UPLOAD_PK, sk: batchId },
    UpdateExpression: 'SET taskId = :task',
    ConditionExpression: 'attribute_exists(pk)',
    ExpressionAttributeValues: { ':task': taskId },
  }));
}

async function readBatch(context: UploadContext, batchId: string): Promise<any> {
  return (await context.ddb.send(new GetCommand({
    TableName: context.table,
    Key: { pk: UPLOAD_PK, sk: batchId },
    ConsistentRead: true,
  }))).Item;
}

/** 本人側の2つ。認証（署名Cookie）と送信元の確認は呼び出し元で済ませておく */
export async function handleOwnerUploads(
  context: UploadContext,
  verb: string,
  path: string,
  body: Record<string, any>,
): Promise<{ statusCode: number; body: unknown }> {
  if (verb === 'POST' && path === '/api/owner/uploads') {
    const count = Number(body.count ?? 0);
    const withText = body.text === true;
    if (!Number.isInteger(count) || count < (withText ? 0 : 1) || count > MAX_UPLOAD_FILES) {
      return reply(400, { error: `Send between ${withText ? 0 : 1} and ${MAX_UPLOAD_FILES} images` });
    }
    const batchId = context.uuid();
    // 画像が先、全文の .txt が最後
    const keys = Array.from({ length: count }, (_, index) => uploadKey(batchId, index));
    if (withText) keys.push(textKey(batchId));
    const iso = new Date(context.now * 1000).toISOString();
    await context.ddb.send(new PutCommand({
      TableName: context.table,
      Item: {
        pk: UPLOAD_PK, sk: batchId, batchId,
        status: 'uploading',
        keys,
        count: 0,
        createdAt: iso,
        updatedAt: iso,
        expiresAt: context.now + UPLOAD_TTL_SECONDS,
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
    const uploads = await Promise.all(keys.map(async (key) => ({
      key,
      ...(await context.store.presignPost(isTextKey(key)
        ? { key, maxBytes: MAX_TEXT_BYTES, expiresIn: POST_EXPIRES_SECONDS, contentType: TEXT_CONTENT_TYPE }
        : { key, maxBytes: MAX_UPLOAD_BYTES, expiresIn: POST_EXPIRES_SECONDS, contentType: 'image/jpeg' })),
    })));
    return reply(201, { batchId, uploads });
  }

  const commit = path.match(/^\/api\/owner\/uploads\/([^/]+)\/commit$/);
  if (verb === 'POST' && commit) {
    if (!isBatchId(commit[1])) return reply(400, { error: 'Invalid upload ID' });
    const current = await readBatch(context, commit[1]);
    if (!current) return reply(404, { error: 'This upload has expired' });
    // 途中で電波が切れた分は数えない。届いたものだけを束に残す
    const keys: string[] = current.keys ?? [];
    const found = await Promise.all(keys.map((key) => context.store.exists(key)));
    const present = keys.filter((_, index) => found[index]);
    if (present.length === 0) return reply(400, { error: 'No attachments were received' });
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, NOTE_MAX) : '';
    await context.ddb.send(new UpdateCommand({
      TableName: context.table,
      Key: { pk: UPLOAD_PK, sk: commit[1] },
      UpdateExpression: 'SET #status = :ready, #keys = :keys, #count = :count, note = :note, updatedAt = :updatedAt',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: { '#status': 'status', '#keys': 'keys', '#count': 'count' },
      ExpressionAttributeValues: {
        ':ready': 'ready',
        ':keys': present,
        ':count': present.length,
        ':note': note,
        ':updatedAt': new Date(context.now * 1000).toISOString(),
      },
    }));
    return reply(200, { batchId: commit[1], count: present.length, missing: keys.length - present.length });
  }

  return reply(404, { error: 'Not found' });
}

/** 端末側の2つ。端末トークンの確認は呼び出し元で済ませておく */
export async function handleDeviceUploads(
  context: UploadContext,
  verb: string,
  path: string,
): Promise<{ statusCode: number; body: unknown }> {
  if (verb === 'GET' && path === '/api/device/uploads') {
    const result = await context.ddb.send(new QueryCommand({
      TableName: context.table,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': UPLOAD_PK },
      ConsistentRead: true,
    }));
    const ready = (result.Items ?? [])
      .filter((item: any) => item.status === 'ready' && item.expiresAt > context.now)
      .sort((left: any, right: any) => String(left.createdAt).localeCompare(String(right.createdAt)));
    const items = await Promise.all(ready.map(async (item: any) => ({
      ...publicBatch(item),
      images: await Promise.all((item.keys ?? []).map(async (key: string) => ({
        name: key.split('/').pop(),
        url: await context.store.presignGet({ key, expiresIn: GET_EXPIRES_SECONDS }),
      }))),
    })));
    return reply(200, { items });
  }

  const done = path.match(/^\/api\/device\/uploads\/([^/]+)\/done$/);
  if (verb === 'POST' && done) {
    if (!isBatchId(done[1])) return reply(400, { error: 'Invalid upload ID' });
    const current = await readBatch(context, done[1]);
    // 2台のPCが同じ束を取り込んでも、後から来た側は成功として扱う
    if (!current) return reply(200, { deleted: done[1], already: true });
    await context.store.remove(current.keys ?? []);
    await context.ddb.send(new DeleteCommand({
      TableName: context.table,
      Key: { pk: UPLOAD_PK, sk: done[1] },
    }));
    return reply(200, { deleted: done[1] });
  }

  return reply(404, { error: 'Not found' });
}
