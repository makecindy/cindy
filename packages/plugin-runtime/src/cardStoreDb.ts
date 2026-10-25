/**
 * cardStoreDb.ts — 意识聊天卡片的持久层(ghost_cards 表,卡槽③)。
 *
 * 语义:一行 = 一次 ghost_call 的最新卡片版本(upsert by callId)。
 * GC:插入后按行数上限保最新 N 行(按 updatedAt 淘汰最旧)——卡片是
 * 展示层缓存,被淘汰的历史卡在 renderer 侧自动降级为通用媒体渲染,
 * 不是数据丢失。取模抽样触发 count,避免每次写都全表计数。
 *
 * 所有函数接受可注入 db(规则 14;口径同 cindy-media/ledger.ts):生产走
 * DbClient 的 drizzle 代理,测试注入内存库直测。
 */

import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type * as schema from './cardSchema.js';
import { ghostCards } from './cardSchema.js';
import type { GhostCardRow } from './cardService.js';

export type GhostCardDb = BetterSQLite3Database<typeof schema>;

/** 行数上限(超出按 updatedAt 淘汰最旧)。 */
export const GHOST_CARDS_MAX_ROWS = 5000;
/** 每 N 次插入抽查一次行数(GC 触发抽样)。 */
const GC_SAMPLE_EVERY = 32;

let insertCounter = 0;

/** upsert by callId;每 GC_SAMPLE_EVERY 次写入顺手做一次上限裁剪。 */
export async function upsertGhostCard(
  row: GhostCardRow,
  db: GhostCardDb,
): Promise<void> {
  await db
    .insert(ghostCards)
    .values({
      callId: row.callId,
      ghostId: row.ghostId,
      sessionId: row.sessionId,
      html: row.html,
      height: row.height,
      v: row.v,
      updatedAt: row.updatedAt,
    })
    .onConflictDoUpdate({
      target: ghostCards.callId,
      set: {
        html: row.html,
        height: row.height,
        v: row.v,
        updatedAt: row.updatedAt,
      },
    });
  insertCounter += 1;
  if (insertCounter % GC_SAMPLE_EVERY === 0) {
    await pruneGhostCards(db);
  }
}

export interface GhostCardRecord {
  callId: string;
  ghostId: string;
  sessionId: string | null;
  html: string;
  height: number;
  v: number;
}

/** 按 callId 取卡;无卡返回 null(renderer 据此降级 generic 渲染)。 */
export async function getGhostCard(
  callId: string,
  db: GhostCardDb,
): Promise<GhostCardRecord | null> {
  const rows = await db
    .select({
      callId: ghostCards.callId,
      ghostId: ghostCards.ghostId,
      sessionId: ghostCards.sessionId,
      html: ghostCards.html,
      height: ghostCards.height,
      v: ghostCards.v,
    })
    .from(ghostCards)
    .where(eq(ghostCards.callId, callId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * 按会话批量取卡(历史回放用):一次查出本会话全部卡片(含 tool-call 卡与
 * will-assistant-message 出口钩子的 turn 级自绘卡,后者 callId = assistant 消息
 * clientId)。renderer 会话打开时一次性灌进 byCallId,免逐条 ensureCard 打 IPC,
 * 也让"该气泡被自绘替换"的判定(byCallId 命中 clientId)在重启后成立。
 */
export async function listGhostCardsBySession(
  sessionId: string,
  db: GhostCardDb,
): Promise<GhostCardRecord[]> {
  return db
    .select({
      callId: ghostCards.callId,
      ghostId: ghostCards.ghostId,
      sessionId: ghostCards.sessionId,
      html: ghostCards.html,
      height: ghostCards.height,
      v: ghostCards.v,
    })
    .from(ghostCards)
    .where(eq(ghostCards.sessionId, sessionId));
}

/**
 * 权威实测高写回(renderer 量高后回填):历史回放据此以准确高度首帧挂载,
 * 消除"声明估计值 → 实测值"的可见收敛动画(规则 7)。行不存在时静默跳过
 * (卡已被 GC / 竞态),不 upsert——高度不该凭空造出卡。
 */
export async function updateGhostCardHeight(
  callId: string,
  height: number,
  db: GhostCardDb,
): Promise<void> {
  await db.update(ghostCards).set({ height }).where(eq(ghostCards.callId, callId));
}

/**
 * 内置意识改名迁移:把历史卡片的归属 ghostId 整体改挂新 id(幂等 UPDATE,
 * 无旧行 = no-op)。老卡的 chip 归属展示与交互按钮(card-action 派发按
 * ghostId 找意识)全靠这个字段,不迁移旧卡按钮在改名后全部失效。
 */
export async function reassignGhostCards(
  fromGhostId: string,
  toGhostId: string,
  db: GhostCardDb,
): Promise<void> {
  await db.update(ghostCards).set({ ghostId: toGhostId }).where(eq(ghostCards.ghostId, fromGhostId));
}

/** 上限裁剪:总行数超限时删最旧的溢出部分。导出供测试直调。 */
export async function pruneGhostCards(db: GhostCardDb): Promise<number> {
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(ghostCards);
  const overflow = total - GHOST_CARDS_MAX_ROWS;
  if (overflow <= 0) return 0;
  const victims = await db
    .select({ callId: ghostCards.callId })
    .from(ghostCards)
    .orderBy(asc(ghostCards.updatedAt))
    .limit(overflow);
  if (victims.length === 0) return 0;
  await db.delete(ghostCards).where(
    inArray(
      ghostCards.callId,
      victims.map((v) => v.callId),
    ),
  );
  return victims.length;
}
