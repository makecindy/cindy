/**
 * 个人飞书 bot 存量会话的启动补写(幂等; 不 bump updatedAt, 避免重排列表)。
 *
 * `source='feishu'` 同时覆盖两类任务:
 *   - 个人飞书 bot 会话: 建行即写 feishuBotAppId(该列随首次开源提交就在);
 *   - 官方飞书 / Lark 机器人(hook)会话: feishuBotAppId 为空, 按用户在飞书里
 *     选的工作目录落项目或「对话」, 标题也不是个人 bot 的默认格式。
 * 这里只改个人 bot 的行: 不加这层过滤, 官方任务每次启动都会被挪出它的项目分组。
 */

import { and, eq, isNotNull, isNull, like, ne, or, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { sessions } from '../../localDb/schema';

type Db = Pick<BetterSQLite3Database, 'update'>;
type Log = { warn: (message: string) => void };

export async function backfillPersonalFeishuSessions(db: Db, log: Log): Promise<void> {
  const personalFeishu = and(eq(sessions.source, 'feishu'), isNotNull(sessions.feishuBotAppId));
  // 2026-07 起个人飞书会话进侧边栏「对话」分组(sessionSource.ts 白名单 + feishu
  // adapter 声明), 此前落库的行还是默认 'project', 不补会以
  // im-working-dir/{botAppId} 聚成一个假项目组。
  //
  // 只补还留在机器人托管目录里的行(目录以 `im-working-dir/<botAppId>` 结尾, 或为空)。
  // 用 /project 切进项目的会话是用户的显式选择: 它的 'project' 不是旧默认值, 一刀切
  // 补写会在每次启动把它挪回「对话」分组, 而工作目录还指着那个项目。
  const inManagedDir = or(
    isNull(sessions.workingDir),
    // 按字面比较尾段, 不用 LIKE: 机器人 ID 里常带下划线(cli_xxx), 在 LIKE 里是通配符,
    // 会把目录尾段只差一个字符的项目会话误判成托管目录。
    sql`substr(replace(${sessions.workingDir}, char(92), '/'), -length('/im-working-dir/' || ${sessions.feishuBotAppId})) = '/im-working-dir/' || ${sessions.feishuBotAppId}`,
  );
  try {
    await db
      .update(sessions)
      .set({ workspaceKind: 'dialogue' })
      .where(and(personalFeishu, inManagedDir, ne(sessions.workspaceKind, 'dialogue')));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`feishu sessions workspaceKind backfill failed (non-fatal): ${msg}`);
  }
  // 旧默认标题 `飞书 · {后6位}` 迁到新风格 `[飞书·DM] {后6位}`。
  try {
    await db
      .update(sessions)
      .set({ title: sql`'[飞书·DM] ' || substr(${sessions.title}, 6)` })
      .where(and(personalFeishu, like(sessions.title, '飞书 · %')));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`feishu sessions title backfill failed (non-fatal): ${msg}`);
  }
}
