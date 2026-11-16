import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// スマホからインボックスへ送った画像をPCへ取り込む。
//
// 置き場は ~/Pictures/html-share-inbox/<日付>/（HTML_SHARE_IMAGES_DIR で差し替え可）。
// どのリポジトリにも入らない場所なので、間違って commit されない。取り込んだら一時置き場からは消し、
// 手元のものも30日たったら消す。束と依頼の対応は .index.json に残し、inbox が依頼の画像を引けるようにする。

export const IMAGE_KEEP_DAYS = 30;

export interface UploadedImage {
  name: string;
  url: string;
}

export interface UploadBatch {
  batchId: string;
  createdAt: string;
  note?: string;
  taskId?: string | null;
  images?: UploadedImage[];
}

export interface PulledBatch {
  batchId: string;
  createdAt: string;
  note: string;
  taskId: string | null;
  files: string[];
}

interface ImageIndex {
  batches: Record<string, { files: string[]; createdAt: string; note: string; taskId: string | null; pulledAt: string }>;
}

export function imagesDir(): string {
  return process.env.HTML_SHARE_IMAGES_DIR ?? path.join(homedir(), 'Pictures', 'html-share-inbox');
}

const indexFile = (dir: string) => path.join(dir, '.index.json');

export function readImageIndex(dir = imagesDir()): ImageIndex {
  try {
    const parsed = JSON.parse(readFileSync(indexFile(dir), 'utf8'));
    return parsed && typeof parsed.batches === 'object' && parsed.batches ? parsed : { batches: {} };
  } catch {
    return { batches: {} };
  }
}

function writeImageIndex(dir: string, index: ImageIndex): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(indexFile(dir), `${JSON.stringify(index, null, 2)}\n`);
}

const pad = (value: number) => String(value).padStart(2, '0');

/** このPCの時刻での日付（YYYY-MM-DD）と時刻（HHMMSS）。フォルダとファイルの名前に使う */
export function localParts(iso: string): { day: string; time: string } {
  const date = new Date(iso);
  return {
    day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  };
}

/** 保存期間を過ぎた日付フォルダと、その束の記録を消す。日付の形でないフォルダには触らない */
export function pruneImages(dir = imagesDir(), now = Date.now()): string[] {
  if (!existsSync(dir)) return [];
  const limit = localParts(new Date(now - IMAGE_KEEP_DAYS * 86_400_000).toISOString()).day;
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(name) && name < limit) {
      rmSync(path.join(dir, name), { recursive: true, force: true });
      removed.push(name);
    }
  }
  if (removed.length > 0) {
    const index = readImageIndex(dir);
    for (const [id, batch] of Object.entries(index.batches)) {
      if (removed.includes(localParts(batch.createdAt).day)) delete index.batches[id];
    }
    writeImageIndex(dir, index);
  }
  return removed;
}

/**
 * 届いている束を取り込む。only を渡すとその束だけ（inbox が依頼の画像だけを取るとき）。
 * list・done は Review API の呼び出し、download は URL → 中身。
 */
export async function pullImages(options: {
  list: () => Promise<UploadBatch[]>;
  done: (batchId: string) => Promise<void>;
  download: (url: string) => Promise<Buffer>;
  only?: string[];
  dir?: string;
}): Promise<PulledBatch[]> {
  const dir = options.dir ?? imagesDir();
  const wanted = (await options.list()).filter((batch) => !options.only || options.only.includes(batch.batchId));
  const index = readImageIndex(dir);
  const pulled: PulledBatch[] = [];
  for (const batch of wanted) {
    const { day, time } = localParts(batch.createdAt);
    const folder = path.join(dir, day);
    mkdirSync(folder, { recursive: true });
    const files: string[] = [];
    for (const image of batch.images ?? []) {
      const name = path.basename(image.name).replace(/[^A-Za-z0-9._-]/g, '');
      const file = path.join(folder, `${time}-${batch.batchId.slice(0, 8)}-${name}`);
      writeFileSync(file, await options.download(image.url));
      files.push(file);
    }
    const record = { files, createdAt: batch.createdAt, note: batch.note || '', taskId: batch.taskId || null };
    index.batches[batch.batchId] = { ...record, pulledAt: new Date().toISOString() };
    writeImageIndex(dir, index);
    // 手元へ書けてから一時置き場を消す。途中で落ちても、次の取り込みで同じ束を取り直せる
    await options.done(batch.batchId);
    pulled.push({ batchId: batch.batchId, ...record });
  }
  pruneImages(dir);
  return pulled;
}

/** 束のファイルを画像と全文（.txt）に分ける。全文は長い依頼の本体 */
export function attachedFiles(files: string[]): { images?: string[]; texts?: string[] } {
  const texts = files.filter((file) => file.endsWith('.txt'));
  const images = files.filter((file) => !file.endsWith('.txt'));
  return { ...(images.length > 0 ? { images } : {}), ...(texts.length > 0 ? { texts } : {}) };
}

/** 取り込み済みの束のファイル（inbox が依頼に添えるとき） */
export function filesForBatch(batchId: string, dir = imagesDir()): string[] {
  return readImageIndex(dir).batches[batchId]?.files?.filter((file) => existsSync(file)) ?? [];
}

/** 直近に取り込んだ束（新しい順）。「さっき送った画像」を、別の取り込みが先に拾っていたときに探す */
export function recentBatches(limit = 5, dir = imagesDir()): PulledBatch[] {
  return Object.entries(readImageIndex(dir).batches)
    .map(([batchId, batch]) => ({
      batchId,
      createdAt: batch.createdAt,
      note: batch.note,
      taskId: batch.taskId,
      files: batch.files.filter((file) => existsSync(file)),
    }))
    .filter((batch) => batch.files.length > 0)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    .slice(0, limit);
}
