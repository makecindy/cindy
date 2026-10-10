/**
 * Lead 所在电脑侧：驱动在另一台电脑(运行设备)上运行的协同 Worker。
 *
 * 远端 Worker 在本机只有一条代理任务行(不跑 Agent)，真实任务在运行设备上。本模块负责：
 *  - 派活：经 `maker:input:enqueue` 投递到运行设备的任务，按 clientId 幂等；
 *  - 轮询：每台设备一次 `maker:list-active` 得到全部远端 Worker 的运行状态，派活后加快节奏；
 *  - 回报：派出的消息已进入对话(投递回执 accepted)且运行设备不在跑时，按该 user 的 clientId
 *    找对应的 assistant 回复交给 auto-bridge；按消息 id 去重，断线重连后自然补报；
 *  - 可达性：设备调用失败即标为不可达，恢复后自动回到在线，不判失败、不重派。
 *
 * 用户在运行设备上直接发的消息(插话)不会触发回报：只有本机派出、仍在等待回报的消息才会。
 */
import {
  DL_HISTORY_MESSAGES_CHANNEL,
  ORCA_REMOTE_WORKER_RELEASE_CHANNEL,
} from '@cindy/device-link';
import { formatAgentMessage, formatOrcaCommunicationMessage } from '@cindy/orca-workflow';
import type { OrcaRemotePendingReport } from '../../shared/orcaRemoteWorker.js';

import type {
  AgentInputCreateOpts,
  AgentInputQueuedMessage,
} from '../../shared/agentInputQueue.js';
import type { HistoryCursor, HistoryMessage, HistoryPage } from '../localDb/chatHistoryReader.js';

export interface RemoteWorkerRef {
  workerId: string;
  teamId: string;
  leadSessionId: string;
  /** 本机代理任务行 id；Orca 状态机、auto-bridge 都以它为键。 */
  proxySessionId: string;
  deviceId: string;
  /** 运行设备上的真实任务 id。 */
  remoteSessionId: string;
  lastBridgedMessageId: string | null;
  pendingReport?: OrcaRemotePendingReport | null;
}

export interface RemoteWorkerTurnEnd {
  status: 'done' | 'error';
  finalText: string;
  diagnostic?: string;
}

export type RemoteWorkerDispatchResult =
  | { ok: true; mode: 'dispatched' | 'queued' }
  | {
      ok: false;
      code: 'DEVICE_UNREACHABLE' | 'SESSION_NOT_FOUND' | 'SEND_FAILED';
      message: string;
    };

export interface OrcaRemoteWorkerRuntimeDeps {
  /** 调用运行设备的 channel；失败抛出 Error(message 形如 `[CODE] ...`)。 */
  invoke(deviceId: string, channel: string, args: unknown[]): Promise<unknown>;
  deviceName(deviceId: string): string;
  saveReport(
    workerId: string,
    pending: OrcaRemotePendingReport | null,
    messageId?: string,
  ): Promise<void>;
  isOwnerCurrent?(): boolean;
  onTurnStarted(proxySessionId: string): Promise<void>;
  /** 同步冻结已完成宿主 accepted 生命周期的回报身份，异步收尾不得重新读取新派活身份。 */
  captureTurnEnded(proxySessionId: string): (turn: RemoteWorkerTurnEnd) => Promise<boolean>;
  /** 可达性或运行状态变化，供协同面板刷新。 */
  onWorkerStateChanged(leadSessionId: string): void;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  log: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

/** 派活后的轮询间隔；没有待回报时只做低频的可达性刷新。 */
export const REMOTE_WORKER_FAST_POLL_MS = 2_000;
export const REMOTE_WORKER_IDLE_POLL_MS = 15_000;
/** 消息已进入对话、设备不在跑，但还没有新回复时，最多再等这么多轮才按异常收尾。 */
const MISSING_REPLY_POLLS = 15;
/** `local-db:history:messages` 的 contentCharLimit 只接受 1–8000。 */
const MAX_REPORT_CHARS = 8_000;
/** 单轮只读最多 2000 行 user/assistant，预算用尽后下一轮从游标续读。 */
const REPORT_HISTORY_PAGE_SIZE = 100;
const REPORT_HISTORY_MAX_PAGES = 20;

/** 视为「设备当前不可达」的错误码：relay / 链路 / 本机开关 / 熔断。其余错误按普通失败处理。 */
const UNREACHABLE_CODES = new Set([
  'DEVICE_OFFLINE',
  'REMOTE_DISABLED',
  'ACCESS_REVOKED',
  'INVOKE_TIMEOUT',
  'LINK_NOT_OPEN',
  'NOT_CONNECTED',
  'DEVICE_LINK_NOT_CONNECTED',
  'DEVICE_LINK_CONTROL_DISABLED',
  'DEVICE_LINK_STANDBY',
  'DEVICE_UNRESPONSIVE',
]);

interface AwaitingReport {
  clientIds: string[];
  baselineMessageId: string | null;
  startedNotified: boolean;
  missingReplyPolls: number;
  terminalHandler: ((turn: RemoteWorkerTurnEnd) => Promise<boolean>) | null;
  /** 宿主 accepted 回调失败时恢复上一代原对象；确认成功后释放。 */
  previous: AwaitingReport | null;
  historyScan: ReportHistoryScan | null;
}

interface ReportHistoryScan {
  cursor: HistoryCursor | null;
  reply: { id: string; text: string } | null;
  newerInput: boolean;
  terminalError: boolean;
}

interface WorkerState {
  ref: RemoteWorkerRef;
  inTurn: boolean;
  awaiting: AwaitingReport | null;
  /** 运行设备上的工作目录(只做展示)；重启后首次轮询时补读。 */
  workingDir: string | null;
  persistence: Promise<void>;
}

function errorCode(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err);
  const match = /^\[([A-Z_]+)\]/.exec(message);
  if (match) return match[1] ?? null;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === 'string'
          ? block
          : block &&
              typeof block === 'object' &&
              typeof (block as { text?: unknown }).text === 'string'
            ? (block as { text: string }).text
            : '',
      )
      .filter(Boolean)
      .join('\n');
  }
  if (
    content &&
    typeof content === 'object' &&
    typeof (content as { text?: unknown }).text === 'string'
  ) {
    return (content as { text: string }).text;
  }
  return '';
}

function agentKindOf(value: unknown): AgentInputCreateOpts['agentKind'] {
  return value === 'codex' || value === 'pi' ? value : 'claude-code';
}

interface RemoteSessionRow {
  agentKind?: unknown;
  workingDir?: unknown;
  model?: unknown;
  providerId?: unknown;
  effort?: unknown;
  permissionMode?: unknown;
  fastMode?: unknown;
  planModeEnabled?: unknown;
  sdkSessionId?: unknown;
}

/** 远端任务的建会话参数取自运行设备的任务记录；本机不知道它的原生会话 id 等运行态。 */
function createOptsFromRow(row: RemoteSessionRow): AgentInputCreateOpts {
  const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  return {
    agentKind: agentKindOf(row.agentKind === 'cc' ? 'claude-code' : row.agentKind),
    workingDir: str(row.workingDir) ?? '',
    model: str(row.model) ?? '',
    ...(str(row.providerId) ? { providerId: str(row.providerId) } : {}),
    ...(str(row.effort) ? { effort: str(row.effort) } : {}),
    ...(typeof row.fastMode === 'boolean' ? { fastMode: row.fastMode } : {}),
    ...(str(row.permissionMode) ? { permissionMode: str(row.permissionMode) } : {}),
    ...(typeof row.planModeEnabled === 'boolean' ? { planMode: row.planModeEnabled } : {}),
    ...(str(row.sdkSessionId) ? { resumeSessionId: str(row.sdkSessionId) } : {}),
  };
}

/** 远端没有 Orca Worker 桥：只带来源标签，不附 worker_id 工具提示。 */
export function buildRemoteWorkerQueuedMessage(params: {
  clientId: string;
  rawContent: string;
  createOpts: AgentInputCreateOpts;
  createdAt: string;
}): AgentInputQueuedMessage {
  const persistedContent = formatOrcaCommunicationMessage('lead', params.rawContent);
  return {
    clientId: params.clientId,
    durableDelivery: true,
    text: formatAgentMessage('lead', params.rawContent),
    persistedContent,
    model: params.createOpts.model,
    effort: params.createOpts.effort ?? '',
    permissionMode: params.createOpts.permissionMode ?? 'auto',
    workingDir: params.createOpts.workingDir,
    chatMessage: {
      clientId: params.clientId,
      role: 'user',
      content: persistedContent,
      createdAt: params.createdAt,
    },
    createOpts: params.createOpts,
    origin: { kind: 'orca', senderLabel: 'Lead', displayText: params.rawContent },
  };
}

export function createOrcaRemoteWorkerRuntime(deps: OrcaRemoteWorkerRuntimeDeps) {
  const workers = new Map<string, WorkerState>();
  const unreachableDevices = new Set<string>();
  let timer: unknown = null;
  let polling = false;
  let stopped = false;

  const current = (state: WorkerState) =>
    !stopped &&
    workers.get(state.ref.proxySessionId) === state &&
    deps.isOwnerCurrent?.() !== false;

  function persist(
    state: WorkerState,
    settled?: AwaitingReport,
    messageId?: string,
  ): Promise<void> {
    const write = state.persistence
      .catch(() => undefined)
      .then(async () => {
        if (!current(state)) throw new Error('remote worker owner changed');
        const pending = state.awaiting === settled ? null : state.awaiting;
        await deps.saveReport(
          state.ref.workerId,
          pending
            ? {
                clientIds: pending.clientIds,
                baselineMessageId: pending.baselineMessageId,
              }
            : null,
          messageId,
        );
        if (!current(state)) return;
        if (messageId) state.ref = { ...state.ref, lastBridgedMessageId: messageId };
        if (settled && state.awaiting === settled) state.awaiting = null;
      });
    state.persistence = write;
    return write;
  }

  function deviceUnreachable(err: unknown): boolean {
    const code = errorCode(err);
    return code !== null && UNREACHABLE_CODES.has(code);
  }

  function leadsOnDevice(deviceId: string): string[] {
    return [
      ...new Set(
        [...workers.values()]
          .filter((state) => state.ref.deviceId === deviceId)
          .map((state) => state.ref.leadSessionId),
      ),
    ];
  }

  function setReachable(deviceId: string, reachable: boolean): void {
    const changed = reachable
      ? unreachableDevices.delete(deviceId)
      : !unreachableDevices.has(deviceId);
    if (!reachable) unreachableDevices.add(deviceId);
    if (changed) {
      deps.log.info('orca remote worker device reachability changed', { deviceId, reachable });
      for (const lead of leadsOnDevice(deviceId)) deps.onWorkerStateChanged(lead);
    }
  }

  function schedule(): void {
    if (stopped) return;
    if (timer !== null) deps.clearTimeout(timer);
    timer = null;
    if (workers.size === 0) return;
    const fast = [...workers.values()].some((state) => state.awaiting !== null);
    timer = deps.setTimeout(
      () => {
        timer = null;
        void pollOnce().finally(schedule);
      },
      fast ? REMOTE_WORKER_FAST_POLL_MS : REMOTE_WORKER_IDLE_POLL_MS,
    );
  }

  async function lastAssistantMessage(ref: RemoteWorkerRef): Promise<{
    id: string | null;
    text: string;
    terminalError: boolean;
  }> {
    const page = (await deps.invoke(ref.deviceId, DL_HISTORY_MESSAGES_CHANNEL, [
      {
        sessionId: ref.remoteSessionId,
        workdir: null,
        fromMs: null,
        toMs: null,
        agentKind: null,
        roles: ['assistant'],
        includeRewound: false,
        limit: 1,
        cursor: null,
        order: 'desc',
        contentCharLimit: MAX_REPORT_CHARS,
      },
    ])) as {
      items?: Array<{ id?: unknown; content?: unknown }>;
      terminal?: { status?: unknown } | null;
    };
    const item = Array.isArray(page?.items) ? page.items[0] : undefined;
    return {
      id: typeof item?.id === 'string' ? item.id : null,
      text: textOf(item?.content).slice(-MAX_REPORT_CHARS),
      terminalError: page?.terminal?.status === 'error',
    };
  }

  async function deliveryStates(ref: RemoteWorkerRef, clientIds: string[]): Promise<string[]> {
    const projection = (await deps.invoke(ref.deviceId, 'maker:input:get-projection', [
      ref.remoteSessionId,
      { deliveryClientIds: clientIds },
    ])) as { deliveryReceipts?: Array<{ clientId?: unknown; state?: unknown }> };
    const receipts = Array.isArray(projection?.deliveryReceipts) ? projection.deliveryReceipts : [];
    return clientIds.map((id) => {
      const receipt = receipts.find((entry) => entry.clientId === id);
      return typeof receipt?.state === 'string' ? receipt.state : 'unknown';
    });
  }

  async function replyForInputs(
    ref: RemoteWorkerRef,
    clientIds: string[],
    scan: ReportHistoryScan,
  ): Promise<{
    id: string | null;
    text: string;
    terminalError: boolean;
    complete: boolean;
  }> {
    const inputs = new Set(clientIds);
    for (let pageIndex = 0; pageIndex < REPORT_HISTORY_MAX_PAGES; pageIndex += 1) {
      const page = (await deps.invoke(ref.deviceId, DL_HISTORY_MESSAGES_CHANNEL, [
        {
          sessionId: ref.remoteSessionId,
          workdir: null,
          fromMs: null,
          toMs: null,
          agentKind: null,
          roles: ['user', 'assistant'],
          includeRewound: false,
          limit: REPORT_HISTORY_PAGE_SIZE,
          cursor: scan.cursor,
          order: 'desc',
          contentCharLimit: MAX_REPORT_CHARS,
        },
      ])) as HistoryPage<
        Pick<HistoryMessage, 'id' | 'clientId' | 'role' | 'content' | 'agentMeta'>
      > & {
        terminal?: { status?: unknown } | null;
      };
      if (scan.cursor === null) scan.terminalError = page?.terminal?.status === 'error';
      for (const item of Array.isArray(page?.items) ? page.items : []) {
        // 子 Agent 的消息不构成顶层输入/回复边界。
        if ((item.agentMeta as { parentUuid?: unknown } | null)?.parentUuid) continue;
        if (item.role === 'assistant' && typeof item.id === 'string' && !scan.reply) {
          scan.reply = { id: item.id, text: textOf(item.content).slice(-MAX_REPORT_CHARS) };
        } else if (item.role === 'user') {
          // 自动续跑(额度恢复后、供应商组换电脑后)的隐藏消息接着同一次派活，不是插话：它之后的回复照常收尾。
          if ((item.agentMeta as { autoResume?: unknown } | null)?.autoResume === true) continue;
          if (typeof item.clientId === 'string' && inputs.has(item.clientId)) {
            return {
              id: scan.reply?.id ?? null,
              text: scan.reply?.text ?? '',
              terminalError: !scan.newerInput && scan.terminalError,
              complete: true,
            };
          }
          // 倒序先遇到的非 Lead 输入及其回复属于插话，不能用来收尾派活。
          scan.newerInput = true;
          scan.reply = null;
        }
      }
      if (!page?.hasMore) return { id: null, text: '', terminalError: false, complete: true };
      if (!page.nextCursor || page.nextCursor.id === scan.cursor?.id) {
        throw new Error('remote worker history pagination cursor did not advance');
      }
      scan.cursor = page.nextCursor;
    }
    return { id: null, text: '', terminalError: false, complete: false };
  }

  async function finishTurn(
    state: WorkerState,
    turn: RemoteWorkerTurnEnd,
    messageId: string | null,
    awaiting: AwaitingReport,
  ) {
    if (!current(state) || state.awaiting !== awaiting) return;
    state.inTurn = false;
    // TeamService 拒收回报时正常返回；必须取得结清确认后才推进去重游标。
    if (!(await awaiting.terminalHandler!(turn)) || !current(state)) return;
    await persist(state, awaiting, messageId ?? undefined);
    deps.onWorkerStateChanged(state.ref.leadSessionId);
  }

  async function checkAwaiting(state: WorkerState, running: boolean): Promise<void> {
    const awaiting = state.awaiting;
    if (!awaiting?.terminalHandler) return;
    if (running) {
      if (!awaiting.startedNotified) {
        awaiting.startedNotified = true;
        await deps.onTurnStarted(state.ref.proxySessionId);
      }
      return;
    }
    const states = await deliveryStates(state.ref, awaiting.clientIds);
    if (!current(state) || state.awaiting !== awaiting) return;
    // 仍在运行设备的队列里(排在用户插话之后等)，继续等。
    if (states.some((value) => value === 'pending')) return;
    if (states.every((value) => value === 'removed')) {
      await finishTurn(
        state,
        {
          status: 'error',
          finalText: '',
          diagnostic: `派给 ${deps.deviceName(state.ref.deviceId)} 的消息在那台电脑上被撤回，Worker 没有执行。`,
        },
        null,
        awaiting,
      );
      return;
    }
    const scan = (awaiting.historyScan ??= {
      cursor: null,
      reply: null,
      newerInput: false,
      terminalError: false,
    });
    const last = await replyForInputs(
      state.ref,
      // 崩溃可能发生在预写身份之后、enqueue 之前，也可能只是投递回执过期。
      // unknown 同样查历史，查不到时按有限轮数报告未确认执行，绝不盲目重发。
      awaiting.clientIds.filter((_, index) => states[index] !== 'removed'),
      scan,
    );
    // 历史读取期间又派入新任务时保留新的 awaiting，下一轮按完整输入集合复核。
    if (!current(state) || state.awaiting !== awaiting) return;
    // 扫描预算不足不代表没有回复，保留当前游标与候选，下一轮继续。
    if (!last.complete) return;
    awaiting.historyScan = null;
    if (
      last.id &&
      last.id !== awaiting.baselineMessageId &&
      last.id !== state.ref.lastBridgedMessageId
    ) {
      await finishTurn(
        state,
        { status: last.terminalError ? 'error' : 'done', finalText: last.text },
        last.id,
        awaiting,
      );
      return;
    }
    awaiting.missingReplyPolls += 1;
    if (last.terminalError || awaiting.missingReplyPolls >= MISSING_REPLY_POLLS) {
      await finishTurn(
        state,
        {
          status: 'error',
          finalText: '',
          diagnostic: states.some((value) => value === 'unknown')
            ? `无法确认派给 ${deps.deviceName(state.ref.deviceId)} 的消息是否执行，请检查运行设备上的任务。消息没有重新发送。`
            : last.terminalError
              ? `Worker 在 ${deps.deviceName(state.ref.deviceId)} 上异常结束，没有产生回复。`
              : `Worker 在 ${deps.deviceName(state.ref.deviceId)} 上本轮结束，但没有产生回复。`,
        },
        null,
        awaiting,
      );
    }
  }

  async function pollDevice(deviceId: string, states: WorkerState[]): Promise<void> {
    let active: Map<string, boolean>;
    try {
      const result = (await deps.invoke(deviceId, 'maker:list-active', [
        { summary: true, snapshotVersion: 2 },
      ])) as { sessions?: Array<{ sessionId?: unknown; isTurnRunning?: unknown }> };
      active = new Map(
        (Array.isArray(result?.sessions) ? result.sessions : [])
          .filter((entry) => typeof entry.sessionId === 'string')
          .map((entry) => [entry.sessionId as string, entry.isTurnRunning === true]),
      );
      if (!states.some(current)) return;
      setReachable(deviceId, true);
    } catch (err) {
      if (!states.some(current)) return;
      if (deviceUnreachable(err)) setReachable(deviceId, false);
      deps.log.warn('orca remote worker: poll failed', { deviceId, err: errorMessage(err) });
      return;
    }
    for (const state of states) {
      if (!current(state)) continue;
      if (state.workingDir === null) await readWorkingDir(state);
      if (!current(state)) continue;
      const running = active.get(state.ref.remoteSessionId) === true;
      const changed = running !== state.inTurn;
      state.inTurn = running;
      try {
        await checkAwaiting(state, running);
      } catch (err) {
        if (!current(state)) continue;
        if (deviceUnreachable(err)) setReachable(deviceId, false);
        deps.log.warn('orca remote worker: report check failed', {
          workerId: state.ref.workerId,
          err: errorMessage(err),
        });
      }
      if (changed && current(state)) deps.onWorkerStateChanged(state.ref.leadSessionId);
    }
  }

  async function readWorkingDir(state: WorkerState): Promise<void> {
    try {
      const row = (await deps.invoke(state.ref.deviceId, 'local-db:sessions:get', [
        state.ref.remoteSessionId,
      ])) as RemoteSessionRow | null;
      if (current(state) && typeof row?.workingDir === 'string' && row.workingDir) {
        state.workingDir = row.workingDir;
        deps.onWorkerStateChanged(state.ref.leadSessionId);
      }
    } catch {
      // 只影响展示，下一轮再试。
    }
  }

  async function pollOnce(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      const byDevice = new Map<string, WorkerState[]>();
      for (const state of workers.values()) {
        byDevice.set(state.ref.deviceId, [...(byDevice.get(state.ref.deviceId) ?? []), state]);
      }
      await Promise.all([...byDevice].map(([deviceId, states]) => pollDevice(deviceId, states)));
    } finally {
      polling = false;
    }
  }

  return {
    track(ref: RemoteWorkerRef, opts: { workingDir?: string } = {}): void {
      const existing = workers.get(ref.proxySessionId);
      const workingDir = opts.workingDir || existing?.workingDir || null;
      if (existing) {
        existing.ref = ref;
        existing.workingDir = workingDir;
      } else {
        workers.set(ref.proxySessionId, {
          ref,
          inTurn: false,
          workingDir,
          persistence: Promise.resolve(),
          awaiting: ref.pendingReport
            ? {
                ...ref.pendingReport,
                startedNotified: false,
                missingReplyPolls: 0,
                terminalHandler: deps.captureTurnEnded(ref.proxySessionId),
                previous: null,
                historyScan: null,
              }
            : null,
        });
      }
      if (timer === null) schedule();
    },

    untrack(proxySessionId: string): void {
      workers.delete(proxySessionId);
      if (workers.size === 0) schedule();
    },

    isRemote(proxySessionId: string): boolean {
      return workers.has(proxySessionId);
    },

    get(proxySessionId: string): RemoteWorkerRef | null {
      return workers.get(proxySessionId)?.ref ?? null;
    },

    isTurnRunning(proxySessionId: string): boolean {
      return workers.get(proxySessionId)?.inTurn ?? false;
    },

    hasPendingReport(proxySessionId: string): boolean {
      return workers.get(proxySessionId)?.awaiting != null;
    },

    workingDir(proxySessionId: string): string | null {
      return workers.get(proxySessionId)?.workingDir ?? null;
    },

    isReachable(proxySessionId: string): boolean {
      const state = workers.get(proxySessionId);
      return state ? !unreachableDevices.has(state.ref.deviceId) : true;
    },

    async dispatch(params: {
      proxySessionId: string;
      rawContent: string;
      clientId: string;
      /** Lead 的 accepted 权限／状态复核必须先于运行设备持久入队。 */
      beforeEnqueue?: () => void | Promise<void>;
    }): Promise<RemoteWorkerDispatchResult> {
      const state = workers.get(params.proxySessionId);
      if (!state)
        return { ok: false, code: 'SESSION_NOT_FOUND', message: 'remote worker is not tracked' };
      const { ref } = state;
      const deviceName = deps.deviceName(ref.deviceId);
      let prepared: AwaitingReport | null = null;
      let acceptedCheckFailed = false;
      try {
        const row = (await deps.invoke(ref.deviceId, 'local-db:sessions:get', [
          ref.remoteSessionId,
        ])) as (RemoteSessionRow & { status?: unknown }) | null;
        if (typeof row?.workingDir === 'string' && row.workingDir)
          state.workingDir = row.workingDir;
        if (!row || (row.status !== undefined && row.status !== 'active')) {
          return {
            ok: false,
            code: 'SESSION_NOT_FOUND',
            message: `Worker 在 ${deviceName} 上的任务已不存在或已归档，消息没有发出。`,
          };
        }
        const baseline = state.awaiting?.baselineMessageId ?? (await lastAssistantMessage(ref)).id;
        if (!current(state)) throw new Error('remote worker owner changed');
        const item = buildRemoteWorkerQueuedMessage({
          clientId: params.clientId,
          rawContent: params.rawContent,
          createOpts: createOptsFromRow(row),
          createdAt: new Date(deps.now()).toISOString(),
        });
        prepared = {
          clientIds: [...(state.awaiting?.clientIds ?? []), params.clientId].slice(-64),
          baselineMessageId: baseline,
          startedNotified: state.awaiting?.startedNotified ?? false,
          missingReplyPolls: 0,
          terminalHandler: null,
          previous: state.awaiting,
          historyScan: null,
        };
        state.awaiting = prepared;
        // 先落盘再发送；重启后用同一 clientId 核对回执和历史。
        await persist(state);
        if (!current(state)) throw new Error('remote worker owner changed');
        try {
          await params.beforeEnqueue?.();
        } catch (err) {
          acceptedCheckFailed = true;
          throw err;
        }
        if (!current(state) || state.awaiting !== prepared)
          throw new Error('remote worker owner or dispatch changed');
        const accept = (): RemoteWorkerDispatchResult => {
          setReachable(ref.deviceId, true);
          const mode = state.inTurn ? 'queued' : 'dispatched';
          schedule();
          return { ok: true, mode };
        };
        try {
          await deps.invoke(ref.deviceId, 'maker:input:enqueue', [ref.remoteSessionId, item]);
        } catch (err) {
          // 请求可能已送达、只是回执丢了：按 clientId 查一次投递回执，已在队列或对话里就算送达，
          // 不重发(enqueue 按 clientId 幂等，但这里不做盲重试)。查不到再按失败处理。
          if (
            errorCode(err) === 'INVOKE_TIMEOUT' ||
            (err as { inFlight?: unknown })?.inFlight === true
          ) {
            const [delivered] = await deliveryStates(ref, [params.clientId]).catch(() => [
              'unknown',
            ]);
            if (delivered === 'pending' || delivered === 'accepted') return accept();
            // 已发出但无法确认的请求保留身份，后续轮询核对，不让调用方重派同一工作。
            if (delivered === 'unknown') return accept();
          }
          throw err;
        }
        return accept();
      } catch (err) {
        if (prepared && current(state) && state.awaiting === prepared) {
          state.awaiting = prepared.previous;
          await persist(state).catch((persistError) =>
            deps.log.warn('orca remote worker: rollback persistence failed', {
              workerId: ref.workerId,
              err: errorMessage(persistError),
            }),
          );
        }
        // 权限／状态拒绝沿用 TeamService 的取消异常，不能转换为已送达或吞掉原始原因。
        if (acceptedCheckFailed) throw err;
        if (!current(state))
          return { ok: false, code: 'SEND_FAILED', message: 'remote worker owner changed' };
        if (deviceUnreachable(err)) {
          setReachable(ref.deviceId, false);
          return {
            ok: false,
            code: 'DEVICE_UNREACHABLE',
            message: `${deviceName} 当前不可达（离线或已关闭远程控制），消息没有发出。`,
          };
        }
        if (errorCode(err) === 'NOT_FOUND') {
          return {
            ok: false,
            code: 'SESSION_NOT_FOUND',
            message: `Worker 在 ${deviceName} 上的任务已不存在，消息没有发出。`,
          };
        }
        return { ok: false, code: 'SEND_FAILED', message: errorMessage(err) };
      }
    },

    /** Host onAccepted/onAcceptedCommit 完成后才能冻结身份并允许回报。 */
    confirmDispatchAccepted(proxySessionId: string, clientId: string): void {
      const awaiting = workers.get(proxySessionId)?.awaiting;
      if (!awaiting || awaiting.clientIds.at(-1) !== clientId) return;
      awaiting.terminalHandler = deps.captureTurnEnded(proxySessionId);
      awaiting.previous = null;
    },

    /** accepted 回调的原有异常继续上抛；这里只恢复 runtime 对应的旧回报代次。 */
    async rejectDispatchAcceptance(proxySessionId: string, clientId: string): Promise<void> {
      const state = workers.get(proxySessionId);
      if (!state?.awaiting || state.awaiting.clientIds.at(-1) !== clientId) return;
      state.awaiting = state.awaiting.previous;
      await persist(state);
      schedule();
    },

    /** 诊断用：运行设备上这条任务的最后一条回复(读不到返回空串)。 */
    async latestReply(proxySessionId: string): Promise<string> {
      const state = workers.get(proxySessionId);
      if (!state) return '';
      try {
        return (await lastAssistantMessage(state.ref)).text;
      } catch (err) {
        if (current(state) && deviceUnreachable(err)) setReachable(state.ref.deviceId, false);
        return '';
      }
    },

    /** 停止运行设备上的当前一轮；任务与记录保留。 */
    async abort(proxySessionId: string): Promise<boolean> {
      const state = workers.get(proxySessionId);
      if (!state) return false;
      try {
        await deps.invoke(state.ref.deviceId, 'maker:abort-session', [state.ref.remoteSessionId]);
        return true;
      } catch (err) {
        if (current(state) && deviceUnreachable(err)) setReachable(state.ref.deviceId, false);
        deps.log.warn('orca remote worker: abort failed', {
          proxySessionId,
          err: errorMessage(err),
        });
        return false;
      }
    },

    async abortRemote(
      ref: Pick<RemoteWorkerRef, 'deviceId' | 'remoteSessionId'>,
    ): Promise<boolean> {
      try {
        await deps.invoke(ref.deviceId, 'maker:abort-session', [ref.remoteSessionId]);
        return true;
      } catch (err) {
        if (errorCode(err) === 'NOT_FOUND') return true;
        deps.log.warn('orca remote worker: abort failed', {
          deviceId: ref.deviceId,
          err: errorMessage(err),
        });
        return false;
      }
    },

    /** 通知运行设备结束协同(任务与文件保留)。设备不可达时返回 false，由调用方留待重试。 */
    async release(ref: Pick<RemoteWorkerRef, 'deviceId' | 'remoteSessionId'>): Promise<boolean> {
      try {
        await deps.invoke(ref.deviceId, ORCA_REMOTE_WORKER_RELEASE_CHANNEL, [
          { sessionId: ref.remoteSessionId },
        ]);
        return true;
      } catch (err) {
        if (errorCode(err) === 'NOT_FOUND') return true;
        deps.log.warn('orca remote worker: release failed', {
          deviceId: ref.deviceId,
          err: errorMessage(err),
        });
        return false;
      }
    },

    /** 测试与关闭时用：立即跑一轮。 */
    pollNow: pollOnce,

    /** 账号切换后重建：清空登记与可达性，恢复调度(随后由调用方重新 track)。 */
    reset(): void {
      if (timer !== null) deps.clearTimeout(timer);
      timer = null;
      workers.clear();
      unreachableDevices.clear();
      stopped = false;
    },

    stop(): void {
      stopped = true;
      if (timer !== null) deps.clearTimeout(timer);
      timer = null;
    },
  };
}

export type OrcaRemoteWorkerRuntime = ReturnType<typeof createOrcaRemoteWorkerRuntime>;
