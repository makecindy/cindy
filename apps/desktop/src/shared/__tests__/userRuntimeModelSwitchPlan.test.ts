/**
 * 已建任务里「点模型」的发布保证矩阵。
 *
 * 不启 Electron:把点选快照、窗口闸门、延期 profile、换窗结算串成一次 plan。
 * 每一行对应用户会踩到的一类体验,断言 outcome + effort/Fast,避免再出现
 * 「切过去了但 thinking/Fast 丢了」或「未核实窗口直接无法切换」。
 */
import { describe, expect, it } from 'vitest';

import { resolveSessionRuntimeAxes } from '../../main/maker-ipc/sessionRuntimeControl.js';
import {
  nextDeferredModelWindowRetry,
  planUserRuntimeModelSwitch,
} from '../runtimeModelSwitchGate.js';

const million = 1_000_000;
const twoHundredK = 200_000;

const runningLocalClaude = {
  inTurn: true,
  isRemote: false,
  agentKind: 'claude-code',
  runtimeRouteChanged: true,
  verifiedCurrentWindow: million,
  contextTokensKnown: true,
  contextTokens: 450_000,
};

describe('planUserRuntimeModelSwitch — 用户点选体验矩阵', () => {
  it.each([
    {
      name: '跑着 Opus 5 → Cindy 打折/Fable(窗口未核实) → 热切,档位 high 留下',
      input: {
        agentKind: 'claude-code',
        model: 'claude-fable-5',
        providerId: 'cindy',
        currentFastMode: false,
        gate: { ...runningLocalClaude, verifiedTargetWindow: null },
        click: {
          efforts: ['low', 'medium', 'high'] as const,
          effort: 'high',
          fastSupported: false,
          requestedFast: false,
        },
      },
      want: {
        outcome: 'hot-apply',
        skipRebuild: true,
        selection: { effort: 'high', fastMode: false },
      },
    },
    {
      name: '跑着切 Cindy 打折,上一模型 Fast 开着 → Fast 必须关,不能带着插队状态',
      input: {
        agentKind: 'claude-code',
        model: 'claude-opus-5',
        providerId: 'cindy',
        currentFastMode: true,
        gate: { ...runningLocalClaude, verifiedTargetWindow: null },
        click: {
          efforts: ['high'] as const,
          effort: 'high',
          fastSupported: false,
          requestedFast: true,
        },
      },
      want: {
        outcome: 'hot-apply',
        skipRebuild: true,
        selection: { effort: 'high', fastMode: false },
      },
    },
    {
      name: '跑着切无思考档本地模型,界面还写着 leftover high → 运行时 effort null',
      input: {
        agentKind: 'claude-code',
        model: 'local-llama',
        providerId: 'custom:ollama',
        currentFastMode: true,
        gate: { ...runningLocalClaude, verifiedTargetWindow: null },
        click: {
          efforts: [] as const,
          effort: 'high',
          fastSupported: false,
          requestedFast: true,
        },
      },
      want: {
        outcome: 'hot-apply',
        skipRebuild: true,
        selection: { effort: null, fastMode: false },
      },
    },
    {
      name: '收藏 Fast 开 + high,同窗空闲 → 热切,Fast 必须还在',
      input: {
        agentKind: 'codex',
        model: 'gpt-5.5',
        providerId: 'xd',
        currentFastMode: false,
        gate: {
          inTurn: false,
          isRemote: false,
          agentKind: 'codex',
          runtimeRouteChanged: true,
          verifiedTargetWindow: million,
          verifiedCurrentWindow: million,
          contextTokensKnown: true,
          contextTokens: 100_000,
        },
        click: {
          efforts: ['low', 'high'] as const,
          effort: 'high',
          fastSupported: true,
          requestedFast: true,
        },
      },
      want: {
        outcome: 'hot-apply',
        skipRebuild: true,
        selection: { effort: 'high', fastMode: true },
      },
    },
    {
      name: '收藏 Fast 关压过当前会话 Fast 开',
      input: {
        agentKind: 'codex',
        model: 'gpt-5.5',
        providerId: 'xd',
        currentFastMode: true,
        gate: {
          ...runningLocalClaude,
          agentKind: 'codex',
          verifiedTargetWindow: million,
        },
        click: {
          efforts: ['high'] as const,
          effort: 'high',
          fastSupported: true,
          requestedFast: false,
        },
      },
      want: {
        outcome: 'hot-apply',
        skipRebuild: true,
        selection: { effort: 'high', fastMode: false },
      },
    },
    {
      name: 'Pi 跑着换模型 → 延期,high 进 pending,本轮不丢',
      input: {
        agentKind: 'pi',
        model: 'grok-4.6',
        providerId: 'xai',
        currentFastMode: false,
        gate: {
          ...runningLocalClaude,
          agentKind: 'pi',
          verifiedTargetWindow: million,
        },
        click: {
          efforts: ['low', 'high'] as const,
          effort: 'high',
          fastSupported: false,
          requestedFast: false,
        },
      },
      want: {
        outcome: 'defer',
        skipRebuild: true,
        selection: { effort: 'high', fastMode: false },
      },
    },
    {
      name: '远端跑着换模型 → 延期,选择留下',
      input: {
        agentKind: 'claude-code',
        model: 'claude-fable-5',
        providerId: 'anthropic',
        currentFastMode: false,
        gate: {
          ...runningLocalClaude,
          isRemote: true,
          verifiedTargetWindow: million,
        },
        click: {
          efforts: ['high'] as const,
          effort: 'high',
          fastSupported: false,
          requestedFast: false,
        },
      },
      want: {
        outcome: 'defer',
        skipRebuild: true,
        selection: { effort: 'high', fastMode: false },
      },
    },
    {
      name: '跑着危险缩窗 → 延期而不是拒绝,high 留下等回合结束交接',
      input: {
        agentKind: 'claude-code',
        model: 'claude-haiku-4-5',
        providerId: 'anthropic',
        currentFastMode: false,
        gate: {
          ...runningLocalClaude,
          verifiedTargetWindow: twoHundredK,
          contextTokens: 190_000,
        },
        click: {
          efforts: ['high'] as const,
          effort: 'high',
          fastSupported: false,
          requestedFast: false,
        },
      },
      want: {
        outcome: 'defer',
        skipRebuild: false,
        selection: { effort: 'high', fastMode: false },
      },
    },
    {
      name: '空闲危险缩窗 → 热切但要换窗重建',
      input: {
        agentKind: 'claude-code',
        model: 'claude-haiku-4-5',
        providerId: 'anthropic',
        currentFastMode: false,
        gate: {
          ...runningLocalClaude,
          inTurn: false,
          verifiedTargetWindow: twoHundredK,
          contextTokens: 190_000,
        },
        click: {
          efforts: ['high'] as const,
          effort: 'high',
          fastSupported: false,
          requestedFast: false,
        },
      },
      want: {
        outcome: 'hot-apply',
        skipRebuild: false,
        selection: { effort: 'high', fastMode: false },
      },
    },
    {
      name: '远端空闲危险缩窗 → 仍拒绝(没有 rebuild)',
      input: {
        agentKind: 'claude-code',
        model: 'claude-haiku-4-5',
        providerId: 'anthropic',
        currentFastMode: false,
        gate: {
          ...runningLocalClaude,
          inTurn: false,
          isRemote: true,
          verifiedTargetWindow: twoHundredK,
          contextTokens: 190_000,
        },
        click: {
          efforts: ['high'] as const,
          effort: 'high',
          fastSupported: false,
          requestedFast: false,
        },
      },
      want: {
        outcome: 'reject',
        skipRebuild: false,
        selection: { effort: 'high', fastMode: false },
      },
    },
    {
      name: '占用未知 + Cindy 未核实 → fail-open 热切',
      input: {
        agentKind: 'claude-code',
        model: 'claude-opus-5',
        providerId: 'cindy',
        currentFastMode: false,
        gate: {
          ...runningLocalClaude,
          verifiedTargetWindow: null,
          contextTokensKnown: false,
          contextTokens: 0,
        },
        click: {
          efforts: ['high'] as const,
          effort: 'high',
          fastSupported: false,
          requestedFast: false,
        },
      },
      want: {
        outcome: 'hot-apply',
        skipRebuild: true,
        selection: { effort: 'high', fastMode: false },
      },
    },
    {
      name: 'Codex 跑着同窗换模型 → 热切,不打断本轮',
      input: {
        agentKind: 'codex',
        model: 'gpt-5.5',
        providerId: 'openai',
        currentFastMode: false,
        gate: {
          ...runningLocalClaude,
          agentKind: 'codex',
          verifiedTargetWindow: million,
        },
        click: {
          efforts: ['medium', 'high'] as const,
          effort: 'medium',
          fastSupported: true,
          requestedFast: true,
        },
      },
      want: {
        outcome: 'hot-apply',
        skipRebuild: true,
        selection: { effort: 'medium', fastMode: true },
      },
    },
  ])('$name', ({ input, want }) => {
    const plan = planUserRuntimeModelSwitch(input);
    expect(plan.outcome).toBe(want.outcome);
    expect(plan.skipRebuild).toBe(want.skipRebuild);
    expect(plan.selection).toEqual(want.selection);
    expect(plan.pendingProfile).toMatchObject({
      model: input.model,
      providerId: input.providerId,
      effort: want.selection.effort,
      fastMode: want.selection.fastMode,
    });
    if (want.outcome === 'defer') {
      expect(plan.pendingProfile.effort).toBe(want.selection.effort);
      expect(plan.pendingProfile.fastMode).toBe(want.selection.fastMode);
    }
  });

  it('延期缩窗在空闲结算时带着核实窗口重试,而不是把选择取消', () => {
    const plan = planUserRuntimeModelSwitch({
      agentKind: 'claude-code',
      model: 'claude-haiku-4-5',
      providerId: 'anthropic',
      currentFastMode: false,
      gate: {
        ...runningLocalClaude,
        verifiedTargetWindow: twoHundredK,
        contextTokens: 190_000,
      },
      click: {
        efforts: ['high'],
        effort: 'high',
        fastSupported: false,
        requestedFast: false,
      },
    });
    expect(plan.outcome).toBe('defer');
    expect(nextDeferredModelWindowRetry(true, twoHundredK)).toEqual({
      action: 'retry',
      confirmedContextWindow: twoHundredK,
    });
    expect(nextDeferredModelWindowRetry(true, undefined).action).toBe('cancel');
  });

  it('main 已归一化的 atomic selection 不再被 click 重猜', () => {
    const plan = planUserRuntimeModelSwitch({
      agentKind: 'claude-code',
      model: 'claude-fable-5',
      providerId: 'cindy',
      currentFastMode: true,
      gate: { ...runningLocalClaude, verifiedTargetWindow: null },
      selection: { effort: 'high', fastMode: false },
      click: {
        efforts: [],
        effort: 'low',
        fastSupported: true,
        requestedFast: true,
      },
    });
    expect(plan.selection).toEqual({ effort: 'high', fastMode: false });
    expect(plan.pendingProfile.effort).toBe('high');
  });

  it('无档模型:原子 null 经 axes 仍是 null,不会把 leftover high 写回', () => {
    const plan = planUserRuntimeModelSwitch({
      agentKind: 'claude-code',
      model: 'local-llama',
      providerId: 'custom:ollama',
      currentFastMode: true,
      gate: { ...runningLocalClaude, verifiedTargetWindow: null },
      click: {
        efforts: [],
        effort: 'high',
        fastSupported: false,
        requestedFast: true,
      },
    });
    const axes = resolveSessionRuntimeAxes({
      model: {
        id: 'local-llama',
        name: 'local-llama',
        contextWindow: 32_000,
        efforts: [],
        defaultEffort: null,
        supportsFastMode: false,
      } as never,
      effort: plan.selection.effort as never,
      fastMode: plan.selection.fastMode,
      effortExplicit: true,
      fastExplicit: true,
      allowFixedEffortPlaceholder: true,
    });
    expect(axes).toEqual({ ok: true, effort: null, fastMode: false });
  });
});
