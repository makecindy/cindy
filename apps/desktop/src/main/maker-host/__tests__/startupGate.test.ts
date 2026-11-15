import { afterEach, describe, expect, it, vi } from 'vitest';
import { Maker, createConsoleLogger, type BaseAgent } from '@cindy/maker-core';
import { createMakerStartupGate } from '../startup-gate.js';
import { createPiRuntimeRecovery, prepareOptionalPiRuntime } from '../../agent-binaries/pi-runtime-recovery.js';

afterEach(() => vi.useRealTimers());

describe('Maker binary startup boundary', () => {
  it.each([true, false])('waits for Pi result before construction (ready=%s), then recovers if needed', async (ready) => {
    const gate = createMakerStartupGate();
    const agent = {} as BaseAgent;
    let maker: Maker | undefined;
    let piReady = false;
    let finishPrepare!: (result: { ready: boolean; path?: string; error?: string }) => void;
    const getMaker = vi.fn(() => {
      gate.assertComplete();
      return maker ??= new Maker({
        agents: { 'claude-code': agent, codex: agent, ...(piReady ? { pi: agent } : {}) },
        storage: {
          create: vi.fn(), get: vi.fn(), list: vi.fn(), update: vi.fn(),
          compareAndClearSdkSessionId: vi.fn(), delete: vi.fn(),
        },
        logger: createConsoleLogger('startup-test'),
      });
    });
    const register = () => maker?.registerAgent('pi', agent) ?? false;
    const startup = prepareOptionalPiRuntime({
      prepare: () => new Promise((resolve) => { finishPrepare = resolve; }),
      register: () => !maker || register(),
    });
    const pluginRequest = gate.wait(1_000).then((available) => available ? getMaker() : null);
    expect(() => getMaker()).toThrow('startup preparation');
    await Promise.resolve();
    expect(maker).toBeUndefined();

    piReady = ready;
    finishPrepare(ready ? { ready: true, path: '/managed/pi' } : { ready: false, error: 'NETWORK' });
    const result = await startup;
    expect(result.status).toBe(ready ? 'passed' : 'failed');
    gate.complete();
    const instance = await pluginRequest;
    expect(instance?.listAvailableAgents()).toEqual(ready ? ['claude-code', 'codex', 'pi'] : ['claude-code', 'codex']);
    expect(getMaker()).toBe(instance);

    if (!ready) {
      const recovery = createPiRuntimeRecovery({
        isOnline: () => true,
        prepare: async () => ({ ready: true, path: '/managed/pi' }),
        register,
        onRegistered: vi.fn(),
      });
      try {
        recovery.markUnavailable(result.error);
        expect(await recovery.retryNow()).toBe(true);
        expect(await recovery.retryNow()).toBe(false);
        expect(instance?.listAvailableAgents()).toEqual(['claude-code', 'codex', 'pi']);
        expect(getMaker()).toBe(instance);
      } finally {
        recovery.dispose();
      }
    }
  });

  it('times out one caller without releasing startup or executing it later', async () => {
    vi.useFakeTimers();
    const gate = createMakerStartupGate();
    const request = vi.fn();
    const expired = gate.wait(10).then((ready) => { if (ready) request(); return ready; });
    const survivor = gate.wait(100);
    await vi.advanceTimersByTimeAsync(10);
    expect(await expired).toBe(false);
    expect(() => gate.assertComplete()).toThrow('startup preparation');
    gate.complete();
    gate.complete();
    expect(await survivor).toBe(true);
    expect(await gate.wait(100)).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

});
