/**
 * 测试价值
 * - 生产入口与可观察结果：startRemoteSwitch；只有目标明确回答所请求的状态才返回 done，超时返回 failed。
 * - Bug／规则依据：PR #10095 discussion_r4546058345；DESIGN.md §11.1 与 agent-net.md 的真实结果要求。
 * - 现有覆盖缺口：目标端测试不运行发起端的等待逻辑，原先切回超时也会报告完成。
 * - 最小失败输入：接受关闭请求后，目标始终回答 enabled=true，或重连期间一直无法联系。
 * - tier：unit，真实编排入口、内存宿主与假时钟，不需要 DOM、网络或实际等待。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SelfHostedRelayCommand } from '../../../../shared/selfHostedRelay';
import { startRemoteSwitch } from '../agentNetRemoteSwitch';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('remote Agent-Net switch result on the requesting computer', () => {
  it.each(['still-enabled', 'unreachable'] as const)('does not report a completed switch-back when the target remains %s', async (failure) => {
    const command = vi.fn(async (input: SelfHostedRelayCommand) => {
      if (input.type !== 'peer-agent-net') throw new Error('unexpected command');
      const peer = input.request.action === 'set'
        ? { ok: true, result: { switchId: input.request.switchId, enabled: false, confirmWithinMs: null } }
        : failure === 'still-enabled'
          ? { ok: true, result: { enabled: true } }
          : { ok: false, code: 'NOT_CONNECTED', message: 'not connected' };
      return { state: {}, peer };
    });
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, electronAPI: { selfHostedRelay: { command } } });
    const result = startRemoteSwitch(failure, 'device-link');
    await vi.advanceTimersByTimeAsync(32_000);
    await expect(result).resolves.toBe('failed');
  });

  it('does not accept an already-enabled switch as proof that the connection is encrypted', async () => {
    const command = vi.fn(async (input: SelfHostedRelayCommand) => {
      if (input.type !== 'peer-agent-net') throw new Error('unexpected command');
      return { state: {}, peer: { ok: true, result: input.request.action === 'set'
        ? { switchId: input.request.switchId, enabled: true, confirmWithinMs: null }
        : { enabled: true, encrypted: false, pending: false } } };
    });
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, electronAPI: { selfHostedRelay: { command } } });
    const result = startRemoteSwitch('enabled-but-legacy', 'agent-net');
    await vi.advanceTimersByTimeAsync(32_000);
    await expect(result).resolves.toBe('failed');
  });

  it('uses actual encrypted status to recover when the confirmation reply was lost', async () => {
    const command = vi.fn(async (input: SelfHostedRelayCommand) => {
      if (input.type !== 'peer-agent-net') throw new Error('unexpected command');
      const peer = input.request.action === 'set'
        ? { ok: true, result: { switchId: input.request.switchId, enabled: true, confirmWithinMs: 60_000 } }
        : input.request.action === 'confirm'
          ? { ok: false, code: 'IPC_ERROR', message: '[AGENT_NET_SWITCH_STALE] already confirmed' }
          : { ok: true, result: { enabled: true, encrypted: true, pending: false } };
      return { state: {}, peer };
    });
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, electronAPI: { selfHostedRelay: { command } } });
    const result = startRemoteSwitch('confirmed-reply-lost', 'agent-net');
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(result).resolves.toBe('done');
  });

  it('completes after reconnection actually reports the requested disabled state', async () => {
    let statuses = 0;
    const command = vi.fn(async (input: SelfHostedRelayCommand) => {
      if (input.type !== 'peer-agent-net') throw new Error('unexpected command');
      return { state: {}, peer: { ok: true, result: input.request.action === 'set'
        ? { switchId: input.request.switchId, enabled: false, confirmWithinMs: null }
        : { enabled: ++statuses < 2 } } };
    });
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, electronAPI: { selfHostedRelay: { command } } });
    const result = startRemoteSwitch('reconnected', 'device-link');
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toBe('done');
    expect(statuses).toBe(2);
  });
});
