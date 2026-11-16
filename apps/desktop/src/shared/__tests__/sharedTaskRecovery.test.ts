import { afterEach, describe, expect, it, vi } from 'vitest';
import { canRecoverUndeliveredOrcaReport, probeSharedTask } from '../sharedTaskRecovery.js';

// Unit: the actual probe runner must survive a short outage without repeating
// allocation/open/send. Earlier coverage did not exercise delayed recovery or
// cancellation between attempts. Fake time keeps all delays in-process.
afterEach(() => vi.useRealTimers());
describe('shared task report preparation recovery', () => {
  it('recovers only the failed read after a short outage', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValueOnce({ code: 'LINK_CLOSED' })
      .mockRejectedValueOnce({ code: 'TIMEOUT' }).mockResolvedValue({ available: true });
    const result = probeSharedTask('capability', read, () => {});
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toEqual({ available: true });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('cancels a delayed probe before another remote request', async () => {
    vi.useFakeTimers();
    let current = true;
    const read = vi.fn().mockRejectedValue({ code: 'TIMEOUT' });
    const result = probeSharedTask('executor', read, () => { if (!current) throw new Error('cancelled'); });
    const rejected = expect(result).rejects.toThrow('cancelled');
    await vi.advanceTimersByTimeAsync(0);
    current = false;
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('preserves the classified error when the bounded probe retries are exhausted', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValue({ code: 'TIMEOUT' });
    const rejected = expect(probeSharedTask('capability', read, () => {}))
      .rejects.toThrow('[SHARED_TASK_RECOVERY_timeout] [SHARED_TASK_STAGE_capability]');
    await vi.advanceTimersByTimeAsync(4_000);
    await rejected;
    expect(read).toHaveBeenCalledTimes(4);
  });

  it.each(['ACCESS_REVOKED', 'REMOTE_AGENT_BUSY', 'REMOTE_AGENT_UNAVAILABLE'])('does not retry a definitive or unknown %s failure', async code => {
    const read = vi.fn().mockRejectedValue({ code });
    await expect(probeSharedTask('capability', read, () => {})).rejects.toThrow();
    expect(read).toHaveBeenCalledOnce();
  });

  it.each(['allocation', 'authorization', 'executor', 'capability'])('does not replay startup after a possible grant write at %s', stage => {
    expect(canRecoverUndeliveredOrcaReport(
      `[REMOTE_AGENT_UNAVAILABLE] [SHARED_TASK_RECOVERY_timeout] [SHARED_TASK_STAGE_${stage}]`,
    )).toBe(false);
  });
});
