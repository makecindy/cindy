import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ media: vi.fn(), owner: vi.fn() }));
vi.mock('../../cindy-media/invocationService.js', () => ({ callCindyMedia: h.media }));
import { prepareBotInvitationAvatar, finishBotInvitationAvatar } from '../botInvitationAvatar.js';
import type { LedgerDb } from '../../cindy-media/ledger.js';

beforeEach(() => vi.resetAllMocks());

describe('optional invitation portrait', () => {
  it('uses an executable model with its exact provider and a prompt-only guide', async () => {
    h.media
      .mockResolvedValueOnce({
        ok: true,
        models: [{ id: 'current-image', provider_id: 'subscription' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        invocation_id: 'saved-1',
        input_schema: { properties: { prompt: {} }, required: ['prompt'] },
      });
    expect(await prepareBotInvitationAvatar(h.owner)).toBe('saved-1');
    expect(h.media).toHaveBeenLastCalledWith({
      action: 'prepare',
      capability: 'image.generate',
      modelId: 'current-image',
      providerId: 'subscription',
    });
  });

  it('skips a guide requiring extra vendor parameters instead of guessing a request', async () => {
    h.media
      .mockResolvedValueOnce({ ok: true, models: [{ id: 'current-image', provider_id: 'xd' }] })
      .mockResolvedValueOnce({
        ok: true,
        invocation_id: 'saved-1',
        input_schema: { properties: { prompt: {} }, required: ['prompt', 'vendorOption'] },
      });
    expect(await prepareBotInvitationAvatar(h.owner)).toBeNull();
    expect(h.media.mock.calls.every(([request]) => request.action !== 'request')).toBe(true);
  });

  it('reuses Core paid-submit deduplication and polls the same pending invocation', async () => {
    h.media
      .mockResolvedValueOnce({ ok: false, errorCode: 'INVOCATION_ALREADY_USED' })
      .mockResolvedValueOnce({ ok: false, errorCode: 'SUBMISSION_OUTCOME_UNKNOWN' });
    await expect(
      finishBotInvitationAvatar('saved-1', 'portrait', h.owner, {} as LedgerDb),
    ).rejects.toThrow();
    expect(h.media.mock.calls).toEqual([
      [{ action: 'request', invocationId: 'saved-1', body: { prompt: 'portrait' } }],
      [{ action: 'poll', invocationId: 'saved-1' }],
    ]);
  });

  it('does not prepare an image after the account changes during catalog lookup', async () => {
    h.media.mockResolvedValueOnce({
      ok: true,
      models: [{ id: 'current-image', provider_id: 'xd' }],
    });
    h.owner.mockImplementation(() => {
      throw new Error('owner changed');
    });
    await expect(prepareBotInvitationAvatar(h.owner)).rejects.toThrow('owner changed');
    expect(h.media).toHaveBeenCalledTimes(1);
  });
});
