import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('session effort store', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('clears a stale effort when a fixed-effort runtime profile supplies null', async () => {
    const { getSessionEffort, setSessionEffort } = await import('../session-effort-store');

    setSessionEffort('fixed-effort', 'xhigh');
    expect(getSessionEffort('fixed-effort')).toBe('xhigh');

    setSessionEffort('fixed-effort', null);
    expect(getSessionEffort('fixed-effort')).toBeNull();
  });
});
