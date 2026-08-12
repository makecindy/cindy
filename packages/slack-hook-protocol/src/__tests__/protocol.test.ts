/**
 * slack-hook-protocol 协议包测试:
 *   1. 每种消息 构造 -> 序列化 -> 解析 的 round-trip 等价
 *   2. 信封层坏帧拒收(版本 / 类型 / id / ts / payload / 非 JSON / 超长帧)
 *   3. 各 payload 的字段联动约束(dispatch 二选一、ack 三态联动、turn.end 状态联动)
 */

import { describe, it, expect } from 'vitest';

import {
  HOOK_MAX_FRAME_CHARS,
  HOOK_FEATURE_TURN_DELIVERY,
  HOOK_PROTOCOL_VERSION,
  isHookMessageType,
  makeHello,
  makeLifecyclePreference,
  makePing,
  makePong,
  makeSessionArchive,
  makeTaskAck,
  makeTaskDispatch,
  makeTurnEnd,
  makeTurnDelivery,
  makeWelcome,
  parseHookMessage,
  serializeHookMessage,
  type HookMessage,
  type TaskAckPayload,
  type TurnEndPayload,
  type TurnDeliveryPayload,
} from '../index';

/** 构造 -> 序列化 -> 解析, 断言等价并返回解析结果(供进一步断言)。 */
function roundTrip(message: HookMessage): HookMessage {
  const parsed = parseHookMessage(serializeHookMessage(message));
  expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
  if (!parsed.ok) throw new Error('unreachable');
  expect(parsed.message).toEqual(message);
  return parsed.message;
}

/** 基于合法消息改坏某些字段, 断言解析失败且错误信息含关键词。 */
function expectReject(mutated: unknown, keyword: string): void {
  const parsed = parseHookMessage(mutated);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) throw new Error('unreachable');
  expect(parsed.error).toContain(keyword);
}

const VALID_ACK_ACCEPTED: TaskAckPayload = {
  requestId: 'req-1',
  result: 'accepted',
  reason: null,
  sessionId: 'sess-1',
  queuePosition: null,
};

const VALID_TURN_END_OK: TurnEndPayload = {
  requestId: 'req-1',
  externalKey: 'team-slack:C123:1720000.123',
  sessionId: 'sess-1',
  status: 'ok',
  finalText: '完成了',
  errorMessage: null,
  usage: { durationMs: 4500 },
};

const VALID_TURN_DELIVERY_ACCEPTED: TurnDeliveryPayload = {
  requestId: 'req-1',
  state: 'accepted',
  attempt: 0,
  retryAt: null,
  error: null,
};

describe('round-trip: 每种消息构造后可被解析且等价', () => {
  it('hello', () => {
    const msg = roundTrip(
      makeHello({
        deviceId: 'dev-abc',
        deviceName: 'Cindy',
        workspaces: ['cindy', 'blog'],
        agents: ['cc', 'codex'],
        lifecycleAnnouncement: false,
      }),
    );
    if (msg.type !== 'hello') throw new Error('unreachable');
    // protocolVersion 由包内固定, 不由调用方传
    expect(msg.payload.protocolVersion).toBe(HOOK_PROTOCOL_VERSION);
    expect(msg.v).toBe(HOOK_PROTOCOL_VERSION);
    expect(msg.id.length).toBeGreaterThan(0);
    expect(msg.payload.lifecycleAnnouncement).toBe(false);
  });

  it('lifecycle.preference', () => {
    roundTrip(makeLifecyclePreference({ enabled: true }));
    expectReject(
      { ...makeLifecyclePreference({ enabled: true }), payload: { enabled: 'yes' } },
      'lifecycle.preference.enabled',
    );
  });

  it('welcome / ping / pong', () => {
    roundTrip(makeWelcome({ serverName: 'my-hooks', features: [] }));
    roundTrip(makePing());
    roundTrip(makePong());
  });

  it('turn.delivery accepted / retrying / delivered / failed', () => {
    expect(HOOK_FEATURE_TURN_DELIVERY).toBe('turn-delivery-v1');
    roundTrip(makeTurnDelivery(VALID_TURN_DELIVERY_ACCEPTED));
    roundTrip(
      makeTurnDelivery({
        requestId: 'req-1',
        state: 'retrying',
        attempt: 1,
        retryAt: 1_800_000_000_000,
        error: {
          code: 'X_RATE_LIMITED',
          message: 'X 暂时限制了回复发布，服务端会自动重试。',
          retryable: true,
        },
      }),
    );
    roundTrip(
      makeTurnDelivery({
        requestId: 'req-1',
        state: 'delivered',
        attempt: 2,
        retryAt: null,
        error: null,
      }),
    );
    roundTrip(
      makeTurnDelivery({
        requestId: 'req-1',
        state: 'failed',
        attempt: 2,
        retryAt: null,
        error: {
          code: 'X_FORBIDDEN',
          message: 'X 拒绝了回复发布。',
          retryable: false,
        },
      }),
    );
  });

  it('task.dispatch 普通派发(workspace 路径)', () => {
    const msg = roundTrip(
      makeTaskDispatch({
        requestId: 'req-1',
        externalKey: 'team-slack:C123:1720000.123',
        workspace: 'cindy',
        prompt: '看下 CI 为什么挂了',
      }),
    );
    if (msg.type !== 'task.dispatch') throw new Error('unreachable');
    // 构造器给出显式默认: sessionId null
    expect(msg.payload.sessionId).toBeNull();
  });

  it('task.dispatch 带图片附件(attachments)', () => {
    const msg = roundTrip(
      makeTaskDispatch({
        requestId: 'req-img',
        externalKey: 'team-slack:C1:1.1',
        workspace: 'cindy',
        prompt: '看看这张图',
        attachments: [
          { name: 'shot.png', mimeType: 'image/png', dataBase64: 'aGVsbG8=' },
          { name: null, mimeType: 'image/jpeg', dataBase64: 'd29ybGQ=' },
        ],
      }),
    );
    if (msg.type !== 'task.dispatch') throw new Error('unreachable');
    expect(msg.payload.attachments).toHaveLength(2);
    expect(msg.payload.attachments?.[1].name).toBeNull();
  });

  it('task.dispatch 带来源元数据(source: im + threadContext + userText)', () => {
    const msg = roundTrip(
      makeTaskDispatch({
        requestId: 'req-src',
        externalKey: 'team-slack:C1:1.1',
        workspace: 'cindy',
        prompt: '<thread_context>...</thread_context>\n\n看看有没有优化空间',
        source: {
          im: 'slack',
          userText: '看看有没有优化空间',
          threadContext: [
            { author: '张三', text: 'auth 是不是有改动' },
            { author: 'Tina(bot)', text: '已检查', isBot: true },
          ],
        },
      }),
    );
    if (msg.type !== 'task.dispatch') throw new Error('unreachable');
    expect(msg.payload.source?.im).toBe('slack');
    expect(msg.payload.source?.userText).toBe('看看有没有优化空间');
    expect(msg.payload.source?.threadContext).toHaveLength(2);
    // 负例: im 空串 / threadContext 条目缺 text / userText 非 string
    const base = makeTaskDispatch({
      requestId: 'r',
      externalKey: 'k',
      workspace: 'w',
      prompt: 'p',
    });
    expectReject(
      { ...base, payload: { ...base.payload, source: { im: '' } } },
      'task.dispatch.source.im',
    );
    expectReject(
      {
        ...base,
        payload: { ...base.payload, source: { im: 'slack', threadContext: [{ author: 'a' }] } },
      },
      'threadContext[0].text',
    );
    expectReject(
      { ...base, payload: { ...base.payload, source: { im: 'slack', userText: 42 } } },
      'task.dispatch.source.userText',
    );
  });

  it('task.dispatch 接管派发(sessionId 路径, workspace 可为 null)', () => {
    roundTrip(
      makeTaskDispatch({
        requestId: 'req-2',
        externalKey: 'team-slack:C123:1720001.456',
        sessionId: 'sess-42',
        prompt: '继续',
        options: { model: null, permissionMode: 'acceptEdits', agentKind: null },
      }),
    );
  });

  it('task.ack 三态', () => {
    roundTrip(makeTaskAck(VALID_ACK_ACCEPTED));
    roundTrip(
      makeTaskAck({
        requestId: 'req-1',
        result: 'queued',
        reason: null,
        sessionId: 'sess-1',
        queuePosition: 2,
      }),
    );
    roundTrip(
      makeTaskAck({
        requestId: 'req-1',
        result: 'rejected',
        reason: 'unknown_workspace',
        sessionId: null,
        queuePosition: null,
      }),
    );
  });

  it('session.archive', () => {
    const msg = roundTrip(makeSessionArchive({ externalKey: 'slack:dm:U123:g2' }));
    if (msg.type !== 'session.archive') throw new Error('unreachable');
    expect(msg.payload.externalKey).toBe('slack:dm:U123:g2');
    // externalKey 必须非空
    expectReject({ ...msg, payload: { externalKey: '' } }, 'session.archive.externalKey');
  });

  it('turn.end ok / error', () => {
    roundTrip(makeTurnEnd(VALID_TURN_END_OK));
    roundTrip(
      makeTurnEnd({
        ...VALID_TURN_END_OK,
        status: 'error',
        finalText: '',
        errorMessage: 'agent runtime error',
        usage: { durationMs: null },
      }),
    );
  });
});

describe('信封层坏帧拒收', () => {
  const base = makePing();

  it('非 JSON 文本', () => {
    expectReject('not-json{', 'not valid JSON');
  });

  it('超长帧', () => {
    expectReject('"' + 'x'.repeat(HOOK_MAX_FRAME_CHARS + 1) + '"', 'frame too large');
  });

  it('非对象 / 数组', () => {
    expectReject('42', 'envelope must be an object');
    expectReject([], 'envelope must be an object');
    expectReject(null, 'envelope must be an object');
  });

  it('版本不符', () => {
    expectReject({ ...base, v: 2 }, 'unsupported protocol version');
    expectReject({ ...base, v: undefined }, 'unsupported protocol version');
  });

  it('未知消息类型', () => {
    // task.cancel 已在 v2 转正, 换一个仍未定义的类型验证拒收
    expectReject({ ...base, type: 'task.pause' }, 'unknown message type');
  });

  it('id / ts / payload 非法', () => {
    expectReject({ ...base, id: '' }, 'envelope.id');
    expectReject({ ...base, ts: 'now' }, 'envelope.ts');
    expectReject({ ...base, ts: Number.NaN }, 'envelope.ts');
    expectReject({ ...base, payload: null }, 'envelope.payload');
  });

  it('ping payload 必须为空对象', () => {
    expectReject({ ...base, payload: { extra: 1 } }, 'empty object');
  });
});

describe('task.dispatch 字段约束', () => {
  const valid = makeTaskDispatch({
    requestId: 'req-1',
    externalKey: 'k',
    workspace: 'cindy',
    prompt: 'p',
  });

  it('sessionId 为 null 时 workspace 必填', () => {
    expectReject(
      { ...valid, payload: { ...valid.payload, workspace: null } },
      'workspace is required when sessionId is null',
    );
  });

  it('sessionId 给了空串拒收', () => {
    expectReject({ ...valid, payload: { ...valid.payload, sessionId: '' } }, 'sessionId');
  });

  it('prompt / requestId / externalKey 必须非空', () => {
    expectReject({ ...valid, payload: { ...valid.payload, prompt: '' } }, 'prompt');
    expectReject({ ...valid, payload: { ...valid.payload, requestId: '' } }, 'requestId');
    expectReject({ ...valid, payload: { ...valid.payload, externalKey: '' } }, 'externalKey');
  });

  it('options 字段类型', () => {
    expectReject(
      { ...valid, payload: { ...valid.payload, options: { model: 42 } } },
      'options.model',
    );
    expectReject({ ...valid, payload: { ...valid.payload, options: 'x' } }, 'options');
  });

  it('attachments 校验: 非数组 / 元素缺字段 / 超上限', () => {
    expectReject({ ...valid, payload: { ...valid.payload, attachments: 'x' } }, 'attachments');
    expectReject(
      {
        ...valid,
        payload: { ...valid.payload, attachments: [{ name: 'a', mimeType: '', dataBase64: 'x' }] },
      },
      'mimeType',
    );
    expectReject(
      {
        ...valid,
        payload: {
          ...valid.payload,
          attachments: [{ name: 'a', mimeType: 'image/png', dataBase64: '' }],
        },
      },
      'dataBase64',
    );
    expectReject(
      {
        ...valid,
        payload: {
          ...valid.payload,
          attachments: [{ name: 1, mimeType: 'image/png', dataBase64: 'x' }],
        },
      },
      'name',
    );
    const tooMany = Array.from({ length: 17 }, () => ({
      name: null,
      mimeType: 'image/png',
      dataBase64: 'x',
    }));
    expectReject({ ...valid, payload: { ...valid.payload, attachments: tooMany } }, 'at most');
  });
});

describe('task.ack 三态联动约束', () => {
  const valid = makeTaskAck(VALID_ACK_ACCEPTED);

  it('非 rejected 不许带 reason', () => {
    expectReject(
      { ...valid, payload: { ...valid.payload, reason: 'invalid' } },
      'reason must be null unless rejected',
    );
  });

  it('rejected 必须带枚举内 reason 且 sessionId 为 null', () => {
    expectReject(
      {
        ...valid,
        payload: { ...valid.payload, result: 'rejected', reason: null, sessionId: null },
      },
      'reason must be one of',
    );
    expectReject(
      {
        ...valid,
        payload: { ...valid.payload, result: 'rejected', reason: 'nope', sessionId: null },
      },
      'reason must be one of',
    );
    expectReject(
      {
        ...valid,
        payload: { ...valid.payload, result: 'rejected', reason: 'disabled', sessionId: 'sess-1' },
      },
      'sessionId must be null when rejected',
    );
  });

  it('accepted / queued 必须带 sessionId', () => {
    expectReject(
      { ...valid, payload: { ...valid.payload, sessionId: null } },
      'sessionId must be a non-empty string',
    );
  });

  it('queuePosition 仅 queued 时非 null, 且为非负整数', () => {
    expectReject(
      { ...valid, payload: { ...valid.payload, queuePosition: 1 } },
      'queuePosition must be null unless queued',
    );
    expectReject(
      { ...valid, payload: { ...valid.payload, result: 'queued', queuePosition: null } },
      'queuePosition must be a non-negative integer',
    );
    expectReject(
      { ...valid, payload: { ...valid.payload, result: 'queued', queuePosition: -1 } },
      'queuePosition must be a non-negative integer',
    );
    expectReject(
      { ...valid, payload: { ...valid.payload, result: 'queued', queuePosition: 1.5 } },
      'queuePosition must be a non-negative integer',
    );
  });
});

describe('turn.end 状态联动约束', () => {
  const valid = makeTurnEnd(VALID_TURN_END_OK);

  it('ok 时 errorMessage 必须为 null', () => {
    expectReject(
      { ...valid, payload: { ...valid.payload, errorMessage: 'boom' } },
      'errorMessage must be null when status is ok',
    );
  });

  it('error 时 errorMessage 必须非空', () => {
    expectReject(
      { ...valid, payload: { ...valid.payload, status: 'error', errorMessage: null } },
      'errorMessage must be a non-empty string',
    );
    expectReject(
      { ...valid, payload: { ...valid.payload, status: 'error', errorMessage: '' } },
      'errorMessage must be a non-empty string',
    );
  });

  it('finalText 允许空串但必须是 string', () => {
    const ok = parseHookMessage({ ...valid, payload: { ...valid.payload, finalText: '' } });
    expect(ok.ok).toBe(true);
    expectReject({ ...valid, payload: { ...valid.payload, finalText: null } }, 'finalText');
  });

  it('usage.durationMs 非负有限数或 null', () => {
    expectReject(
      { ...valid, payload: { ...valid.payload, usage: { durationMs: -1 } } },
      'durationMs',
    );
    expectReject(
      { ...valid, payload: { ...valid.payload, usage: { durationMs: Number.POSITIVE_INFINITY } } },
      'durationMs',
    );
    expectReject({ ...valid, payload: { ...valid.payload, usage: null } }, 'usage');
  });
});

describe('turn.delivery 状态联动约束', () => {
  const valid = makeTurnDelivery(VALID_TURN_DELIVERY_ACCEPTED);

  const validRetrying = {
    ...valid,
    payload: {
      ...valid.payload,
      state: 'retrying' as const,
      attempt: 1,
      retryAt: 1_800_000_000_000,
      error: { code: 'X', message: 'x', retryable: true },
    },
  };

  it('accepted / delivered 不带 error 或 retryAt', () => {
    expectReject(
      {
        ...valid,
        payload: { ...valid.payload, error: { code: 'X', message: 'x', retryable: false } },
      },
      'error must be null',
    );
    expectReject(
      { ...valid, payload: { ...valid.payload, retryAt: 1_800_000_000_000 } },
      'retryAt',
    );
  });

  it('retrying 必须带可重试错误和 retryAt', () => {
    expectReject(
      { ...valid, payload: { ...valid.payload, state: 'retrying', attempt: 1 } },
      'retryAt',
    );
    expectReject(
      {
        ...valid,
        payload: {
          ...valid.payload,
          state: 'retrying',
          attempt: 1,
          retryAt: 1_800_000_000_000,
          error: { code: 'X', message: 'x', retryable: false },
        },
      },
      'retryable must be true',
    );
  });

  it('attempt 必须与状态联动', () => {
    expectReject(
      { ...valid, payload: { ...valid.payload, attempt: 1 } },
      'attempt must be 0 when state is accepted',
    );
    expectReject(
      { ...validRetrying, payload: { ...validRetrying.payload, attempt: 0 } },
      'attempt must be at least 1 when state is retrying',
    );
    expectReject(
      {
        ...valid,
        payload: { ...valid.payload, state: 'delivered', attempt: 0 },
      },
      'attempt must be at least 1 when state is delivered',
    );
    expectReject(
      {
        ...valid,
        payload: {
          ...valid.payload,
          state: 'failed',
          attempt: 0,
          error: { code: 'X', message: 'x', retryable: false },
        },
      },
      'attempt must be at least 1 when state is failed',
    );
    expectReject(
      { ...valid, payload: { ...valid.payload, attempt: Number.MAX_SAFE_INTEGER + 1 } },
      'safe integer',
    );
  });

  it('retryAt 必须是 retrying 状态的正安全整数', () => {
    for (const retryAt of [1.5, Number.MAX_SAFE_INTEGER + 1, 0, -1]) {
      expectReject(
        { ...validRetrying, payload: { ...validRetrying.payload, retryAt } },
        'positive safe integer',
      );
    }
  });

  it('failed 必须带不可重试的结构化错误', () => {
    expectReject(
      { ...valid, payload: { ...valid.payload, state: 'failed', attempt: 1 } },
      'error must be an object',
    );
    expectReject({ ...valid, payload: { ...valid.payload, attempt: 1.5 } }, 'attempt');
    expectReject(
      {
        ...valid,
        payload: {
          ...valid.payload,
          state: 'failed',
          attempt: 1,
          error: { code: 'X', message: 'x', retryable: true },
        },
      },
      'retryable must be false',
    );
  });

  it('error 只允许安全结构化字段', () => {
    expectReject(
      {
        ...validRetrying,
        payload: {
          ...validRetrying.payload,
          error: { ...validRetrying.payload.error, providerResponse: 'secret' },
        },
      },
      'providerResponse is not allowed',
    );
  });
});

describe('辅助函数', () => {
  it('isHookMessageType', () => {
    expect(isHookMessageType('task.dispatch')).toBe(true);
    expect(isHookMessageType('task.cancel')).toBe(true); // v2 转正
    expect(isHookMessageType('turn.delivery')).toBe(true);
    expect(isHookMessageType('task.pause')).toBe(false);
  });
});
