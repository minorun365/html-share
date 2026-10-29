/**
 * 保持期限。最終更新から content.retainDays 日を過ぎたページは配信から外し、一覧の「保管庫」にタイトルだけ残す。
 *
 *   配信は「バケットに無いキーは消す」同期なので、外したページは配信先からも消え、
 *   そのページへ発行済みの共有URLもそこで開けなくなる。元のHTMLは手元に残るので、
 *   `html-share page revive` で keep（見直し日）を書けば次の publish で配信へ戻る。
 *
 *   続ける理由は、手元の設定だけで決まるものに限る。スターや最終閲覧日は本人の画面から
 *   クラウドへ保存される値で、publish する CLI からは読めない。読めないまま判定に混ぜると、
 *   取得に失敗した回に使っているページまで外れるので、材料にしない。
 */

const DAY_MS = 86400e3;

/** 配信を続ける理由。null なら保管庫へ移す */
export type KeepReason = 'fresh' | 'keep' | 'shelf';

export interface RetentionInput {
  /** ページの最終更新（ISO 8601） */
  updatedAt: string;
  /** 見直し日（YYYY-MM-DD）。この日までは配信を続ける */
  keep?: string;
  stream: string;
}

export interface RetentionContext {
  retainDays: number;
  /** JST の今日（YYYY-MM-DD） */
  today: string;
  now: number;
  /** 進行中フィルターに載っているテーマ */
  shelfStreams: Set<string>;
}

export function keepReason(page: RetentionInput, context: RetentionContext): KeepReason | null {
  const ageDays = (context.now - Date.parse(page.updatedAt)) / DAY_MS;
  if (!(ageDays > context.retainDays)) return 'fresh';
  if (page.keep && page.keep >= context.today) return 'keep';
  if (context.shelfStreams.has(page.stream)) return 'shelf';
  return null;
}

/** revive が書く見直し日の既定。開いて確かめる時間を取り、過ぎればまた保管庫へ戻る */
export const REVIVE_DAYS = 14;
