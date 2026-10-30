import { describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost.js';
import { createGhostDisplayListHandler } from '../ghostDisplayListIpc.js';

// Unit: sendSync must reply during filesystem failures without leaking the last
// account's roster or hiding a genuine empty installation list after recovery.
describe('plugin display list recovery', () => {
  const ghost = { manifest: { id: 'hello' }, enabled: true } as InstalledGhost;
  function harness() {
    const state = { scope: 'owner-a:1', pending: false, complete: true };
    const list = vi.fn(() => [ghost]);
    const warn = vi.fn();
    const handler = createGhostDisplayListHandler({
      scopeKey: () => state.scope, isBoundaryPending: () => state.pending,
      isScanComplete: () => state.complete, list, warn,
    });
    return { state, list, warn, handler };
  }

  it('retains a complete roster during partial and failed scans, then observes a genuine removal', () => {
    const h = harness();
    expect(h.handler().ghosts).toEqual([ghost]);
    h.state.complete = false;
    h.list.mockReturnValue([]);
    expect(h.handler().ghosts).toEqual([ghost]);
    h.list.mockImplementationOnce(() => { throw new Error('unavailable'); });
    expect(h.handler().ghosts).toEqual([ghost]);
    expect(h.warn).toHaveBeenCalledOnce();
    h.state.complete = true;
    expect(h.handler().ghosts).toEqual([]);
  });

  it.each(['boundary', 'owner'] as const)('never reuses a previous roster after an %s change', (change) => {
    const h = harness();
    h.handler();
    if (change === 'boundary') h.state.pending = true;
    else h.state.scope = 'owner-b:2';
    h.list.mockImplementation(() => { throw new Error('unavailable'); });
    expect(h.handler().ghosts).toEqual([]);
    h.state.pending = false;
    expect(h.handler().ghosts).toEqual([]);
  });
});
