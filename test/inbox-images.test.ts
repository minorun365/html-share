// Folder and file names follow the computer's local time. Pin it so the test does not depend on the runner.
process.env.TZ = 'Asia/Tokyo';

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  attachedFiles,
  filesForBatch,
  localParts,
  pruneImages,
  pullImages,
  readImageIndex,
  recentBatches,
  type UploadBatch,
} from '../src/inbox-images.ts';

const A = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const B = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';

function fakeApi() {
  const batches: UploadBatch[] = [
    {
      batchId: A, createdAt: '2026-11-15T03:04:05.000Z', note: '', taskId: null,
      images: [{ name: '01.jpg', url: 'u/a1' }, { name: '02.jpg', url: 'u/a2' }],
    },
    {
      batchId: B, createdAt: '2026-11-15T16:00:00.000Z', note: 'memo', taskId: 'task-1',
      images: [{ name: '01.jpg', url: 'u/b1' }],
    },
  ];
  const done: string[] = [];
  return {
    done,
    list: async () => batches.filter((batch) => !done.includes(batch.batchId)),
    finish: async (batchId: string) => { done.push(batchId); },
    download: async (url: string) => Buffer.from(`jpeg:${url}`),
  };
}

test('downloads phone images into local-date folders and records the matching request', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'html-share-images-'));
  try {
    const api = fakeApi();
    const options = { list: api.list, done: api.finish, download: api.download, dir };

    const onlyB = await pullImages({ ...options, only: [B] });
    assert.equal(onlyB.length, 1);
    assert.deepEqual(api.done, [B], 'only the requested batch is removed from the server');
    // 16:00Z is 01:00 the next day in Tokyo.
    assert.equal(onlyB[0].files[0], path.join(dir, '2026-11-16', '010000-bbbbbbbb-01.jpg'));
    assert.equal(readFileSync(onlyB[0].files[0], 'utf8'), 'jpeg:u/b1');
    assert.deepEqual(filesForBatch(B, dir), onlyB[0].files);

    const rest = await pullImages(options);
    assert.equal(rest.length, 1);
    assert.equal(rest[0].files.length, 2);
    assert.equal(path.basename(rest[0].files[0]), '120405-aaaaaaaa-01.jpg');
    assert.equal((await pullImages(options)).length, 0, 'downloaded batches are not fetched again');

    const recent = recentBatches(5, dir);
    assert.deepEqual(recent.map((batch) => batch.batchId), [B, A]);
    assert.equal(readImageIndex(dir).batches[B].taskId, 'task-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removes date folders after the keep period and leaves other folders alone', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'html-share-images-'));
  try {
    const api = fakeApi();
    await pullImages({ list: api.list, done: api.finish, download: api.download, dir });
    mkdirSync(path.join(dir, 'notes'), { recursive: true });
    writeFileSync(path.join(dir, 'notes', 'keep.txt'), '');

    const removed = pruneImages(dir, Date.parse('2026-12-16T00:00:00Z'));
    assert.deepEqual(removed, ['2026-11-15']);
    assert.equal(existsSync(path.join(dir, '2026-11-15')), false);
    assert.equal(existsSync(path.join(dir, '2026-11-16')), true);
    assert.equal(readImageIndex(dir).batches[A], undefined, 'the index forgets removed folders');
    assert.ok(readImageIndex(dir).batches[B]);
    assert.equal(existsSync(path.join(dir, 'notes', 'keep.txt')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('names files after the local date and time', () => {
  assert.deepEqual(localParts('2026-11-15T15:00:00.000Z'), { day: '2026-11-16', time: '000000' });
});

test('splits a request\'s files into images and full-text files', () => {
  assert.deepEqual(attachedFiles(['/p/01.jpg', '/p/text.txt', '/p/02.jpg']), { images: ['/p/01.jpg', '/p/02.jpg'], texts: ['/p/text.txt'] });
  assert.deepEqual(attachedFiles(['/p/text.txt']), { texts: ['/p/text.txt'] });
  assert.deepEqual(attachedFiles(['/p/01.jpg']), { images: ['/p/01.jpg'] });
  assert.deepEqual(attachedFiles([]), {});
});
