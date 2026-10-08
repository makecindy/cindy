import { describe, expect, it, vi } from 'vitest';
import { patchRemoteAutoTitle } from '../patchRemoteAutoTitle';

describe('patchRemoteAutoTitle', () => {
  it('sends the source and expected title to the remote conditional write', async () => {
    const invoke = vi.fn(async () => undefined);

    await patchRemoteAutoTitle(invoke, 'device', 'session', 'new title', 'old title');

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('device', 'local-db:sessions:patch-meta', [
      'session',
      { title: 'new title', titleSource: 'auto', expectedTitle: 'old title' },
    ]);
  });

  it.each(['titleSource', 'expectedTitle'])('supports old hosts rejecting %s', async (field) => {
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('[INVALID_PARAMS] field not allowed in patch-meta: ' + field),
      )
      .mockResolvedValueOnce(undefined);

    await patchRemoteAutoTitle(invoke, 'device', 'session', 'new title', 'old title');

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith('device', 'local-db:sessions:patch-meta', [
      'session',
      { title: 'new title' },
    ]);
  });

  it.each([
    'request timed out',
    '[INTERNAL] database unavailable',
    '[INVALID_PARAMS] automatic title requires expectedTitle',
    '[INVALID_PARAMS] field not allowed in patch-meta: status',
  ])('does not retry ambiguous or unrelated errors: %s', async (message) => {
    const error = new Error(message);
    const invoke = vi.fn().mockRejectedValueOnce(error);

    await expect(patchRemoteAutoTitle(invoke, 'device', 'session', 'title', 'old')).rejects.toBe(
      error,
    );
    expect(invoke).toHaveBeenCalledOnce();
  });
});
