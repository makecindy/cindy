import {eq} from 'drizzle-orm';
import {sessions} from './schema.js';
import type {DbClient} from './client/DbClient.js';
import type {DbLogger} from './logging.js';
import {normalizeRemoteHostId} from './remoteHostId.js';


export interface SessionRowSnapshot {
  status: string;
  /** Bound schedule cold resumes preserve the owner's permission choice. */
  permissionMode?: string | null;
  planModeEnabled?: boolean | null;
  title: string | null;
  userSendAt: number | null;
  workingDir: string | null;
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
  /** Authoritative `/clear` visibility boundary (unix ms). */
  clearedAt?: number | null;
}
export function createSessionSnapshot(host:{getDbClient():DbClient;logger:DbLogger}){
const {getDbClient,logger:log}=host;


/**
 * 按 session id 查 desktop 端 sessions 表的产品快照。
 * 与 maker-core SessionMeta 不重叠 —— SessionMeta 故意不带 status (那是 desktop 产品语义)。
 * Resume 路径(scheduler runner / send_to_session)用它做归档/删除兜底和展示元数据返回。
 * 失败 swallow 返 null 而非抛 —— 调用方应当把 null 视作 NOT_FOUND, 由业务自己决定 fallback。
 */
/**
 * sessionId → remoteHostId 的进程内缓存 reader:session 的 remoteHostId 创建后
 * 不变,lazy resume 路径每次 send 都经过 ensureRemoteReadyForSessionStart,避免
 * 重复查库。查询成功(含行不存在)才缓存;DB 异常返回 null 但**不缓存** ——
 * 一次瞬时 DB 失败不该永久关闭该 session 的 remote ensure 兜底(否则远端
 * session 会被按本地会话处理远端 workingDir)。
 */
function createSessionRemoteHostIdReader(): (sessionId: string) => Promise<string | null> {
  const cache = new Map<string, string | null>();
  return async (sessionId) => {
    if (cache.has(sessionId)) {
      return cache.get(sessionId) ?? null;
    }
    let value: string | null;
    try {
      const db = getDbClient().drizzle;
      const [row] = await db
        .select({ remoteHostId: sessions.remoteHostId })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      value = normalizeRemoteHostId(row?.remoteHostId ?? null);
    } catch {
      return null;
    }
    cache.set(sessionId, value);
    return value;
  };
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
async function getSessionRowSnapshotStrict(id: string): Promise<SessionRowSnapshot | null> {
  return selectSessionRowSnapshot(id);
}

async function getSessionRowSnapshot(id: string): Promise<SessionRowSnapshot | null> {
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

/**
 * 按 session id 查 fs 槽(意识写文件)守门要看的会话快照:workdir 位置、
 * permission 模式(claude / codex / pi 共用这一列,codex 的 approval/sandbox
 * 由它映射派生)、plan 开关、远程工作区标记。失败 swallow 返 null(调用方按
 * 「会话不存在」拒绝写入,不抛)。
 */
async function getSessionFsSnapshot(id: string): Promise<{
  workingDir: string | null;
  permissionMode: string;
  planModeEnabled: boolean;
  remoteHostId: string | null;
} | null> {
  try {
    const db = getDbClient().drizzle;
    const [row] = await db
      .select({
        workingDir: sessions.workingDir,
        permissionMode: sessions.permissionMode,
        planModeEnabled: sessions.planModeEnabled,
        remoteHostId: sessions.remoteHostId,
      })
      .from(sessions)
      .where(eq(sessions.id, id))
      .limit(1);
    return row ?? null;
  } catch (err) {
    log.warn('getSessionFsSnapshot failed', {
      sessionId: id,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
return {createSessionRemoteHostIdReader, getSessionRowSnapshotStrict, getSessionRowSnapshot, getSessionFsSnapshot};
}
