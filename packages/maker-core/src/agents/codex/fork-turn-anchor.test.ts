import { describe, expect, it, vi } from 'vitest';
import { resolveForkTurnAnchor } from './fork-turn-anchor.js';

describe('resolveForkTurnAnchor', () => {
  it('ignores UI tail counts when a hidden failed retry remains in native history', async () => {
    const request = vi.fn().mockResolvedValue({ data: [
      { id: 'visible-retry-2', status: 'failed', startedAt: 400 },
      { id: 'visible-retry-1', status: 'failed', startedAt: 300 },
      { id: 'hidden-retry', status: 'failed', startedAt: 200 },
      { id: 'requested-turn', status: 'interrupted', startedAt: 100 },
    ], nextCursor: null });
    await expect(resolveForkTurnAnchor(request, 'source', 2, 110_123)).resolves.toBe('requested-turn');
  });

  it('does not include a hidden later retry even when the UI reports no tail turns', async () => {
    const request = vi.fn().mockResolvedValue({ data: [
      { id: 'hidden-retry', status: 'failed', startedAt: 200 },
      { id: 'requested-turn', status: 'interrupted', startedAt: 100 },
    ], nextCursor: null });
    await expect(resolveForkTurnAnchor(request, 'source', 0, 110_123)).resolves.toBe('requested-turn');
  });

  it.each([undefined, null, 110])('refuses missing or same-second ambiguous native timestamps (%s)', async (startedAt) => {
    const request = vi.fn().mockResolvedValue({
      data: [{ id: 'uncertain', status: 'failed', startedAt }], nextCursor: null,
    });
    await expect(resolveForkTurnAnchor(request, 'source', 2, 110_123)).rejects.toThrow();
  });

  it('finds a failed boundary across metadata pages without loading message bodies', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ data: [{ id: 'retry-2', status: 'failed' }], nextCursor: 'page-2' })
      .mockResolvedValueOnce({ data: [
        { id: 'retry-1', status: 'failed' }, { id: 'boundary', status: 'interrupted' },
      ], nextCursor: null });
    await expect(resolveForkTurnAnchor(request, 'source', 2)).resolves.toBe('boundary');
    expect(request.mock.calls.map(([, params]) => params)).toEqual([
      { threadId: 'source', limit: 3, sortDirection: 'desc', itemsView: 'notLoaded' },
      { threadId: 'source', cursor: 'page-2', limit: 2, sortDirection: 'desc', itemsView: 'notLoaded' },
    ]);
  });

  it.each([
    { data: [], nextCursor: null },
    { data: [{ id: 'live', status: 'inProgress' }], nextCursor: null },
    { data: [{ id: 'only-turn', status: 'completed' }], nextCursor: null },
  ])('rejects a boundary it cannot establish: %j', async (page) => {
    await expect(resolveForkTurnAnchor(vi.fn().mockResolvedValue(page), 'source', 1)).rejects.toThrow();
  });

  it('rejects repeated pages instead of selecting a duplicate turn or looping', async () => {
    const request = vi.fn().mockResolvedValue({
      data: [{ id: 'repeated', status: 'completed' }], nextCursor: 'same',
    });
    await expect(resolveForkTurnAnchor(request, 'source', 5)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
