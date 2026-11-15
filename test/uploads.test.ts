import assert from 'node:assert/strict';
import test from 'node:test';
import { IMAGE_ONLY_QUESTION, ownerQuestion } from '../functions/review-handler.ts';
import {
  attachableBatch,
  handleDeviceUploads,
  handleOwnerUploads,
  linkBatchToTask,
  type UploadContext,
  type UploadStore,
} from '../functions/uploads.ts';

class FakeDdb {
  items = new Map<string, any>();

  private key(value: any): string {
    return `${value.pk}|${value.sk}`;
  }

  async send(command: any): Promise<any> {
    const name = command.constructor.name;
    const input = command.input;
    if (name === 'PutCommand') {
      const key = this.key(input.Item);
      if (input.ConditionExpression && this.items.has(key)) throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
      this.items.set(key, structuredClone(input.Item));
      return {};
    }
    if (name === 'GetCommand') {
      const item = this.items.get(this.key(input.Key));
      return { Item: item ? structuredClone(item) : undefined };
    }
    if (name === 'QueryCommand') {
      const pk = input.ExpressionAttributeValues[':pk'];
      return { Items: [...this.items.values()].filter((item) => item.pk === pk).map((item) => structuredClone(item)) };
    }
    if (name === 'UpdateCommand') {
      const item = this.items.get(this.key(input.Key));
      if (!item) throw Object.assign(new Error('missing'), { name: 'ConditionalCheckFailedException' });
      // Only `SET a = :a, #b = :b` is needed here.
      for (const part of input.UpdateExpression.replace(/^SET\s+/, '').split(',')) {
        const [left, right] = part.split('=').map((value: string) => value.trim());
        const attribute = left.startsWith('#') ? input.ExpressionAttributeNames[left] : left;
        item[attribute] = structuredClone(input.ExpressionAttributeValues[right]);
      }
      return {};
    }
    if (name === 'DeleteCommand') {
      this.items.delete(this.key(input.Key));
      return {};
    }
    throw new Error(`Unsupported command: ${name}`);
  }
}

class FakeStore implements UploadStore {
  objects = new Set<string>();
  removed: string[] = [];

  async presignPost({ key, maxBytes }: { key: string; maxBytes: number }) {
    return { url: 'https://uploads.example.com/', fields: { key, 'Content-Type': 'image/jpeg', max: String(maxBytes) } };
  }

  async exists(key: string) {
    return this.objects.has(key);
  }

  async presignGet({ key }: { key: string }) {
    return `https://uploads.example.com/${key}?signature=1`;
  }

  async remove(keys: string[]) {
    for (const key of keys) {
      this.objects.delete(key);
      this.removed.push(key);
    }
  }
}

function setup() {
  const ddb = new FakeDdb();
  const store = new FakeStore();
  let sequence = 0;
  const context: UploadContext = {
    ddb,
    table: 'reviews',
    store,
    now: 2_000_000_000,
    uuid: () => `22222222-2222-4222-8222-cccccccc${String(++sequence).padStart(4, '0')}`,
  };
  return { ddb, store, context };
}

test('issues one signed upload per image and rejects out-of-range counts', async () => {
  const { context } = setup();
  assert.equal((await handleOwnerUploads(context, 'POST', '/api/owner/uploads', { count: 0 })).statusCode, 400);
  assert.equal((await handleOwnerUploads(context, 'POST', '/api/owner/uploads', { count: 21 })).statusCode, 400);
  assert.equal((await handleOwnerUploads(context, 'POST', '/api/owner/uploads', { count: 1.5 })).statusCode, 400);

  const created = await handleOwnerUploads(context, 'POST', '/api/owner/uploads', { count: 3 });
  assert.equal(created.statusCode, 201);
  const { batchId, uploads } = created.body as any;
  assert.equal(uploads.length, 3);
  assert.equal(uploads[0].key, `inbox/${batchId}/01.jpg`);
  assert.equal(uploads[2].fields.max, String(15 * 1024 * 1024));
});

test('commits only the images that actually arrived', async () => {
  const { ddb, store, context } = setup();
  const { batchId, uploads } = (await handleOwnerUploads(context, 'POST', '/api/owner/uploads', { count: 3 })).body as any;

  const empty = await handleOwnerUploads(context, 'POST', `/api/owner/uploads/${batchId}/commit`, {});
  assert.equal(empty.statusCode, 400, 'a batch with no images must not become ready');

  store.objects.add(uploads[0].key);
  store.objects.add(uploads[2].key);
  const committed = await handleOwnerUploads(context, 'POST', `/api/owner/uploads/${batchId}/commit`, { note: '  look at this  ' });
  assert.equal(committed.statusCode, 200);
  assert.deepEqual(committed.body, { batchId, count: 2, missing: 1 });
  const stored = ddb.items.get(`UPLOAD|${batchId}`);
  assert.equal(stored.status, 'ready');
  assert.equal(stored.note, 'look at this');
  assert.deepEqual(stored.keys, [uploads[0].key, uploads[2].key]);

  assert.equal((await handleOwnerUploads(context, 'POST', '/api/owner/uploads/not-an-id/commit', {})).statusCode, 400);
  assert.equal(
    (await handleOwnerUploads(context, 'POST', '/api/owner/uploads/33333333-3333-4333-8333-dddddddddddd/commit', {})).statusCode,
    404,
  );
});

test('attaches only ready batches to an owner request', async () => {
  const { ddb, store, context } = setup();
  assert.equal(await attachableBatch(context, undefined), null);
  assert.equal(await attachableBatch(context, ''), null);
  await assert.rejects(attachableBatch(context, 'abc'), { statusCode: 400 });

  const pending = (await handleOwnerUploads(context, 'POST', '/api/owner/uploads', { count: 1 })).body as any;
  await assert.rejects(attachableBatch(context, pending.batchId), { statusCode: 400 }, 'an unfinished upload cannot be attached');

  store.objects.add(pending.uploads[0].key);
  await handleOwnerUploads(context, 'POST', `/api/owner/uploads/${pending.batchId}/commit`, {});
  assert.deepEqual(await attachableBatch(context, pending.batchId), { batchId: pending.batchId, count: 1 });
  await linkBatchToTask(context, pending.batchId, 'task-1');
  assert.equal(ddb.items.get(`UPLOAD|${pending.batchId}`).taskId, 'task-1');
});

test('fills in the question only when images are attached', () => {
  assert.equal(ownerQuestion('', true), IMAGE_ONLY_QUESTION);
  assert.equal(ownerQuestion('  check the error  ', true), 'check the error');
  assert.throws(() => ownerQuestion('', false), { statusCode: 400 });
});

test('lets a paired device download ready batches and then deletes them', async () => {
  const { ddb, store, context } = setup();
  const ready = (await handleOwnerUploads(context, 'POST', '/api/owner/uploads', { count: 2 })).body as any;
  const unfinished = (await handleOwnerUploads(context, 'POST', '/api/owner/uploads', { count: 1 })).body as any;
  for (const upload of ready.uploads) store.objects.add(upload.key);
  await handleOwnerUploads(context, 'POST', `/api/owner/uploads/${ready.batchId}/commit`, { note: 'memo' });
  await linkBatchToTask(context, ready.batchId, 'task-1');

  const listed = await handleDeviceUploads(context, 'GET', '/api/device/uploads');
  assert.equal(listed.statusCode, 200);
  const items = (listed.body as any).items;
  assert.equal(items.length, 1, `only the committed batch is listed, not ${unfinished.batchId}`);
  assert.equal(items[0].taskId, 'task-1');
  assert.equal(items[0].note, 'memo');
  assert.deepEqual(items[0].images.map((image: any) => image.name), ['01.jpg', '02.jpg']);
  assert.match(items[0].images[0].url, /^https:\/\/uploads\.example\.com\/inbox\//);
  assert.equal('pk' in items[0] || 'expiresAt' in items[0], false, 'internal keys stay private');

  const done = await handleDeviceUploads(context, 'POST', `/api/device/uploads/${ready.batchId}/done`);
  assert.equal(done.statusCode, 200);
  assert.equal(store.removed.length, 2);
  assert.equal(ddb.items.has(`UPLOAD|${ready.batchId}`), false);
  const again = await handleDeviceUploads(context, 'POST', `/api/device/uploads/${ready.batchId}/done`);
  assert.equal(again.statusCode, 200, 'a second pickup of the same batch is not an error');
  assert.equal(((await handleDeviceUploads(context, 'GET', '/api/device/uploads')).body as any).items.length, 0);
});

test('hides batches past their expiry even before the table TTL removes them', async () => {
  const { store, context } = setup();
  const batch = (await handleOwnerUploads(context, 'POST', '/api/owner/uploads', { count: 1 })).body as any;
  store.objects.add(batch.uploads[0].key);
  await handleOwnerUploads(context, 'POST', `/api/owner/uploads/${batch.batchId}/commit`, {});
  const later = { ...context, now: context.now + 8 * 24 * 60 * 60 };
  assert.equal(((await handleDeviceUploads(later, 'GET', '/api/device/uploads')).body as any).items.length, 0);
});
