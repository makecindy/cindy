import { describe, expect, it, vi } from 'vitest';

import { createPiRetiredRouteWindowGuard } from '../piRetiredRouteWindowGuard.js';

const CHECK = {
  model: 'gpt-6-sol',
  providerId: 'openai',
  catalogTargetWindow: 200_000,
  previousWindow: 200_000,
  contextTokensFloor: 95_000,
};

function createGuard(
  preparation: string = 'not-needed',
  liveWindow: number | null = 100_000,
) {
  const prepareModelWindowSwitch = vi.fn(async () => preparation as never);
  const readLiveContextWindow = vi.fn(() => liveWindow ?? undefined);
  const guard = createPiRetiredRouteWindowGuard({
    prepareModelWindowSwitch,
    readLiveContextWindow,
    log: { info: vi.fn(), warn: vi.fn() },
  });
  return { guard, prepareModelWindowSwitch, readLiveContextWindow };
}

describe('pi retired-route window guard', () => {
  it('does nothing for a session that never retired a route', async () => {
    const { guard, prepareModelWindowSwitch } = createGuard();
    await expect(guard.verifyBeforeSend('s1')).resolves.toEqual({ status: 'not-required' });
    expect(prepareModelWindowSwitch).not.toHaveBeenCalled();
  });

  it('blocks the send and keeps the marker when the new runtime reports no window', async () => {
    const { guard, prepareModelWindowSwitch } = createGuard('not-needed', null);
    guard.record('s1', CHECK);

    const result = await guard.verifyBeforeSend('s1');

    expect(result).toMatchObject({ status: 'failed', code: 'MODEL_WINDOW_TARGET_CONTEXT_UNKNOWN' });
    expect(result.status === 'failed' && result.message).toContain('这条消息没有发送');
    expect(prepareModelWindowSwitch).not.toHaveBeenCalled();
    // 失败不清标记：下一次发送必须重新核验，保护不允许被绕过。
    expect(guard.has('s1')).toBe(true);
  });

  it('verifies with the runtime window, re-checks target pressure and passes the usage floor', async () => {
    const { guard, prepareModelWindowSwitch } = createGuard('not-needed');
    guard.record('s1', CHECK);

    await expect(guard.verifyBeforeSend('s1')).resolves.toEqual({
      status: 'verified',
      contextWindow: 100_000,
      rebuilt: false,
    });

    expect(prepareModelWindowSwitch).toHaveBeenCalledWith('s1', {
      contextWindow: 100_000,
      recheckTargetPressure: true,
      confirmedTargetPressure: true,
      contextTokensFloor: 95_000,
    });
    expect(guard.has('s1')).toBe(false);
  });

  it('reports the protection rebuild and clears the marker', async () => {
    const { guard } = createGuard('rebuilt');
    guard.record('s1', CHECK);

    await expect(guard.verifyBeforeSend('s1')).resolves.toEqual({
      status: 'verified',
      contextWindow: 100_000,
      rebuilt: true,
    });
    expect(guard.has('s1')).toBe(false);
  });

  it('omits the usage floor when the session has no frozen live reading', async () => {
    const { guard, prepareModelWindowSwitch } = createGuard('not-needed');
    guard.record('s1', { ...CHECK, contextTokensFloor: null });

    await guard.verifyBeforeSend('s1');

    expect(prepareModelWindowSwitch).toHaveBeenCalledWith(
      's1',
      expect.not.objectContaining({ contextTokensFloor: expect.anything() }),
    );
  });

  it.each([
    ['busy', 'MODEL_SWITCH_TASK_RUNNING'],
    ['in-flight', 'MODEL_WINDOW_PREPARATION_IN_PROGRESS'],
    ['unknown-context', 'MODEL_WINDOW_CURRENT_CONTEXT_UNKNOWN'],
    ['remote-unsupported', 'MODEL_WINDOW_REMOTE_REBUILD_UNSUPPORTED'],
    ['confirmation-required', 'MODEL_WINDOW_PROTECTION_UNAVAILABLE'],
  ] as const)('maps %s to a recoverable failure and keeps the marker', async (preparation, code) => {
    const { guard } = createGuard(preparation);
    guard.record('s1', CHECK);

    const result = await guard.verifyBeforeSend('s1');

    expect(result).toMatchObject({ status: 'failed', code });
    expect(result.status === 'failed' && result.message).toContain('这条消息没有发送');
    expect(guard.has('s1')).toBe(true);
  });

  it('fails closed when the protection transaction itself throws', async () => {
    const prepareModelWindowSwitch = vi.fn(async () => {
      throw new Error('close failed');
    });
    const guard = createPiRetiredRouteWindowGuard({
      prepareModelWindowSwitch,
      readLiveContextWindow: () => 100_000,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    guard.record('s1', CHECK);

    await expect(guard.verifyBeforeSend('s1')).resolves.toMatchObject({
      status: 'failed',
      code: 'MODEL_WINDOW_PROTECTION_UNAVAILABLE',
    });
    expect(guard.has('s1')).toBe(true);
  });

  it('clears a pending check when the session closes', () => {
    const { guard } = createGuard();
    guard.record('s1', CHECK);
    expect(guard.read('s1')).toEqual(CHECK);

    guard.clear('s1');

    expect(guard.has('s1')).toBe(false);
  });
});
