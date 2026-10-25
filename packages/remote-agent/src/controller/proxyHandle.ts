/**
 * 远程 Agent 的本机会话句柄(控制端)。
 *
 * 对本机的 Maker / Session 来说，它就是一个普通的 AgentSessionHandle：方法调用经协议客户端
 * 交给对方电脑上真正运行的 Agent；同步读取的状态(用量、是否在跑、计划模式等)读本地镜像，
 * 镜像由对方事件流里的状态行更新；权限确认、问题与计划审阅由本机的交互回调回答。
 * 本机用户在确认卡上允许的文件 / 命令操作同时登记到执行器的权限上限里。
 *
 * 连接池让出名额后(controller/connectionPool.ts)句柄照常是活的：缓存的状态照常读；要对方 Agent 干活的
 * 调用先连回同一个会话；只改设置的调用(换模型、权限档、计划模式、目录等)只记在本机，连回来时带上。
 */
import fsp from 'node:fs/promises';
import { isTerminalAgentErrorEvent } from '@cindy/maker-core';

import type { RemoteAgentMethod, RemoteAgentReply, RemoteAgentReverseRequest, RemoteAgentTeardownReason } from '@cindy/device-link';
import type {
  AgentEvent,
  AgentKind,
  AgentSessionHandle,
  AgentSessionTeardownOptions,
  BackgroundTaskSnapshot,
  Effort,
  InteractionDecision,
  InteractionRequest,
  InteractionResolver,
  SendOptions,
  UsageSnapshot,
  UserMessage,
} from '@cindy/maker-core';

import type { ExecutorAction } from '../executor/gate.js';
import type { ExecutorConfirmation } from '../executor/executor.js';
import type { ExecutorWorkspace } from '../executor/workspace.js';
import { isProviderShareCredentialSessionApproval } from '../shared/providerShareCredentialConsent.js';
import { encodeSendOptions, encodeUserMessage } from '../wire.js';
import { RemoteAgentRemoteError, type RemoteAgentRunClient } from './runClient.js';
import { localPlanReview, RemoteEventProjection } from './eventProjection.js';

const MAX_REMEMBERED_SEND_CALLBACKS = 64;

/** 对方运行的会话描述(open 成功时返回)。 */
export interface RemoteStartedInfo {
  id: string;
  agentKind: AgentKind;
  model: string;
  shadowDir: string;
  /** Agent 主机上的虚拟镜像根。 */
  mirrorRoot?: string;
  previousMirrorRoots?: string[];
  extraDirs?: string[];
  writableDirs?: string[];
  virtualWorkspace?: boolean;
  methods: string[];
  state: Record<string, unknown>;
  requestSessionId?: string;
  codexProxyActive?: boolean;
  codexHostKey?: string;
  codexCindyRemoteCompactionCompatible?: boolean;
  codexProductPromptDelivery?: { threadId: string; historyHasProductPrompt: boolean };
}

export function parseStartedInfo(value: Record<string, unknown>, kind: AgentKind): RemoteStartedInfo {
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const id = str(value.id);
  if (!id) throw new Error('[REMOTE_AGENT_INVALID] the other computer returned an invalid session');
  const delivery = value.codexProductPromptDelivery as Record<string, unknown> | undefined;
  return {
    id,
    agentKind: kind,
    model: str(value.model) ?? '',
    shadowDir: str(value.shadowDir) ?? '',
    virtualWorkspace: value.virtualWorkspace === true,
    ...(str(value.mirrorRoot) ? { mirrorRoot: str(value.mirrorRoot) } : {}),
    previousMirrorRoots: Array.isArray(value.previousMirrorRoots) ? value.previousMirrorRoots.filter((item): item is string => typeof item === 'string') : [],
    extraDirs: Array.isArray(value.extraDirs) ? value.extraDirs.filter((item): item is string => typeof item === 'string') : [],
    writableDirs: Array.isArray(value.writableDirs) ? value.writableDirs.filter((item): item is string => typeof item === 'string') : [],
    methods: Array.isArray(value.methods) ? value.methods.filter((m): m is string => typeof m === 'string') : [],
    state: value.state && typeof value.state === 'object' ? value.state as Record<string, unknown> : {},
    ...(str(value.requestSessionId) ? { requestSessionId: str(value.requestSessionId) } : {}),
    ...(typeof value.codexProxyActive === 'boolean' ? { codexProxyActive: value.codexProxyActive } : {}),
    ...(str(value.codexHostKey) ? { codexHostKey: str(value.codexHostKey) } : {}),
    ...(typeof value.codexCindyRemoteCompactionCompatible === 'boolean'
      ? { codexCindyRemoteCompactionCompatible: value.codexCindyRemoteCompactionCompatible }
      : {}),
    ...(delivery && typeof delivery.threadId === 'string' && typeof delivery.historyHasProductPrompt === 'boolean'
      ? { codexProductPromptDelivery: { threadId: delivery.threadId, historyHasProductPrompt: delivery.historyHasProductPrompt } }
      : {}),
  };
}

/** 单消费者事件队列。 */
class EventQueue implements AsyncIterable<AgentEvent> {
  private readonly items: AgentEvent[] = [];
  private waiter: (() => void) | null = null;
  private ended = false;

  push(event: AgentEvent): void {
    if (this.ended) return;
    this.items.push(event);
    this.waiter?.();
    this.waiter = null;
  }

  end(): void {
    this.ended = true;
    this.waiter?.();
    this.waiter = null;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    for (;;) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

/** 工具名(含 Claude Code 的 Cindy 工具前缀)到执行器操作的对应；用于登记本机用户的批准。 */
const EXEC_TOOLS = new Set(['bash', 'powershell', 'exec', 'exec_command', 'shell', 'commandexecution']);
const WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit', 'apply_patch', 'filechange', 'file_change']);
const READ_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'glob']);

/**
 * Codex 的命令确认给的是 `/bin/zsh -lc 'cmd'` 这样的完整命令行，而 exec-server 收到的是
 * argv；两边都还原成 shell 里实际执行的那段脚本再比对。
 */
export function innerShellScript(command: string): string {
  const match = /^(?:\S*\/)?(?:ba|z|da|k)?sh -l?c '((?:[^']|'\\'')*)'$/.exec(command.trim());
  return match ? match[1].replace(/'\\''/g, "'") : command;
}

export function approvalActionsFor(
  request: InteractionRequest,
  workspace: ExecutorWorkspace,
): ExecutorAction[] {
  if (request.kind !== 'permission') return [];
  const name = request.toolName.replace(/^mcp__cindy_exec__/, '').toLowerCase();
  const input = request.input ?? {};
  const actions: ExecutorAction[] = [];
  if (EXEC_TOOLS.has(name)) {
    const raw = input.command;
    const command = typeof raw === 'string'
      ? raw
      : Array.isArray(raw) && raw.every((part) => typeof part === 'string') ? (raw as string[]).join(' ') : undefined;
    const cwd = typeof input.cwd === 'string' ? workspace.resolve(input.cwd) : workspace.workingDir;
    if (command) actions.push({ kind: 'exec', command: workspace.mapCommand(innerShellScript(command)), cwd });
  }
  // Codex 的改文件确认：逐个目标路径登记。
  if (Array.isArray(input.changes)) {
    for (const change of input.changes as Array<{ path?: unknown }>) {
      if (typeof change?.path !== 'string' || !change.path) continue;
      try {
        actions.push({ kind: 'write', path: workspace.resolve(change.path) });
      } catch {
        // 路径不合法时不登记。
      }
    }
  }
  const target = ['file_path', 'path', 'notebook_path']
    .map((key) => input[key])
    .find((value): value is string => typeof value === 'string' && value.length > 0);
  if (target && (WRITE_TOOLS.has(name) || READ_TOOLS.has(name))) {
    try {
      actions.push({ kind: WRITE_TOOLS.has(name) ? 'write' : 'read', path: workspace.resolve(target) });
    } catch {
      // 路径不合法时不登记。
    }
  }
  // 受邀者任务里本机提供的 WebFetch：登记批准过的地址。
  if (name === 'webfetch' && typeof input.url === 'string' && input.url.trim()) {
    actions.push({ kind: 'fetch', url: input.url.trim() });
  }
  return actions;
}

/**
 * 句柄与对方电脑之间的连接。连接池让出名额后 `live()` 为 null，`ensure()` 连回同一个会话。
 */
export interface RemoteAgentLink {
  /** 连着的连接；正在连回时等它连上；已让出名额(或正在让)时为 null。 */
  live(): Promise<RemoteAgentRunClient | null>;
  /** 要对方 Agent 干活：已让出名额就连回来。 */
  ensure(): Promise<RemoteAgentRunClient>;
  /** 一次要对方参与的调用开始(期间不让出名额)；返回结束回调。 */
  begin(): () => void;
  /** 结束对方的 Agent；已让出名额时什么也不做。 */
  close(mode: 'close' | 'detach', reason: RemoteAgentTeardownReason): Promise<void>;
}

/** 固定的一条连接(不进连接池)。 */
export function fixedRemoteAgentLink(client: RemoteAgentRunClient): RemoteAgentLink {
  return {
    live: async () => client,
    ensure: async () => client,
    begin: () => () => undefined,
    close: (mode, reason) => client.close(mode, reason),
  };
}

export interface RemoteHandleDeps {
  /** 缺省时用 `client` 作为固定连接。 */
  link?: RemoteAgentLink;
  client?: RemoteAgentRunClient;
  started: RemoteStartedInfo;
  workspace: ExecutorWorkspace;
  recordApproval(action: ExecutorAction): void;
  /** 用户停止或关闭时立即收起本机确认，不等远端 RPC 返回。 */
  cancelPendingConfirmations?(): void;
  onInvalidResumeSession?: (expectedSdkSessionId: string) => Promise<boolean>;
  /** 读本机图片(随消息带给对方)。 */
  readImage?: (path: string) => Promise<Buffer>;
  /** 改写来自对方的事件(如把 Cindy 工具名换回 Agent 自带工具名)。 */
  mapEvent?: (event: AgentEvent) => AgentEvent;
  newId(): string;
  /** 权限档 / 附加目录等变化时同步给执行器。 */
  onPermissionMode?: (mode: string) => void;
  onPlanMode?: (enabled: boolean) => void;
  onExtraDirs?: (dirs: string[], libraryRoot?: string | null) => void;
  /** 可写目录变化时同步给执行器(在对方确认成功后调用，保持两边一致)。 */
  onWritableDirs?: (dirs: string[]) => void;
  /** 本机 MCP 身份引用的 vendorOptions 同步更新。 */
  onVendorOptions?: (patch: Record<string, unknown>) => void;
  /** 模型 / 推理强度 / 快速模式 / 思考开关变化(连回对方时按最新值打开)。 */
  onModel?: (model: string, opts?: { providerId?: string | null; effort?: Effort }) => void;
  onEffort?: (effort: Effort) => void;
  onFastMode?: (enabled: boolean | 'ultrafast') => void;
  onThinkingEnabled?: (enabled: boolean) => void;
  /** 改用 Cindy 自动审查兜底(对方进程里的状态，连回来时要再告诉一次)。 */
  onAutoReviewFallback?: () => void;
  /** 句柄关闭后释放本机资源(执行器、MCP 身份等)。 */
  dispose(): Promise<void>;
  /** 供应商组(分享的人)：这次发送要不要告诉对方开始新的一轮(用户亲自接手过)。 */
  takeGroupNewRound?(): boolean;
}

/** 本机自己发起的确认的内容(确认卡上显示的工具、参数与说明)。 */
export type LocalConfirmation = Omit<Extract<InteractionRequest, { kind: 'permission' }>, 'kind' | 'requestId'>;

export interface RemoteAgentHandleController {
  handle: AgentSessionHandle;
  onEvent(event: unknown): void;
  onState(state: Record<string, unknown>): void;
  onRequest(request: RemoteAgentReverseRequest): Promise<RemoteAgentReply> | null;
  onClosed(reason: string, message?: string): void;
  /**
   * 本机自己发起的确认(不是 Agent 发来的)：走与 Agent 确认同一个确认卡通道，桌面、手机远控与 IM 都能
   * 处理。只有本机提供了凭证授权建议的确认卡能返回会话级允许；交互还没接上或任务已结束时按拒绝处理。
   */
  confirm(request: LocalConfirmation, signal?: AbortSignal): Promise<ExecutorConfirmation>;
  /** 当前的状态镜像(只读)。 */
  readState(): Readonly<Record<string, unknown>>;
  /**
   * 没有放不下的事：没有在跑的回合、没在准备回合、对方进程里没有后台任务、没有待唤醒的续跑。
   * (本机执行器里的后台命令留在本机，不算。)
   */
  isQuiet(): boolean;
  /** 连回了对方(新的 Agent 进程，同一个会话)：合入它的状态，用量先保留上一次的读数。 */
  onReconnected(started: RemoteStartedInfo): void;
  /** 连回时没能接上原来的会话、对方开了新会话：告诉用户之前的上下文没接上。 */
  notifyResumeLost(): void;
}

export function createRemoteAgentHandle(deps: RemoteHandleDeps): RemoteAgentHandleController {
  const { started } = deps;
  const link = deps.link ?? fixedRemoteAgentLink(deps.client!);
  const queue = new EventQueue();
  const projection = new RemoteEventProjection(deps.workspace);
  let state: Record<string, unknown> = { ...started.state };
  let resolver: InteractionResolver | null = null;
  let disposed = false;
  const sendCallbacks = new Map<string, {
    onTranscriptUserEntry?: (entryId: string) => void | Promise<void>;
    onInteractionStateChange?: (state: 'waiting' | 'resolved' | 'cancelled') => void;
  }>();
  const readImage = deps.readImage ?? ((file: string) => fsp.readFile(file));
  const supported = new Set(started.methods);
  /** 连回后的新进程还没报过有内容的用量：先保留上一次的读数，界面不清零。 */
  let carriedUsage: unknown;
  /** 回到某条消息后、下一轮跑完前(Claude Code 要到下一次发送才在对方截断)：不能让出名额。 */
  let rewindPending = false;
  // The provider terminal owns this turn's failure, including its quota reset.
  // A later transport teardown must close the handle without replacing that error.
  let terminalErrorDelivered = false;

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    for (const projected of projection.flush()) queue.push(projected);
    queue.end();
    await deps.dispose().catch(() => undefined);
  };

  /** 要对方 Agent 参与的调用：已让出名额就先连回来。 */
  const call = async (method: RemoteAgentMethod, ...args: unknown[]) => {
    const end = link.begin();
    try {
      return await (await link.ensure()).call(method, args);
    } finally {
      end();
    }
  };
  /**
   * 只改设置的调用：连着就交给对方；已让出名额时只记在本机(连回来时随打开带上)，返回 false。
   */
  const callIfLive = async (method: RemoteAgentMethod, ...args: unknown[]): Promise<boolean> => {
    const end = link.begin();
    try {
      const live = await link.live();
      if (!live) return false;
      await live.call(method, args);
      return true;
    } finally {
      end();
    }
  };

  async function sendLike(method: 'send' | 'steer', message: UserMessage, opts?: SendOptions): Promise<void> {
    const encoded = await encodeSendOptions(opts, readImage);
    const wireMessage = await encodeUserMessage(message, readImage);
    const projectMessage = (wire: typeof wireMessage) => {
      if (typeof wire.content === 'string') wire.content = deps.workspace.mapTextForAgent(wire.content);
      else wire.content = wire.content.map((block) => {
        if (block.type === 'text') return { ...block, text: deps.workspace.mapTextForAgent(block.text) };
        if (block.type === 'file' || block.type === 'mention') return { ...block, path: deps.workspace.toAgentPath(block.path) };
        return block;
      });
    };
    const callId = deps.newId();
    if (encoded.onTranscriptUserEntry || encoded.onInteractionStateChange) {
      sendCallbacks.set(callId, {
        onTranscriptUserEntry: encoded.onTranscriptUserEntry,
        onInteractionStateChange: encoded.onInteractionStateChange,
      });
      while (sendCallbacks.size > MAX_REMEMBERED_SEND_CALLBACKS) {
        sendCallbacks.delete(sendCallbacks.keys().next().value as string);
      }
    }
    const client = await link.ensure();
    // 连回成功后才取供应商组的「新一轮」标记：连不回时消息没发出，标记要留给重试。
    if (method === 'send' && deps.takeGroupNewRound?.()) encoded.wire.groupNewRound = true;
    // 连回之后才转换路径：让出期间改过的目录要等连回补发后才有虚拟路径。
    projectMessage(wireMessage);
    if (encoded.wire.cindy?.autoReviewSourceContent) projectMessage(encoded.wire.cindy.autoReviewSourceContent);
    if (method === 'send') terminalErrorDelivered = false;
    await client.callWithId(callId, method, [wireMessage, encoded.wire]);
  }

  async function sendLikeTracked(method: 'send' | 'steer', message: UserMessage, opts?: SendOptions): Promise<void> {
    const end = link.begin();
    try {
      await sendLike(method, message, opts);
    } finally {
      end();
    }
  }

  const optional = <K extends keyof AgentSessionHandle>(method: RemoteAgentMethod, fn: AgentSessionHandle[K]) =>
    (supported.has(method) ? { [method]: fn } : {}) as Partial<AgentSessionHandle>;

  const handle: AgentSessionHandle = {
    get id() {
      return typeof state.id === 'string' ? state.id : started.id;
    },
    get requestSessionId() {
      return typeof state.requestSessionId === 'string' ? state.requestSessionId : started.requestSessionId;
    },
    agentKind: started.agentKind,
    get model() {
      return typeof state.model === 'string' ? state.model : started.model;
    },
    ...(started.codexProxyActive !== undefined ? { codexProxyActive: started.codexProxyActive } : {}),
    ...(started.codexHostKey ? { codexHostKey: started.codexHostKey } : {}),
    get codexThreadModelProviderId() {
      return typeof state.codexThreadModelProviderId === 'string' ? state.codexThreadModelProviderId : undefined;
    },
    get codexThreadMayHaveRollout() {
      return typeof state.codexThreadMayHaveRollout === 'boolean' ? state.codexThreadMayHaveRollout : undefined;
    },
    ...(started.codexCindyRemoteCompactionCompatible !== undefined
      ? { codexCindyRemoteCompactionCompatible: started.codexCindyRemoteCompactionCompatible }
      : {}),
    ...(started.codexProductPromptDelivery ? { codexProductPromptDelivery: started.codexProductPromptDelivery } : {}),
    get disabledSkillPaths() {
      return Array.isArray(state.disabledSkillPaths) ? state.disabledSkillPaths as string[] : undefined;
    },

    send: (message, opts) => sendLikeTracked('send', message, opts),
    steer: (message, opts) => sendLikeTracked('steer', message, opts),
    // 已让出名额时对方没有在跑的回合，停止什么也不用做。
    abort: async () => {
      deps.cancelPendingConfirmations?.();
      await callIfLive('abort');
    },
    close: async (opts?: AgentSessionTeardownOptions) => {
      deps.cancelPendingConfirmations?.();
      try {
        await link.close('close', opts?.reason ?? 'navigation');
      } finally {
        await dispose();
      }
    },
    detach: async (opts?: AgentSessionTeardownOptions) => {
      deps.cancelPendingConfirmations?.();
      try {
        await link.close('detach', opts?.reason ?? 'navigation');
      } finally {
        await dispose();
      }
    },
    events: () => queue,
    getUsageSnapshot: () => (state.usage && typeof state.usage === 'object'
      ? state.usage as UsageSnapshot
      : { tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
    setInteractionResolver: (next) => {
      resolver = next;
    },
    isTurnRunning: () => state.turnRunning === true,
    isPreparingUserTurn: () => state.preparing === true,
    getCurrentTurnId: () => (typeof state.currentTurnId === 'string' ? state.currentTurnId : null),
    getPlanMode: () => (typeof state.planMode === 'boolean' ? state.planMode : null),
    getExecutionPlanMode: () => (typeof state.executionPlanMode === 'boolean' ? state.executionPlanMode : null),
    getFastMode: () => state.fastMode === 'ultrafast' ? 'ultrafast' : state.fastMode === true,
    getEffort: () => (typeof state.effort === 'string' ? state.effort as Effort : null),
    listBackgroundTasks: () => (Array.isArray(state.backgroundTasks) ? state.backgroundTasks as BackgroundTaskSnapshot[] : []),
    countPendingWakeContinuations: () => (typeof state.pendingWake === 'number' ? state.pendingWake : 0),
    ...optional('requestGracefulStop', async () => {
      await callIfLive('requestGracefulStop');
    }),
    ...optional('setModel', async (model: string, opts?: { providerId?: string | null; effort?: Effort }) => {
      if (!await callIfLive('setModel', model, opts)) {
        state = { ...state, model, ...(opts?.effort ? { effort: opts.effort } : {}) };
      }
      deps.onModel?.(model, opts);
    }),
    // 已让出名额时下一次连回本来就是带新模型的冷启动接回，不用另外重建。
    ...optional('requiresModelSwitchRebuild', async (model: string, opts?: { providerId?: string | null }) => {
      const end = link.begin();
      try {
        const live = await link.live();
        return live ? (await live.call('requiresModelSwitchRebuild', [model, opts])) === true : false;
      } finally {
        end();
      }
    }),
    ...optional('previewModelSwitch', (async (model: string, opts?: { providerId?: string | null }) =>
      call('previewModelSwitch', model, opts)) as AgentSessionHandle['previewModelSwitch']),
    ...optional('setPermissionMode', async (mode: string) => {
      await callIfLive('setPermissionMode', mode);
      deps.onPermissionMode?.(mode);
    }),
    ...optional('setEffort', async (effort: Effort) => {
      if (!await callIfLive('setEffort', effort)) state = { ...state, effort };
      deps.onEffort?.(effort);
    }),
    ...optional('setFastMode', async (enabled: boolean | 'ultrafast') => {
      if (!await callIfLive('setFastMode', enabled)) state = { ...state, fastMode: enabled };
      deps.onFastMode?.(enabled);
    }),
    ...optional('setPlanMode', async (enabled: boolean) => {
      if (!await callIfLive('setPlanMode', enabled)) state = { ...state, planMode: enabled };
      deps.onPlanMode?.(enabled);
    }),
    ...optional('setThinkingEnabled', async (enabled: boolean) => {
      await callIfLive('setThinkingEnabled', enabled);
      deps.onThinkingEnabled?.(enabled);
    }),
    ...optional('setExtraDirs', async (dirs: string[], libraryRoot?: string | null) => {
      deps.onExtraDirs?.(dirs, libraryRoot);
      await callIfLive('setExtraDirs', deps.workspace.virtualizeDirs(dirs), libraryRoot ? deps.workspace.virtualizeDirs([libraryRoot])[0] : null);
    }),
    ...optional('setWritableDirs', async (dirs: string[]) => {
      await callIfLive('setWritableDirs', deps.workspace.virtualizeDirs(dirs));
      // 对方成功后才更新本机执行器的根目录：新建的可写目录在本机也能过 root 判定，
      // 撤掉的不再被本机上限当可信根；失败时两边都保持原状。
      deps.onWritableDirs?.(dirs);
    }),
    // 本机 MCP 身份(协同等工具)必须立即看到改动；对方不支持时也照样更新本机这一份。
    setVendorOptions: async (patch: Record<string, unknown>) => {
      deps.onVendorOptions?.(patch ?? {});
      if (supported.has('setVendorOptions')) await callIfLive('setVendorOptions', JSON.parse(JSON.stringify(patch ?? {})));
    },
    // 已让出名额时对方进程里没有后台任务(有后台任务时不会让)。
    ...optional('stopBackgroundTask', async (taskId: string) => {
      await callIfLive('stopBackgroundTask', taskId);
    }),
    ...optional('resumeBackgroundTask', async (taskId: string, message: string, childId?: string) => {
      await call('resumeBackgroundTask', taskId, message, childId);
    }),
    ...optional('compactSession', (async (instructions?: string) =>
      call('compactSession', instructions)) as AgentSessionHandle['compactSession']),
    ...optional('getContextUsage', (async () => call('getContextUsage')) as AgentSessionHandle['getContextUsage']),
    ...optional('getCodexContextWindowInfo', (async () =>
      call('getCodexContextWindowInfo')) as AgentSessionHandle['getCodexContextWindowInfo']),
    ...optional('useCindyAutoReviewFallback', async () => {
      await callIfLive('useCindyAutoReviewFallback');
      deps.onAutoReviewFallback?.();
    }),
    ...optional('previewRewindFiles', (async (userUuid: string) =>
      call('previewRewindFiles', userUuid)) as AgentSessionHandle['previewRewindFiles']),
    ...optional('commitRewindFiles', (async (userUuid: string, priorAssistantUuid: string, opts?: unknown) => {
      const result = await call('commitRewindFiles', userUuid, priorAssistantUuid, opts ?? null);
      rewindPending = true;
      return result;
    }) as AgentSessionHandle['commitRewindFiles']),
  };

  async function answerInteraction(request: InteractionRequest): Promise<RemoteAgentReply> {
    if (!resolver) {
      // 本机还没接上交互回调：按系统性拒绝处理，不替用户允许。
      const decision: InteractionDecision = request.kind === 'ask_user_question'
        ? { kind: 'ask_user_question', answers: {}, dismissed: true }
        : request.kind === 'plan_review'
          ? { kind: 'plan_review', behavior: 'deny', reason: 'interaction_unavailable', dismissed: true }
          : { kind: 'permission', behavior: 'deny', reason: 'interaction_unavailable' };
      return { type: 'interaction', result: decision };
    }
    let decision = await resolver(localPlanReview(request, deps.workspace));
    if (decision.kind === 'permission' && decision.behavior === 'allow') {
      const effective = decision.updatedInput ? { ...request, input: decision.updatedInput } : request;
      for (const action of approvalActionsFor(effective, deps.workspace)) deps.recordApproval(action);
    }
    // 用户改过的计划按本机路径展示，交回 Agent 前换回它那边的写法。
    if (decision.kind === 'plan_review') {
      decision = { ...decision,
        ...(typeof decision.editedPlan === 'string' ? { editedPlan: deps.workspace.mapTextForAgent(decision.editedPlan) } : {}),
        ...(!decision.dismissed && typeof decision.reason === 'string' ? { reason: deps.workspace.mapTextForAgent(decision.reason) } : {}),
      };
    }
    return { type: 'interaction', result: JSON.parse(JSON.stringify(decision)) };
  }

  return {
    handle,
    onEvent(event) {
      if (!event || typeof event !== 'object' || typeof (event as AgentEvent).type !== 'string') return;
      let typed = event as AgentEvent;
      if (isTerminalAgentErrorEvent(typed) && typed.turnScope !== 'background') terminalErrorDelivered = true;
      if (typed.type === 'image' && typed.source === 'codex'
        && (typed.data as { kind?: unknown } | null)?.kind === 'generation') {
        typed = { ...typed, data: { ...(typed.data as object), pathOrigin: 'remote-agent' } };
      }
      if (typed.type === 'done') rewindPending = false;
      for (const projected of projection.project(deps.mapEvent ? deps.mapEvent(typed) : typed)) queue.push(projected);
    },
    onState(next) {
      state = { ...state, ...next };
      if (carriedUsage !== undefined) {
        // 新进程开始干活或报了有内容的用量后，以它为准。
        if (state.turnRunning === true || !isEmptyUsage(state.usage)) carriedUsage = undefined;
        else state = { ...state, usage: carriedUsage };
      }
    },
    readState: () => state,
    isQuiet: () => !rewindPending
      && state.turnRunning !== true
      && state.preparing !== true
      && !(Array.isArray(state.backgroundTasks) && state.backgroundTasks.length > 0)
      && !(typeof state.pendingWake === 'number' && state.pendingWake > 0),
    onReconnected(next) {
      const previousUsage = state.usage;
      state = { ...state, ...next.state };
      if (!isEmptyUsage(previousUsage) && isEmptyUsage(state.usage) && state.turnRunning !== true) {
        carriedUsage = previousUsage;
        state = { ...state, usage: previousUsage };
      }
    },
    notifyResumeLost() {
      if (disposed) return;
      queue.push({
        type: 'error',
        data: {
          message: '[REMOTE_AGENT_RESUME_LOST] The earlier conversation on the other computer could not be resumed, so the agent continues without it.',
          isTerminal: false,
        },
        source: started.agentKind,
      });
    },
    onRequest(request) {
      if (request.type === 'interaction') {
        return answerInteraction(request.request as InteractionRequest);
      }
      if (request.type === 'callback') {
        return (async (): Promise<RemoteAgentReply> => {
          const [first, second] = request.args;
          if (request.name === 'onInvalidResumeSession') {
            const value = typeof first === 'string' && deps.onInvalidResumeSession
              ? await deps.onInvalidResumeSession(first)
              : false;
            return { type: 'callback', value };
          }
          const callbacks = typeof first === 'string' ? sendCallbacks.get(first) : undefined;
          if (request.name === 'onTranscriptUserEntry' && typeof second === 'string') {
            await callbacks?.onTranscriptUserEntry?.(second);
          } else if (request.name === 'onInteractionStateChange'
            && (second === 'waiting' || second === 'resolved' || second === 'cancelled')) {
            callbacks?.onInteractionStateChange?.(second);
          }
          return { type: 'callback' };
        })();
      }
      return null;
    },
    async confirm(request, signal) {
      if (!resolver || disposed || signal?.aborted) return false;
      const decision = await resolver({ ...request, kind: 'permission', requestId: deps.newId() }, signal);
      if (disposed || signal?.aborted || decision.kind !== 'permission' || decision.behavior !== 'allow') return false;
      // 只能从本机生成的凭证确认卡建立授权；对方的 interaction 回包不经过这里。
      if (request.metadata?.hostOwnedConfirmation === 'shared_provider_credential'
        && isProviderShareCredentialSessionApproval(request.suggestions)
        && isProviderShareCredentialSessionApproval(decision.permissionUpdates)) return 'session';
      return true;
    },
    onClosed(reason, message) {
      for (const projected of projection.flush()) queue.push(projected);
      // 'superseded'：同一任务被重新打开、旧实例让位给新实例，不是错误，静默收起。
      if (!terminalErrorDelivered && reason !== 'closed' && reason !== 'detached' && reason !== 'ended' && reason !== 'superseded') {
        queue.push({
          type: 'error',
          data: {
            message: message ?? `[REMOTE_AGENT_UNAVAILABLE] The agent on the other computer stopped (${reason}).`,
            isTerminal: true,
            // 拉不到那台(连续 2 分钟)只说明连接断了，那台本身可能没事：供应商组先等它恢复、恢复了留在原电脑继续；
            // 其余(对方出错收尾、撤权、流不可信等)是那台那边的问题(provider-group/failurePolicy)。
            reason: reason === 'unreachable' ? 'remote_agent_lost' : 'remote_agent_closed',
          },
          source: started.agentKind,
        });
      }
      void dispose();
    },
  };
}

/** 用量读数是不是空的(新进程还没跑过回合)。 */
function isEmptyUsage(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true;
  const usage = value as Partial<UsageSnapshot>;
  return !usage.tokenUsage && !usage.contextTokens;
}

/** 对方错误还原成本机能识别的错误(保留类名，供 Maker 判断登录失效等)。 */
export function localizeRemoteError(error: unknown): Error {
  if (error instanceof RemoteAgentRemoteError) {
    const local = new Error(error.message);
    local.name = error.name;
    return local;
  }
  return error instanceof Error ? error : new Error(String(error));
}
