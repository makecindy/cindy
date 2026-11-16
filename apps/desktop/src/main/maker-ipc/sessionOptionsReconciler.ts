import { eq } from 'drizzle-orm';
import { permissionModeOrAsk } from '@cindy/maker-shared/permission-mode';
import { dbToMakerAgentKind } from '../../shared/agentKindConversion.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import type { MakerSessionCreateOpts as CreateOpts } from './sessionRequest.js';
import type { createLogger } from '../logger.js';

export type SessionExecutionRow = Partial<Pick<typeof sessions.$inferSelect,
  'agentKind' | 'model' | 'sdkSessionId' | 'providerId' | 'effort' | 'fastMode' |
  'permissionMode' | 'planModeEnabled' | 'agentDeviceId' | 'remoteHostId'>> & Pick<typeof sessions.$inferSelect, 'model'>;

async function readSession(sessionId: string): Promise<SessionExecutionRow | undefined> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({
      agentKind: sessions.agentKind,
      model: sessions.model,
      sdkSessionId: sessions.sdkSessionId,
      providerId: sessions.providerId,
      effort: sessions.effort,
      fastMode: sessions.fastMode,
      permissionMode: sessions.permissionMode,
      planModeEnabled: sessions.planModeEnabled,
      agentDeviceId: sessions.agentDeviceId,
      remoteHostId: sessions.remoteHostId,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return row;
}

/** Refresh stale queue/native-resume snapshots from the task's persisted settings.
 * Desktop uses the original DB query; Host injects its owner-scoped admission read. */
export function createSessionOptionsReconciler(deps: {
  log: Pick<ReturnType<typeof createLogger>, 'warn'>;
  readSession?: (sessionId: string) => Promise<SessionExecutionRow | null | undefined>;
}) {
  const { log } = deps;
  const loadSession = deps.readSession ?? readSession;
  return async function reconcileCreateOptsAgainstDb(sessionId: string, co: CreateOpts): Promise<void> {
    try {
      const row = await loadSession(sessionId);
      if (!row) return;
      // Agent 换电脑也在发送事务内落地：快照里的旧位置不能把 Agent 拉回原来那台。
      // 缺省(undefined)交给 bootstrapSession 按任务记录读取，与恢复路径同一口径。
      if (!co.remoteHostId && !row.remoteHostId) {
        co.agentDeviceId = row.agentDeviceId ?? undefined;
      }
      const dbMakerKind = dbToMakerAgentKind(row.agentKind);
      if (co.agentKind !== dbMakerKind) {
        log.warn('lazy-create: createOpts agentKind drifted from DB (agent switch); reconciling', {
          sessionId,
          staleAgentKind: co.agentKind,
          dbAgentKind: dbMakerKind,
        });
        co.agentKind = dbMakerKind;
      }
      // 意图制切换 / 凭证形态切换下,renderer 与排队项的 createOpts 快照构建于 send
      // 事务内 apply 之前。agentKind 可能已一致,但 model/resume/providerId/effort/fast
      // 仍是旧值；
      // 尤其 resumeSessionId 可能是**旧引擎**的原生会话 id——resume 会以错误引擎
      // 解释它)。lazy-create 时刻 DB 行是唯一真源,执行字段无条件对齐。
      co.model = row.model ?? undefined;
      co.resumeSessionId = row.sdkSessionId ?? undefined;
      if (!row.sdkSessionId && co.vendorOptions) {
        // context.rebuild clears the DB sdk_session_id. Queued createOpts may
        // still carry vendor-specific resume/fork anchors from before the close;
        // strip every native continuation hint so CC/Codex bootstrap fresh too.
        const freshVendorOptions = { ...co.vendorOptions };
        for (const key of ['resumeSessionAt', 'forkSession', 'threadId', 'tailTurnsToDrop']) {
          delete freshVendorOptions[key];
        }
        co.vendorOptions =
          Object.keys(freshVendorOptions).length > 0 ? freshVendorOptions : undefined;
      }
      co.providerId = row.providerId;
      co.effort = (row.effort ?? undefined) as CreateOpts['effort'];
      co.fastMode = (row.fastMode ?? false);
      co.permissionMode = permissionModeOrAsk(row.permissionMode);
      // 新建会话的计划模式按落库状态起档：排队项的 createOpts.planMode 是那一条消息的
      // 计划意图（伙伴委派等 Host 输入恒为 false），本轮意图仍由发送事务按原快照传给
      // send，这里只校正冷启动的会话状态，不改本轮是否以计划执行。
      co.planMode = row.planModeEnabled === true;
    } catch (error) {
      // context.rebuild clears sdk_session_id before the next bootstrap. If the
      // DB truth cannot be read, continuing with caller-supplied opts could
      // resurrect the dead native resume/fork/thread; fail closed instead.
      log.warn('lazy-create: DB reconciliation failed; refusing stale native bootstrap', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}
