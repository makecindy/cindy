import {and,eq,sql} from 'drizzle-orm';
import type {DbClient} from '@cindy/runtime-db';
import {sessions} from '@cindy/runtime-db/schema';
import {isRetainableProjectSession} from '@cindy/maker-shared/session-source';
import {normalizeWorkingDirForProjectSettings} from '@cindy/maker-shared/working-dir';
import type {createSessionNotifications} from './sessionNotifications.js';
import type {createRecentWorkdirs} from './recentWorkdirs.js';
export function createSessionUserActivity(host: {getDbClient():DbClient;notifications:Pick<ReturnType<typeof createSessionNotifications>,'captureOwnerScope'|'isOwnerScopeCurrent'|'broadcastSessionPatched'|'broadcastRecentWorkdirsChanged'>;upsertRecentWorkdir:ReturnType<typeof createRecentWorkdirs>['upsertRecentWorkdir']}) {
const {getDbClient,upsertRecentWorkdir}=host;
const {captureOwnerScope,isOwnerScopeCurrent,broadcastSessionPatched,broadcastRecentWorkdirsChanged}=host.notifications;


/**
 * 内部 API：标记用户显式发送时间。
 *
 * 过去这一步由 renderer 在 sendMessage 里直接调 IPC。队列 / 插话迁到 main 事务
 * 协调器后，renderer 只发 intent，真正“这条输入已进入事务”的时间必须跟 main
 * 状态机同源，否则 retry / rollback 时会出现 DB 已 bump 但输入没有被接受的分裂。
 */
async function touchUserSendInDb(id: string, atMs?: number): Promise<void> {
  const ownerScope = captureOwnerScope();
  const ts =
    typeof atMs === 'number' && Number.isFinite(atMs) && atMs > 0 ? Math.floor(atMs) : Date.now();
  const dbClient = getDbClient();
  const db = dbClient.drizzle;
  // 原子 guard：单条 UPDATE + WHERE 代替 SELECT→条件判断→UPDATE 三步走。
  // 旧实现存在 TOCTOU 竞态：两个并发调用（如 scheduler fire + 手动发送）都可能
  // 通过旧值检查后都执行 UPDATE，后写入的更早时间戳会覆盖已写入的更新值。
  // WHERE 条件由 SQLite 行锁原子执行，消除竞态窗口。
  // updatedAt 用 MAX 防止 run 完成路径写入 finishedAt 后被更早的 firedAt 回退。
  // 同步 bump updatedAt:侧栏时间轴统一读 sessions.updatedAt("最近有动静的会话"),
  // 用户按下发送就是最典型的"有动静"—— userSendAt 保持"用户发送时刻"专用语义,
  // updatedAt 表示"任意路径下这个 session 最近一次被推进",两者语义正交但需同刷。
  await db
    .update(sessions)
    .set({ userSendAt: ts, updatedAt: sql`MAX(${sessions.updatedAt}, ${ts})` })
    .where(
      and(
        eq(sessions.id, id),
        sql`(${sessions.userSendAt} IS NULL OR ${sessions.userSendAt} < ${ts})`,
      ),
    );
  // 验证 UPDATE 是否落地，避免向 renderer 广播过时值。
  // WHERE 条件为假时（并发写入已领先，或 userSendAt 已 >= ts）UPDATE 为 no-op；
  // 此时 DB 里的 userSendAt ≠ ts，SELECT 返回空，正确跳过广播。
  // 通过 SELECT 拿回实际落库的 updatedAt（已经是 MAX'd 结果）用于广播，
  // 避免把旧 ts 当作 updatedAt 广播给 renderer。
  const updated = await db
    .select({
      userSendAt: sessions.userSendAt,
      updatedAt: sessions.updatedAt,
      workingDir: sessions.workingDir,
      workspaceKind: sessions.workspaceKind,
      remoteHostId: sessions.remoteHostId,
      source: sessions.source,
      orcaRole: sessions.orcaRole,
    })
    .from(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.userSendAt, ts)))
    .limit(1);
  if (updated.length === 0) return;
  // 广播 sessions:patched,让 renderer 把刚发过消息的会话从「草稿(未分类)」即时重归到
  // 项目分组下(projectGrouping 的草稿兜底:userSendAt==null && messages==0 → unclassified)。
  //   - 本机会话:renderer 在 sendMessage 里已乐观 patchLocal(userSendAt),这条是权威确认(幂等)。
  //   - device-link 远程会话:控制端是在**被控端** enqueue 时才 bump userSendAt,被控端自己的
  //     renderer 不会乐观更新 —— 没有这条广播,被控端 sidebar 会把控制端新建的远程会话一直
  //     当草稿挂在项目外。经 device-link tap 同时把权威 userSendAt 推给控制端,两端收敛。
  // userSendAt 按 renderer 约定用 ISO 字符串(与 sessionToCamel 的 msToIso 对齐)。
  if (isOwnerScopeCurrent(ownerScope)) {
    broadcastSessionPatched(
      id,
      {
        userSendAt: new Date(updated[0].userSendAt!).toISOString(),
        updatedAt: new Date(updated[0].updatedAt).toISOString(),
      },
      ownerScope,
    );
  }
  // 项目独立保留真实使用时间；不能等归档/删除时再取清理时间，也不能从剩余任务重算。
  // 复用入口处的 client，避免 await 期间切换账号后把旧项目写入新账号数据库。
  const row = updated[0];
  if (
    row.workspaceKind === 'project' &&
    row.workingDir &&
    !row.remoteHostId &&
    isRetainableProjectSession(row)
  ) {
    const projectDir = normalizeWorkingDirForProjectSettings(row.workingDir);
    const touched = await upsertRecentWorkdir(projectDir, ts, process.platform, dbClient);
    if (touched && projectDir) broadcastRecentWorkdirsChanged(projectDir, ownerScope);
  }
}
return {touchUserSendInDb};
}
