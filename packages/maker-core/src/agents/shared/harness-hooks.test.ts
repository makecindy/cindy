import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarnessHookBridge } from './harness-hooks.js';

afterEach(() => vi.useRealTimers());

describe('native harness hook lifetime', () => {
  it('preserves native policy when absent, failed, or timed out', async () => {
    const bridge = createHarnessHookBridge();
    expect(await bridge.run({ name: 'tool.before' })).toEqual({ action: 'continue' });
    bridge.setHandler(async () => { throw new Error('unavailable'); });
    expect(await bridge.run({ name: 'tool.before' })).toEqual({ action: 'continue' });
    vi.useFakeTimers();
    bridge.setHandler(() => new Promise(() => {}));
    const result = bridge.run({ name: 'compaction.before' });
    await vi.advanceTimersByTimeAsync(1750);
    expect(await result).toEqual({ action: 'continue' });
  });

  it('unregisters immediately and ignores a late block', async () => {
    const bridge = createHarnessHookBridge();
    let finish!: (result: { action: 'block' }) => void;
    const dispose = bridge.setHandler(() => new Promise(resolve => { finish = resolve; }));
    const result = bridge.run({ name: 'tool.before' });
    await Promise.resolve();
    dispose();
    expect(await result).toEqual({ action: 'continue' });
    finish({ action: 'block' });
    expect(await bridge.run({ name: 'tool.before' })).toEqual({ action: 'continue' });
  });

  it('rejects pending native work when the runtime closes', async () => {
    const bridge = createHarnessHookBridge();
    bridge.setHandler(() => new Promise(() => {}));
    const result = bridge.run({ name: 'tool.before' });
    bridge.close();
    expect(await result).toEqual({ action: 'block' });
    expect(await bridge.run({ name: 'tool.before' })).toEqual({ action: 'block' });
  });

  it('does not invoke a handler disposed before its scheduled callback starts', async () => {
    const bridge = createHarnessHookBridge();
    const handler = vi.fn(async () => ({ action: 'continue' as const }));
    const dispose = bridge.setHandler(handler);
    const result = bridge.run({ name: 'tool.before' });
    dispose();
    expect(await result).toEqual({ action: 'continue' });
    expect(handler).not.toHaveBeenCalled();
  });
});
