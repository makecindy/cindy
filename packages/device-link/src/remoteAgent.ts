/**
 * 远程 Agent(同账号)：任务、项目文件与命令留在控制端(用户操作的电脑)，Agent 进程跑在
 * 被控端(提供 Agent 登录、订阅与供应商的电脑)。被控端用它自己的程序、登录与供应商配置
 * 启动 Agent；读写文件、执行命令与 Cindy 工具经本通道回到控制端执行。
 *
 * 通信方向始终由控制端发起，被控端从不反过来控制控制端：
 *  - `open / call / reply / push / close`：控制端 → 被控端的指令与回复；
 *  - `poll`：控制端按游标拉取被控端的事件字节流(每行一个 JSON，见 RemoteAgentStreamItem)。
 *    同一台被控端上的全部任务共用一个 poll(一次带上各任务的游标)，任务再多也只占一个在途请求。
 *    Agent 事件、方法调用结果、被控端需要控制端处理的反向请求(权限确认、MCP 与执行器 HTTP、
 *    Codex exec-server WebSocket 帧)都在这条流里，读多快才发多快，不主动推送到共享 relay；
 *  - 大内容(带图片的消息、文件内容回复)先分段 `upload` 暂存，再由 open / call / reply 引用。
 *
 * 幂等：poll 按游标幂等，peer reset 后可重读；open 按 runId、call 按 callId、reply 按 requestId、
 * push 按 seq 去重。除 read 外都不自动重试(结果不明时由上层按自身语义处理)。
 */
export const REMOTE_AGENT_CHANNEL = 'maker:remote-agent:v1';
export const REMOTE_AGENT_VERSION = 1;

export const REMOTE_AGENT_KINDS = ['claude-code', 'codex', 'pi'] as const;
export type RemoteAgentKind = (typeof REMOTE_AGENT_KINDS)[number];

/** 每段上传的原始字节(gzip 之后)。base64 后约 683KB，远低于单条逻辑消息 4MB 上限。 */
export const REMOTE_AGENT_UPLOAD_CHUNK_BYTES = 512 * 1024;
/** gzip 后单个暂存载荷上限。 */
export const REMOTE_AGENT_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
export const REMOTE_AGENT_MAX_UPLOAD_CHUNKS =
  REMOTE_AGENT_MAX_PAYLOAD_BYTES / REMOTE_AGENT_UPLOAD_CHUNK_BYTES;
/** 内联载荷(JSON 序列化后)上限；更大的走 upload。 */
export const REMOTE_AGENT_MAX_INLINE_PAYLOAD_CHARS = 1024 * 1024;
/** 单个任务一次 poll 最多返回的事件流字节。 */
export const REMOTE_AGENT_READ_MAX_BYTES = 512 * 1024;
/** 一次 poll 所有任务合计最多返回的字节(base64 后仍远低于单条逻辑消息 4MB)。 */
export const REMOTE_AGENT_POLL_MAX_BYTES = 1536 * 1024;
/** 没有新数据时被控端最多挂起 poll 的时长；远低于通道超时，留出回程余量。 */
export const REMOTE_AGENT_READ_WAIT_MS = 10_000;
/** 一次 poll 最多带的任务数。 */
export const REMOTE_AGENT_MAX_POLL_RUNS = 64;
export const REMOTE_AGENT_INVOKE_TIMEOUT_MS = 30_000;
/** 同一控制端在一台被控端上同时运行的远程 Agent 任务上限。 */
export const REMOTE_AGENT_MAX_RUNS_PER_CONTROLLER = 16;
/** 一次 push 最多携带的 WebSocket 帧数。 */
export const REMOTE_AGENT_MAX_PUSH_FRAMES = 64;

/**
 * 控制端可以调用的 Agent 会话方法(白名单)。与 maker-core AgentSessionHandle 同名；
 * 不在表里的方法被控端一律拒绝。
 */
export const REMOTE_AGENT_METHODS = [
  'send',
  'steer',
  'abort',
  'requestGracefulStop',
  'setModel',
  'requiresModelSwitchRebuild',
  'previewModelSwitch',
  'setPermissionMode',
  'setEffort',
  'setFastMode',
  'setPlanMode',
  'setThinkingEnabled',
  'setExtraDirs',
  'setWritableDirs',
  'setVendorOptions',
  'stopBackgroundTask',
  'resumeBackgroundTask',
  'compactSession',
  'getContextUsage',
  'getCodexContextWindowInfo',
  'useCindyAutoReviewFallback',
  // 回到某条消息：对话在 Agent 那边截断(文件在控制端按保存点回退)。
  'previewRewindFiles',
  'commitRewindFiles',
] as const;
export type RemoteAgentMethod = (typeof REMOTE_AGENT_METHODS)[number];

export const REMOTE_AGENT_ERROR_CODES = [
  'REMOTE_AGENT_INVALID',
  'REMOTE_AGENT_NOT_FOUND',
  'REMOTE_AGENT_UNSUPPORTED',
  'REMOTE_AGENT_BUSY',
  'REMOTE_AGENT_EXPIRED',
  'REMOTE_AGENT_ACCOUNT_CHANGED',
  'REMOTE_AGENT_UNAVAILABLE',
  // 那台电脑没有对这个供应商打开「允许被远程调用」(或已关闭)。
  'REMOTE_AGENT_PROVIDER_NOT_ALLOWED',
] as const;
export type RemoteAgentErrorCode = (typeof REMOTE_AGENT_ERROR_CODES)[number];

/** 内联 JSON 或引用已上传的 gzip(JSON) 分段。 */
export type RemoteAgentPayload =
  | { json: unknown }
  | { uploadId: string; chunks: number; bytes: number };

export interface RemoteAgentErrorInfo {
  code: string;
  message: string;
  /** 原错误类名(仅用于控制端还原 maker-core 的特定错误类型)。 */
  name?: string;
}

/** 被控端请控制端处理的反向请求。 */
export type RemoteAgentReverseRequest =
  | { type: 'interaction'; request: unknown }
  | {
      type: 'http';
      /** 被控端隧道上的路由(如 `/exec/read`、`/mcp/cindy_memory`)。 */
      method: string;
      path: string;
      headers: Array<[string, string]>;
      /** base64 请求体。 */
      body?: string;
    }
  | { type: 'callback'; name: RemoteAgentCallbackName; args: unknown[] };

export const REMOTE_AGENT_CALLBACKS = [
  'onTranscriptUserEntry',
  'onInvalidResumeSession',
  'onInteractionStateChange',
] as const;
export type RemoteAgentCallbackName = (typeof REMOTE_AGENT_CALLBACKS)[number];

/** 控制端对反向请求的回复。 */
export type RemoteAgentReply =
  | { type: 'interaction'; result: unknown }
  | { type: 'http'; status: number; headers: Array<[string, string]>; body?: string }
  | { type: 'callback'; value?: unknown }
  | { type: 'error'; error: RemoteAgentErrorInfo };

/**
 * 控制端发给被控端 WebSocket 连接的帧(Codex exec-server 隧道)。单帧过大的消息拆成多段，
 * 除最后一段外都带 `more: true`，被控端拼好后再作为一条 WebSocket 消息发出。
 */
export interface RemoteAgentPushFrame {
  connId: string;
  kind: 'message' | 'close';
  data?: string;
  more?: true;
}

/** 一次 push 里所有帧数据的总长度上限(远低于单条逻辑消息 4MB)。 */
export const REMOTE_AGENT_MAX_PUSH_CHARS = 3 * 1024 * 1024;

export type RemoteAgentRequest =
  | { op: 'caps' }
  | { op: 'upload'; uploadId: string; index: number; data: string }
  | { op: 'open'; runId: string; agentKind: RemoteAgentKind; payload: RemoteAgentPayload }
  | { op: 'call'; runId: string; callId: string; method: RemoteAgentMethod; payload: RemoteAgentPayload }
  /**
   * waitMs：没有新数据时最多挂起多久(缺省 READ_WAIT_MS)。控制端在已有一个长等待在途时，
   * 可以再发一个 waitMs=0 的短 poll 立刻取新任务或刚触发的数据；两个 poll 返回的数据可能重叠，
   * 控制端按 from 去重。
   */
  | { op: 'poll'; runs: Array<{ runId: string; cursor: number }>; waitMs?: number }
  | { op: 'reply'; runId: string; requestId: string; payload: RemoteAgentPayload }
  | { op: 'push'; runId: string; seq: number; frames: RemoteAgentPushFrame[] }
  | { op: 'close'; runId: string; mode: 'close' | 'detach'; reason: RemoteAgentTeardownReason }
  /**
   * 供应商组(组所在电脑 → 组内电脑)：组所在电脑删掉某个受邀者后，请组内电脑清掉替这个受邀者
   * 运行过的任务留下的会话记录与目录。relay 是组所在电脑为受邀者取的不透明键(打开任务时随载荷带过来)，
   * 只作用于调用方自己的 relay。旧版组内电脑回 REMOTE_AGENT_INVALID(它从没接过被中转的任务)。
   */
  | { op: 'forget'; relay: string };

/** 供应商组为受邀者取的不透明键(组所在电脑按受邀者派生，不含身份信息)；「需要换一台」凭证同一格式。 */
export const REMOTE_AGENT_RELAY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * 供应商组「需要换一台」：组所在电脑在中转任务的事件流里发出的状态键，值是一次性凭证。只发给打开任务时
 * 声明了 acceptsGroupSwitch 的控制端，排在那次错误前面；控制端取走凭证、不并入任务状态。
 */
export const REMOTE_AGENT_GROUP_SWITCH_STATE_KEY = 'providerGroupSwitch';

/** 与 maker-core AgentSessionTeardownReason 同值。 */
export const REMOTE_AGENT_TEARDOWN_REASONS = ['navigation', 'account-boundary', 'app-quit'] as const;
export type RemoteAgentTeardownReason = (typeof REMOTE_AGENT_TEARDOWN_REASONS)[number];

export interface RemoteAgentCaps {
  version: number;
  agents: Array<{ kind: RemoteAgentKind; available: boolean }>;
  maxRuns: number;
  uploadChunkBytes: number;
  maxPayloadBytes: number;
  /** 是否支持 opaque 虚拟工作区；不支持时控制端必须拒绝启动以免泄露真实路径。 */
  virtualWorkspace?: boolean;
  /**
   * 供应商组：能接受同账号组所在电脑中转过来的受邀者任务(打开时带 relay 键就按受邀者隔离运行)。
   * 不声明的电脑，组所在电脑不给它分受邀者的任务(否则受邀者会拿到主人级权限)。
   */
  guestRelay?: boolean;
}

export interface RemoteAgentReadResult {
  /** 本次数据的起始偏移(缺省等于请求的游标)。并发 poll 时可能晚于请求的游标。 */
  from?: number;
  /** 本次返回数据之后的游标(事件流字节偏移)。 */
  cursor: number;
  /** base64 的事件流字节(NDJSON，可能在行中间截断，控制端按行拼接)。 */
  data?: string;
  /** 流已结束且全部读完。 */
  done?: true;
}

/** poll 的结果：只列出有新数据、已结束或已不存在的任务。 */
export interface RemoteAgentPollResult {
  runs: Array<RemoteAgentReadResult & { runId: string; missing?: true }>;
}

/** 事件流里的一行。 */
export type RemoteAgentStreamItem =
  | { t: 'started'; handle: Record<string, unknown> }
  | { t: 'start-failed'; error: RemoteAgentErrorInfo }
  | { t: 'event'; event: unknown }
  | { t: 'state'; state: Record<string, unknown> }
  | { t: 'result'; callId: string; ok: true; value?: unknown }
  | { t: 'result'; callId: string; ok: false; error: RemoteAgentErrorInfo }
  | { t: 'request'; requestId: string; request: RemoteAgentReverseRequest }
  /** 被控端放弃了一个尚未回包的反向请求(如 Agent 取消了工具调用)，控制端应中止对应执行。 */
  | { t: 'cancel'; requestId: string }
  | { t: 'ws'; connId: string; kind: 'open' | 'message' | 'close'; path?: string; data?: string }
  | { t: 'closed'; reason: string; error?: RemoteAgentErrorInfo };

const ID = /^[0-9a-f-]{36}$/;
const CONN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const MAX_HEADERS = 64;
const MAX_HEADER_VALUE = 8192;
const MAX_PATH = 2048;
const MAX_MESSAGE = 2048;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function invalid(): never {
  throw new Error('REMOTE_AGENT_INVALID');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function id(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) invalid();
  return value;
}

function count(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) invalid();
  return value as number;
}

function base64Chars(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

function base64(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || value.length > base64Chars(maxBytes) || !BASE64.test(value)) invalid();
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) invalid();
  return value as T;
}

function payload(value: unknown): RemoteAgentPayload {
  const v = record(value);
  if ('json' in v) {
    // 内联载荷的大小由序列化后的长度约束；控制端发送前同样检查。
    let size: number;
    try {
      size = JSON.stringify(v.json)?.length ?? 0;
    } catch {
      invalid();
    }
    if (size > REMOTE_AGENT_MAX_INLINE_PAYLOAD_CHARS) invalid();
    return { json: v.json };
  }
  const chunks = count(v.chunks, REMOTE_AGENT_MAX_UPLOAD_CHUNKS);
  const bytes = count(v.bytes, REMOTE_AGENT_MAX_PAYLOAD_BYTES);
  if (chunks < 1 || bytes > chunks * REMOTE_AGENT_UPLOAD_CHUNK_BYTES) invalid();
  return { uploadId: id(v.uploadId), chunks, bytes };
}

function pushFrames(value: unknown): RemoteAgentPushFrame[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > REMOTE_AGENT_MAX_PUSH_FRAMES) invalid();
  let total = 0;
  return value.map((item) => {
    const frame = record(item);
    if (typeof frame.connId !== 'string' || !CONN_ID.test(frame.connId)) invalid();
    const kind = oneOf(frame.kind, ['message', 'close'] as const);
    if (kind === 'message' && typeof frame.data !== 'string') invalid();
    if (typeof frame.data === 'string' && frame.data.length > REMOTE_AGENT_MAX_INLINE_PAYLOAD_CHARS) invalid();
    total += typeof frame.data === 'string' ? frame.data.length : 0;
    if (total > REMOTE_AGENT_MAX_PUSH_CHARS) invalid();
    if (frame.more !== undefined && (frame.more !== true || kind !== 'message')) invalid();
    return {
      connId: frame.connId,
      kind,
      ...(typeof frame.data === 'string' ? { data: frame.data } : {}),
      ...(frame.more === true ? { more: true as const } : {}),
    };
  });
}

/** 被控端解析控制端请求；不合法一律抛 `REMOTE_AGENT_INVALID`。 */
export function parseRemoteAgentRequest(value: unknown): RemoteAgentRequest {
  const v = record(value);
  switch (v.op) {
    case 'caps':
      return { op: 'caps' };
    case 'upload':
      return {
        op: 'upload',
        uploadId: id(v.uploadId),
        index: count(v.index, REMOTE_AGENT_MAX_UPLOAD_CHUNKS - 1),
        data: base64(v.data, REMOTE_AGENT_UPLOAD_CHUNK_BYTES),
      };
    case 'open':
      return {
        op: 'open',
        runId: id(v.runId),
        agentKind: oneOf(v.agentKind, REMOTE_AGENT_KINDS),
        payload: payload(v.payload),
      };
    case 'call':
      return {
        op: 'call',
        runId: id(v.runId),
        callId: id(v.callId),
        method: oneOf(v.method, REMOTE_AGENT_METHODS),
        payload: payload(v.payload),
      };
    case 'poll': {
      if (!Array.isArray(v.runs) || v.runs.length === 0 || v.runs.length > REMOTE_AGENT_MAX_POLL_RUNS) invalid();
      const runs = v.runs.map((item) => {
        const entry = record(item);
        return { runId: id(entry.runId), cursor: count(entry.cursor, Number.MAX_SAFE_INTEGER) };
      });
      if (new Set(runs.map((run) => run.runId)).size !== runs.length) invalid();
      return {
        op: 'poll',
        runs,
        ...(v.waitMs !== undefined ? { waitMs: count(v.waitMs, REMOTE_AGENT_READ_WAIT_MS) } : {}),
      };
    }
    case 'reply':
      return { op: 'reply', runId: id(v.runId), requestId: id(v.requestId), payload: payload(v.payload) };
    case 'push':
      return { op: 'push', runId: id(v.runId), seq: count(v.seq, Number.MAX_SAFE_INTEGER), frames: pushFrames(v.frames) };
    case 'close':
      return {
        op: 'close',
        runId: id(v.runId),
        mode: oneOf(v.mode, ['close', 'detach'] as const),
        reason: oneOf(v.reason, REMOTE_AGENT_TEARDOWN_REASONS),
      };
    case 'forget':
      if (typeof v.relay !== 'string' || !REMOTE_AGENT_RELAY_KEY_PATTERN.test(v.relay)) invalid();
      return { op: 'forget', relay: v.relay };
    default:
      invalid();
  }
}

/** poll 按游标幂等：peer reset 后可以重读，其余 op 不可重试。 */
export function isRemoteAgentReadInvoke(channel: string, args: unknown[] | undefined): boolean {
  if (channel !== REMOTE_AGENT_CHANNEL) return false;
  const request = args?.[0];
  return !!request && typeof request === 'object' && (request as { op?: unknown }).op === 'poll';
}

// ─── 控制端解析被控端回包(对端可能是不同版本，按最小合同防御)───────────────

/** 控制端接受的单次 read 数据上限：高于本版本的 READ_MAX_BYTES，给新版被控端留余量。 */
const READ_RESULT_ACCEPT_BYTES = 2 * 1024 * 1024;

export function parseRemoteAgentCaps(value: unknown): RemoteAgentCaps {
  const v = record(value);
  const agents = Array.isArray(v.agents)
    ? v.agents.flatMap((item) => {
        const entry = item && typeof item === 'object' ? item as Record<string, unknown> : null;
        if (!entry || !(REMOTE_AGENT_KINDS as readonly unknown[]).includes(entry.kind)) return [];
        return [{ kind: entry.kind as RemoteAgentKind, available: entry.available === true }];
      })
    : [];
  const caps = {
    version: count(v.version, 1_000),
    agents,
    maxRuns: count(v.maxRuns, 1_000),
    uploadChunkBytes: count(v.uploadChunkBytes, REMOTE_AGENT_UPLOAD_CHUNK_BYTES),
    maxPayloadBytes: count(v.maxPayloadBytes, Number.MAX_SAFE_INTEGER),
    ...(v.virtualWorkspace === true ? { virtualWorkspace: true } : {}),
    ...(v.guestRelay === true ? { guestRelay: true } : {}),
  };
  if (caps.version < 1 || caps.maxRuns < 1 || caps.uploadChunkBytes < 1) invalid();
  return caps;
}

export function parseRemoteAgentReadResult(value: unknown): RemoteAgentReadResult {
  const v = record(value);
  const result: RemoteAgentReadResult = { cursor: count(v.cursor, Number.MAX_SAFE_INTEGER) };
  if (v.from !== undefined) {
    result.from = count(v.from, Number.MAX_SAFE_INTEGER);
    if (result.from > result.cursor) invalid();
  }
  if (v.data !== undefined) result.data = base64(v.data, READ_RESULT_ACCEPT_BYTES);
  if (v.done !== undefined) {
    if (v.done !== true) invalid();
    result.done = true;
  }
  return result;
}

export function parseRemoteAgentPollResult(value: unknown): RemoteAgentPollResult {
  const v = record(value);
  if (!Array.isArray(v.runs) || v.runs.length > REMOTE_AGENT_MAX_POLL_RUNS) invalid();
  return {
    runs: v.runs.map((item) => {
      const entry = record(item);
      return {
        runId: id(entry.runId),
        ...parseRemoteAgentReadResult(entry),
        ...(entry.missing === true ? { missing: true as const } : {}),
      };
    }),
  };
}

function errorInfo(value: unknown): RemoteAgentErrorInfo {
  const v = record(value);
  return {
    code: typeof v.code === 'string' ? v.code.slice(0, 128) : 'INTERNAL',
    message: typeof v.message === 'string' ? v.message.slice(0, MAX_MESSAGE) : '',
    ...(typeof v.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(v.name) ? { name: v.name } : {}),
  };
}

function headerList(value: unknown): Array<[string, string]> {
  if (!Array.isArray(value) || value.length > MAX_HEADERS) invalid();
  return value.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2) invalid();
    const [name, headerValue] = entry as unknown[];
    if (typeof name !== 'string' || !HEADER_NAME.test(name)) invalid();
    if (typeof headerValue !== 'string' || headerValue.length > MAX_HEADER_VALUE || /[\r\n\0]/.test(headerValue)) invalid();
    return [name, headerValue] as [string, string];
  });
}

function reverseRequest(value: unknown): RemoteAgentReverseRequest {
  const v = record(value);
  switch (v.type) {
    case 'interaction':
      return { type: 'interaction', request: v.request };
    case 'http': {
      if (typeof v.method !== 'string' || !/^[A-Z]{3,7}$/.test(v.method)) invalid();
      if (typeof v.path !== 'string' || !v.path.startsWith('/') || v.path.length > MAX_PATH || /[\s\0]/.test(v.path)) invalid();
      return {
        type: 'http',
        method: v.method,
        path: v.path,
        headers: headerList(v.headers),
        ...(v.body !== undefined ? { body: base64(v.body, REMOTE_AGENT_MAX_PAYLOAD_BYTES) } : {}),
      };
    }
    case 'callback':
      return {
        type: 'callback',
        name: oneOf(v.name, REMOTE_AGENT_CALLBACKS),
        args: Array.isArray(v.args) ? v.args : [],
      };
    default:
      invalid();
  }
}

/**
 * 控制端解析事件流的一行。不认识的行类型返回 null(新版被控端可能新增类型，旧控制端跳过)，
 * 已知类型但字段不合法时抛 `REMOTE_AGENT_INVALID`。
 */
export function parseRemoteAgentStreamItem(line: string): RemoteAgentStreamItem | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    invalid();
  }
  const v = record(parsed);
  switch (v.t) {
    case 'started':
      return { t: 'started', handle: record(v.handle) };
    case 'start-failed':
      return { t: 'start-failed', error: errorInfo(v.error) };
    case 'event':
      return { t: 'event', event: v.event };
    case 'state':
      return { t: 'state', state: record(v.state) };
    case 'result':
      return v.ok === true
        ? { t: 'result', callId: id(v.callId), ok: true, ...(v.value !== undefined ? { value: v.value } : {}) }
        : { t: 'result', callId: id(v.callId), ok: false, error: errorInfo(v.error) };
    case 'request':
      return { t: 'request', requestId: id(v.requestId), request: reverseRequest(v.request) };
    case 'cancel':
      return { t: 'cancel', requestId: id(v.requestId) };
    case 'ws': {
      if (typeof v.connId !== 'string' || !CONN_ID.test(v.connId)) invalid();
      const kind = oneOf(v.kind, ['open', 'message', 'close'] as const);
      return {
        t: 'ws',
        connId: v.connId,
        kind,
        ...(typeof v.path === 'string' && v.path.length <= MAX_PATH ? { path: v.path } : {}),
        ...(typeof v.data === 'string' ? { data: v.data } : {}),
      };
    }
    case 'closed':
      return {
        t: 'closed',
        reason: typeof v.reason === 'string' ? v.reason.slice(0, 128) : 'unknown',
        ...(v.error !== undefined ? { error: errorInfo(v.error) } : {}),
      };
    default:
      return null;
  }
}

/** 被控端校验控制端对反向请求的回复。 */
export function parseRemoteAgentReply(value: unknown): RemoteAgentReply {
  const v = record(value);
  switch (v.type) {
    case 'interaction':
      return { type: 'interaction', result: v.result };
    case 'http': {
      const status = count(v.status, 599);
      if (status < 100) invalid();
      return {
        type: 'http',
        status,
        headers: headerList(v.headers),
        ...(v.body !== undefined ? { body: base64(v.body, REMOTE_AGENT_MAX_PAYLOAD_BYTES) } : {}),
      };
    }
    case 'callback':
      return { type: 'callback', ...(v.value !== undefined ? { value: v.value } : {}) };
    case 'error':
      return { type: 'error', error: errorInfo(v.error) };
    default:
      invalid();
  }
}

/** 从 `[CODE] message` 形式的 IPC 错误里取出远程 Agent 错误码。 */
export function remoteAgentErrorCode(message: string | undefined): RemoteAgentErrorCode | null {
  const code = /\[(REMOTE_AGENT_[A-Z_]+)\]/.exec(message ?? '')?.[1];
  return code && (REMOTE_AGENT_ERROR_CODES as readonly string[]).includes(code)
    ? (code as RemoteAgentErrorCode)
    : null;
}
