import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  broadcastRemoteResourceChanged: vi.fn(),
  tx: vi.fn(),
}));

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({ tx: h.tx }),
}));
vi.mock('../botRemoteResourceInvalidation.js', () => ({
  broadcastBotRemoteResourceChanged: h.broadcastRemoteResourceChanged,
}));

import { clearBotAttention, noteBotAttention } from '../botAttentionService.js';

describe('Bot durable attention service', () => {
  beforeEach(() => {
    h.tx.mockReset();
    h.tx.mockResolvedValue({ changed: true });
    h.broadcastRemoteResourceChanged.mockReset();
  });

  it('persists a typed user-action failure', async () => {
    await expect(noteBotAttention({
      botId: 'bot-1',
      failure: new Error('Error code: 403 - invalid API key'),
      observedAt: 20,
    })).resolves.toEqual({ reason: 'provider_auth_or_access', changed: true });
    expect(h.tx).toHaveBeenCalledWith('bots.updateAttention', {
      botId: 'bot-1',
      reason: 'provider_auth_or_access',
      observedAt: 20,
    });
    expect(h.broadcastRemoteResourceChanged).toHaveBeenCalledWith('bot-1');
  });

  it('keeps transient failures in native diagnostics without a durable badge', async () => {
    await expect(noteBotAttention({
      botId: 'bot-1',
      failure: new Error('Error code: 429 - rate limited'),
      observedAt: 20,
    })).resolves.toEqual({ reason: 'provider_rate_limit', changed: false });
    expect(h.tx).not.toHaveBeenCalled();
    expect(h.broadcastRemoteResourceChanged).not.toHaveBeenCalled();
  });

  it('clears through the same monotonic transaction', async () => {
    await expect(clearBotAttention({ botId: 'bot-1', successfulAt: 30 }))
      .resolves.toEqual({ reason: null, changed: true });
    expect(h.tx).toHaveBeenCalledWith('bots.updateAttention', {
      botId: 'bot-1',
      reason: null,
      observedAt: 30,
    });
    expect(h.broadcastRemoteResourceChanged).toHaveBeenCalledWith('bot-1');
  });

  it('does not invalidate when the monotonic attention write is unchanged', async () => {
    h.tx.mockResolvedValue({ changed: false });
    await expect(clearBotAttention({ botId: 'bot-1', successfulAt: 30 }))
      .resolves.toEqual({ reason: null, changed: false });
    expect(h.broadcastRemoteResourceChanged).not.toHaveBeenCalled();
  });
});
