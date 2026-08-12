/**
 * slack-hook-protocol/build.ts
 * ---------------------------------------------------------------------------
 * 协议帧构造器: 两端发帧的唯一出口。信封字段(v / id / ts)在这里统一生成,
 * 业务代码只提供 payload —— 保证发出的每一帧都合法且版本一致。
 *
 * 构造器只做形状组装, 不做业务校验(如 ack 的 reason/result 联动由类型签名
 * 约束 + 对端 parse 兜底); serialize 前如需自检可回喂 parseHookMessage。
 */

import { randomUUID } from 'node:crypto';

import {
  HOOK_PROTOCOL_VERSION,
  type BindRevokePayload,
  type BindStartPayload,
  type BindStatePayload,
  type BindUpdatePayload,
  type HelloPayload,
  type HookBindRevokeMessage,
  type HookBindStartMessage,
  type HookBindStateMessage,
  type HookBindUpdateMessage,
  type HookEnvelope,
  type HookHelloMessage,
  type HookInteractionCancelMessage,
  type HookInteractionDecisionMessage,
  type HookInteractionRequestMessage,
  type HookLifecyclePreferenceMessage,
  type HookMessage,
  type HookMessageType,
  type HookPingMessage,
  type HookPongMessage,
  type HookPrefsGetMessage,
  type HookPrefsSetMessage,
  type HookPrefsStateMessage,
  type HookProviderBindCancelMessage,
  type HookProviderBindRevokeMessage,
  type HookProviderBindStartMessage,
  type HookProviderBindStateMessage,
  type HookProviderBindUpdateMessage,
  type GroupMessagePayload,
  type HookGroupMessageMessage,
  type HookProviderBehaviorGetMessage,
  type HookProviderBehaviorSetMessage,
  type HookProviderBehaviorStateMessage,
  type HookProviderPrefsGetMessage,
  type HookProviderPrefsSetMessage,
  type HookProviderPrefsStateMessage,
  type HookQueryRequestMessage,
  type HookQueryResponseMessage,
  type HookSessionArchiveMessage,
  type HookTaskAckMessage,
  type HookTaskCancelMessage,
  type HookTaskDispatchMessage,
  type HookToolRequestMessage,
  type HookToolResponseMessage,
  type HookTurnEndMessage,
  type HookTurnDeliveryMessage,
  type HookTurnProgressMessage,
  type HookTurnReopenMessage,
  type HookWelcomeMessage,
  type InteractionCancelPayload,
  type InteractionDecisionPayload,
  type InteractionRequestPayload,
  type LifecyclePreferencePayload,
  type PrefsGetPayload,
  type PrefsSetPayload,
  type PrefsStatePayload,
  type ProviderBehaviorGetPayload,
  type ProviderBehaviorSetPayload,
  type ProviderBehaviorStatePayload,
  type ProviderBindCancelPayload,
  type ProviderBindRevokePayload,
  type ProviderBindStartPayload,
  type ProviderBindStatePayload,
  type ProviderBindUpdatePayload,
  type ProviderPrefsGetPayload,
  type ProviderPrefsSetPayload,
  type ProviderPrefsStatePayload,
  type QueryRequestPayload,
  type QueryResponsePayload,
  type SessionArchivePayload,
  type TaskAckPayload,
  type TaskCancelPayload,
  type TaskDispatchPayload,
  type ToolRequestPayload,
  type ToolResponsePayload,
  type TurnEndPayload,
  type TurnDeliveryPayload,
  type TurnProgressPayload,
  type MessageOpPayload,
  type MessageOpResultPayload,
  type HookMessageOpMessage,
  type HookMessageOpResultMessage,
  type TurnReopenPayload,
  type WelcomePayload,
} from './types';

/** 组装信封: 版本固定为当前版本, id 随机, ts 取发送方时钟。 */
function envelope<TType extends HookMessageType, TPayload>(
  type: TType,
  payload: TPayload,
): HookEnvelope<TType, TPayload> {
  return { v: HOOK_PROTOCOL_VERSION, type, id: randomUUID(), ts: Date.now(), payload };
}

/** hello 的入参: protocolVersion 由包内固定, 调用方只报身份与能力。 */
export type HelloInput = Omit<HelloPayload, 'protocolVersion'>;

export function makeHello(input: HelloInput): HookHelloMessage {
  return envelope('hello', { protocolVersion: HOOK_PROTOCOL_VERSION, ...input });
}

export function makeWelcome(payload: WelcomePayload): HookWelcomeMessage {
  return envelope('welcome', payload);
}

export function makePing(): HookPingMessage {
  return envelope('ping', {});
}

export function makePong(): HookPongMessage {
  return envelope('pong', {});
}

/**
 * dispatch 构造器: workspace / sessionId / options 给出显式默认,
 * 让"普通派发"调用点只需 requestId + externalKey + workspace + prompt。
 */
export function makeTaskDispatch(
  input: Pick<TaskDispatchPayload, 'requestId' | 'externalKey' | 'prompt'> &
    Partial<
      Pick<TaskDispatchPayload, 'workspace' | 'sessionId' | 'options' | 'attachments' | 'source'>
    >,
): HookTaskDispatchMessage {
  return envelope('task.dispatch', {
    workspace: null,
    sessionId: null,
    ...input,
  });
}

export function makeTaskAck(payload: TaskAckPayload): HookTaskAckMessage {
  return envelope('task.ack', payload);
}

export function makeTurnEnd(payload: TurnEndPayload): HookTurnEndMessage {
  return envelope('turn.end', payload);
}

export function makeTurnDelivery(payload: TurnDeliveryPayload): HookTurnDeliveryMessage {
  return envelope('turn.delivery', payload);
}

export function makeTurnProgress(payload: TurnProgressPayload): HookTurnProgressMessage {
  return envelope('turn.progress', payload);
}

/** msg.op: 内容面上收客户端后的消息操作动词(见 types.ts 阶段 20)。 */
export function makeMessageOp(payload: MessageOpPayload): HookMessageOpMessage {
  return envelope('msg.op', payload);
}

/** msg.op.result: 操作回执; messageId 是客户端后续 edit/delete/react 的唯一依据。 */
export function makeMessageOpResult(payload: MessageOpResultPayload): HookMessageOpResultMessage {
  return envelope('msg.op.result', payload);
}

/**
 * turn.reopen: 续跑轮认领渠道里那条已收口的消息(见 types.ts 文件头第 18 条)。
 * reason 给出显式默认 —— 当前只有"用户在桌面端续跑"这一种触发。
 *
 * 默认值在 spread **之后**兜: `Partial` 允许调用方把可选值显式写成 undefined
 * (如 `sessionId: maybeId` 而 maybeId 为 undefined), 那样 `...input` 会把默认值
 * 覆盖成 undefined、JSON 序列化再把这个键整个删掉, 收帧端按"必填字段缺失"拒收
 * 整帧 —— 续跑结果就再也回不到渠道那条消息上。两个字段都不接受 undefined 语义,
 * 用 `??` 收敛掉。
 */
export function makeTurnReopen(
  input: Pick<TurnReopenPayload, 'requestId' | 'reopenOf' | 'externalKey'> &
    Partial<Pick<TurnReopenPayload, 'sessionId' | 'reason'>>,
): HookTurnReopenMessage {
  return envelope('turn.reopen', {
    ...input,
    sessionId: input.sessionId ?? null,
    reason: input.reason ?? 'user-continued',
  });
}

export function makeBindStart(payload: BindStartPayload): HookBindStartMessage {
  return envelope('bind.start', payload);
}

export function makeBindUpdate(payload: BindUpdatePayload): HookBindUpdateMessage {
  return envelope('bind.update', payload);
}

/**
 * bind.revoke: 缺省空 payload = 解绑本设备全部(老语义); 传 { teamId } =
 * 只解绑该 workspace(multi-team, 仅 server 声明该能力后使用)。
 */
export function makeBindRevoke(payload: BindRevokePayload = {}): HookBindRevokeMessage {
  return envelope('bind.revoke', payload);
}

export function makeBindState(payload: BindStatePayload): HookBindStateMessage {
  return envelope('bind.state', payload);
}

export function makeProviderBindStart(
  payload: ProviderBindStartPayload,
): HookProviderBindStartMessage {
  return envelope('provider.bind.start', payload);
}

export function makeProviderBindCancel(
  payload: ProviderBindCancelPayload,
): HookProviderBindCancelMessage {
  return envelope('provider.bind.cancel', payload);
}

export function makeProviderBindRevoke(
  payload: ProviderBindRevokePayload,
): HookProviderBindRevokeMessage {
  return envelope('provider.bind.revoke', payload);
}

export function makeProviderBindUpdate(
  payload: ProviderBindUpdatePayload,
): HookProviderBindUpdateMessage {
  return envelope('provider.bind.update', payload);
}

export function makeProviderBindState(
  payload: ProviderBindStatePayload,
): HookProviderBindStateMessage {
  return envelope('provider.bind.state', payload);
}

export function makeQueryRequest(payload: QueryRequestPayload): HookQueryRequestMessage {
  return envelope('query.request', payload);
}

export function makeQueryResponse(payload: QueryResponsePayload): HookQueryResponseMessage {
  return envelope('query.response', payload);
}

export function makeTaskCancel(payload: TaskCancelPayload): HookTaskCancelMessage {
  return envelope('task.cancel', payload);
}

export function makeSessionArchive(payload: SessionArchivePayload): HookSessionArchiveMessage {
  return envelope('session.archive', payload);
}

export function makeInteractionRequest(
  payload: InteractionRequestPayload,
): HookInteractionRequestMessage {
  return envelope('interaction.request', payload);
}

export function makeInteractionDecision(
  payload: InteractionDecisionPayload,
): HookInteractionDecisionMessage {
  return envelope('interaction.decision', payload);
}

export function makeInteractionCancel(
  payload: InteractionCancelPayload,
): HookInteractionCancelMessage {
  return envelope('interaction.cancel', payload);
}

export function makePrefsGet(payload: PrefsGetPayload): HookPrefsGetMessage {
  return envelope('prefs.get', payload);
}

export function makePrefsSet(payload: PrefsSetPayload): HookPrefsSetMessage {
  return envelope('prefs.set', payload);
}

export function makePrefsState(payload: PrefsStatePayload): HookPrefsStateMessage {
  return envelope('prefs.state', payload);
}

export function makeProviderPrefsGet(
  payload: ProviderPrefsGetPayload,
): HookProviderPrefsGetMessage {
  return envelope('provider.prefs.get', payload);
}

export function makeProviderPrefsSet(
  payload: ProviderPrefsSetPayload,
): HookProviderPrefsSetMessage {
  return envelope('provider.prefs.set', payload);
}

export function makeProviderPrefsState(
  payload: ProviderPrefsStatePayload,
): HookProviderPrefsStateMessage {
  return envelope('provider.prefs.state', payload);
}

export function makeProviderBehaviorGet(
  payload: ProviderBehaviorGetPayload,
): HookProviderBehaviorGetMessage {
  return envelope('provider.behavior.get', payload);
}

export function makeProviderBehaviorSet(
  payload: ProviderBehaviorSetPayload,
): HookProviderBehaviorSetMessage {
  return envelope('provider.behavior.set', payload);
}

export function makeProviderBehaviorState(
  payload: ProviderBehaviorStatePayload,
): HookProviderBehaviorStateMessage {
  return envelope('provider.behavior.state', payload);
}

export function makeToolRequest(payload: ToolRequestPayload): HookToolRequestMessage {
  return envelope('tool.request', payload);
}

export function makeToolResponse(payload: ToolResponsePayload): HookToolResponseMessage {
  return envelope('tool.response', payload);
}

export function makeGroupMessage(payload: GroupMessagePayload): HookGroupMessageMessage {
  return envelope('group.message', payload);
}

export function makeLifecyclePreference(
  payload: LifecyclePreferencePayload,
): HookLifecyclePreferenceMessage {
  return envelope('lifecycle.preference', payload);
}

/** 序列化为 WS 文本帧。与 parseHookMessage 互为逆操作。 */
export function serializeHookMessage(message: HookMessage): string {
  return JSON.stringify(message);
}
