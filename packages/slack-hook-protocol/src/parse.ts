/**
 * slack-hook-protocol/parse.ts
 * ---------------------------------------------------------------------------
 * 协议帧的运行时校验(规则 9: 确定性用代码保证, 不靠对端自觉)。
 *
 * parseHookMessage 是两端收帧的唯一入口: 任何来源的原始数据(WS 文本帧或已
 * JSON.parse 的对象)先过这里, 通过才进入业务; 坏帧返回 ok:false + 具体原因,
 * 绝不抛异常 —— 调用方按需记日志/断连, 不需要 try/catch。
 *
 * 手写校验、零依赖: 校验规则即协议规范本身, 每个分支的错误信息都带字段路径,
 * 方便两端联调时直接定位是哪个字段不合法。
 */

import {
  BIND_UPDATE_STATES,
  DEFAULT_TELEGRAM_BEHAVIOR,
  HOOK_MAX_FRAME_CHARS,
  HOOK_MESSAGE_TYPES,
  HOOK_PROVIDERS,
  HOOK_PROTOCOL_VERSION,
  MAX_INTERACTION_BUTTONS,
  PROVIDER_BEHAVIOR_PROVIDERS,
  QUERY_KINDS,
  PROVIDER_BIND_STATES,
  TASK_ACK_RESULTS,
  TASK_REJECT_REASONS,
  TELEGRAM_EMOJI_REACTIONS,
  TELEGRAM_GROUP_ACTIVATION_ALWAYS,
  TELEGRAM_REPLY_QUOTE_DM,
  TELEGRAM_REPLY_QUOTE_GROUP,
  TURN_DELIVERY_STATES,
  TURN_END_STATUSES,
  type BindUpdatePayload,
  type HookMessage,
  type HookMessageType,
  type HookParseResult,
  type ProviderBindStatusPayload,
  type QueryResponsePayload,
  type TaskAckPayload,
  type TaskDispatchPayload,
  type TurnEndPayload,
} from './types';

/** 非空字符串。 */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** 纯对象(排除 null / 数组)。 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** string 数组(允许空数组, 元素必须是非空字符串)。 */
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => isNonEmptyString(x));
}

/** `string | null` 字段(缺省 undefined 不算合法 —— 协议字段必须显式给 null)。 */
function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

function isNullableNonEmptyString(v: unknown): v is string | null {
  return v === null || isNonEmptyString(v);
}

/** Positive unix-millisecond timestamp. */
function isPositiveTimestamp(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

/** Provider links are always HTTPS; provider-specific allowlists live in the host. */
function isSafeHttpsUrl(v: unknown): v is string {
  if (!isNonEmptyString(v)) return false;
  try {
    const url = new URL(v);
    return (
      url.protocol === 'https:' &&
      url.hostname.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

function validateProvider(v: unknown, path: string): string | null {
  if (!HOOK_PROVIDERS.includes(v as never)) {
    return `${path} must be one of: ${HOOK_PROVIDERS.join(', ')}`;
  }
  return null;
}

function validateProviderBehaviorProvider(v: unknown, path: string): string | null {
  if (!PROVIDER_BEHAVIOR_PROVIDERS.includes(v as never)) {
    return `${path} must be one of: ${PROVIDER_BEHAVIOR_PROVIDERS.join(', ')}`;
  }
  return null;
}

/** Telegram group/channel ids are canonical negative integers within Bot API's 52-bit range. */
const TELEGRAM_CHAT_ID_MAX_CHARS = 32;
const TELEGRAM_GROUP_CHAT_ID_PATTERN = /^-[1-9][0-9]*$/;
const TELEGRAM_ID_MAX = (1n << 52n) - 1n;
const TELEGRAM_CHAT_ID_MIN = -TELEGRAM_ID_MAX;

function isTelegramGroupChatId(v: unknown): v is string {
  if (
    typeof v !== 'string' ||
    v.length === 0 ||
    v.length > TELEGRAM_CHAT_ID_MAX_CHARS ||
    !TELEGRAM_GROUP_CHAT_ID_PATTERN.test(v)
  ) {
    return false;
  }
  return BigInt(v) >= TELEGRAM_CHAT_ID_MIN;
}

/**
 * Optional nullable-enum patch field (provider.behavior.set's three global
 * fields): undefined = untouched; null = explicit clear (revert to whatever
 * DEFAULT_TELEGRAM_BEHAVIOR carries for this field); a string must be a known
 * enum member (set as an explicit override, persisted even if it happens to
 * equal the current default — see ProviderBehaviorSetPayload's docblock).
 */
function validateOptionalNullableEnum(
  v: unknown,
  allowed: readonly string[],
  path: string,
): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !allowed.includes(v)) {
    return `${path} must be one of: ${allowed.join(', ')}, or null, when present`;
  }
  return null;
}

function fail(error: string): HookParseResult {
  return { ok: false, error };
}

// ── 各消息 payload 校验 ──────────────────────────────────────────────────────
// 每个校验器返回 null 表示通过, 否则返回带字段路径的错误描述。

function validateHello(p: Record<string, unknown>): string | null {
  if (typeof p.protocolVersion !== 'number') return 'hello.protocolVersion must be a number';
  if (!isNonEmptyString(p.deviceId)) return 'hello.deviceId must be a non-empty string';
  if (!isNonEmptyString(p.deviceName)) return 'hello.deviceName must be a non-empty string';
  if (!isStringArray(p.workspaces)) return 'hello.workspaces must be an array of non-empty strings';
  if (!isStringArray(p.agents)) return 'hello.agents must be an array of non-empty strings';
  // features 可选(旧 desktop 不发 = 无能力)
  if (p.features !== undefined && !isStringArray(p.features)) {
    return 'hello.features must be an array of non-empty strings when present';
  }
  if (p.lifecycleAnnouncement !== undefined && typeof p.lifecycleAnnouncement !== 'boolean') {
    return 'hello.lifecycleAnnouncement must be a boolean when present';
  }
  // defaultWorkspace 可选(旧 desktop 不发 = 无默认)。成员关系在协议层卡死:
  // server 只能派发 workspaces 内的别名, 默认值若能指向清单外的别名, 等于给
  // 这条约束开了后门 —— 而它恰恰是 server 侧派发校验的唯一依据。
  if (p.defaultWorkspace !== undefined && p.defaultWorkspace !== null) {
    if (!isNonEmptyString(p.defaultWorkspace)) {
      return 'hello.defaultWorkspace must be a non-empty string or null when present';
    }
    if (!(p.workspaces as string[]).includes(p.defaultWorkspace)) {
      return 'hello.defaultWorkspace must be one of hello.workspaces';
    }
  }
  return null;
}

function validateWelcome(p: Record<string, unknown>): string | null {
  if (!isNonEmptyString(p.serverName)) return 'welcome.serverName must be a non-empty string';
  if (!isStringArray(p.features)) return 'welcome.features must be an array of non-empty strings';
  return null;
}

function validateLifecyclePreference(p: Record<string, unknown>): string | null {
  if (typeof p.enabled !== 'boolean') {
    return 'lifecycle.preference.enabled must be a boolean';
  }
  return null;
}

/** ping / pong: payload 必须是空对象(有多余键 = 对端实现有误, 拒收暴露问题)。 */
function validateEmpty(p: Record<string, unknown>, label: string): string | null {
  if (Object.keys(p).length > 0) return `${label}.payload must be an empty object`;
  return null;
}

function validateDispatchOptions(v: unknown): string | null {
  if (v === undefined) return null;
  if (!isPlainObject(v)) return 'task.dispatch.options must be an object when present';
  for (const key of ['model', 'permissionMode', 'agentKind', 'effort'] as const) {
    if (v[key] !== undefined && !isNullableString(v[key])) {
      return `task.dispatch.options.${key} must be a string or null`;
    }
  }
  return null;
}

/** 附件数组上限(粗防御, 精细限额在生产端)。 */
const MAX_ATTACHMENTS = 16;

/** 附件数组校验(入站 task.dispatch 与出站 turn.end 共用, label 定位错误)。 */
function validateAttachments(v: unknown, label: string): string | null {
  if (v === undefined) return null;
  if (!Array.isArray(v)) return `${label}.attachments must be an array when present`;
  if (v.length > MAX_ATTACHMENTS) {
    return `${label}.attachments must have at most ${MAX_ATTACHMENTS} items`;
  }
  for (let i = 0; i < v.length; i++) {
    const a = v[i];
    if (!isPlainObject(a)) return `${label}.attachments[${i}] must be an object`;
    if (a.name !== null && typeof a.name !== 'string') {
      return `${label}.attachments[${i}].name must be a string or null`;
    }
    if (!isNonEmptyString(a.mimeType)) {
      return `${label}.attachments[${i}].mimeType must be a non-empty string`;
    }
    if (!isNonEmptyString(a.dataBase64)) {
      return `${label}.attachments[${i}].dataBase64 must be a non-empty string`;
    }
  }
  return null;
}

function validateSource(v: unknown): string | null {
  if (v === undefined) return null;
  if (!isPlainObject(v)) return 'task.dispatch.source must be an object when present';
  if (!isNonEmptyString(v.im)) return 'task.dispatch.source.im must be a non-empty string';
  if (v.channelName !== undefined && !isNullableString(v.channelName)) {
    return 'task.dispatch.source.channelName must be a string or null';
  }
  if (v.teamId !== undefined && !isNullableString(v.teamId)) {
    return 'task.dispatch.source.teamId must be a string or null';
  }
  if (v.teamName !== undefined && !isNullableString(v.teamName)) {
    return 'task.dispatch.source.teamName must be a string or null';
  }
  if (v.userText !== undefined && typeof v.userText !== 'string') {
    return 'task.dispatch.source.userText must be a string when present';
  }
  if (v.triggerMessageId !== undefined && !isNullableNonEmptyString(v.triggerMessageId)) {
    return 'task.dispatch.source.triggerMessageId must be a non-empty string or null';
  }
  if (v.threadContext !== undefined) {
    if (!Array.isArray(v.threadContext)) {
      return 'task.dispatch.source.threadContext must be an array when present';
    }
    for (let i = 0; i < v.threadContext.length; i++) {
      const entry = v.threadContext[i];
      if (!isPlainObject(entry))
        return `task.dispatch.source.threadContext[${i}] must be an object`;
      if (typeof entry.author !== 'string') {
        return `task.dispatch.source.threadContext[${i}].author must be a string`;
      }
      if (typeof entry.text !== 'string') {
        return `task.dispatch.source.threadContext[${i}].text must be a string`;
      }
    }
  }
  return null;
}

function validateDispatch(p: Record<string, unknown>): string | null {
  if (!isNonEmptyString(p.requestId)) return 'task.dispatch.requestId must be a non-empty string';
  if (!isNonEmptyString(p.externalKey))
    return 'task.dispatch.externalKey must be a non-empty string';
  if (!isNullableString(p.workspace)) return 'task.dispatch.workspace must be a string or null';
  if (!isNullableString(p.sessionId)) return 'task.dispatch.sessionId must be a string or null';
  // 会话定位二选一: 无 sessionId(默认路径)时 workspace 必填
  if (p.sessionId === null && !isNonEmptyString(p.workspace)) {
    return 'task.dispatch.workspace is required when sessionId is null';
  }
  if (p.sessionId !== null && !isNonEmptyString(p.sessionId)) {
    return 'task.dispatch.sessionId must be a non-empty string when present';
  }
  if (!isNonEmptyString(p.prompt)) return 'task.dispatch.prompt must be a non-empty string';
  const optErr = validateDispatchOptions(p.options);
  if (optErr) return optErr;
  const attErr = validateAttachments(p.attachments, 'task.dispatch');
  if (attErr) return attErr;
  return validateSource(p.source);
}

function validateAck(p: Record<string, unknown>): string | null {
  if (!isNonEmptyString(p.requestId)) return 'task.ack.requestId must be a non-empty string';
  if (!TASK_ACK_RESULTS.includes(p.result as never)) {
    return `task.ack.result must be one of: ${TASK_ACK_RESULTS.join(', ')}`;
  }
  const result = p.result as TaskAckPayload['result'];
  // reason 与 result 联动: 仅 rejected 时必填且必须在枚举内
  if (result === 'rejected') {
    if (!TASK_REJECT_REASONS.includes(p.reason as never)) {
      return `task.ack.reason must be one of: ${TASK_REJECT_REASONS.join(', ')} when rejected`;
    }
    if (p.sessionId !== null) return 'task.ack.sessionId must be null when rejected';
  } else {
    if (p.reason !== null) return 'task.ack.reason must be null unless rejected';
    if (!isNonEmptyString(p.sessionId)) {
      return 'task.ack.sessionId must be a non-empty string when accepted/queued';
    }
  }
  // queuePosition 与 result 联动: 仅 queued 时非 null
  if (result === 'queued') {
    if (
      typeof p.queuePosition !== 'number' ||
      !Number.isInteger(p.queuePosition) ||
      p.queuePosition < 0
    ) {
      return 'task.ack.queuePosition must be a non-negative integer when queued';
    }
  } else if (p.queuePosition !== null) {
    return 'task.ack.queuePosition must be null unless queued';
  }
  return null;
}

function validateTurnEnd(p: Record<string, unknown>): string | null {
  if (!isNonEmptyString(p.requestId)) return 'turn.end.requestId must be a non-empty string';
  if (!isNonEmptyString(p.externalKey)) return 'turn.end.externalKey must be a non-empty string';
  if (!isNullableString(p.sessionId)) return 'turn.end.sessionId must be a string or null';
  if (!TURN_END_STATUSES.includes(p.status as never)) {
    return `turn.end.status must be one of: ${TURN_END_STATUSES.join(', ')}`;
  }
  if (typeof p.finalText !== 'string') return 'turn.end.finalText must be a string';
  // errorMessage 与 status 联动: 仅 error 时必填非空, ok / cancelled 恒 null
  if (p.status === 'error') {
    if (!isNonEmptyString(p.errorMessage)) {
      return 'turn.end.errorMessage must be a non-empty string when status is error';
    }
  } else if (p.errorMessage !== null) {
    return `turn.end.errorMessage must be null when status is ${String(p.status)}`;
  }
  if (!isPlainObject(p.usage)) return 'turn.end.usage must be an object';
  const d = p.usage.durationMs;
  if (d !== null && (typeof d !== 'number' || !Number.isFinite(d) || d < 0)) {
    return 'turn.end.usage.durationMs must be a non-negative finite number or null';
  }
  return validateAttachments(p.attachments, 'turn.end');
}

function validateTurnDelivery(p: Record<string, unknown>): string | null {
  if (!isNonEmptyString(p.requestId)) {
    return 'turn.delivery.requestId must be a non-empty string';
  }
  if (!TURN_DELIVERY_STATES.includes(p.state as never)) {
    return `turn.delivery.state must be one of: ${TURN_DELIVERY_STATES.join(', ')}`;
  }
  const retrying = p.state === 'retrying';
  const delivered = p.state === 'delivered';
  const failed = p.state === 'failed';
  if (typeof p.attempt !== 'number' || !Number.isSafeInteger(p.attempt) || p.attempt < 0) {
    return 'turn.delivery.attempt must be a non-negative safe integer';
  }
  if (p.state === 'accepted' && p.attempt !== 0) {
    return 'turn.delivery.attempt must be 0 when state is accepted';
  }
  if ((retrying || delivered || failed) && p.attempt < 1) {
    return `turn.delivery.attempt must be at least 1 when state is ${String(p.state)}`;
  }
  if (retrying) {
    if (typeof p.retryAt !== 'number' || !Number.isSafeInteger(p.retryAt) || p.retryAt <= 0) {
      return 'turn.delivery.retryAt must be a positive safe integer when state is retrying';
    }
  } else if (p.retryAt !== null) {
    return 'turn.delivery.retryAt must be null when state is not retrying';
  }
  if (!retrying && !failed) {
    return p.error === null
      ? null
      : `turn.delivery.error must be null when state is ${String(p.state)}`;
  }
  if (!isPlainObject(p.error)) {
    return `turn.delivery.error must be an object when state is ${String(p.state)}`;
  }
  if (!isNonEmptyString(p.error.code)) {
    return 'turn.delivery.error.code must be a non-empty string';
  }
  if (!isNonEmptyString(p.error.message)) {
    return 'turn.delivery.error.message must be a non-empty string';
  }
  if (typeof p.error.retryable !== 'boolean') {
    return 'turn.delivery.error.retryable must be a boolean';
  }
  const allowedErrorKeys = new Set(['code', 'message', 'retryable']);
  const unexpectedErrorKey = Object.keys(p.error).find((key) => !allowedErrorKeys.has(key));
  if (unexpectedErrorKey !== undefined) {
    return `turn.delivery.error.${unexpectedErrorKey} is not allowed`;
  }
  if (retrying && p.error.retryable !== true) {
    return 'turn.delivery.error.retryable must be true when state is retrying';
  }
  if (failed && p.error.retryable !== false) {
    return 'turn.delivery.error.retryable must be false when state is failed';
  }
  return null;
}

function validateTurnProgress(p: Record<string, unknown>): string | null {
  if (!isNonEmptyString(p.requestId)) return 'turn.progress.requestId must be a non-empty string';
  if (typeof p.text !== 'string') return 'turn.progress.text must be a string';
  return null;
}

/**
 * turn.reopen: requestId 与 reopenOf 必须都在且**不相等** —— 复用同一个 id 会让
 * server 侧把新一轮登记成它自己的前身, 幂等表状态不可推理(见 types.ts 第 18 条:
 * 续跑刻意换新 id)。reason 是开放集合, 只校验非空串, 未知值由消费方兜底。
 */
function validateTurnReopen(p: Record<string, unknown>): string | null {
  if (!isNonEmptyString(p.requestId)) return 'turn.reopen.requestId must be a non-empty string';
  if (!isNonEmptyString(p.reopenOf)) return 'turn.reopen.reopenOf must be a non-empty string';
  if (p.requestId === p.reopenOf) return 'turn.reopen.requestId must differ from reopenOf';
  if (!isNonEmptyString(p.externalKey)) {
    return 'turn.reopen.externalKey must be a non-empty string';
  }
  if (!isNullableString(p.sessionId)) return 'turn.reopen.sessionId must be a string or null';
  if (!isNonEmptyString(p.reason)) return 'turn.reopen.reason must be a non-empty string';
  return null;
}

/**
 * msg.op: 内容面上收客户端后的消息操作动词。
 *
 * 校验刻意只到"形状"为止 —— 服务端是哑执行器, 不解释内容, 所以正文长度、
 * 分块、文案一律不在这里判(那些由客户端负责)。但两件事必须校严:
 *   - `opId` 是断连重发下不产生重复消息的唯一依据(Telegram 无发送端幂等键),
 *     缺失即拒收, 不能让服务端"尽力而为"地猜;
 *   - `scope.externalKey` 是多租户授权的锚点, 缺失即拒收。
 */
function validateMessageOp(p: Record<string, unknown>): string | null {
  if (!isNonEmptyString(p.opId)) return 'msg.op.opId must be a non-empty string';
  if (p.requestId !== undefined && !isNonEmptyString(p.requestId)) {
    return 'msg.op.requestId must be a non-empty string when present';
  }
  if (!isPlainObject(p.scope)) return 'msg.op.scope must be an object';
  const scope = p.scope as Record<string, unknown>;
  if (!isNonEmptyString(scope.externalKey)) {
    return 'msg.op.scope.externalKey must be a non-empty string';
  }
  // 寻址字段一律拒收: externalKey 是唯一授权锚点, 目标 chat 必须由服务端从
  // 自己那份 lane 记录里取。放行一个客户端指定的 chat_id, 一台被攻陷或有 bug
  // 的桌面就能越过自己 lane 的边界往任意聊天发消息 —— 静默忽略不够, 因为那会
  // 让发送方以为寻址生效了。
  if (scope.chatId !== undefined || scope.threadId !== undefined) {
    return 'msg.op.scope must not carry chatId/threadId: the server resolves the target from externalKey';
  }
  if (!isPlainObject(p.action)) return 'msg.op.action must be an object';
  const action = p.action as Record<string, unknown>;
  const kind = action.kind;
  if (kind === 'send' || kind === 'edit') {
    if (typeof action.text !== 'string') return `msg.op.action.text must be a string`;
    if (kind === 'edit' && !isNonEmptyString(action.messageId)) {
      return 'msg.op.action.messageId must be a non-empty string';
    }
    if (
      action.tier !== undefined &&
      action.tier !== 'rich' &&
      action.tier !== 'html' &&
      action.tier !== 'plain'
    ) {
      return 'msg.op.action.tier must be one of: rich, html, plain';
    }
    return null;
  }
  if (kind === 'delete') {
    return isNonEmptyString(action.messageId)
      ? null
      : 'msg.op.action.messageId must be a non-empty string';
  }
  if (kind === 'react') {
    if (!isNonEmptyString(action.targetMessageId)) {
      return 'msg.op.action.targetMessageId must be a non-empty string';
    }
    // 空串是**撤销**语义, 合法; 只拒非字符串。
    return typeof action.emoji === 'string' ? null : 'msg.op.action.emoji must be a string';
  }
  if (kind === 'typing') return null;
  if (kind === 'media') {
    if (!Array.isArray(action.items) || action.items.length === 0) {
      return 'msg.op.action.items must be a non-empty array';
    }
    for (const item of action.items) {
      if (!isPlainObject(item)) return 'msg.op.action.items[] must be objects';
      const media = item as Record<string, unknown>;
      if (!isNonEmptyString(media.name))
        return 'msg.op.action.items[].name must be a non-empty string';
      if (!isNonEmptyString(media.mimeType)) {
        return 'msg.op.action.items[].mimeType must be a non-empty string';
      }
      if (!isNonEmptyString(media.dataBase64)) {
        return 'msg.op.action.items[].dataBase64 must be a non-empty string';
      }
    }
    return null;
  }
  return `msg.op.action.kind is unknown: ${String(kind)}`;
}

/**
 * msg.op.result: 操作回执。`messageId` 是客户端做后续 edit / delete / react 的
 * 唯一依据 —— 没有它整个动词集只能发不能改, 所以 ok=true 的 send / media 必须带。
 * 这里只能校验形状(是否为串), "该不该带"由动作类型决定, 交给消费方。
 */
function validateMessageOpResult(p: Record<string, unknown>): string | null {
  if (!isNonEmptyString(p.opId)) return 'msg.op.result.opId must be a non-empty string';
  if (typeof p.ok !== 'boolean') return 'msg.op.result.ok must be a boolean';
  // messageId / error 都是**可选**字段: typing、delete 的回执没有 message id,
  // 成功回执也没有 error。缺席与显式 null 同义, 都不算格式错误。
  if (p.messageId !== undefined && !isNullableString(p.messageId)) {
    return 'msg.op.result.messageId must be a string or null';
  }
  if (p.messageIds !== undefined) {
    if (!Array.isArray(p.messageIds) || p.messageIds.some((v) => !isNonEmptyString(v))) {
      return 'msg.op.result.messageIds must be an array of non-empty strings';
    }
  }
  if (p.error !== undefined && !isNullableString(p.error)) {
    return 'msg.op.result.error must be a string or null';
  }
  if (
    p.retryAfterMs !== undefined &&
    p.retryAfterMs !== null &&
    (typeof p.retryAfterMs !== 'number' || !Number.isFinite(p.retryAfterMs) || p.retryAfterMs < 0)
  ) {
    return 'msg.op.result.retryAfterMs must be a non-negative finite number or null';
  }
  return null;
}

// ── v2 增量帧校验 ────────────────────────────────────────────────────────────

/**
 * 阶段 4 起 email 可选(新端发空对象 {}); 若携带则粗校验为"含 @ 的非空串",
 * 以便 server 能正常收下老客户端的帧并识别为旧版回升级提示(坏 email 直接
 * 拒收会丢帧, server 就无从判断)。
 */
function validateBindStart(p: Record<string, unknown>): string | null {
  if (p.email !== undefined && (!isNonEmptyString(p.email) || !p.email.includes('@'))) {
    return 'bind.start.email, when present, must be an email-like string';
  }
  if (p.teamId !== undefined && !isNullableString(p.teamId)) {
    return 'bind.start.teamId must be a string or null when present';
  }
  return null;
}

function validateBindUpdate(p: Record<string, unknown>): string | null {
  if (!BIND_UPDATE_STATES.includes(p.state as never)) {
    return `bind.update.state must be one of: ${BIND_UPDATE_STATES.join(', ')}`;
  }
  if (!isNullableString(p.slackUserId)) return 'bind.update.slackUserId must be a string or null';
  if (!isNullableString(p.slackUserName))
    return 'bind.update.slackUserName must be a string or null';
  if (!isNullableString(p.message)) return 'bind.update.message must be a string or null';
  if (p.authorizeUrl !== undefined && !isNullableString(p.authorizeUrl)) {
    return 'bind.update.authorizeUrl must be a string or null';
  }
  // reason 只校验形状不校验取值: 新 server 推出新 reason 时老客户端照常收下并忽略
  if (p.reason !== undefined && !isNullableString(p.reason)) {
    return 'bind.update.reason must be a string or null';
  }
  if (p.installUrl !== undefined && !isNullableString(p.installUrl)) {
    return 'bind.update.installUrl must be a string or null';
  }
  if (p.teamName !== undefined && !isNullableString(p.teamName)) {
    return 'bind.update.teamName must be a string or null';
  }
  if (p.teamId !== undefined && !isNullableString(p.teamId)) {
    return 'bind.update.teamId must be a string or null';
  }
  const state = p.state as BindUpdatePayload['state'];
  // 字段联动: confirmed 必须带身份 slackUserId; pending(OIDC)必须带授权链接;
  // failed 必须说明原因
  if (state === 'confirmed' && !isNonEmptyString(p.slackUserId)) {
    return 'bind.update.slackUserId must be a non-empty string when state is confirmed';
  }
  if (state === 'pending' && !isNonEmptyString(p.authorizeUrl)) {
    return 'bind.update.authorizeUrl must be a non-empty string when state is pending';
  }
  if (state === 'failed' && !isNonEmptyString(p.message)) {
    return 'bind.update.message must be a non-empty string when state is failed';
  }
  return null;
}

/**
 * bind.revoke: 从空对象放宽为 { teamId?, pendingOnly? }(multi-team 按 team
 * 解绑 / 取消在途授权)。未知键仍拒收 —— 保留"对端实现有误即拒收"的暴露性。
 */
function validateBindRevoke(p: Record<string, unknown>): string | null {
  for (const key of Object.keys(p)) {
    if (key !== 'teamId' && key !== 'pendingOnly') {
      return `bind.revoke.${key} is not a known field`;
    }
  }
  if (p.teamId !== undefined && !isNullableString(p.teamId)) {
    return 'bind.revoke.teamId must be a string or null when present';
  }
  if (p.pendingOnly !== undefined && typeof p.pendingOnly !== 'boolean') {
    return 'bind.revoke.pendingOnly must be a boolean when present';
  }
  return null;
}

/** bind.state(multi-team): 绑定全量快照。 */
function validateBindState(p: Record<string, unknown>): string | null {
  if (!Array.isArray(p.bindings)) return 'bind.state.bindings must be an array';
  for (let i = 0; i < p.bindings.length; i++) {
    const b: unknown = p.bindings[i];
    const path = `bind.state.bindings[${i}]`;
    if (!isPlainObject(b)) return `${path} must be an object`;
    if (!isNonEmptyString(b.teamId)) return `${path}.teamId must be a non-empty string`;
    if (!isNullableString(b.teamName)) return `${path}.teamName must be a string or null`;
    if (!isNonEmptyString(b.slackUserId)) return `${path}.slackUserId must be a non-empty string`;
    if (!isNullableString(b.slackUserName)) return `${path}.slackUserName must be a string or null`;
  }
  return null;
}

function validateProviderBindStart(p: Record<string, unknown>): string | null {
  if (!isNonEmptyString(p.requestId)) {
    return 'provider.bind.start.requestId must be a non-empty string';
  }
  const providerError = validateProvider(p.provider, 'provider.bind.start.provider');
  if (providerError) return providerError;
  if (p.scopeId !== undefined && !isNullableNonEmptyString(p.scopeId)) {
    return 'provider.bind.start.scopeId must be a non-empty string or null when present';
  }
  return null;
}

function validateProviderBindCancel(p: Record<string, unknown>): string | null {
  if (!isNonEmptyString(p.requestId)) {
    return 'provider.bind.cancel.requestId must be a non-empty string';
  }
  const providerError = validateProvider(p.provider, 'provider.bind.cancel.provider');
  if (providerError) return providerError;
  if (!isNonEmptyString(p.attemptId)) {
    return 'provider.bind.cancel.attemptId must be a non-empty string';
  }
  return null;
}

function validateProviderBindRevoke(p: Record<string, unknown>): string | null {
  if (!isNonEmptyString(p.requestId)) {
    return 'provider.bind.revoke.requestId must be a non-empty string';
  }
  const providerError = validateProvider(p.provider, 'provider.bind.revoke.provider');
  if (providerError) return providerError;
  if (!isNonEmptyString(p.bindingId)) {
    return 'provider.bind.revoke.bindingId must be a non-empty string';
  }
  return null;
}

const PROVIDER_BIND_ID_FIELDS = [
  'attemptId',
  'bindingId',
  'principalId',
  'principalName',
  'scopeId',
  'scopeName',
] as const;

const PROVIDER_BIND_FAILURE_STATES = [
  'denied',
  'expired',
  'failed',
  'revoked',
  'superseded',
] as const;

/** provider.bind.update/state share one strict, replacement-safe snapshot shape. */
function validateProviderBindStatus(
  p: Record<string, unknown>,
  label: 'provider.bind.update' | 'provider.bind.state',
): string | null {
  const providerError = validateProvider(p.provider, `${label}.provider`);
  if (providerError) return providerError;
  if (!isNullableNonEmptyString(p.replyTo)) {
    return `${label}.replyTo must be a non-empty string or null`;
  }
  if (!PROVIDER_BIND_STATES.includes(p.state as never)) {
    return `${label}.state must be one of: ${PROVIDER_BIND_STATES.join(', ')}`;
  }
  for (const field of PROVIDER_BIND_ID_FIELDS) {
    if (!isNullableNonEmptyString(p[field])) {
      return `${label}.${field} must be a non-empty string or null`;
    }
  }
  if (p.connectUrl !== null && !isSafeHttpsUrl(p.connectUrl)) {
    return `${label}.connectUrl must be a safe HTTPS URL or null`;
  }
  if (p.remediationUrl !== null && !isSafeHttpsUrl(p.remediationUrl)) {
    return `${label}.remediationUrl must be a safe HTTPS URL or null`;
  }
  if (p.expiresAt !== null && !isPositiveTimestamp(p.expiresAt)) {
    return `${label}.expiresAt must be a positive integer timestamp or null`;
  }
  if (!isNullableNonEmptyString(p.reason)) {
    return `${label}.reason must be a non-empty string or null`;
  }
  if (!isStringArray(p.actions)) {
    return `${label}.actions must be an array of non-empty strings`;
  }
  if (p.actions.length > 16) return `${label}.actions must have at most 16 items`;
  if (new Set(p.actions).size !== p.actions.length) {
    return `${label}.actions must not contain duplicates`;
  }

  const state = p.state as ProviderBindStatusPayload['state'];
  const attemptState =
    state === 'pending' ||
    state === 'awaiting_confirmation' ||
    state === 'denied' ||
    state === 'expired' ||
    state === 'failed';
  const activeAttemptState = state === 'pending' || state === 'awaiting_confirmation';
  const failedAttemptState = state === 'denied' || state === 'expired' || state === 'failed';
  if (attemptState && !isNonEmptyString(p.attemptId)) {
    return `${label}.attemptId must be non-empty for attempt state ${state}`;
  }
  if (activeAttemptState && p.bindingId !== null) {
    return `${label}.bindingId must be null when state is ${state}`;
  }
  if (failedAttemptState) {
    for (const field of ['bindingId', 'principalId', 'principalName'] as const) {
      if (p[field] !== null) {
        return `${label}.${field} must be null when state is ${state}`;
      }
    }
    if (p.expiresAt !== null) {
      return `${label}.expiresAt must be null when state is ${state}`;
    }
  }
  if (activeAttemptState && !isPositiveTimestamp(p.expiresAt)) {
    return `${label}.expiresAt must be non-null for active attempt state ${state}`;
  }
  if (state === 'pending' && !isSafeHttpsUrl(p.connectUrl)) {
    return `${label}.connectUrl must be a safe HTTPS URL when state is pending`;
  }
  if (state !== 'pending' && p.connectUrl !== null) {
    return `${label}.connectUrl must be null unless state is pending`;
  }
  if (state === 'confirmed') {
    for (const field of ['bindingId', 'principalId', 'scopeId'] as const) {
      if (!isNonEmptyString(p[field])) {
        return `${label}.${field} must be non-empty when state is confirmed`;
      }
    }
  }
  if ((state === 'revoked' || state === 'superseded') && !isNonEmptyString(p.bindingId)) {
    return `${label}.bindingId must be non-empty when state is ${state}`;
  }
  if (PROVIDER_BIND_FAILURE_STATES.includes(state as never) && !isNonEmptyString(p.reason)) {
    return `${label}.reason must be non-empty when state is ${state}`;
  }
  if (
    (state === 'none' || state === 'confirmed' || state === 'revoked' || state === 'superseded') &&
    (p.attemptId !== null || p.expiresAt !== null)
  ) {
    return `${label}.attemptId and expiresAt must be null when state is ${state}`;
  }
  if (state === 'none') {
    for (const field of ['bindingId', 'principalId', 'principalName'] as const) {
      if (p[field] !== null) return `${label}.${field} must be null when state is none`;
    }
  }
  if (!PROVIDER_BIND_FAILURE_STATES.includes(state as never) && p.reason !== null) {
    return `${label}.reason must be null when state is ${state}`;
  }
  return null;
}

function validateQueryRequest(p: Record<string, unknown>): string | null {
  if (!isNonEmptyString(p.queryId)) return 'query.request.queryId must be a non-empty string';
  if (!QUERY_KINDS.includes(p.kind as never)) {
    return `query.request.kind must be one of: ${QUERY_KINDS.join(', ')}`;
  }
  if (p.kind === 'session-new') {
    if (!isPlainObject(p.sessionNew)) {
      return 'query.request.sessionNew must be an object when kind is session-new';
    }
    const request = p.sessionNew;
    if (!isNonEmptyString(request.previousExternalKey)) {
      return 'query.request.sessionNew.previousExternalKey must be a non-empty string';
    }
    if (!isNonEmptyString(request.externalKey)) {
      return 'query.request.sessionNew.externalKey must be a non-empty string';
    }
    if (request.externalKey === request.previousExternalKey) {
      return 'query.request.sessionNew.externalKey must differ from previousExternalKey';
    }
    if (!isNonEmptyString(request.workspace)) {
      return 'query.request.sessionNew.workspace must be a non-empty string';
    }
    const optErr = validateDispatchOptions(request.options);
    if (optErr) return optErr;
    return validateSource(request.source);
  }
  return null;
}

/** agents 数组(kind=models 响应体)的形状校验。 */
function validateAgentModels(v: unknown): string | null {
  if (!Array.isArray(v)) return 'query.response.agents must be an array';
  for (let i = 0; i < v.length; i++) {
    const g = v[i];
    if (!isPlainObject(g)) return `query.response.agents[${i}] must be an object`;
    if (!isNonEmptyString(g.agentKind)) {
      return `query.response.agents[${i}].agentKind must be a non-empty string`;
    }
    if (!Array.isArray(g.models)) return `query.response.agents[${i}].models must be an array`;
    for (let j = 0; j < g.models.length; j++) {
      const m: unknown = g.models[j];
      const path = `query.response.agents[${i}].models[${j}]`;
      if (!isPlainObject(m)) return `${path} must be an object`;
      if (!isNonEmptyString(m.id)) return `${path}.id must be a non-empty string`;
      if (!isNonEmptyString(m.label)) return `${path}.label must be a non-empty string`;
      if (!isStringArray(m.efforts)) return `${path}.efforts must be an array of non-empty strings`;
      if (!isNullableString(m.defaultEffort))
        return `${path}.defaultEffort must be a string or null`;
      if (m.group !== undefined && !isNullableString(m.group)) {
        return `${path}.group must be a string or null when present`;
      }
    }
    // permissionModes 可选(旧版 desktop 不发); present 时校验形状
    if (g.permissionModes !== undefined) {
      if (!Array.isArray(g.permissionModes)) {
        return `query.response.agents[${i}].permissionModes must be an array when present`;
      }
      for (let j = 0; j < g.permissionModes.length; j++) {
        const pm: unknown = g.permissionModes[j];
        const path = `query.response.agents[${i}].permissionModes[${j}]`;
        if (!isPlainObject(pm)) return `${path} must be an object`;
        if (!isNonEmptyString(pm.id)) return `${path}.id must be a non-empty string`;
        if (!isNonEmptyString(pm.label)) return `${path}.label must be a non-empty string`;
      }
    }
  }
  return null;
}

function looksLikeAbsolutePath(v: string): boolean {
  return v.startsWith('/') || v.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(v) || /^file:/i.test(v);
}

function validateQuerySessions(v: unknown): string | null {
  if (!Array.isArray(v)) return 'query.response.sessions must be an array';
  if (v.length > 20) return 'query.response.sessions must have at most 20 items';
  const ids = new Set<string>();
  const allowedFields = new Set(['id', 'title', 'workspace', 'lastActiveAt']);
  for (let i = 0; i < v.length; i++) {
    const session: unknown = v[i];
    const path = `query.response.sessions[${i}]`;
    if (!isPlainObject(session)) return `${path} must be an object`;
    for (const field of Object.keys(session)) {
      if (!allowedFields.has(field)) {
        return `${path}.${field} is not allowed in the privacy-minimised session shape`;
      }
    }
    if (!isNonEmptyString(session.id)) return `${path}.id must be a non-empty string`;
    if (ids.has(session.id)) return `${path}.id must be unique within the response`;
    ids.add(session.id);
    if (!isNonEmptyString(session.title)) return `${path}.title must be a non-empty string`;
    if (!isNonEmptyString(session.workspace)) {
      return `${path}.workspace must be a non-empty alias`;
    }
    if (looksLikeAbsolutePath(session.workspace)) {
      return `${path}.workspace must not be an absolute path`;
    }
    if (!isPositiveTimestamp(session.lastActiveAt)) {
      return `${path}.lastActiveAt must be a positive integer timestamp`;
    }
  }
  return null;
}

function validateQueryResponse(p: Record<string, unknown>): string | null {
  if (!isNonEmptyString(p.queryId)) return 'query.response.queryId must be a non-empty string';
  if (!QUERY_KINDS.includes(p.kind as never)) {
    return `query.response.kind must be one of: ${QUERY_KINDS.join(', ')}`;
  }
  if (typeof p.ok !== 'boolean') return 'query.response.ok must be a boolean';
  if (!isNullableString(p.error)) return 'query.response.error must be a string or null';
  if (!p.ok) {
    if (!isNonEmptyString(p.error)) {
      return 'query.response.error must be a non-empty string when ok is false';
    }
    return null; // 失败响应不要求携带清单
  }
  const kind = p.kind as QueryResponsePayload['kind'];
  if (kind === 'workspaces') {
    if (!isStringArray(p.workspaces)) {
      return 'query.response.workspaces must be an array of non-empty strings when kind is workspaces';
    }
    return null;
  }
  if (kind === 'models') return validateAgentModels(p.agents);
  if (kind === 'sessions') return validateQuerySessions(p.sessions);
  return isNonEmptyString(p.sessionId)
    ? null
    : 'query.response.sessionId must be a non-empty string when kind is session-new';
}

function validateTaskCancel(p: Record<string, unknown>): string | null {
  if (!isNonEmptyString(p.requestId)) return 'task.cancel.requestId must be a non-empty string';
  return null;
}

function validateSessionArchive(p: Record<string, unknown>): string | null {
  if (!isNonEmptyString(p.externalKey)) {
    return 'session.archive.externalKey must be a non-empty string';
  }
  return null;
}

// ── 阶段 10(v2): 执行中交互 ─────────────────────────────────────────────────

const BUTTON_STYLES = ['primary', 'danger', 'default'] as const;

function validateInteractionRequest(p: Record<string, unknown>): string | null {
  if (!isNonEmptyString(p.requestId))
    return 'interaction.request.requestId must be a non-empty string';
  if (!isNonEmptyString(p.interactionId)) {
    return 'interaction.request.interactionId must be a non-empty string';
  }
  if (!isNonEmptyString(p.kind)) return 'interaction.request.kind must be a non-empty string';
  if (!isNonEmptyString(p.title)) return 'interaction.request.title must be a non-empty string';
  if (typeof p.body !== 'string') return 'interaction.request.body must be a string';
  if (!Array.isArray(p.buttons) || p.buttons.length === 0) {
    return 'interaction.request.buttons must be a non-empty array';
  }
  if (p.buttons.length > MAX_INTERACTION_BUTTONS) {
    return `interaction.request.buttons must have at most ${MAX_INTERACTION_BUTTONS} items`;
  }
  const seen = new Set<string>();
  for (let i = 0; i < p.buttons.length; i++) {
    const b: unknown = p.buttons[i];
    const path = `interaction.request.buttons[${i}]`;
    if (!isPlainObject(b)) return `${path} must be an object`;
    if (!isNonEmptyString(b.id)) return `${path}.id must be a non-empty string`;
    // '|' 是 server 侧 value 复合编码的分隔符, id 带它会破坏回传解析
    if (b.id.includes('|')) return `${path}.id must not contain '|'`;
    if (seen.has(b.id)) return `${path}.id must be unique within the card`;
    seen.add(b.id);
    if (!isNonEmptyString(b.label)) return `${path}.label must be a non-empty string`;
    if (!BUTTON_STYLES.includes(b.style as never)) {
      return `${path}.style must be one of: ${BUTTON_STYLES.join(', ')}`;
    }
  }
  return null;
}

function validateInteractionDecision(p: Record<string, unknown>): string | null {
  if (!isNonEmptyString(p.requestId))
    return 'interaction.decision.requestId must be a non-empty string';
  if (!isNonEmptyString(p.interactionId)) {
    return 'interaction.decision.interactionId must be a non-empty string';
  }
  if (!isNonEmptyString(p.buttonId))
    return 'interaction.decision.buttonId must be a non-empty string';
  return null;
}

function validateInteractionCancel(p: Record<string, unknown>): string | null {
  if (!isNonEmptyString(p.requestId))
    return 'interaction.cancel.requestId must be a non-empty string';
  if (!isNonEmptyString(p.interactionId)) {
    return 'interaction.cancel.interactionId must be a non-empty string';
  }
  if (typeof p.reason !== 'string') return 'interaction.cancel.reason must be a string';
  return null;
}

// ── 阶段 12(v2): Slack 网关工具 ────────────────────────────────────────────

function validateToolRequest(p: Record<string, unknown>): string | null {
  if (!isNonEmptyString(p.requestId)) return 'tool.request.requestId must be a non-empty string';
  // tool 是开放集合: 只校验形状, 未知工具名由 server 业务层回 UNKNOWN_TOOL
  if (!isNonEmptyString(p.tool)) return 'tool.request.tool must be a non-empty string';
  if (p.args !== undefined && !isPlainObject(p.args)) {
    return 'tool.request.args must be an object when present';
  }
  if (p.teamId !== undefined && !isNullableString(p.teamId)) {
    return 'tool.request.teamId must be a string or null when present';
  }
  return null;
}

function validateToolResponse(p: Record<string, unknown>): string | null {
  if (!isNonEmptyString(p.replyTo)) return 'tool.response.replyTo must be a non-empty string';
  if (typeof p.ok !== 'boolean') return 'tool.response.ok must be a boolean';
  // 字段联动: 失败必须给结构化错误, 成功不得携带 error(result 形状不限)
  if (p.ok === false) {
    if (!isPlainObject(p.error)) {
      return 'tool.response.error must be an object when ok is false';
    }
    if (!isNonEmptyString(p.error.code)) {
      return 'tool.response.error.code must be a non-empty string';
    }
    if (!isNonEmptyString(p.error.message)) {
      return 'tool.response.error.message must be a non-empty string';
    }
  } else if (p.error !== undefined && p.error !== null) {
    return 'tool.response.error must be absent or null when ok is true';
  }
  return null;
}

// ── 阶段 11(v2): 目录偏好远程读写 ──────────────────────────────────────────

/** prefs.set 可部分更新的偏好字段(shape 校验共用)。 */
const PREFS_PATCH_FIELDS = ['model', 'effort', 'agentKind', 'permissionMode'] as const;

function validatePrefsGet(p: Record<string, unknown>): string | null {
  if (!isNonEmptyString(p.requestId)) return 'prefs.get.requestId must be a non-empty string';
  return null;
}

function validatePrefsSet(p: Record<string, unknown>): string | null {
  if (!isNonEmptyString(p.requestId)) return 'prefs.set.requestId must be a non-empty string';
  if (!isNonEmptyString(p.workspace)) return 'prefs.set.workspace must be a non-empty string';
  // 部分更新语义: 缺席 = 不动, null = 显式清空; 值合法性不在协议层校验
  for (const field of PREFS_PATCH_FIELDS) {
    if (p[field] !== undefined && !isNullableString(p[field])) {
      return `prefs.set.${field} must be a string or null when present`;
    }
  }
  if (p.teamId !== undefined && !isNullableString(p.teamId)) {
    return 'prefs.set.teamId must be a string or null when present';
  }
  return null;
}

function validatePrefsState(p: Record<string, unknown>): string | null {
  if (!isNullableString(p.replyTo)) return 'prefs.state.replyTo must be a string or null';
  if (typeof p.bound !== 'boolean') return 'prefs.state.bound must be a boolean';
  if (!Array.isArray(p.prefs)) return 'prefs.state.prefs must be an array';
  // 字段联动: 未绑定时不该有任何偏好行
  if (!p.bound && p.prefs.length > 0) return 'prefs.state.prefs must be empty when bound is false';
  for (let i = 0; i < p.prefs.length; i++) {
    const entry: unknown = p.prefs[i];
    const path = `prefs.state.prefs[${i}]`;
    if (!isPlainObject(entry)) return `${path} must be an object`;
    if (!isNonEmptyString(entry.workspace)) return `${path}.workspace must be a non-empty string`;
    for (const field of PREFS_PATCH_FIELDS) {
      // 快照条目字段必须显式给出(null 而非缺席), 与 UserPrefsRow 同形
      if (!isNullableString(entry[field])) return `${path}.${field} must be a string or null`;
    }
    if (entry.teamId !== undefined && !isNullableString(entry.teamId)) {
      return `${path}.teamId must be a string or null when present`;
    }
  }
  return null;
}

function validateProviderPrefsSelector(
  p: Record<string, unknown>,
  label: 'provider.prefs.get' | 'provider.prefs.set' | 'provider.prefs.state',
): string | null {
  const providerError = validateProvider(p.provider, `${label}.provider`);
  if (providerError) return providerError;
  if (!isNullableNonEmptyString(p.bindingId)) {
    return `${label}.bindingId must be a non-empty string or null`;
  }
  if (!isNullableNonEmptyString(p.scopeId)) {
    return `${label}.scopeId must be a non-empty string or null`;
  }
  if ((p.bindingId === null) === (p.scopeId === null)) {
    return `${label} must select exactly one of bindingId or scopeId`;
  }
  return null;
}

function validateProviderPrefsGet(p: Record<string, unknown>): string | null {
  if (!isNonEmptyString(p.requestId)) {
    return 'provider.prefs.get.requestId must be a non-empty string';
  }
  return validateProviderPrefsSelector(p, 'provider.prefs.get');
}

function validateProviderPrefsSet(p: Record<string, unknown>): string | null {
  if (!isNonEmptyString(p.requestId)) {
    return 'provider.prefs.set.requestId must be a non-empty string';
  }
  const selectorError = validateProviderPrefsSelector(p, 'provider.prefs.set');
  if (selectorError) return selectorError;
  if (!isNonEmptyString(p.workspace)) {
    return 'provider.prefs.set.workspace must be a non-empty string';
  }
  if (looksLikeAbsolutePath(p.workspace)) {
    return 'provider.prefs.set.workspace must not be an absolute path';
  }
  for (const field of PREFS_PATCH_FIELDS) {
    if (p[field] !== undefined && !isNullableString(p[field])) {
      return `provider.prefs.set.${field} must be a string or null when present`;
    }
  }
  return null;
}

function validateProviderPrefsState(p: Record<string, unknown>): string | null {
  const selectorError = validateProviderPrefsSelector(p, 'provider.prefs.state');
  if (selectorError) return selectorError;
  if (!isNullableNonEmptyString(p.replyTo)) {
    return 'provider.prefs.state.replyTo must be a non-empty string or null';
  }
  if (typeof p.bound !== 'boolean') return 'provider.prefs.state.bound must be a boolean';
  if (!Array.isArray(p.prefs)) return 'provider.prefs.state.prefs must be an array';
  if (!p.bound && p.prefs.length > 0) {
    return 'provider.prefs.state.prefs must be empty when bound is false';
  }
  for (let i = 0; i < p.prefs.length; i++) {
    const entry: unknown = p.prefs[i];
    const path = `provider.prefs.state.prefs[${i}]`;
    if (!isPlainObject(entry)) return `${path} must be an object`;
    if (!isNonEmptyString(entry.workspace)) return `${path}.workspace must be a non-empty string`;
    if (looksLikeAbsolutePath(entry.workspace)) {
      return `${path}.workspace must not be an absolute path`;
    }
    for (const field of PREFS_PATCH_FIELDS) {
      if (!isNullableString(entry[field])) return `${path}.${field} must be a string or null`;
    }
    if (entry.teamId !== undefined) {
      return `${path}.teamId is Slack-specific and is not allowed in provider prefs`;
    }
  }
  return null;
}

// ── Provider-neutral behavior (Telegram, append-only v1) ───────────────────
// 见文件头第 19 条。groupActivation 不另设条目上限：每次合法 set 都必须能在
// 后续 state 全量快照中表达；整帧仍受 HOOK_MAX_FRAME_CHARS 的统一上限保护。

/**
 * provider.behavior.* 选择器: 与 provider.prefs.* 不同, 只认 bindingId
 * (非空必填), 不支持 scopeId —— 行为配置在绑定成立前没有意义。
 */
function validateProviderBehaviorSelector(
  p: Record<string, unknown>,
  label: 'provider.behavior.get' | 'provider.behavior.set' | 'provider.behavior.state',
): string | null {
  const providerError = validateProviderBehaviorProvider(p.provider, `${label}.provider`);
  if (providerError) return providerError;
  if (!isNonEmptyString(p.bindingId)) {
    return `${label}.bindingId must be a non-empty string`;
  }
  return null;
}

function validateProviderBehaviorGet(p: Record<string, unknown>): string | null {
  if (!isNonEmptyString(p.requestId)) {
    return 'provider.behavior.get.requestId must be a non-empty string';
  }
  return validateProviderBehaviorSelector(p, 'provider.behavior.get');
}

/**
 * groupActivation patch/clear 的形状校验(set 与 state 共用大部分逻辑不同,
 * 这里只做 set 的单条 patch 校验; state 的 map 校验在 validateProviderBehaviorState)。
 */
function validateGroupActivationPatch(v: unknown): string | null {
  if (!isPlainObject(v)) {
    return 'provider.behavior.set.groupActivation must be an object when present';
  }
  if (!isTelegramGroupChatId(v.chatId)) {
    return 'provider.behavior.set.groupActivation.chatId must be a canonical negative Telegram group chat id within the 52-bit Bot API range';
  }
  if (v.value !== null && v.value !== TELEGRAM_GROUP_ACTIVATION_ALWAYS) {
    return `provider.behavior.set.groupActivation.value must be '${TELEGRAM_GROUP_ACTIVATION_ALWAYS}' or null`;
  }
  return null;
}

function validateProviderBehaviorSet(p: Record<string, unknown>): string | null {
  if (!isNonEmptyString(p.requestId)) {
    return 'provider.behavior.set.requestId must be a non-empty string';
  }
  const selectorError = validateProviderBehaviorSelector(p, 'provider.behavior.set');
  if (selectorError) return selectorError;

  const emojiError = validateOptionalNullableEnum(
    p.emojiReactions,
    TELEGRAM_EMOJI_REACTIONS,
    'provider.behavior.set.emojiReactions',
  );
  if (emojiError) return emojiError;
  const dmError = validateOptionalNullableEnum(
    p.replyQuoteDm,
    TELEGRAM_REPLY_QUOTE_DM,
    'provider.behavior.set.replyQuoteDm',
  );
  if (dmError) return dmError;
  const groupQuoteError = validateOptionalNullableEnum(
    p.replyQuoteGroup,
    TELEGRAM_REPLY_QUOTE_GROUP,
    'provider.behavior.set.replyQuoteGroup',
  );
  if (groupQuoteError) return groupQuoteError;

  let hasGroupActivationPatch = false;
  if (p.groupActivation !== undefined) {
    const patchError = validateGroupActivationPatch(p.groupActivation);
    if (patchError) return patchError;
    hasGroupActivationPatch = true;
  }

  // 至少一个实际 patch: 空 set 没有可观察反馈, 直接拒收比静默 no-op 更安全
  const hasBehaviorPatch =
    p.emojiReactions !== undefined ||
    p.replyQuoteDm !== undefined ||
    p.replyQuoteGroup !== undefined;
  if (!hasBehaviorPatch && !hasGroupActivationPatch) {
    return 'provider.behavior.set must include at least one behavior field or a groupActivation patch';
  }
  return null;
}

function validateProviderBehaviorState(p: Record<string, unknown>): string | null {
  const selectorError = validateProviderBehaviorSelector(p, 'provider.behavior.state');
  if (selectorError) return selectorError;
  if (!isNullableNonEmptyString(p.replyTo)) {
    return 'provider.behavior.state.replyTo must be a non-empty string or null';
  }
  if (typeof p.bound !== 'boolean') return 'provider.behavior.state.bound must be a boolean';

  if (!TELEGRAM_EMOJI_REACTIONS.includes(p.emojiReactions as never)) {
    return `provider.behavior.state.emojiReactions must be one of: ${TELEGRAM_EMOJI_REACTIONS.join(', ')}`;
  }
  if (!TELEGRAM_REPLY_QUOTE_DM.includes(p.replyQuoteDm as never)) {
    return `provider.behavior.state.replyQuoteDm must be one of: ${TELEGRAM_REPLY_QUOTE_DM.join(', ')}`;
  }
  if (!TELEGRAM_REPLY_QUOTE_GROUP.includes(p.replyQuoteGroup as never)) {
    return `provider.behavior.state.replyQuoteGroup must be one of: ${TELEGRAM_REPLY_QUOTE_GROUP.join(', ')}`;
  }

  if (!isPlainObject(p.groupActivation)) {
    return 'provider.behavior.state.groupActivation must be an object';
  }
  let hasGroupActivation = false;
  // Do not use Object.entries/Object.keys here: a valid state may contain a
  // large accumulated map, and materializing a second tuple/key array can
  // roughly double peak memory after JSON.parse. The frame-size guard remains
  // the cardinality bound; this pass adds only constant memory.
  for (const chatId in p.groupActivation) {
    if (!Object.prototype.hasOwnProperty.call(p.groupActivation, chatId)) continue;
    hasGroupActivation = true;
    const value = p.groupActivation[chatId];
    if (!isTelegramGroupChatId(chatId)) {
      return 'provider.behavior.state.groupActivation key must be a canonical negative Telegram group chat id within the 52-bit Bot API range';
    }
    if (value !== TELEGRAM_GROUP_ACTIVATION_ALWAYS) {
      return `provider.behavior.state.groupActivation[${chatId}] must be '${TELEGRAM_GROUP_ACTIVATION_ALWAYS}'`;
    }
  }

  // 字段联动(parse 强制): 未绑定没有主体持有 per-chat 覆盖, 必须收敛为默认快照
  if (!p.bound) {
    if (
      p.emojiReactions !== DEFAULT_TELEGRAM_BEHAVIOR.emojiReactions ||
      p.replyQuoteDm !== DEFAULT_TELEGRAM_BEHAVIOR.replyQuoteDm ||
      p.replyQuoteGroup !== DEFAULT_TELEGRAM_BEHAVIOR.replyQuoteGroup
    ) {
      return 'provider.behavior.state must report the default behavior when bound is false';
    }
    if (hasGroupActivation) {
      return 'provider.behavior.state.groupActivation must be empty when bound is false';
    }
  }
  return null;
}

// ── 阶段 14: 群消息中继 ──────────────────────────────────────────────────────

const GROUP_MESSAGE_TEXT_MAX = 8_192;
const GROUP_MESSAGE_FILE_NAMES_MAX = 20;
const GROUP_MESSAGE_FILE_NAME_CHARS_MAX = 256;
/**
 * author.id / author.username 按 Telegram 当前实际契约收紧(见 types.ts
 * GroupMessageAuthor 的文档注释): id 是 Telegram 数字 user id 的规范十进制
 * 正整数字符串(无前导零,在 Bot API 52-bit 范围内), username 是 Telegram @handle(仅
 * [A-Za-z0-9_], 1~32 位)。
 */
const GROUP_MESSAGE_AUTHOR_ID_PATTERN = /^[1-9][0-9]*$/;
const GROUP_MESSAGE_AUTHOR_USERNAME_PATTERN = /^[A-Za-z0-9_]{1,32}$/;

function isGroupMessageAuthorId(v: unknown): v is string {
  return (
    typeof v === 'string' && GROUP_MESSAGE_AUTHOR_ID_PATTERN.test(v) && BigInt(v) <= TELEGRAM_ID_MAX
  );
}

function isGroupMessageAuthorUsername(v: unknown): v is string {
  return typeof v === 'string' && GROUP_MESSAGE_AUTHOR_USERNAME_PATTERN.test(v);
}

function validateGroupMessage(p: Record<string, unknown>): string | null {
  if (!isNonEmptyString(p.provider)) return 'group.message.provider must be a non-empty string';
  if (p.recipient !== undefined) {
    if (!isPlainObject(p.recipient)) {
      return 'group.message.recipient must be an object when present';
    }
    if (!isNonEmptyString(p.recipient.bindingId)) {
      return 'group.message.recipient.bindingId must be a non-empty string';
    }
    if (!isNonEmptyString(p.recipient.principalId)) {
      return 'group.message.recipient.principalId must be a non-empty string';
    }
  }
  if (!isNonEmptyString(p.chatId)) return 'group.message.chatId must be a non-empty string';
  if (!isNullableNonEmptyString(p.threadId)) {
    return 'group.message.threadId must be a non-empty string or null';
  }
  if (!isNonEmptyString(p.messageId)) return 'group.message.messageId must be a non-empty string';
  if (!isNullableNonEmptyString(p.chatName)) {
    return 'group.message.chatName must be a non-empty string or null';
  }
  if (!isPlainObject(p.author) || !isNonEmptyString(p.author.name)) {
    return 'group.message.author.name must be a non-empty string';
  }
  if (p.author.isBot !== undefined && typeof p.author.isBot !== 'boolean') {
    return 'group.message.author.isBot must be a boolean';
  }
  // id / username 可选(旧生产端不发时省略), present 时按 Telegram 契约校验
  if (p.author.id !== undefined && !isGroupMessageAuthorId(p.author.id)) {
    return 'group.message.author.id must be a canonical positive Telegram user id within the 52-bit Bot API range';
  }
  if (p.author.username !== undefined && !isGroupMessageAuthorUsername(p.author.username)) {
    return 'group.message.author.username must match [A-Za-z0-9_]{1,32}';
  }
  if (typeof p.text !== 'string' || p.text.length > GROUP_MESSAGE_TEXT_MAX) {
    return `group.message.text must be a string of at most ${GROUP_MESSAGE_TEXT_MAX} chars`;
  }
  if (p.fileNames !== undefined) {
    if (
      !isStringArray(p.fileNames) ||
      p.fileNames.length > GROUP_MESSAGE_FILE_NAMES_MAX ||
      p.fileNames.some((name) => name.length > GROUP_MESSAGE_FILE_NAME_CHARS_MAX)
    ) {
      return `group.message.fileNames must be at most ${GROUP_MESSAGE_FILE_NAMES_MAX} non-empty strings of at most ${GROUP_MESSAGE_FILE_NAME_CHARS_MAX} chars`;
    }
  }
  if (
    p.text.length === 0 &&
    (p.fileNames === undefined || (p.fileNames as string[]).length === 0)
  ) {
    return 'group.message must carry text or fileNames';
  }
  if (!isPositiveTimestamp(p.sentAt)) {
    return 'group.message.sentAt must be a positive unix-ms timestamp';
  }
  return null;
}

const PAYLOAD_VALIDATORS: Record<HookMessageType, (p: Record<string, unknown>) => string | null> = {
  hello: validateHello,
  welcome: validateWelcome,
  ping: (p) => validateEmpty(p, 'ping'),
  pong: (p) => validateEmpty(p, 'pong'),
  'task.dispatch': validateDispatch,
  'task.ack': validateAck,
  'turn.end': validateTurnEnd,
  'turn.delivery': validateTurnDelivery,
  'turn.progress': validateTurnProgress,
  'turn.reopen': validateTurnReopen,
  'msg.op': validateMessageOp,
  'msg.op.result': validateMessageOpResult,
  'bind.start': validateBindStart,
  'bind.update': validateBindUpdate,
  'bind.revoke': validateBindRevoke,
  'bind.state': validateBindState,
  'provider.bind.start': validateProviderBindStart,
  'provider.bind.cancel': validateProviderBindCancel,
  'provider.bind.revoke': validateProviderBindRevoke,
  'provider.bind.update': (p) => validateProviderBindStatus(p, 'provider.bind.update'),
  'provider.bind.state': (p) => validateProviderBindStatus(p, 'provider.bind.state'),
  'query.request': validateQueryRequest,
  'query.response': validateQueryResponse,
  'task.cancel': validateTaskCancel,
  'session.archive': validateSessionArchive,
  'interaction.request': validateInteractionRequest,
  'interaction.decision': validateInteractionDecision,
  'interaction.cancel': validateInteractionCancel,
  'prefs.get': validatePrefsGet,
  'prefs.set': validatePrefsSet,
  'prefs.state': validatePrefsState,
  'provider.prefs.get': validateProviderPrefsGet,
  'provider.prefs.set': validateProviderPrefsSet,
  'provider.prefs.state': validateProviderPrefsState,
  'tool.request': validateToolRequest,
  'tool.response': validateToolResponse,
  'group.message': validateGroupMessage,
  'lifecycle.preference': validateLifecyclePreference,
  'provider.behavior.get': validateProviderBehaviorGet,
  'provider.behavior.set': validateProviderBehaviorSet,
  'provider.behavior.state': validateProviderBehaviorState,
};

/**
 * 解析并校验一帧协议消息。
 * 接受 WS 原始文本帧(string)或已 JSON.parse 的对象(unknown); 通过后返回
 * 判别联合 HookMessage, 调用方按 `message.type` 分发即可获得完整类型收窄。
 */
export function parseHookMessage(raw: unknown): HookParseResult {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length > HOOK_MAX_FRAME_CHARS) {
      return fail(`frame too large: ${raw.length} > ${HOOK_MAX_FRAME_CHARS} chars`);
    }
    try {
      data = JSON.parse(raw);
    } catch {
      return fail('frame is not valid JSON');
    }
  }

  if (!isPlainObject(data)) return fail('envelope must be an object');
  if (data.v !== HOOK_PROTOCOL_VERSION) {
    return fail(
      `unsupported protocol version: ${String(data.v)} (expected ${HOOK_PROTOCOL_VERSION})`,
    );
  }
  if (!HOOK_MESSAGE_TYPES.includes(data.type as never)) {
    return fail(`unknown message type: ${String(data.type)}`);
  }
  if (!isNonEmptyString(data.id)) return fail('envelope.id must be a non-empty string');
  if (typeof data.ts !== 'number' || !Number.isFinite(data.ts)) {
    return fail('envelope.ts must be a finite number');
  }
  if (!isPlainObject(data.payload)) return fail('envelope.payload must be an object');

  const type = data.type as HookMessageType;
  const validator = Object.hasOwn(PAYLOAD_VALIDATORS, type) ? PAYLOAD_VALIDATORS[type] : undefined;
  if (!validator) return fail(`no validator for type: ${type}`);
  const payloadError = validator(data.payload);
  if (payloadError) return fail(payloadError);

  return { ok: true, message: data as unknown as HookMessage };
}

/** 类型收窄辅助: 判断字符串是否为 v1 已知消息类型。 */
export function isHookMessageType(v: string): v is HookMessageType {
  return HOOK_MESSAGE_TYPES.includes(v as never);
}

// 类型层自检: payload 校验器覆盖的字段与类型定义保持同步时, 这两个别名不会报错
type _AssertDispatchShape = keyof TaskDispatchPayload;
type _AssertTurnEndShape = keyof TurnEndPayload;
