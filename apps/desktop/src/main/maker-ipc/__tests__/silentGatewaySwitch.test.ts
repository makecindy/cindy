/**
 * 测试价值
 * - 生产入口与可观察结果：createSilentGatewaySwitchForSend（register.ts 的发送前钩子）；任务是否切到
 *   目录指定的引擎、发送是否被拒、同一任务之后的发送是否还会再判定。
 * - Bug／规则依据：docs/dev-rules/protocol-compatibility/model-access-silent-switch.md；review 发现
 *   目录按数组引用比较导致内容不变的刷新中断发送、切换失败让该任务每次发送都失败、无需切换时
 *   仍因选择器变化拒绝发送；PR #13427 review 要求取消「每任务只判定一次」：任务忙或切换失败时
 *   消耗掉唯一一次机会，之后的发送永远不再切换；复审要求仍需切换但交接失败时停住本次发送，
 *   留给用户重试同一条输入，而不是让原引擎发出。
 * - 现有覆盖缺口：modelsSyncRefresh.test.ts 只覆盖目标解析 resolveSilentGatewaySwitchTarget，
 *   不覆盖发送前的判定、目录复核与失败回退。
 * - 最小失败输入：交接期间 setXdGatewayModels 以相同内容重写目录；performSessionAgentSwitch 抛错；
 *   无目标时等待期间出现待回答问题；首次发送时回合仍在进行。
 * - tier：unit（进程内 fake 依赖 + 真实 active-catalog 目录 setter）。
 * - 实测耗时：单文件墙钟约 1.6 秒（pnpm --filter desktop exec vitest run 本文件）。
 */
import type { AgentKind } from '@cindy/maker-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getXdGatewayModelAccessSnapshot,
  markXdGatewayModelAccessUnknown,
  setXdGatewayModels,
  type XdGatewayModelInfo,
} from '../../maker-host/active-catalog.js';
import {
  createSilentGatewaySwitchForSend,
  type SilentGatewaySwitchDeps,
  type SilentGatewaySwitchSessionRow,
} from '../silentGatewaySwitch.js';

const AUTO: XdGatewayModelInfo = {
  id: 'auto',
  name: 'Auto',
  contextWindow: 128_000,
  availability: 'available',
  silentSwitch: true,
  agents: ['pi'],
  perAgent: { pi: { wireProtocol: 'openai-responses', defaultEffort: 'medium' } },
};

function harness(options: {
  models?: XdGatewayModelInfo[];
  row?: Partial<SilentGatewaySwitchSessionRow>;
  switchAgent?: SilentGatewaySwitchDeps['switchAgent'];
} = {}) {
  setXdGatewayModels(options.models ?? [AUTO], { authoritative: true });
  const owner = {};
  const state = { pendingQuestion: false, turnRunning: false };
  const row: SilentGatewaySwitchSessionRow = {
    providerId: 'xd', model: 'auto', status: 'active', agentKind: 'codex', source: 'desktop', ...options.row,
  };
  const getSessionRow = vi.fn(async () => row);
  const switchAgent = vi.fn<SilentGatewaySwitchDeps['switchAgent']>(
    options.switchAgent ?? (async (params) => {
      params.assertSelectionCurrent();
      return { switched: true };
    }),
  );
  // Like performSessionAgentSwitch, a completed switch persists the new engine on the task.
  const persistSwitch = async (params: Parameters<SilentGatewaySwitchDeps['switchAgent']>[0]) => {
    const result = await switchAgent(params);
    if (result.switched && !result.deferred) row.agentKind = params.targetAgentKind;
    return result;
  };
  const log = { warn: vi.fn() };
  const send = createSilentGatewaySwitchForSend({
    getOwner: () => owner,
    isRemoteInvoke: () => false,
    hasPendingAgentSwitch: () => false,
    isTurnRunning: () => state.turnRunning,
    hasPendingInteraction: () => state.pendingQuestion,
    getCatalog: getXdGatewayModelAccessSnapshot,
    getSessionRow,
    toBuiltinAgent: kind => (kind === 'acp' ? undefined : kind as AgentKind),
    listAvailableAgents: () => ['codex', 'pi'],
    canUseRoute: async () => true,
    switchAgent: persistSwitch,
    log,
  });
  return { send, state, row, getSessionRow, switchAgent, log };
}

afterEach(() => {
  setXdGatewayModels([], { authoritative: false });
});

describe('silent Cindy AI engine switch on send', () => {
  it('switches a task on its first eligible send and keeps later sends on the chosen engine', async () => {
    const h = harness();
    await h.send('task-1');
    await h.send('task-1');
    expect(h.switchAgent).toHaveBeenCalledTimes(1);
    expect(h.switchAgent.mock.calls[0]![0]).toMatchObject({
      sessionId: 'task-1', targetAgentKind: 'pi', model: 'auto', effort: 'medium',
    });
    expect(h.row.agentKind).toBe('pi');
    // Each send re-checks the task against the catalog; it is already on the allowed engine.
    expect(h.getSessionRow).toHaveBeenCalledTimes(2);
    expect(h.log.warn).not.toHaveBeenCalled();
  });

  it.each([
    // Cheap path: accounts without any flagged entry never read the task.
    ['the directory has no silentSwitch entry', { models: [{ ...AUTO, silentSwitch: undefined }] }, 0],
    ['the task already runs on the allowed engine', { row: { agentKind: 'pi' } }, 2],
  ])('does not switch when %s', async (_label, options, rowReads) => {
    const h = harness(options);
    await h.send('task-1');
    await h.send('task-1');
    expect(h.switchAgent).not.toHaveBeenCalled();
    expect(h.getSessionRow).toHaveBeenCalledTimes(rowReads);
  });

  it.each(['turnRunning', 'pendingQuestion'] as const)('skips a busy task (%s) without giving up, and switches on the next send', async (busy) => {
    const h = harness();
    h.state[busy] = true;
    await h.send('task-1');
    expect(h.switchAgent).not.toHaveBeenCalled();
    h.state[busy] = false;
    await h.send('task-1');
    expect(h.switchAgent).toHaveBeenCalledTimes(1);
    expect(h.row.agentKind).toBe('pi');
  });

  it('does not reject a send that needs no switch when a question appears while the task is read', async () => {
    const h = harness({ row: { agentKind: 'pi' } });
    h.getSessionRow.mockImplementationOnce(async () => {
      h.state.pendingQuestion = true;
      return { providerId: 'xd', model: 'auto', status: 'active', agentKind: 'pi' };
    });
    await expect(h.send('task-1')).resolves.toBeUndefined();
    expect(h.switchAgent).not.toHaveBeenCalled();
  });

  it('keeps switching when a refresh rewrites the same directory content during the handoff', async () => {
    const h = harness({
      switchAgent: async (params) => {
        // Production sync: revoke authority, then write the response twice (chat list + media rebuild).
        markXdGatewayModelAccessUnknown();
        setXdGatewayModels([{ ...AUTO }], { authoritative: true });
        setXdGatewayModels([{ ...AUTO }]);
        params.assertSelectionCurrent();
        return { switched: true };
      },
    });
    await h.send('task-1');
    expect(h.log.warn).not.toHaveBeenCalled();
  });

  it.each<[string, SilentGatewaySwitchDeps['switchAgent']]>([
    ['the handoff throws', async () => { throw new Error('engine unavailable'); }],
    ['the switch is only deferred', async () => ({ switched: false, deferred: true })],
  ])('stops the send when %s so the same input is retried, and switches on the retry', async (_label, switchAgent) => {
    const h = harness({ switchAgent });
    await expect(h.send('task-1')).rejects.toMatchObject({ code: 'HARNESS_SWITCH_NOT_READY' });
    expect(h.row.agentKind).toBe('codex');
    expect(h.log.warn).toHaveBeenCalledTimes(1);
    expect(h.log.warn.mock.calls[0]![1]).toMatchObject({ sessionId: 'task-1', targetAgentKind: 'pi' });
    h.switchAgent.mockImplementation(async () => ({ switched: true }));
    await expect(h.send('task-1')).resolves.toBeUndefined();
    expect(h.switchAgent).toHaveBeenCalledTimes(2);
    expect(h.row.agentKind).toBe('pi');
  });

  it.each<[string, (h: ReturnType<typeof harness>) => void]>([
    ['the directory withdraws the switch', () => {
      setXdGatewayModels([{ ...AUTO, silentSwitch: undefined }], { authoritative: true });
    }],
    ['a question appears on the task', (h) => { h.state.pendingQuestion = true; }],
  ])('sends on the current engine when %s during the handoff, since nothing is left to switch', async (_label, change) => {
    const ref: { h?: ReturnType<typeof harness> } = {};
    const h = harness({
      switchAgent: async (params) => {
        change(ref.h!);
        params.assertSelectionCurrent();
        return { switched: true };
      },
    });
    ref.h = h;
    await expect(h.send('task-1')).resolves.toBeUndefined();
    expect(h.row.agentKind).toBe('codex');
    expect(h.log.warn).toHaveBeenCalledTimes(1);
    expect(h.log.warn.mock.calls[0]![0]).toContain('no longer applies');
  });

  it('propagates a cancelled send and lets the next send switch', async () => {
    const controller = new AbortController();
    const h = harness({
      switchAgent: async (params) => {
        controller.abort();
        params.signal?.throwIfAborted();
        return { switched: true };
      },
    });
    await expect(h.send('task-1', controller.signal)).rejects.toThrow();
    h.switchAgent.mockImplementation(async () => ({ switched: true }));
    await h.send('task-1');
    expect(h.switchAgent).toHaveBeenCalledTimes(2);
  });

  it('defers the decision while the directory is not authoritative', async () => {
    const h = harness();
    markXdGatewayModelAccessUnknown();
    await h.send('task-1');
    expect(h.getSessionRow).not.toHaveBeenCalled();
    expect(h.switchAgent).not.toHaveBeenCalled();
    setXdGatewayModels([AUTO], { authoritative: true });
    await h.send('task-1');
    expect(h.switchAgent).toHaveBeenCalledTimes(1);
  });
});
