/**
 * slack-hook-protocol v2 增量帧测试:
 *   1. 新帧(bind.* / query.* / task.cancel)构造 -> 序列化 -> 解析 round-trip
 *   2. bind.update / query.response 的字段联动约束
 *   3. dispatch options.effort 与 turn.end cancelled 的扩展行为
 *   4. 老帧回归: v1 帧的解析行为不因扩展而变化(见 protocol.test.ts, 此处只
 *      验证"未知类型仍拒收"没有被扩展破坏)
 */

import { describe, it, expect } from 'vitest';

import {
  makeBindRevoke,
  makeBindStart,
  makeBindUpdate,
  makeQueryRequest,
  makeQueryResponse,
  makeTaskCancel,
  makeTaskDispatch,
  makeTurnEnd,
  makeTurnReopen,
  parseHookMessage,
  serializeHookMessage,
  type BindUpdatePayload,
  type HookMessage,
  type QueryResponsePayload,
  type TurnEndPayload,
} from '../index';

/** 构造 -> 序列化 -> 解析, 断言等价并返回解析结果。 */
function roundTrip(message: HookMessage): HookMessage {
  const parsed = parseHookMessage(serializeHookMessage(message));
  expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
  if (!parsed.ok) throw new Error('unreachable');
  expect(parsed.message).toEqual(message);
  return parsed.message;
}

/** 基于合法消息改坏字段, 断言解析失败且错误信息含关键词。 */
function expectReject(mutated: unknown, keyword: string): void {
  const parsed = parseHookMessage(mutated);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) throw new Error('unreachable');
  expect(parsed.error).toContain(keyword);
}

const CONFIRMED_UPDATE: BindUpdatePayload = {
  state: 'confirmed',
  slackUserId: 'U0123ABCD',
  slackUserName: 'cindy',
  message: null,
};

const MODELS_RESPONSE: QueryResponsePayload = {
  queryId: 'q-1',
  kind: 'models',
  ok: true,
  error: null,
  agents: [
    {
      agentKind: 'claude-code',
      models: [
        {
          id: 'claude-opus-4-8',
          label: 'Opus 4.8',
          efforts: ['low', 'medium', 'high'],
          defaultEffort: 'high',
          group: 'anthropic',
        },
        { id: 'claude-sonnet-5', label: 'Sonnet 5', efforts: [], defaultEffort: null, group: null },
      ],
      permissionModes: [
        { id: 'ask', label: 'Ask permissions' },
        { id: 'bypassPermissions', label: 'Bypass permissions' },
      ],
    },
  ],
};

/** 旧版 desktop 应答: 无 permissionModes 字段(向后兼容基线)。 */
const MODELS_RESPONSE_LEGACY: QueryResponsePayload = {
  queryId: 'q-legacy',
  kind: 'models',
  ok: true,
  error: null,
  agents: [
    {
      agentKind: 'codex',
      models: [
        { id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'high'], defaultEffort: 'high' },
      ],
    },
  ],
};

describe('v2 新帧 round-trip', () => {
  it('bind.start(新端空 payload + 老端邮箱 payload 都 round-trip)', () => {
    roundTrip(makeBindStart({})); // 阶段 4 新端: 空对象
    roundTrip(makeBindStart({ email: 'cindy@example.com' })); // 老端识别用: email 仍可解析
  });

  it('bind.update 全状态', () => {
    roundTrip(makeBindUpdate(CONFIRMED_UPDATE));
    roundTrip(
      makeBindUpdate({ state: 'none', slackUserId: null, slackUserName: null, message: null }),
    );
    // pending 携带 OIDC 授权链接(不再是 slackUserId)
    roundTrip(
      makeBindUpdate({
        state: 'pending',
        slackUserId: null,
        slackUserName: null,
        message: null,
        authorizeUrl: 'https://slack.example.com/openid/connect/authorize?state=x',
      }),
    );
    roundTrip(
      makeBindUpdate({ state: 'denied', slackUserId: null, slackUserName: null, message: null }),
    );
    roundTrip(
      makeBindUpdate({ state: 'expired', slackUserId: null, slackUserName: null, message: null }),
    );
    roundTrip(
      makeBindUpdate({
        state: 'failed',
        slackUserId: null,
        slackUserName: null,
        message: '该 workspace 未安装本 app',
      }),
    );
    // failed 携带结构化 reason(可选字段; 未知取值也放行 —— 前向兼容)
    roundTrip(
      makeBindUpdate({
        state: 'failed',
        slackUserId: null,
        slackUserName: null,
        message: '该 workspace 未安装本 app',
        reason: 'not-installed',
        installUrl: 'https://hook.example/slack/install-to?team=T1',
      }),
    );
    roundTrip(
      makeBindUpdate({
        state: 'revoked',
        slackUserId: null,
        slackUserName: null,
        message: '被新设备顶掉',
      }),
    );
  });

  it('bind.revoke(空 payload)', () => {
    roundTrip(makeBindRevoke());
  });

  it('query.request / query.response(workspaces 与 models)', () => {
    roundTrip(makeQueryRequest({ queryId: 'q-1', kind: 'workspaces' }));
    roundTrip(makeQueryRequest({ queryId: 'q-2', kind: 'models' }));
    roundTrip(
      makeQueryResponse({
        queryId: 'q-1',
        kind: 'workspaces',
        ok: true,
        error: null,
        workspaces: ['cindy', 'blog'],
      }),
    );
    roundTrip(makeQueryResponse(MODELS_RESPONSE));
    roundTrip(makeQueryResponse(MODELS_RESPONSE_LEGACY));
    roundTrip(
      makeQueryResponse({ queryId: 'q-3', kind: 'models', ok: false, error: 'device busy' }),
    );
  });

  it('task.cancel', () => {
    roundTrip(makeTaskCancel({ requestId: 'req-1' }));
  });
});

describe('bind 帧字段联动', () => {
  it('bind.start email 可选; 携带时必须像邮箱', () => {
    const msg = makeBindStart({ email: 'cindy@example.com' });
    // 空对象放行(新端形态)
    expect(parseHookMessage(JSON.stringify({ ...msg, payload: {} })).ok).toBe(true);
    // 携带则粗校验
    expectReject({ ...msg, payload: { email: 'not-an-email' } }, 'email-like');
    expectReject({ ...msg, payload: { email: '' } }, 'email-like');
  });

  it('confirmed 必须带 slackUserId; pending 必须带 authorizeUrl', () => {
    const msg = makeBindUpdate(CONFIRMED_UPDATE);
    expectReject(
      { ...msg, payload: { ...CONFIRMED_UPDATE, slackUserId: null } },
      'slackUserId must be a non-empty string when state is confirmed',
    );
    // pending 缺 authorizeUrl 拒收
    expectReject(
      {
        ...msg,
        payload: { state: 'pending', slackUserId: null, slackUserName: null, message: null },
      },
      'authorizeUrl must be a non-empty string when state is pending',
    );
    // authorizeUrl 类型错误拒收
    expectReject(
      {
        ...msg,
        payload: {
          state: 'confirmed',
          slackUserId: 'U1',
          slackUserName: null,
          message: null,
          authorizeUrl: 123,
        },
      },
      'authorizeUrl must be a string or null',
    );
  });

  it('failed 必须带 message; 未知 state 拒收', () => {
    const msg = makeBindUpdate(CONFIRMED_UPDATE);
    expectReject(
      {
        ...msg,
        payload: { state: 'failed', slackUserId: null, slackUserName: null, message: null },
      },
      'message must be a non-empty string when state is failed',
    );
    // reason 形状校验: 非 string|null 拒收; 未知字符串取值放行(前向兼容)
    expectReject(
      {
        ...msg,
        payload: {
          state: 'failed',
          slackUserId: null,
          slackUserName: null,
          message: 'x',
          reason: 42,
        },
      },
      'reason must be a string or null',
    );
    expect(
      parseHookMessage(
        JSON.stringify({
          ...msg,
          payload: {
            state: 'failed',
            slackUserId: null,
            slackUserName: null,
            message: 'x',
            reason: 'future-reason',
          },
        }),
      ).ok,
    ).toBe(true);
    expectReject(
      { ...msg, payload: { ...CONFIRMED_UPDATE, state: 'bogus' } },
      'bind.update.state must be one of',
    );
  });

  it('bind.revoke 带多余键拒收', () => {
    const msg = makeBindRevoke();
    expectReject({ ...msg, payload: { extra: 1 } }, 'bind.revoke.extra is not a known field');
  });
});

describe('query 帧字段联动', () => {
  it('ok=false 必须带 error; ok=true 按 kind 必须带对应清单', () => {
    const base = makeQueryResponse(MODELS_RESPONSE);
    expectReject(
      { ...base, payload: { queryId: 'q', kind: 'models', ok: false, error: null } },
      'error must be a non-empty string when ok is false',
    );
    expectReject(
      { ...base, payload: { queryId: 'q', kind: 'workspaces', ok: true, error: null } },
      'workspaces must be an array',
    );
    expectReject(
      { ...base, payload: { queryId: 'q', kind: 'models', ok: true, error: null } },
      'agents must be an array',
    );
  });

  it('models 条目形状校验(efforts / defaultEffort)', () => {
    const base = makeQueryResponse(MODELS_RESPONSE);
    const bad = structuredClone(MODELS_RESPONSE) as unknown as Record<string, unknown>;
    (bad.agents as Array<{ models: Array<Record<string, unknown>> }>)[0].models[0].efforts = 'high';
    expectReject({ ...base, payload: bad }, 'efforts must be an array');
    const bad2 = structuredClone(MODELS_RESPONSE) as unknown as Record<string, unknown>;
    (bad2.agents as Array<{ models: Array<Record<string, unknown>> }>)[0].models[0].defaultEffort =
      42;
    expectReject({ ...base, payload: bad2 }, 'defaultEffort must be a string or null');
  });

  it('models 条目 group 可选(旧桌面端缺席合法), present 时必须 string|null', () => {
    const base = makeQueryResponse(MODELS_RESPONSE_LEGACY); // legacy fixture 无 group
    roundTrip(base);
    const bad = structuredClone(MODELS_RESPONSE) as unknown as Record<string, unknown>;
    (bad.agents as Array<{ models: Array<Record<string, unknown>> }>)[0].models[0].group = 42;
    expectReject(
      { ...makeQueryResponse(MODELS_RESPONSE), payload: bad },
      'group must be a string or null',
    );
  });

  it('permissionModes 可选字段形状校验', () => {
    const base = makeQueryResponse(MODELS_RESPONSE);
    const badArr = structuredClone(MODELS_RESPONSE) as unknown as Record<string, unknown>;
    (badArr.agents as Array<Record<string, unknown>>)[0].permissionModes = 'ask';
    expectReject({ ...base, payload: badArr }, 'permissionModes must be an array');
    const badId = structuredClone(MODELS_RESPONSE) as unknown as Record<string, unknown>;
    (
      badId.agents as Array<{ permissionModes: Array<Record<string, unknown>> }>
    )[0].permissionModes[0].id = '';
    expectReject({ ...base, payload: badId }, 'permissionModes[0].id must be a non-empty string');
    const badLabel = structuredClone(MODELS_RESPONSE) as unknown as Record<string, unknown>;
    delete (badLabel.agents as Array<{ permissionModes: Array<Record<string, unknown>> }>)[0]
      .permissionModes[0].label;
    expectReject(
      { ...base, payload: badLabel },
      'permissionModes[0].label must be a non-empty string',
    );
  });

  it('未知 kind 拒收', () => {
    const msg = makeQueryRequest({ queryId: 'q-1', kind: 'workspaces' });
    expectReject({ ...msg, payload: { queryId: 'q-1', kind: 'channels' } }, 'kind must be one of');
  });
});

describe('v1 帧扩展行为', () => {
  it('dispatch options.effort 合法透传, 非法拒收', () => {
    roundTrip(
      makeTaskDispatch({
        requestId: 'r1',
        externalKey: 'C1:1.1',
        workspace: 'cindy',
        prompt: '修一下',
        options: { model: 'claude-opus-4-8', effort: 'high' },
      }),
    );
    const msg = makeTaskDispatch({
      requestId: 'r1',
      externalKey: 'C1:1.1',
      workspace: 'x',
      prompt: 'p',
    });
    expectReject(
      { ...msg, payload: { ...msg.payload, options: { effort: 42 } } },
      'options.effort must be a string or null',
    );
  });

  it('turn.end cancelled: errorMessage 必须为 null', () => {
    const cancelled: TurnEndPayload = {
      requestId: 'r1',
      externalKey: 'C1:1.1',
      sessionId: 's1',
      status: 'cancelled',
      finalText: '(已产出的部分)',
      errorMessage: null,
      usage: { durationMs: 1200 },
    };
    roundTrip(makeTurnEnd(cancelled));
    const msg = makeTurnEnd(cancelled);
    expectReject(
      { ...msg, payload: { ...cancelled, errorMessage: 'boom' } },
      'errorMessage must be null when status is cancelled',
    );
  });

  it('未知消息类型仍拒收(type 开放集合只对已知类型开放)', () => {
    const msg = makeTaskCancel({ requestId: 'r1' });
    expectReject({ ...msg, type: 'task.pause' }, 'unknown message type');
  });
});

describe('turn.reopen(阶段 14: 收口后的续跑)', () => {
  it('round-trip; sessionId / reason 有显式默认', () => {
    const msg = makeTurnReopen({
      requestId: 'r2',
      reopenOf: 'r1',
      externalKey: 'slack:C1:1.1',
    });
    roundTrip(msg);
    expect(msg.payload).toEqual({
      requestId: 'r2',
      reopenOf: 'r1',
      externalKey: 'slack:C1:1.1',
      sessionId: null,
      reason: 'user-continued',
    });
    roundTrip(
      makeTurnReopen({
        requestId: 'r3',
        reopenOf: 'r2',
        externalKey: 'telegram:123:456',
        sessionId: 'sess-1',
        reason: 'user-continued',
      }),
    );
  });

  it('显式传 undefined 的可选值不得覆盖默认(否则序列化丢键 -> 收帧端拒收整帧)', () => {
    // 调用方常写 `sessionId: maybeId`, 而 maybeId 可能是 undefined。若默认值被它
    // 覆盖, JSON 序列化会把这个键整个删掉, 对端按"必填字段缺失"拒收 —— 续跑结果
    // 就再也回不到渠道那条消息上。
    const msg = makeTurnReopen({
      requestId: 'r2',
      reopenOf: 'r1',
      externalKey: 'k',
      sessionId: undefined,
      reason: undefined,
    });
    expect(msg.payload.sessionId).toBeNull();
    expect(msg.payload.reason).toBe('user-continued');
    roundTrip(msg);
  });

  it('requestId 不得与 reopenOf 相同(换新 id 是本帧的前提)', () => {
    // 复用同一个 id 会让 server 把续跑轮登记成它自己的前身, 幂等表状态不可推理。
    const msg = makeTurnReopen({ requestId: 'r2', reopenOf: 'r1', externalKey: 'k' });
    expectReject(
      { ...msg, payload: { ...msg.payload, reopenOf: 'r2' } },
      'requestId must differ from reopenOf',
    );
  });

  it('必填字段缺失或空串拒收', () => {
    const msg = makeTurnReopen({ requestId: 'r2', reopenOf: 'r1', externalKey: 'k' });
    expectReject({ ...msg, payload: { ...msg.payload, reopenOf: '' } }, 'reopenOf must be');
    expectReject({ ...msg, payload: { ...msg.payload, externalKey: '' } }, 'externalKey must be');
    expectReject({ ...msg, payload: { ...msg.payload, reason: '' } }, 'reason must be');
    expectReject({ ...msg, payload: { ...msg.payload, sessionId: 7 } }, 'sessionId must be');
  });

  it('reason 是开放集合: 未知值放行(消费方兜底), 不拒帧', () => {
    roundTrip(
      makeTurnReopen({
        requestId: 'r2',
        reopenOf: 'r1',
        externalKey: 'k',
        reason: 'some-future-reason',
      }),
    );
  });
});
