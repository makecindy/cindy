import { eq } from 'drizzle-orm';
import { sessions } from './schema.js';
import { getDbClient } from './client/current.js';
import { createLogger } from '../logger.js';

const log = createLogger('sessions');

export interface SessionRowSnapshot {
  status: string;
  /** Bound schedule cold resumes preserve the owner's permission choice. */
  permissionMode?: string | null;
  planModeEnabled?: boolean | null;
  title: string | null;
  userSendAt: number | null;
  workingDir: string | null;
  projectDir?: string | null;
  workspaceKind: string | null;
  providerId: string | null;
  /** Hook exact-takeover must reject SSH-owned sessions. */
  remoteHostId?: string | null;
  /** 远程 Agent 所在电脑(null = 本机);限额自动继续据此不拿本机账号快照推算。 */
  agentDeviceId?: string | null;
  /** Hook exact-takeover must reject internal Orca worker sessions. */
  orcaRole?: 'lead' | 'worker' | null;
  /** 协同远端 Worker 标记(raw JSON);非空时不能再开启协同。 */
  orcaRemoteLead?: string | null;
  /** Collab policy gate: remote session 的 codex / claude-code 均放行。 */
  agentKind?: string | null;
  /** 会话来源(`bot` = 伙伴会话);限额自动继续据此排除伙伴。 */
  source?: string | null;
  /** 会话当前模型;限额判定据此只看该模型的额度窗口。 */
  model?: string | null;
  /** Native id used by the execution host to resolve the task's subscription account. */
  sdkSessionId?: string | null;
  /** Authoritative `/clear` visibility boundary (unix ms). */
  clearedAt?: number | null;
}

async function selectSessionRowSnapshot(id: string): Promise<SessionRowSnapshot | null> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({
      status: sessions.status,
      permissionMode: sessions.permissionMode,
      planModeEnabled: sessions.planModeEnabled,
      title: sessions.title,
      userSendAt: sessions.userSendAt,
      workingDir: sessions.workingDir,
      projectDir: sessions.projectDir,
      workspaceKind: sessions.workspaceKind,
      // heartbeat 任务 providerId 留空时,沿用绑定会话在聊天里选的来源(与 model
      // 留空沿用 meta.model 对称)。零新增查询,复用 runner 已并行取的这行快照。
      providerId: sessions.providerId,
      clearedAt: sessions.clearedAt,
      remoteHostId: sessions.remoteHostId,
      agentDeviceId: sessions.agentDeviceId,
      orcaRole: sessions.orcaRole,
      orcaRemoteLead: sessions.orcaRemoteLead,
      agentKind: sessions.agentKind,
      source: sessions.source,
      model: sessions.model,
      sdkSessionId: sessions.sdkSessionId,
    })
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * 严格读取发送前的 session 行。
 *
 * 远控输入必须区分「明确不存在」和「数据库暂时不可读」：前者是可恢复之外的
 * 终态拒绝,后者则应让 renderer 保留草稿并稍后重试。普通 scheduler / 展示路径
 * 继续使用下面的 swallow 版本,避免扩大既有错误语义。
 */
export async function getSessionRowSnapshotStrict(id: string): Promise<SessionRowSnapshot | null> {
  return selectSessionRowSnapshot(id);
}

export async function getSessionRowSnapshot(id: string): Promise<SessionRowSnapshot | null> {
  try {
    return await selectSessionRowSnapshot(id);
  } catch (err) {
    log.warn('getSessionRowSnapshot failed', {
      sessionId: id,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
