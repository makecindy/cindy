import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DbClient } from '../client/DbClient.js';
import { compactSessionToolResultsBestEffort } from '../toolResultCompaction.js';

function createClient(tx: ReturnType<typeof vi.fn>): DbClient {
  return { tx } as unknown as DbClient;
}

describe('tool result compaction trigger', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs one explicit-session compaction without a size threshold', async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 26, 8);
    vi.setSystemTime(now);
    const tx = vi.fn(async () => ({ compactedRows: 1, originalBytes: 70_000 }));

    await compactSessionToolResultsBestEffort({
      client: createClient(tx),
      sessionId: 'session-1',
    });

    expect(tx).toHaveBeenCalledTimes(1);
    expect(tx).toHaveBeenCalledWith('toolResults.compactSession', {
      sessionId: 'session-1',
      now,
    });
  });

  it('swallows a failed attempt without scheduling a retry', async () => {
    const tx = vi.fn(async () => {
      throw new Error('database closed');
    });

    await expect(
      compactSessionToolResultsBestEffort({
        client: createClient(tx),
        sessionId: 'session-1',
      }),
    ).resolves.toBeUndefined();
    expect(tx).toHaveBeenCalledTimes(1);
  });
});
