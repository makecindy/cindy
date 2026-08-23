/**
 * slack-hook-protocol 阶段 19(Telegram 行为配置)测试:
 *   1. provider.behavior.get/set/state 构造 -> 序列化 -> 解析 round-trip
 *   2. 选择器校验: provider 只认 telegram、bindingId 非空必填(不接受 scopeId 替代)
 *   3. set: 三个全局字段的 `enum | null` patch 三态(不动 / 显式 override / 显式
 *      清除), 各自取值校验, 以及"至少一个实际 patch"的空 set 拒收(null 也算
 *      一次真实改动)
 *   4. state: 三个全局字段收敛为必填非空枚举(从不是 patch、从不是 null)、
 *      groupActivation 的形状/取值校验与累积可表达性, 以及 bound=false -> 默认值 + 空
 *      groupActivation 的字段联动(parse 强制)
 *   5. 能力标识常量 provider-behavior-v1
 *   6. DEFAULT_TELEGRAM_BEHAVIOR 与个人版桌面客户端出厂默认对齐
 */

import { describe, it, expect } from 'vitest';

import {
  DEFAULT_TELEGRAM_BEHAVIOR,
  HOOK_FEATURE_PROVIDER_BEHAVIOR,
  PROVIDER_BEHAVIOR_PROVIDERS,
  TELEGRAM_EMOJI_REACTIONS,
  TELEGRAM_GROUP_ACTIVATION_ALWAYS,
  TELEGRAM_REPLY_QUOTE_DM,
  TELEGRAM_REPLY_QUOTE_GROUP,
  makeProviderBehaviorGet,
  makeProviderBehaviorSet,
  makeProviderBehaviorState,
  parseHookMessage,
  serializeHookMessage,
  type HookMessage,
  type ProviderBehaviorGetPayload,
  type ProviderBehaviorSetPayload,
  type ProviderBehaviorStatePayload,
} from '../index';

function roundTrip(message: HookMessage): HookMessage {
  const parsed = parseHookMessage(serializeHookMessage(message));
  expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
  if (!parsed.ok) throw new Error('unreachable');
  expect(parsed.message).toEqual(message);
  return parsed.message;
}

function expectReject(mutated: unknown, keyword: string): void {
  const parsed = parseHookMessage(mutated);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) throw new Error('unreachable');
  expect(parsed.error).toContain(keyword);
}

const BINDING_ID = 'binding-tg-1';
const CHAT_ID = '-1001234567890';

const GET: ProviderBehaviorGetPayload = {
  requestId: 'behavior-req-1',
  provider: 'telegram',
  bindingId: BINDING_ID,
};

const SET_GLOBAL_ONLY: ProviderBehaviorSetPayload = {
  requestId: 'behavior-req-2',
  provider: 'telegram',
  bindingId: BINDING_ID,
  emojiReactions: 'minimal',
  replyQuoteDm: 'first',
  replyQuoteGroup: 'all',
};

const SET_GROUP_ACTIVATION_ONLY: ProviderBehaviorSetPayload = {
  requestId: 'behavior-req-3',
  provider: 'telegram',
  bindingId: BINDING_ID,
  groupActivation: { chatId: CHAT_ID, value: TELEGRAM_GROUP_ACTIVATION_ALWAYS },
};

const SET_GROUP_ACTIVATION_CLEAR: ProviderBehaviorSetPayload = {
  requestId: 'behavior-req-4',
  provider: 'telegram',
  bindingId: BINDING_ID,
  groupActivation: { chatId: CHAT_ID, value: null },
};

const SET_COMBINED: ProviderBehaviorSetPayload = {
  requestId: 'behavior-req-5',
  provider: 'telegram',
  bindingId: BINDING_ID,
  emojiReactions: 'expressive',
  replyQuoteDm: 'off',
  replyQuoteGroup: 'first',
  groupActivation: { chatId: CHAT_ID, value: TELEGRAM_GROUP_ACTIVATION_ALWAYS },
};

// 三个全局字段的 null = 显式清除 override(回落版本默认), 与 undefined(不动)
// 是不同的三态第三态。
const SET_GLOBAL_ALL_NULL: ProviderBehaviorSetPayload = {
  requestId: 'behavior-req-6',
  provider: 'telegram',
  bindingId: BINDING_ID,
  emojiReactions: null,
  replyQuoteDm: null,
  replyQuoteGroup: null,
};

const SET_SINGLE_NULL_ONLY: ProviderBehaviorSetPayload = {
  requestId: 'behavior-req-7',
  provider: 'telegram',
  bindingId: BINDING_ID,
  emojiReactions: null,
};

const SET_NULL_PLUS_GROUP_ACTIVATION: ProviderBehaviorSetPayload = {
  requestId: 'behavior-req-8',
  provider: 'telegram',
  bindingId: BINDING_ID,
  replyQuoteGroup: null,
  groupActivation: { chatId: CHAT_ID, value: TELEGRAM_GROUP_ACTIVATION_ALWAYS },
};

const STATE_BOUND_NON_DEFAULT: ProviderBehaviorStatePayload = {
  provider: 'telegram',
  bindingId: BINDING_ID,
  replyTo: 'behavior-req-5',
  bound: true,
  emojiReactions: 'expressive',
  replyQuoteDm: 'first',
  replyQuoteGroup: 'all',
  groupActivation: { [CHAT_ID]: TELEGRAM_GROUP_ACTIVATION_ALWAYS },
};

const STATE_BOUND_DEFAULT: ProviderBehaviorStatePayload = {
  provider: 'telegram',
  bindingId: BINDING_ID,
  replyTo: null,
  bound: true,
  ...DEFAULT_TELEGRAM_BEHAVIOR,
  groupActivation: {},
};

const STATE_UNBOUND: ProviderBehaviorStatePayload = {
  provider: 'telegram',
  bindingId: BINDING_ID,
  replyTo: null,
  bound: false,
  ...DEFAULT_TELEGRAM_BEHAVIOR,
  groupActivation: {},
};

describe('provider.behavior(阶段 19)', () => {
  it('能力标识常量', () => {
    expect(HOOK_FEATURE_PROVIDER_BEHAVIOR).toBe('provider-behavior-v1');
  });

  it('导出的 provider/behavior 枚举表在运行时不可变', () => {
    expect(Object.isFrozen(PROVIDER_BEHAVIOR_PROVIDERS)).toBe(true);
    expect(Object.isFrozen(TELEGRAM_EMOJI_REACTIONS)).toBe(true);
    expect(Object.isFrozen(TELEGRAM_REPLY_QUOTE_DM)).toBe(true);
    expect(Object.isFrozen(TELEGRAM_REPLY_QUOTE_GROUP)).toBe(true);
  });

  it('DEFAULT_TELEGRAM_BEHAVIOR 与个人版桌面客户端出厂默认对齐', () => {
    expect(DEFAULT_TELEGRAM_BEHAVIOR).toEqual({
      emojiReactions: 'minimal',
      replyQuoteDm: 'off',
      replyQuoteGroup: 'first',
    });
    expect(Object.isFrozen(DEFAULT_TELEGRAM_BEHAVIOR)).toBe(true);
    expect(() => {
      (DEFAULT_TELEGRAM_BEHAVIOR as { emojiReactions: string }).emojiReactions = 'off';
    }).toThrow(TypeError);
  });

  it('round-trip: get', () => {
    roundTrip(makeProviderBehaviorGet(GET));
  });

  it('round-trip: set(全局字段 / groupActivation 单独 / 混合 / 清除)', () => {
    roundTrip(makeProviderBehaviorSet(SET_GLOBAL_ONLY));
    roundTrip(makeProviderBehaviorSet(SET_GROUP_ACTIVATION_ONLY));
    roundTrip(makeProviderBehaviorSet(SET_GROUP_ACTIVATION_CLEAR));
    roundTrip(makeProviderBehaviorSet(SET_COMBINED));
  });

  it('round-trip: set 全局字段的显式 null(清除 override, 与 undefined 不同)', () => {
    roundTrip(makeProviderBehaviorSet(SET_GLOBAL_ALL_NULL));
    // 只 clear 一个字段、其余不动, 仍算一次实际 patch, 不会被当空 set 拒收。
    roundTrip(makeProviderBehaviorSet(SET_SINGLE_NULL_ONLY));
    // null 清除与 groupActivation patch 可同帧组合。
    roundTrip(makeProviderBehaviorSet(SET_NULL_PLUS_GROUP_ACTIVATION));
  });

  it('round-trip: state(bound 非默认 / bound 默认 / 未绑定)', () => {
    roundTrip(makeProviderBehaviorState(STATE_BOUND_NON_DEFAULT));
    roundTrip(makeProviderBehaviorState(STATE_BOUND_DEFAULT));
    roundTrip(makeProviderBehaviorState(STATE_UNBOUND));
  });

  it('选择器校验: bindingId 必须非空字符串, 不接受缺省或 scopeId 替代', () => {
    const get = makeProviderBehaviorGet(GET);
    expectReject({ ...get, payload: { ...GET, bindingId: '' } }, 'provider.behavior.get.bindingId');
    const missingBindingId: Record<string, unknown> = { ...GET };
    delete missingBindingId.bindingId;
    expectReject({ ...get, payload: missingBindingId }, 'provider.behavior.get.bindingId');
    // scopeId 不是这个 selector 认识的字段: 加了也不能替代 bindingId。
    expectReject(
      {
        ...get,
        payload: { requestId: GET.requestId, provider: GET.provider, scopeId: 'bot-1' },
      },
      'provider.behavior.get.bindingId',
    );
  });

  it('选择器校验: provider 只认 telegram(get/set/state 三帧都拒收非法值)', () => {
    const get = makeProviderBehaviorGet(GET);
    expectReject(
      { ...get, payload: { ...GET, provider: 'slack' } },
      'provider.behavior.get.provider',
    );
    const set = makeProviderBehaviorSet(SET_GLOBAL_ONLY);
    expectReject(
      { ...set, payload: { ...SET_GLOBAL_ONLY, provider: 'x' } },
      'provider.behavior.set.provider',
    );
    const state = makeProviderBehaviorState(STATE_BOUND_DEFAULT);
    expectReject(
      { ...state, payload: { ...STATE_BOUND_DEFAULT, provider: 'discord' } },
      'provider.behavior.state.provider',
    );
  });

  it('set: 三个全局字段各自校验非法取值(必须是已知枚举或 null, 二者之外都拒收)', () => {
    const set = makeProviderBehaviorSet(SET_GLOBAL_ONLY);
    expectReject(
      { ...set, payload: { ...SET_GLOBAL_ONLY, emojiReactions: 'loud' } },
      'provider.behavior.set.emojiReactions',
    );
    expectReject(
      { ...set, payload: { ...SET_GLOBAL_ONLY, replyQuoteDm: 'always' } },
      'provider.behavior.set.replyQuoteDm',
    );
    expectReject(
      { ...set, payload: { ...SET_GLOBAL_ONLY, replyQuoteGroup: 'some' } },
      'provider.behavior.set.replyQuoteGroup',
    );
    // 非字符串、非 null 的其它类型同样拒收(不能借道混入任意值)。
    expectReject(
      { ...set, payload: { ...SET_GLOBAL_ONLY, emojiReactions: 0 } },
      'provider.behavior.set.emojiReactions',
    );
  });

  it('set: groupActivation patch 的 chatId / value 校验', () => {
    const set = makeProviderBehaviorSet(SET_GROUP_ACTIVATION_ONLY);
    expectReject(
      {
        ...set,
        payload: {
          ...SET_GROUP_ACTIVATION_ONLY,
          groupActivation: { chatId: 'not-a-number', value: TELEGRAM_GROUP_ACTIVATION_ALWAYS },
        },
      },
      'provider.behavior.set.groupActivation.chatId',
    );
    for (const chatId of ['0', '123', '-0', '-001', '-4503599627370496']) {
      expectReject(
        {
          ...set,
          payload: {
            ...SET_GROUP_ACTIVATION_ONLY,
            groupActivation: { chatId, value: TELEGRAM_GROUP_ACTIVATION_ALWAYS },
          },
        },
        'provider.behavior.set.groupActivation.chatId',
      );
    }
    expectReject(
      {
        ...set,
        payload: {
          ...SET_GROUP_ACTIVATION_ONLY,
          groupActivation: { chatId: '', value: TELEGRAM_GROUP_ACTIVATION_ALWAYS },
        },
      },
      'provider.behavior.set.groupActivation.chatId',
    );
    expectReject(
      {
        ...set,
        payload: {
          ...SET_GROUP_ACTIVATION_ONLY,
          groupActivation: { chatId: '1'.repeat(33), value: TELEGRAM_GROUP_ACTIVATION_ALWAYS },
        },
      },
      'provider.behavior.set.groupActivation.chatId',
    );
    expectReject(
      {
        ...set,
        payload: {
          ...SET_GROUP_ACTIVATION_ONLY,
          groupActivation: { chatId: CHAT_ID, value: 'mention' },
        },
      },
      'provider.behavior.set.groupActivation.value',
    );
    expectReject(
      {
        ...set,
        payload: { ...SET_GROUP_ACTIVATION_ONLY, groupActivation: 'not-an-object' },
      },
      'provider.behavior.set.groupActivation',
    );
  });

  it('set: 空 patch(既无全局字段也无 groupActivation)拒收', () => {
    const set = makeProviderBehaviorSet(SET_GLOBAL_ONLY);
    const empty: Record<string, unknown> = {
      requestId: SET_GLOBAL_ONLY.requestId,
      provider: SET_GLOBAL_ONLY.provider,
      bindingId: SET_GLOBAL_ONLY.bindingId,
    };
    expectReject({ ...set, payload: empty }, 'at least one behavior field');
  });

  it('set: requestId 必须非空字符串', () => {
    const set = makeProviderBehaviorSet(SET_GLOBAL_ONLY);
    expectReject(
      { ...set, payload: { ...SET_GLOBAL_ONLY, requestId: '' } },
      'provider.behavior.set.requestId',
    );
  });

  it('state: 三个全局字段必须是完整(非 patch)非空枚举值 —— 不接受 undefined 也不接受 null', () => {
    const state = makeProviderBehaviorState(STATE_BOUND_DEFAULT);
    expectReject(
      { ...state, payload: { ...STATE_BOUND_DEFAULT, emojiReactions: undefined } },
      'provider.behavior.state.emojiReactions',
    );
    // 与 set 不同: state 是已解析的有效值快照, null(patch 语义里的"清除")在这里
    // 没有意义 —— 必须已经解析成某个具体的默认或 override 枚举值。
    expectReject(
      { ...state, payload: { ...STATE_BOUND_DEFAULT, emojiReactions: null } },
      'provider.behavior.state.emojiReactions',
    );
    expectReject(
      { ...state, payload: { ...STATE_BOUND_DEFAULT, replyQuoteDm: 'loud' } },
      'provider.behavior.state.replyQuoteDm',
    );
    expectReject(
      { ...state, payload: { ...STATE_BOUND_DEFAULT, replyQuoteGroup: 'lots' } },
      'provider.behavior.state.replyQuoteGroup',
    );
  });

  it('state: groupActivation 形状、键值校验与累积可表达性', () => {
    const state = makeProviderBehaviorState(STATE_BOUND_NON_DEFAULT);
    expectReject(
      { ...state, payload: { ...STATE_BOUND_NON_DEFAULT, groupActivation: 'not-an-object' } },
      'provider.behavior.state.groupActivation must be an object',
    );
    expectReject(
      {
        ...state,
        payload: {
          ...STATE_BOUND_NON_DEFAULT,
          groupActivation: { 'not-a-chat-id': TELEGRAM_GROUP_ACTIVATION_ALWAYS },
        },
      },
      'provider.behavior.state.groupActivation key must be a canonical negative Telegram group chat id',
    );
    expectReject(
      {
        ...state,
        payload: {
          ...STATE_BOUND_NON_DEFAULT,
          groupActivation: { '001': TELEGRAM_GROUP_ACTIVATION_ALWAYS },
        },
      },
      'provider.behavior.state.groupActivation key must be a canonical negative Telegram group chat id',
    );
    expectReject(
      {
        ...state,
        payload: { ...STATE_BOUND_NON_DEFAULT, groupActivation: { [CHAT_ID]: 'mention' } },
      },
      `must be '${TELEGRAM_GROUP_ACTIVATION_ALWAYS}'`,
    );
    const accumulated: Record<string, typeof TELEGRAM_GROUP_ACTIVATION_ALWAYS> = Object.fromEntries(
      Array.from({ length: 501 }, (_, i) => [`-${i + 1}`, TELEGRAM_GROUP_ACTIVATION_ALWAYS]),
    );
    roundTrip(
      makeProviderBehaviorState({ ...STATE_BOUND_NON_DEFAULT, groupActivation: accumulated }),
    );
  });

  it('字段联动(parse 强制): bound=false 必须收敛为默认行为与空 groupActivation', () => {
    const nonDefaultState = makeProviderBehaviorState(STATE_BOUND_NON_DEFAULT);
    expectReject(
      { ...nonDefaultState, payload: { ...STATE_BOUND_NON_DEFAULT, bound: false } },
      'must report the default behavior when bound is false',
    );

    const defaultState = makeProviderBehaviorState(STATE_BOUND_DEFAULT);
    expectReject(
      {
        ...defaultState,
        payload: {
          ...STATE_BOUND_DEFAULT,
          bound: false,
          groupActivation: { [CHAT_ID]: TELEGRAM_GROUP_ACTIVATION_ALWAYS },
        },
      },
      'groupActivation must be empty when bound is false',
    );

    // 反过来: bound=false 且已是默认值 + 空 map 的合法快照必须放行(已在上面的
    // round-trip 用例覆盖 STATE_UNBOUND, 这里不重复)。
  });
});
