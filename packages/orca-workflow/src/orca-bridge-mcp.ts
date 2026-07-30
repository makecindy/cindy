import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isTerminalAgentErrorEvent, toSessionDispatchOutcome } from '@cindy/maker-core';
import type { AgentEvent, AgentKind, Logger, Maker, McpProvider, McpProviderContext, Session } from '@cindy/maker-core';

const MAX_CAPTURED_TEXT = 64 * 1024;

export type OrcaWorkerStatus = 'idle' | 'running' | 'done' | 'error';

export interface OrcaPersistedSession {
  sessionId: string;
  agentKind: AgentKind;
  workingDir: string;
  model: string;
  providerId?: string | null;
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  permissionMode?: 'ask' | 'auto' | 'bypassPermissions' | 'acceptEdits' | 'plan' | 'default';
  fastMode?: boolean;
  sdkSessionId?: string;
  title?: string;
  /**
   * SSH 远端 session 的 host id。rehydrate (ensureSessionFromMeta) 必须把它
   * 带回 createSession — 缺失时远端 lead 会以远端 workingDir 在本机重建
   * (workdir check 失败或建出错误的本地 session)。
   */
  remoteHostId?: string | null;
}

export interface OrcaWorkerLink {
  workerId: string;
  workflowId: string;
  workerSessionId: string;
  leadSessionId: string;
  leadSession: OrcaPersistedSession;
}

export interface OrcaTeamStore {
  getWorkerLink: (input: {
    workerId?: string;
    workerSessionId?: string;
  }) => Promise<OrcaWorkerLink | null>;
  updateWorkerStatus: (workerId: string, status: OrcaWorkerStatus) => Promise<void>;
}

interface CapturedSessionEntry {
  sessionId: string;
  session: Session | null;
  status: OrcaWorkerStatus;
  finalText: string;
  lastEventAt: number;
  eventSeq: number;
  terminalEventSeq: number;
  captureDispose?: () => void;
}

class CapturedSessionRegistry {
  private readonly sessions = new Map<string, CapturedSessionEntry>();

  get(sessionId: string): CapturedSessionEntry | null {
    return this.sessions.get(sessionId) ?? null;
  }

  add(entry: CapturedSessionEntry): void {
    this.sessions.set(entry.sessionId, entry);
  }
}

export interface OrcaLeadVendorOptions extends Record<string, unknown> {
  orcaRole: 'lead';
  orcaLeadSessionId?: string;
}

export interface OrcaWorkerVendorOptions extends Record<string, unknown> {
  orcaRole: 'worker';
  orcaWorkflowId?: string;
  orcaLeadSessionId?: string;
  orcaWorkerId?: string;
  orcaWorkerSessionId?: string;
}

export interface OrcaBridgeMcpDeps {
  getMaker: () => Maker;
  logger: Logger;
  persistUserMessage: (
    sessionId: string,
    message: { clientId: string; content: string },
  ) => Promise<void>;
  wireSession: (session: Session) => void;
  hydrateSessionRoute?: (sessionId: string, providerId: string | null) => void | Promise<void>;
  /**
   * 远端 session 重建前的 preflight (SSH 重连 / agent install / 远端 MCP
   * 注入), 与宿主 IPC create/send 路径的 remote ensure 同语义。bridge
   * rehydrate (ensureSessionFromMeta) 直调 core createSession 不经 IPC 层,
   * 必须由宿主注入本回调补齐 — 缺失时 app 重启后 worker 回报会在 SSH 未
   * 重连 / agent 未安装 / 远端无协同 MCP 的状态下重建 lead
   * (review: PR #778 codex-connector R17 P1)。仅远端 capable 的宿主注入,
   * 缺省 no-op。
   */
  ensureRemoteSessionStart?: (params: {
    sessionId: string;
    agentKind: AgentKind;
    remoteHostId: string;
    workingDir: string;
  }) => Promise<void | {
    /**
     * 宿主 preflight 归一化后的 per-session Maker Memory 开关 (全局设置
     * backfill + stale-bridge 钳制, 与 IPC create/send 路径同一套 mutate)。
     * rehydrate 的 createSession 必须用它 — 缺省 (老宿主 / no-op) 按 false
     * 保守处理, 不得在未归一化的情况下注入记忆 (review R6 P2)。
     */
    makerMemoryEnabled?: boolean;
  }>;
  orcaTeamStore?: OrcaTeamStore;
  dispatchInterAgentMessage?: (params: {
    targetSessionId: string;
    rawContent: string;
    source: 'lead' | 'worker';
    senderLabel: string;
    workerId?: string;
    onAccepted?: () => void | Promise<void>;
    onAcceptedRollback?: () => void | Promise<void>;
    meta: {
      source: string;
      context: string;
    };
  }) => Promise<{
    ok: true;
    mode: 'dispatched' | 'queued';
    clientId: string;
    dispatchOutcome?: unknown;
  } | {
    ok: false;
    dispatchOutcome?: unknown;
  }>;
}

function text(data: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    isError,
  };
}

type OrcaToolResult = ReturnType<typeof text>;

type OrcaSendSource = 'mcp-tool' | 'auto-bridge';
type HostOrcaDispatch = { hostDispatched: true; queued: boolean };

interface OrcaSendMeta {
  source: OrcaSendSource;
  entrypoint: string;
  sessionId: string;
  agentKind?: string;
  action: string;
  context: string;
  workerId?: string;
  leadSessionId?: string;
  workerStatus?: OrcaWorkerStatus;
  autoBridgePending?: boolean;
}

interface SanitizedOrcaSendError {
  errorName?: string;
  errorCode?: string;
  errorKind?: string;
  safeMessage?: string;
}

const ORCA_SEND_OWNER = 'orca-workflow';
const SAFE_ERROR_NAME_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const SAFE_SEND_ERROR_CODES = new Set(['SESSION_RUNNING']);

function makeOrcaSendContext(entrypoint: string, sessionId: string, action: string): string {
  return `${entrypoint}/${sessionId}/${action}`;
}

function sanitizeOrcaSendError(err: unknown): SanitizedOrcaSendError {
  if (!(err instanceof Error)) return { errorKind: typeof err };
  const rawName = typeof err.name === 'string' ? err.name : '';
  const errorName = SAFE_ERROR_NAME_RE.test(rawName) ? rawName : 'Error';
  const rawCode = (err as { code?: unknown }).code;
  const errorCode = typeof rawCode === 'string' && SAFE_SEND_ERROR_CODES.has(rawCode)
    ? rawCode
    : undefined;
  return {
    errorName,
    ...(errorName === 'Error' && rawName !== 'Error' ? { errorKind: 'unknown' } : {}),
    ...(errorCode ? { errorCode } : {}),
    safeMessage: errorCode ?? errorName,
  };
}

function logOrcaSendNotDispatched(
  log: Logger,
  meta: OrcaSendMeta,
  reason: string,
  extra?: Record<string, unknown>,
): void {
  log.warn('orca bridge session send not dispatched', {
    kind: 'session-dispatch',
    source: meta.source,
    owner: ORCA_SEND_OWNER,
    entrypoint: meta.entrypoint,
    sessionId: meta.sessionId,
    agentKind: meta.agentKind,
    action: meta.action,
    reason,
    context: meta.context,
    workerId: meta.workerId,
    leadSessionId: meta.leadSessionId,
    workerStatus: meta.workerStatus,
    autoBridgePending: meta.autoBridgePending,
    ...extra,
  });
}

function makeOrcaDispatchToolError(
  meta: OrcaSendMeta,
  reason: 'cancelled-before-dispatch',
  extra?: Record<string, unknown>,
): OrcaToolResult {
  return text({
    error: 'session send not dispatched',
    kind: 'session-dispatch',
    source: meta.source,
    dispatched: false,
    reason,
    context: meta.context,
    worker_id: meta.workerId,
    session_id: meta.sessionId,
    lead_session_id: meta.leadSessionId,
    ...extra,
  }, true);
}

function makeOrcaRejectedToolError(
  meta: OrcaSendMeta,
  err: unknown,
  extra?: Record<string, unknown>,
): OrcaToolResult {
  const error = sanitizeOrcaSendError(err);
  return text({
    error: 'session send failed',
    kind: 'session-dispatch',
    source: meta.source,
    dispatched: false,
    reason: 'send-rejected',
    code: error.errorCode,
    context: meta.context,
    worker_id: meta.workerId,
    session_id: meta.sessionId,
    lead_session_id: meta.leadSessionId,
    ...extra,
  }, true);
}

function isHostOrcaDispatch(result: OrcaToolResult | HostOrcaDispatch | null): result is HostOrcaDispatch {
  return result !== null && typeof result === 'object' && 'hostDispatched' in result && result.hostDispatched === true;
}

async function dispatchOrcaToolMessage(input: {
  session: Session;
  message: Parameters<Session['send']>[0];
  deps?: OrcaBridgeMcpDeps;
  rawContent?: string;
  source?: 'lead' | 'worker';
  senderLabel?: string;
  log: Logger;
  meta: OrcaSendMeta;
  errorExtra?: Record<string, unknown>;
  onAccepted?: () => void | Promise<void>;
  hostOnAccepted?: () => void | Promise<void>;
  hostOnAcceptedRollback?: () => void | Promise<void>;
  getLogState?: () => Pick<OrcaSendMeta, 'workerStatus' | 'autoBridgePending'>;
}): Promise<OrcaToolResult | HostOrcaDispatch | null> {
  const readMeta = () => ({
    ...input.meta,
    ...input.getLogState?.(),
  });
  if (input.deps?.dispatchInterAgentMessage && input.rawContent && input.source && input.senderLabel) {
    const result = await input.deps.dispatchInterAgentMessage({
      targetSessionId: input.session.id,
      rawContent: input.rawContent,
      source: input.source,
      senderLabel: input.senderLabel,
      workerId: input.meta.workerId,
      onAccepted: input.hostOnAccepted ?? input.onAccepted,
      onAcceptedRollback: input.hostOnAcceptedRollback,
      meta: {
        source: input.meta.source,
        context: input.meta.context,
      },
    });
    if (result.ok) return { hostDispatched: true, queued: result.mode === 'queued' };
    const meta = readMeta();
    logOrcaSendNotDispatched(input.log, meta, 'send-rejected', {
      dispatchOutcome: result.dispatchOutcome,
    });
    return makeOrcaRejectedToolError(meta, new Error('host dispatch failed'), input.errorExtra);
  }
  try {
    const result = await input.session.send(input.message, {
      planMode: false,
      onAccepted: input.onAccepted,
    });
    const meta = readMeta();
    const outcome = toSessionDispatchOutcome(result, meta.context);
    if (outcome.dispatched) return null;
    logOrcaSendNotDispatched(input.log, meta, outcome.reason);
    return makeOrcaDispatchToolError(meta, outcome.reason, input.errorExtra);
  } catch (err) {
    const meta = readMeta();
    const error = sanitizeOrcaSendError(err);
    logOrcaSendNotDispatched(input.log, meta, 'send-rejected', {
      code: error.errorCode,
      error,
    });
    return makeOrcaRejectedToolError(meta, err, input.errorExtra);
  }
}

// 导出: main 进程的 worker initial_task 派活路径需要复用同一份 lead→worker
// 消息格式 (持久化用 formatOrcaCommunicationMessage, 真正 send 到 worker
// session 用 formatAgentMessage), 才能保证 MCP 工具 + 手动 toggle 两条入口的
// 派活效果完全一致。
export function formatOrcaCommunicationMessage(
  orcaSource: 'lead' | 'worker',
  content: string,
): string {
  return JSON.stringify({ orcaSource, content });
}

export function formatAgentMessage(source: 'lead' | 'worker', content: string, workerId?: string): string {
  const label = source === 'lead' ? '[From Orca Lead]' : '[From Orca Worker]';
  if (source === 'lead' && workerId) {
    return `${label}\n${content}\n\n---\n(Bridge note: your worker_id for tool calls is ${workerId}.)`;
  }
  return `${label}\n${content}`;
}

function captureSessionOutput(
  entry: Pick<CapturedSessionEntry, 'finalText' | 'lastEventAt' | 'status'>,
  ev: AgentEvent,
): void {
  entry.lastEventAt = Date.now();
  if (ev.type === 'text') {
    const data = ev.data as { text?: unknown; isFinal?: unknown } | null;
    if (typeof data?.text !== 'string') return;
    entry.finalText = data.isFinal === true
      ? data.text
      : (entry.finalText + data.text).slice(-MAX_CAPTURED_TEXT);
    return;
  }
  if (ev.type === 'done') {
    const result = (ev.data as { result?: unknown } | null)?.result;
    if (typeof result === 'string' && result.length > 0) {
      entry.finalText = result;
    }
    entry.status = 'done';
    return;
  }
  if (isTerminalAgentErrorEvent(ev)) {
    entry.status = 'error';
  }
}

// B(worker→lead) 仍保留 package 内 pending map: worker 主动 send_to_lead accepted
// 后会清这里，避免 legacy A 尚在的旧会话或测试环境重复 auto-bridge。
interface AutoBridgeState {
  pending: boolean;
  ready: boolean;
  inFlight: boolean;
  version: number;
  deferred?: {
    finalText: string;
    status: 'done' | 'error';
  };
}

const workerAutoBridgePending = new Map<string, AutoBridgeState>();

function peekAutoBridgeState(workerId: string): AutoBridgeState | null {
  return workerAutoBridgePending.get(workerId) ?? null;
}

function setAutoBridgePending(workerId: string, pending: boolean): void {
  let state = peekAutoBridgeState(workerId);
  if (!state) {
    state = { pending: false, ready: false, inFlight: false, version: 0 };
    workerAutoBridgePending.set(workerId, state);
  }
  state.pending = pending;
  state.ready = false;
  state.inFlight = false;
  state.deferred = undefined;
  state.version += 1;
}

function hasAutoBridgePending(workerId: string): boolean {
  return peekAutoBridgeState(workerId)?.pending ?? false;
}

function clearAutoBridgePending(workerId: string): void {
  workerAutoBridgePending.delete(workerId);
}

export const __testing = {
  autoBridgeStateCount: () => workerAutoBridgePending.size,
  clearAutoBridgeState: clearAutoBridgePending,
  hasAutoBridgePending,
};

function attachSessionCapture(entry: CapturedSessionEntry): void {
  if (!entry.session) return;
  if (entry.captureDispose) return;
  entry.captureDispose = entry.session.onEvent((ev) => {
    entry.eventSeq += 1;
    const eventSeq = entry.eventSeq;
    const isTerminalEvent = ev.type === 'done' || isTerminalAgentErrorEvent(ev);
    captureSessionOutput(entry, ev);
    if (isTerminalEvent) {
      entry.terminalEventSeq = eventSeq;
    }
  });
}


async function ensureSessionFromMeta(
  deps: OrcaBridgeMcpDeps,
  meta: OrcaPersistedSession,
  vendorOptions?: Record<string, unknown>,
): Promise<Session> {
  const maker = deps.getMaker();
  await deps.hydrateSessionRoute?.(meta.sessionId, meta.providerId ?? null);
  const active = maker.getSession(meta.sessionId);
  if (active) return active;
  // 远端 lead 重建前必须跑宿主 remote preflight (SSH 重连 / agent install /
  // 远端 MCP 注入):bridge 直调 core createSession 不经 maker-ipc, 跳过这步
  // 会让 app 重启后的首次 worker 回报 host-not-ready 或远端无协同 MCP。
  let remoteMakerMemoryEnabled = false;
  if (meta.remoteHostId) {
    const preflight = await deps.ensureRemoteSessionStart?.({
      sessionId: meta.sessionId,
      agentKind: meta.agentKind,
      remoteHostId: meta.remoteHostId,
      workingDir: meta.workingDir,
    });
    // SSH remote 的 Maker Memory 与 IPC create/send 路径同语义:开关由
    // preflight 归一化 (全局设置 backfill + stale-bridge 钳制) 后回传;
    // 老宿主 / 未注入 preflight 时保守按 false — 不得在未归一化的情况下
    // 注入 (review R6 P2:此前这里硬编码 false, 把远端 rehydrate 会话的
    // 记忆永久关死, 与已放开的其余路径分叉)。
    remoteMakerMemoryEnabled = preflight?.makerMemoryEnabled === true;
  }
  const session = await maker.createSession({
    id: meta.sessionId,
    agentKind: meta.agentKind,
    workingDir: meta.workingDir,
    model: meta.model,
    providerId: meta.providerId ?? undefined,
    effort: meta.effort,
    permissionMode: meta.permissionMode,
    fastMode: meta.fastMode,
    title: meta.title,
    ...(vendorOptions ? { vendorOptions } : {}),
    ...(meta.sdkSessionId ? { resumeSessionId: meta.sdkSessionId } : {}),
    // 远端 lead 在同一台 SSH 主机上重建; 本地 lead 无这两个字段。
    ...(meta.remoteHostId
      ? { remoteHostId: meta.remoteHostId, makerMemoryEnabled: remoteMakerMemoryEnabled }
      : {}),
  });
  deps.wireSession(session);
  return session;
}

function updatePersistedWorkerStatus(
  deps: OrcaBridgeMcpDeps,
  workerId: string,
  status: OrcaWorkerStatus,
  log: Logger,
): void {
  deps.orcaTeamStore?.updateWorkerStatus(workerId, status).catch((err) => {
    log.warn('update worker status failed', { err: String(err), workerId, status });
  });
}

function readWorkerIdentity(
  vendorOptions: Record<string, unknown> | undefined,
  workerIdParam?: string,
): { workerId?: string; workerSessionId?: string } {
  const workerId = typeof workerIdParam === 'string' && workerIdParam.trim()
    ? workerIdParam.trim()
    : typeof vendorOptions?.orcaWorkerId === 'string'
      ? vendorOptions.orcaWorkerId
      : undefined;
  const workerSessionId = typeof vendorOptions?.orcaWorkerSessionId === 'string'
    ? vendorOptions.orcaWorkerSessionId
    : undefined;
  return { workerId, workerSessionId };
}

function resolveRuntimeMcpContext(ctx: McpProviderContext): McpProviderContext {
  return ctx.getSessionContext?.() ?? ctx;
}

function readWorkerCallerSessionId(ctx: McpProviderContext): string | undefined {
  if (typeof ctx.sessionId === 'string' && ctx.sessionId.trim()) {
    return ctx.sessionId.trim();
  }
  const sessionId = ctx.vendorOptions?.orcaWorkerSessionId;
  return typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : undefined;
}

async function resolveWorkerLink(
  deps: OrcaBridgeMcpDeps,
  ctx: McpProviderContext,
  workerIdParam: string | undefined,
): Promise<
  | { ok: true; link: OrcaWorkerLink }
  | { ok: false; error: Record<string, unknown> }
> {
  const store = deps.orcaTeamStore;
  if (!store) {
    return { ok: false, error: { error: 'orca workflow store unavailable' } };
  }
  const runtimeCtx = resolveRuntimeMcpContext(ctx);
  const identity = readWorkerIdentity(runtimeCtx.vendorOptions, workerIdParam);
  const callerSessionId = readWorkerCallerSessionId(runtimeCtx);
  if (runtimeCtx.vendorOptions?.orcaRole !== 'worker' || !callerSessionId) {
    return {
      ok: false,
      error: {
        error: 'not an orca worker session',
        worker_id: identity.workerId,
        detail: 'Start the worker with Orca worker vendorOptions and call from the owning worker session.',
      },
    };
  }
  const link = await store.getWorkerLink({
    workerId: identity.workerId,
    workerSessionId: identity.workerSessionId ?? callerSessionId,
  });
  if (!link) {
    return {
      ok: false,
      error: {
        error: 'orca worker mapping not found',
        worker_id: identity.workerId,
        worker_session_id: identity.workerSessionId,
      },
    };
  }
  if (identity.workerId && identity.workerId !== link.workerId) {
    return {
      ok: false,
      error: {
        error: 'worker identity mismatch',
        worker_id: identity.workerId,
        resolved_worker_id: link.workerId,
      },
    };
  }
  if (callerSessionId !== link.workerSessionId) {
    return {
      ok: false,
      error: {
        error: 'worker session mismatch',
        worker_id: link.workerId,
        worker_session_id: callerSessionId,
        resolved_worker_session_id: link.workerSessionId,
      },
    };
  }
  return { ok: true, link };
}

async function ensureCapturedSession(
  registry: CapturedSessionRegistry,
  deps: OrcaBridgeMcpDeps,
  meta: OrcaPersistedSession,
  vendorOptions?: Record<string, unknown>,
): Promise<CapturedSessionEntry> {
  const existing = registry.get(meta.sessionId);
  if (existing?.session) {
    // 缓存里的 session 引用可能已被 active-orca rehydrate 关闭并重建；这里检测
    // stale 引用并重新订阅 live Session，避免 bridge 继续监听已关闭实例。
    const status = existing.session.getStatus();
    if (status !== 'closed' && status !== 'error') return existing;
    existing.captureDispose?.();
    existing.captureDispose = undefined;
    existing.session = null;
  }
  const session = await ensureSessionFromMeta(deps, meta, vendorOptions);
  const entry: CapturedSessionEntry = existing ?? {
    sessionId: meta.sessionId,
    session,
    status: 'idle',
    finalText: '',
    lastEventAt: Date.now(),
    eventSeq: 0,
    terminalEventSeq: 0,
  };
  entry.session = session;
  attachSessionCapture(entry);
  if (!existing) registry.add(entry);
  return entry;
}


// 契约锚点：归属校验与 auto-bridge settle 见 docs/dev-rules/orca-team-architecture.md「协同运行时行为契约」「坑点与不变量 #3」。
// Codex MCP HTTP bridge 仍然从全局 ctx 注册 server 名称，所以 worker bridge 必须
// 对 Codex 可见。真正的执行边界在工具调用时 fail-closed：resolveWorkerLink 会读
// 本次调用绑定的 session ctx，并校验它确实拥有解析出的 worker link。
export function createOrcaWorkerBridgeMcpProvider(deps: OrcaBridgeMcpDeps): McpProvider {
  const log = deps.logger.child('mcp/orca_worker_bridge');
  const leadCaptures = new CapturedSessionRegistry();
  return {
    name: 'orca_worker_bridge',
    isEnabled: (ctx) => ctx.vendorOptions?.orcaRole === 'worker' || ctx.agentKind === 'codex',
    toClaudeSdkConfig: (ctx) => {
      if (ctx.vendorOptions?.orcaRole !== 'worker' && ctx.agentKind !== 'codex') return null;
      const server = new McpServer({ name: 'orca_worker_bridge', version: '0.1.0' });

      async function resolveLead(workerId?: string) {
        const resolved = await resolveWorkerLink(deps, ctx, workerId);
        if (!resolved.ok) return resolved;
        const link = resolved.link;
        const leadVendorOptions: OrcaLeadVendorOptions = {
          orcaRole: 'lead',
          orcaLeadSessionId: link.leadSessionId,
        };
        const entry = await ensureCapturedSession(
          leadCaptures,
          deps,
          link.leadSession,
          leadVendorOptions,
        );
        return { ok: true as const, link, entry };
      }

      server.tool(
        'send_to_lead',
        'You MUST pass your worker_id (see the Bridge note at the end of the most recent lead message). Report results or ask a question to the lead session.',
        {
          message: z.string().min(1),
          worker_id: z.string().min(1).describe('Required. Your assigned worker_id. Find it in the Bridge note at the end of the most recent lead message, or in the system prompt Identity line.'),
        },
        async ({ message, worker_id }) => {
          const resolved = await resolveLead(worker_id);
          if (!resolved.ok) return text(resolved.error, true);
          const { link, entry } = resolved;
          if (!entry.session) {
            return text({
              error: 'lead session is not running',
              lead_session_id: link.leadSessionId,
            }, true);
          }
          const liveEntry = entry as CapturedSessionEntry & { session: Session };
          const previousStatus = liveEntry.status;
          const previousFinalText = liveEntry.finalText;
          const previousLastEventAt = liveEntry.lastEventAt;
          const previousEventSeq = liveEntry.eventSeq;
          const previousTerminalEventSeq = liveEntry.terminalEventSeq;
          const markLeadDispatchAccepted = () => {
            const observedEventDuringDispatch =
              liveEntry.eventSeq !== previousEventSeq ||
              liveEntry.status !== previousStatus ||
              liveEntry.finalText !== previousFinalText ||
              liveEntry.lastEventAt !== previousLastEventAt;
            if (liveEntry.terminalEventSeq !== previousTerminalEventSeq) {
              return;
            }
            if (!observedEventDuringDispatch || liveEntry.finalText === previousFinalText) {
              liveEntry.finalText = '';
            }
            liveEntry.status = 'running';
            liveEntry.lastEventAt = Date.now();
          };
          // worker 回报被 host 接收(直发 accept 或入队成功)即视为"已回报": 立刻标 done +
          // 清 autoBridgePending。不能等排队消息 drain 到 lead 才清 —— lead 忙时 worker
          // 自己的 turn 会先结束, turn-end 兜底看到 pending 还在会把它当"忘了回报"再补
          // 一条桥接, lead 收到两条重复报告。幂等守卫同时防住 drain 时 hostOnAccepted
          // 二次触发: 那时 worker 可能已被重新派活(running), 不能再改回 done。
          let workerReportSettled = false;
          const settleWorkerReport = () => {
            if (workerReportSettled) return;
            workerReportSettled = true;
            updatePersistedWorkerStatus(deps, link.workerId, 'done', log);
            setAutoBridgePending(link.workerId, false);
          };
          const dispatchError = await dispatchOrcaToolMessage({
            session: liveEntry.session,
            message: { type: 'user', content: formatAgentMessage('worker', message) },
            deps,
            rawContent: message,
            source: 'worker',
            senderLabel: link.workerId,
            log,
            meta: {
              source: 'mcp-tool',
              entrypoint: 'orca_worker_bridge.send_to_lead',
              sessionId: link.leadSessionId,
              agentKind: link.leadSession.agentKind,
              action: 'dispatch-to-lead',
              context: makeOrcaSendContext(
                'orca_worker_bridge.send_to_lead',
                link.leadSessionId,
                'dispatch-to-lead',
              ),
              workerId: link.workerId,
              leadSessionId: link.leadSessionId,
            },
            getLogState: () => ({
              workerStatus: liveEntry.status,
              autoBridgePending: hasAutoBridgePending(link.workerId),
            }),
            onAccepted: markLeadDispatchAccepted,
            hostOnAccepted: () => {
              markLeadDispatchAccepted();
              settleWorkerReport();
            },
          });
          if (isHostOrcaDispatch(dispatchError)) {
            if (dispatchError.queued) settleWorkerReport();
            return text({
              ok: true,
              ...(dispatchError.queued ? { queued: true } : {}),
              worker_id: link.workerId,
              lead_session_id: link.leadSessionId,
            });
          }
          if (dispatchError) {
            liveEntry.status = previousStatus;
            liveEntry.finalText = previousFinalText;
            liveEntry.lastEventAt = previousLastEventAt;
            return dispatchError;
          }
          markLeadDispatchAccepted();
          await deps.persistUserMessage(link.leadSessionId, {
            clientId: randomUUID(),
            content: formatOrcaCommunicationMessage('worker', message),
          }).catch((err) => {
            log.warn('persist lead message failed', {
              err: String(err),
              workerId: link.workerId,
              leadSessionId: link.leadSessionId,
            });
          });
          settleWorkerReport();
          return text({
            ok: true,
            worker_id: link.workerId,
            lead_session_id: link.leadSessionId,
          });
        },
      );

      server.tool(
        'read_lead',
        'You MUST pass your worker_id (see the Bridge note at the end of the most recent lead message). Read captured output from the lead session.',
        {
          worker_id: z.string().min(1).describe('Required. Your assigned worker_id. Find it in the Bridge note at the end of the most recent lead message, or in the system prompt Identity line.'),
        },
        async ({ worker_id }) => {
          const resolved = await resolveLead(worker_id);
          if (!resolved.ok) return text(resolved.error, true);
          const { link, entry } = resolved;
          return text({
            worker_id: link.workerId,
            lead_session_id: link.leadSessionId,
            status: entry.status,
            session_status: entry.session?.getStatus() ?? 'not_running',
            idle_ms: Date.now() - entry.lastEventAt,
            result: entry.finalText,
          });
        },
      );

      server.tool(
        'lead_status',
        'You MUST pass your worker_id (see the Bridge note at the end of the most recent lead message). Check the lead session state.',
        {
          worker_id: z.string().min(1).describe('Required. Your assigned worker_id. Find it in the Bridge note at the end of the most recent lead message, or in the system prompt Identity line.'),
        },
        async ({ worker_id }) => {
          const resolved = await resolveLead(worker_id);
          if (!resolved.ok) return text(resolved.error, true);
          const { link, entry } = resolved;
          return text({
            worker_id: link.workerId,
            lead_session_id: link.leadSessionId,
            status: entry.status,
            session_status: entry.session?.getStatus() ?? 'not_running',
            idle_ms: Date.now() - entry.lastEventAt,
          });
        },
      );

      return {
        type: 'sdk',
        name: 'orca_worker_bridge',
        instance: server,
      };
    },
  };
}
