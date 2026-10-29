import { describe, expect, it, vi } from 'vitest';
import { VoiceInputOperationQueue } from '../VoiceInputOperationQueue';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('per-window voice lifecycle serialization', () => {
  it('waits for pending start and replacement disposal before connecting the next provider', async () => {
    const queue = new VoiceInputOperationQueue();
    const connected = deferred();
    const disposed = deferred();
    const first = { id: 'thread', cancel: vi.fn(), dispose: vi.fn(() => disposed.promise) };
    const second = { id: 'group', cancel: vi.fn() };
    let active: typeof first | typeof second | undefined;
    const connectSecond = vi.fn();
    const a = queue.run(1, async () => { await connected.promise; active = first; return first.id; });
    const b = queue.run(1, async () => {
      const previous = active;
      previous?.cancel();
      if (previous === first) await first.dispose();
      connectSecond();
      active = second;
      return second.id;
    });
    await Promise.resolve();
    expect(active).toBeUndefined();
    expect(connectSecond).not.toHaveBeenCalled();
    connected.resolve();
    expect(await a).toBe('thread');
    await Promise.resolve();
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(connectSecond).not.toHaveBeenCalled();
    disposed.resolve();
    expect(await b).toBe('group');
    expect(active).toBe(second);
    expect(second.cancel).not.toHaveBeenCalled();
  });

  it.each(['stop', 'cancel'])('does not let an awaited %s cleanup erase a replacement start', async operation => {
    const queue = new VoiceInputOperationQueue();
    const cleanup = deferred();
    let active = 'old';
    const finish = queue.run(1, async () => { await cleanup.promise; active = ''; return operation; });
    const replace = queue.run(1, async () => { active = 'new'; });
    await Promise.resolve();
    expect(active).toBe('old');
    cleanup.resolve();
    expect(await finish).toBe(operation);
    await replace;
    expect(active).toBe('new');
  });

  it('keeps another window responsive while a provider is connecting', async () => {
    const queue = new VoiceInputOperationQueue();
    const gate = deferred();
    const blocked = queue.run(1, () => gate.promise);
    expect(await queue.run(2, async () => 'ready')).toBe('ready');
    gate.resolve();
    await blocked;
  });

  it('releases the lane after rejection and after synchronous exceptions', async () => {
    const queue = new VoiceInputOperationQueue();
    const failed = queue.run(1, async () => { throw new Error('connect failed'); });
    const next = queue.run(1, async () => 'ready');
    await expect(failed).rejects.toThrow('connect failed');
    expect(await next).toBe('ready');
    await expect(queue.run(1, () => { throw new Error('sync'); })).rejects.toThrow('sync');
    expect(await queue.run(1, async () => 'again')).toBe('again');
  });
});
