/**
 * chat-data-localization F5：sessionService 切层为 IPC（HTTP → IPC）。
 *
 * 函数签名与原 HTTP 版完全一致——上层 hooks（useCCSessions 等）零改动。
 * 错误形态：main IPC handler throw `Error("[CODE] msg")` → 此处包成 `ApiError(code, 0, msg)`，
 * 与现有 httpClient 错误对齐。
 */

import type { OrcaRole, Session, SessionStatus, WorkspaceKind } from '@/lib/ccAgent.types';
import { ApiError } from '@/lib/httpClient';
import { extractIpcError } from '@/utils/ipcError';
// device-link 透明对等:fork / rewind 按 sessionId 来源路由(本机 → 本地 maker,
// 远程 device-link 会话 → 隧道)。makerApiFor 是 channel 映射的唯一来源(手机版同此契约)。
// 与 makerTransport 互相 import 形成循环依赖,但双方都只在函数体内(运行时)调用对方导出,
// 模块顶层不调用 → ESM 下安全(无 TDZ)。
import { makerApiFor } from '@/lib/makerTransport';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import type { SessionReference } from '../../shared/sessionReference';

/**
 * status 过滤器：对应 Sidebar Filter 的 Active/Archived/All 三选。
 * 切层后由 IPC 层过滤：
 *   - 'active' / 'archived' → WHERE status = ?
 *   - 'all' / undefined     → WHERE status != 'deleted'（deleted 永不可见）
 *   - 其它非法值（含 'deleted'）→ IPC 层容错，等同 'all'
 */
export type ListStatusFilter = 'active' | 'archived' | 'all';

function wrap<T>(p: Promise<T>): Promise<T> {
  return p.catch((err: unknown) => {
    const ipcError = extractIpcError(err);
    if (ipcError) {
      throw new ApiError(ipcError.code, 0, ipcError.message);
    }
    if (err instanceof Error) {
      throw new ApiError('UNKNOWN', 0, err.message);
    }
    throw new ApiError('UNKNOWN', 0, String(err));
  });
}

// Session metadata is read by both the session view and the message bootstrap
// path during a task switch. Share only requests that are currently in flight:
// settled rows must not become a stale renderer cache.
const getInFlight = new Map<string, Promise<Session>>();

export async function list(
  limit: number = 20,
  status?: ListStatusFilter,
): Promise<Session[]> {
  return wrap(window.electronAPI.localDb.sessions.list(limit, status));
}

export async function create(body?: {
  id?: string;
  workingDir?: string;
  workspaceKind?: WorkspaceKind;
  model?: string;
  effort?: string;
  permissionMode?: string;
  fastMode?: boolean;
  /** 计划模式一级开关(与 permissionMode 正交); 草稿开着计划模式时随建会话落库。 */
  planModeEnabled?: boolean;
  agentKind?: 'cc' | 'codex' | 'pi';
  orcaRole?: OrcaRole | null;
  /** 附加只读引用目录列表 (绝对路径); main 端 mapper 会 JSON.stringify 后写库。 */
  extraDirs?: string[];
  /** Remote codex session (P2): 远端 SSH host alias。设置后 workingDir 须为
   *  远端绝对路径; codex agent 跑在远端机器, 本地不 spawn。 */
  remoteHostId?: string;
  /**
   * per-session 来源(供应商)显式选择,落盘 sessions.provider_id(与 update 同列、同语义)。
   * null/undefined = 跟随默认路由。草稿态发送建会话时透传用户在草稿里选定的来源,
   * 让新会话与「会话内切来源」行为一致(首个请求即走对供应商)。
   */
  providerId?: string | null;
}): Promise<Session> {
  return wrap(window.electronAPI.localDb.sessions.create(body));
}

export function get(id: string): Promise<Session> {
  const existing = getInFlight.get(id);
  if (existing) return existing;

  const request = wrap(window.electronAPI.localDb.sessions.get(id));
  getInFlight.set(id, request);
  // Use both fulfillment and rejection handlers so the cleanup promise cannot
  // become an unhandled rejection when the IPC request fails.
  void request.then(
    () => {
      if (getInFlight.get(id) === request) getInFlight.delete(id);
    },
    () => {
      if (getInFlight.get(id) === request) getInFlight.delete(id);
    },
  );
  return request;
}

/** Resolve scheduler-held ids against live, archived, deleted, and missing rows. */
export async function resolveReferences(sessionIds: readonly string[]): Promise<SessionReference[]> {
  return wrap(window.electronAPI.localDb.sessions.resolveReferences(Array.from(sessionIds)));
}

/**
 * 仅当会话仍为 archived 且项目身份未变时原子恢复；条件不匹配返回 null。
 * 用于跨确认框的批量恢复，避免 get + update 的 TOCTOU 竞态。
 */
export async function restoreIfArchived(
  id: string,
  expected: Pick<Session, 'workingDir' | 'workspaceKind' | 'remoteHostId'>,
): Promise<Session | null> {
  return wrap(
    window.electronAPI.localDb.sessions.restoreIfArchived(id, {
      workingDir: expected.workingDir,
      workspaceKind: expected.workspaceKind,
      remoteHostId: expected.remoteHostId ?? null,
    }),
  );
}

export async function update(
  id: string,
  patch: {
    title?: string;
    workingDir?: string;
    workspaceKind?: WorkspaceKind;
    model?: string;
    effort?: string;
    permissionMode?: string;
    fastMode?: boolean;
    /** 计划模式一级开关(与 permissionMode 正交), 与 maker.setPlanMode 双 IPC 协调。 */
    planModeEnabled?: boolean;
    sdkSessionId?: string | null;
    totalTokenUsage?: number;
    totalCostUsd?: number;
    contextTokens?: number;
    contextWindow?: number;
    clearedAt?: string | null;
    pinnedAt?: string | null;
    status?: SessionStatus;
    orcaRole?: OrcaRole | null;
    /** 附加只读引用目录覆盖列表 (绝对路径); main 端会在 mapper 里 JSON.stringify 后写库。 */
    extraDirs?: string[];
    /**
     * per-session 来源(供应商)选择,持久化到 sessions.provider_id(与 model/effort 同模式)。
     * null = 清除显式选择,回落默认路由。运行时即时生效由 maker.setModel 的第 3 参负责;
     * 此处仅落盘,使跨重启可恢复(host 加载时回填 session-provider-store)。
     */
    providerId?: string | null;
  },
): Promise<Session> {
  return wrap(window.electronAPI.localDb.sessions.update(id, patch));
}

/**
 * 窄口径会话元数据编辑(status / title / pinnedAt = 删/归档/恢复/重命名/置顶)。按来源路由:
 *   - device-link 远程会话 → 隧道到被控端的 local-db:sessions:patch-meta(allowlist 内的窄口径写)
 *   - 本机会话 → 保持原 update 路径(零行为变更)
 * 通用 update 写任意字段、故意不进 allowlist,所以远程改这些元数据必须走这个专用通道。
 */
export async function patchMeta(
  sessionId: string,
  patch: { status?: SessionStatus; title?: string; pinnedAt?: string | null },
): Promise<Session> {
  // Metadata writes must stay pinned to the last known device while the
  // relay's session mirror is being rebuilt. Otherwise an archived remote
  // task's auto-unarchive can fall through to the controller's local DB.
  const deviceId = getStickySessionDeviceId(sessionId);
  if (deviceId) {
    return wrap(
      window.electronAPI.deviceLink.invoke(deviceId, 'local-db:sessions:patch-meta', [
        sessionId,
        patch,
      ]) as Promise<Session>,
    );
  }
  return update(sessionId, patch);
}

/** status 切换便捷封装(archive 一并 unpin)。 */
export async function setStatus(sessionId: string, status: SessionStatus): Promise<Session> {
  return patchMeta(sessionId, status === 'archived' ? { status, pinnedAt: null } : { status });
}

/**
 * 单字段 bump：把 sessions.user_send_at 设为 atMs（默认 now）。
 * 不返回 row、不刷 updatedAt。renderer 在用户按下发送的瞬间触发。
 */
export async function touchUserSend(id: string, atMs?: number): Promise<void> {
  return wrap(window.electronAPI.localDb.sessions.touchUserSend(id, atMs));
}

/**
 * fork-at-message：把 source session 在 messageClientId 处 fork 成新 session。
 * fork 点支持 user 消息（复制提问之前的内容）与 assistant 消息（复制含该回复
 * 所在 turn 的全部内容），语义由 main 侧按 role 分支。
 * IPC 走 SDK forkSession（拷 jsonl）+ SQLite 镜像。
 *
 * 错误码：
 *   - SOURCE_NEVER_RAN     原会话从未运行，无法 fork
 *   - NO_PRIOR_ASSISTANT   复制边界之前没有可作锚点的 assistant 回复
 *   - NOT_FOUND / INVALID_PARAMS / UNKNOWN
 *
 * 调用方负责：成功后 emit refresh 让 sidebar 出现新 session、navigate 到新会话。
 * （此函数本身不触发 navigation —— 调用上下文（useForkAtMessage）才知道要不要 saveDraft）
 */
export async function forkAtMessage(
  sourceSessionId: string,
  messageClientId: string,
): Promise<Session> {
  return wrap(
    makerApiFor(sourceSessionId).fork(sourceSessionId, messageClientId) as Promise<Session>,
  );
}

export async function forkStripEncrypted(sourceSessionId: string): Promise<Session> {
  return wrap(
    makerApiFor(sourceSessionId).forkStripEncrypted(sourceSessionId) as Promise<Session>,
  );
}

/**
 * rewind-session: dry-run preview。返回 SDK rewindFiles 的结果。
 * canRewind=false 时 UI 走 Error 态展示 SDK 给的 error 文案（如老 session 没开 checkpointing）。
 *
 * 错误码（透传自 main IPC）：
 *   - SESSION_NOT_FOUND / MESSAGE_NOT_FOUND / NOT_USER_MESSAGE
 *   - NO_PRIOR_ASSISTANT  该 user 消息之前没有 assistant 回复（第一条消息）
 *   - SESSION_RUNNING     会话进行中
 *   - NO_LIVE_QUERY       session 已 paused / 未激活
 *   - INVALID_PARAMS / UNKNOWN
 */
export async function rewindPreview(
  sessionId: string,
  clientId: string,
): Promise<RewindFilesResultPayload> {
  return wrap(makerApiFor(sessionId).rewindPreview(sessionId, clientId));
}

/**
 * rewind-session: commit 真执行。流程详见 main/maker-orchestration/rewind.ts。
 * 成功返回最新 session row（sdk_session_id 已切换、context tokens 清零）。
 *
 * 注：commit 不立即重启 SDK query —— 只挂 pendingRewindTo 标记 + 软删 messages，
 * 即时返回成功。真正的 SDK 重启发生在用户下一次 sendMessage 时（CD 同款设计），
 * 此时 CLI 拿到 input 才能正常发 init / 处理 / 回复。新 sdkSessionId 由
 * cc-agent:sdk-session-id IPC 异步持久化。
 */
export async function rewindCommit(
  sessionId: string,
  clientId: string,
  opts?: { requireLatestUser?: boolean; stopIfRunning?: boolean },
): Promise<Session> {
  return wrap(
    makerApiFor(sessionId).rewindCommit(sessionId, clientId, opts) as Promise<Session>,
  );
}
