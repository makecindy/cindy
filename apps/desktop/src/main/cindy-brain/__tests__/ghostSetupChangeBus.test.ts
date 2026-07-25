import { describe, expect, it, vi } from 'vitest';

import { GhostSetupChangeBus } from '../ghostSetupChangeBus';

describe('GhostSetupChangeBus', () => {
  it('maintains a monotonic revision per ghost and emits no stored values', () => {
    const bus = new GhostSetupChangeBus();
    const listener = vi.fn();
    bus.subscribe('gmail', listener);

    expect(bus.emit('gmail', { source: 'secret', ref: 'api_key' })).toEqual({
      ghostId: 'gmail',
      source: 'secret',
      ref: 'api_key',
      revision: 1,
    });
    expect(bus.emit('gmail', { source: 'oauth', ref: 'google' }).revision).toBe(2);
    expect(bus.emit('art', { source: 'host_config' }).revision).toBe(1);
    expect(JSON.stringify(listener.mock.calls)).not.toContain('secret-value');
  });

  it('unsubscribe stops delivery without changing the current revision', () => {
    const bus = new GhostSetupChangeBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe('gmail', listener);
    bus.emit('gmail', { source: 'kv' });
    unsubscribe();
    bus.emit('gmail', { source: 'kv' });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(bus.currentRevision('gmail')).toBe(2);
  });

  it('wakes waiters without advancing the accepted setup revision', () => {
    const bus = new GhostSetupChangeBus();
    const listener = vi.fn();
    bus.subscribe('gmail', listener);
    bus.emit('gmail', { source: 'oauth' });

    expect(bus.wake('gmail', { source: 'focus' })).toEqual({
      ghostId: 'gmail',
      source: 'focus',
      revision: 1,
    });
    expect(bus.currentRevision('gmail')).toBe(1);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: 'focus', revision: 1 }),
    );
  });

  it('isolates listener failures so committed writes and other waiters keep progressing', () => {
    const warn = vi.fn();
    const bus = new GhostSetupChangeBus({ warn });
    const healthy = vi.fn();
    bus.subscribe('gmail', () => {
      throw new Error('broken waiter');
    });
    bus.subscribe('gmail', healthy);

    expect(() => bus.emit('gmail', { source: 'oauth' })).not.toThrow();
    expect(healthy).toHaveBeenCalledWith(
      expect.objectContaining({ ghostId: 'gmail', revision: 1 }),
    );
    expect(warn).toHaveBeenCalledOnce();
  });

  it('broadcasts shared Host configuration changes only to current waiters', () => {
    const bus = new GhostSetupChangeBus();
    const gmail = vi.fn();
    const art = vi.fn();
    bus.subscribe('gmail', gmail);
    bus.subscribe('art', art);

    expect(bus.emitAll({ source: 'host_config', ref: 'model-provider' })).toEqual([
      {
        ghostId: 'gmail',
        source: 'host_config',
        ref: 'model-provider',
        revision: 1,
      },
      {
        ghostId: 'art',
        source: 'host_config',
        ref: 'model-provider',
        revision: 1,
      },
    ]);
    expect(gmail).toHaveBeenCalledOnce();
    expect(art).toHaveBeenCalledOnce();
  });
});
