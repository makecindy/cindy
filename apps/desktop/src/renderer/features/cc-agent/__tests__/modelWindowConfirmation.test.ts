import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { setModelWithWindowConfirmation } from '../lib/modelWindowConfirmation';

const pressure = {
  deferred: false,
  superseded: false,
  contextWindowConfirmationRequired: 200_000,
  contextTokensForConfirmation: 180_000,
};

describe('Claude subscription model-window confirmation', () => {
  it('gates the subscription recovery route before persistence and retry', () => {
    const source = readFileSync(new URL('../CCAgentSessionView.tsx', import.meta.url), 'utf8');
    const start = source.indexOf('const handleSwitchToClaudeSubscription = useCallback');
    const end = source.indexOf('const handleSilentStopContinue', start);
    const handler = source.slice(start, end);

    expect(handler).toContain('setModelWithWindowConfirmation({');
    expect(handler).toContain('confirmedContextWindow');
    expect(handler).toContain('(EFFORT_VALUES as readonly string[]).includes(session.effort)');
    expect(handler).toContain(': null;');
    expect(handler).toContain('effort: retryEffort,');
    expect(handler).not.toContain('effort: session.effort');
    expect(handler.indexOf('if (!switched) return;')).toBeLessThan(
      handler.indexOf('sessionService.update(sessionId'),
    );
    expect(handler.indexOf('sessionService.update(sessionId')).toBeLessThan(
      handler.indexOf('retryLastError()'),
    );
  });

  it('keeps the ordinary route when Main reports no destructive pressure', async () => {
    const invoke = vi.fn().mockResolvedValue({ deferred: false, superseded: false });
    await expect(
      setModelWithWindowConfirmation({ invoke, confirm: async () => true }),
    ).resolves.toBe('applied');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('does not retry or apply when the first 1M to 200K pressure is cancelled', async () => {
    const invoke = vi.fn().mockResolvedValue(pressure);
    const confirm = vi.fn().mockResolvedValue(false);

    await expect(setModelWithWindowConfirmation({ invoke, confirm })).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith();
    expect(confirm).toHaveBeenCalledWith({ contextWindow: 200_000, contextTokens: 180_000 });
  });

  it('retries only with the exact confirmed target window', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(pressure)
      .mockResolvedValueOnce({ deferred: false, superseded: false });

    await expect(
      setModelWithWindowConfirmation({ invoke, confirm: async () => true }),
    ).resolves.toBe('confirmed');
    expect(invoke.mock.calls).toEqual([[], [200_000]]);
  });

  it('fails closed when the final window drifts before the confirmed retry', async () => {
    const invoke = vi.fn().mockResolvedValueOnce(pressure).mockResolvedValueOnce({
      deferred: false,
      superseded: false,
      contextWindowConfirmationRequired: 180_000,
      contextTokensForConfirmation: 180_000,
    });

    await expect(
      setModelWithWindowConfirmation({ invoke, confirm: async () => true }),
    ).resolves.toBe(false);
  });

  it('fails closed on malformed confirmation facts and propagated busy/unknown errors', async () => {
    await expect(
      setModelWithWindowConfirmation({
        invoke: async () => ({
          deferred: false,
          superseded: false,
          contextWindowConfirmationRequired: 200_000,
        }),
        confirm: async () => true,
      }),
    ).rejects.toThrow('verified model-window confirmation is invalid');

    await expect(
      setModelWithWindowConfirmation({
        invoke: async () => undefined,
        confirm: async () => true,
      }),
    ).rejects.toThrow('did not return an applied result');
    await expect(
      setModelWithWindowConfirmation({
        invoke: async () => ({ deferred: true, superseded: false }),
        confirm: async () => true,
      }),
    ).rejects.toThrow('did not return an applied result');

    const busy = new Error('wait for the current turn');
    await expect(
      setModelWithWindowConfirmation({
        invoke: async () => {
          throw busy;
        },
        confirm: async () => true,
      }),
    ).rejects.toBe(busy);
  });
});
