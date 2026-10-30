/**
 * 测试价值
 * - 生产入口与可观察结果:suggestFollowUpRoute 给出的换模型建议(get_task_digest 的 suggested_route),
 *   伙伴跟进时照它用 set_session_runtime 代主人换模型;deriveFollowUpUsage 是交给它的可信上下文用量
 *   (taskDigestHost 读运行时与库值后经它推导)。
 * - Bug／规则依据:2026-10-19 用户反馈「伙伴把会话的模型切了，上下文直接满了」——任务因工具循环中断,
 *   伙伴照建议把主人用 1M 模型跑的任务换到自己链首的 272K 模型。换模型救不了工具循环;主人自己选的模型
 *   不在伙伴链里时建议退回链首;换过去用量超过提醒线也照样建议。
 * - 现有覆盖缺口:nextBotModelRoute 的测试只覆盖伙伴自己任务的候选链降级,不涉及跟进别人任务时的失败类型、
 *   链外路线与上下文余量;运行时 / 库值的用量推导此前没有任何测试驱动(PR review 指出,三轮修复里各改错过一次)。
 * - 最小失败输入:工具循环出错;只带 SDK invalid_request 或 Codex badRequest 的出错;链外的当前路线(含同模型异供应商);
 *   220K 用量从 1M 换到 272K;没有可信用量时缩窗;用量上限下的正常降级。
 * - tier:unit(纯函数,无数据库与 Electron)。
 */
import { describe, expect, it } from 'vitest';

import { deriveFollowUpUsage, suggestFollowUpRoute, type FollowUpRouteInput } from '../followUpRoute.js';

const OPUS = { harness: 'claude', model: 'claude-opus-5-5', providerId: 'anthropic' } as const;
const SOL = { harness: 'codex', model: 'gpt-6.1-sol', providerId: 'openai' } as const;
const GEMINI = { harness: 'pi', model: 'gemini-3-pro', providerId: 'google' } as const;
const WINDOWS: Record<string, number> = { 'claude-opus-5-5': 1_000_000, 'gpt-6.1-sol': 272_000, 'gemini-3-pro': 1_000_000 };

function input(overrides: Partial<FollowUpRouteInput> = {}): FollowUpRouteInput {
  return {
    chain: [OPUS, SOL, GEMINI],
    current: OPUS,
    failure: { phase: 'usage-limit', error: '已达用量上限', errorReason: null },
    visitedRoutes: [],
    sameHarnessOnly: false,
    contextTokens: 40_000,
    currentContextWindow: 1_000_000,
    windowOf: (route) => WINDOWS[route.model] ?? null,
    ...overrides,
  };
}

describe('follow-up route suggestion', () => {
  it('suggests the next companion route when the task hit a usage limit with room to spare', () => {
    expect(suggestFollowUpRoute(input())).toMatchObject(SOL);
  });

  it('gives no suggestion for failures a different model cannot fix', () => {
    const errored = (error: string, errorReason: string | null) =>
      suggestFollowUpRoute(input({ failure: { phase: 'errored', error, errorReason } }));
    expect(errored('任务因重复工具调用形成循环而中断', 'tool_use_loop_detected')).toBeNull();
    expect(errored('prompt is too long', 'context-overflow')).toBeNull();
    // 没有可判断的错误:不猜。
    expect(errored('', null)).toBeNull();
    // 摘要投影没有 reason、只有运行时记下的 SDK 结构化字段:请求本身无效 / 输出超限。
    const withSdk = (sdkError: string, errorStatus?: number) => suggestFollowUpRoute(input({
      failure: { phase: 'errored', error: 'API Error', errorReason: null, sdkError, errorStatus },
    }));
    expect(withSdk('invalid_request', 400)).toBeNull();
    expect(withSdk('max_output_tokens')).toBeNull();
    // Codex 只带结构化 tag(如 badRequest),消息里没有可匹配的文字。
    expect(suggestFollowUpRoute(input({
      failure: { phase: 'errored', error: 'turn failed', errorReason: null, codexErrorInfo: 'badRequest' },
    }))).toBeNull();
    // 那台账号的问题:换得过去。
    expect(errored('authentication_failed: OAuth token has expired', null)).toMatchObject(SOL);
  });

  it('leaves a task whose model the owner chose alone instead of jumping to the companion primary route', () => {
    const ownerChoice = { harness: 'claude', model: 'claude-fable-5-1', providerId: 'anthropic' } as const;
    expect(suggestFollowUpRoute(input({ current: ownerChoice }))).toBeNull();
    // 同一模型、明确不同的供应商也是主人自己的选择。
    expect(suggestFollowUpRoute(input({ current: { ...OPUS, providerId: 'xd' } }))).toBeNull();
  });

  it('skips a smaller window the current context would crowd, and keeps a larger one', () => {
    // 220K 进 272K 是 81%,过提醒线:跳过 Sol,落到同样 1M 的下一条。
    expect(suggestFollowUpRoute(input({ contextTokens: 220_000 }))).toMatchObject(GEMINI);
    expect(suggestFollowUpRoute(input({ contextTokens: 220_000, chain: [OPUS, SOL] }))).toBeNull();
    // 没有可信用量(会话已关、库里的值可能低报):不缩窗,只留同样大或更大的窗口。
    expect(suggestFollowUpRoute(input({ contextTokens: null }))).toMatchObject(GEMINI);
    // 窗口变大不受当前用量影响。
    expect(suggestFollowUpRoute(input({
      chain: [SOL, OPUS],
      current: SOL,
      currentContextWindow: 272_000,
      contextTokens: 240_000,
    }))).toMatchObject(OPUS);
  });
});

describe('follow-up usage derivation', () => {
  const reading = (contextTokens: number, contextWindow = 1_000_000) => ({ contextTokens, contextWindow });

  it.each([
    // [情形, live, closed, 库值, 期望用量]
    ['新 runtime 的占位 0 不盖掉上一段关闭时的读数', reading(0), reading(220_000), 0, 220_000],
    ['占位 0 被固化进关闭缓存、库里也是 0:未知', reading(0), reading(0), 0, null],
    ['库值低报时运行时读数为准', reading(40_000), null, 220_000, 220_000],
    ['运行时读数更大时取运行时', reading(220_000), null, 40_000, 220_000],
    ['没有运行时读数:库值不能单独证明缩窗安全', null, null, 220_000, null],
    ['什么读数都没有:未知', null, null, null, null],
  ] as const)('%s', (_case, live, closed, dbContextTokens, expected) => {
    expect(deriveFollowUpUsage({ live, closed, dbContextTokens }).contextTokens).toBe(expected);
  });

  it('prefers the current runtime window and falls back to the closed one', () => {
    expect(deriveFollowUpUsage({ live: reading(0, 0), closed: reading(1, 272_000), dbContextTokens: null }).contextWindow)
      .toBe(272_000);
    expect(deriveFollowUpUsage({ live: reading(0, 1_000_000), closed: reading(1, 272_000), dbContextTokens: null })
      .contextWindow).toBe(1_000_000);
    expect(deriveFollowUpUsage({ live: null, closed: null, dbContextTokens: 5 }).contextWindow).toBeNull();
  });
});
