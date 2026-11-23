import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceLinkError, providerShareHostPeer, REMOTE_AGENT_CHANNEL } from '@cindy/device-link';
import { createResponsivenessTracker } from '../../main/device-link/responsivenessTracker';
import { ensureInvokeLinkReady } from '../../main/device-link/linkRecovery';
import { canRecoverUndeliveredOrcaReport, probeSharedTask, sharedTaskFailureReason, sharedTaskRecoveryError } from '../sharedTaskRecovery.js';

// Unit: the actual probe runner must survive a short outage without repeating
// allocation/open/send. Earlier coverage did not exercise delayed recovery or
// cancellation between attempts. Fake time keeps all delays in-process.
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe('shared task report preparation recovery', () => {
  it('recovers only the failed read after a short outage', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const read = vi.fn().mockRejectedValueOnce({ code: 'LINK_CLOSED' })
      .mockRejectedValueOnce({ code: 'TIMEOUT' }).mockResolvedValue({ available: true });
    const result = probeSharedTask('capability', read, () => {});
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toEqual({ available: true });
    expect(read).toHaveBeenCalledTimes(3);
  });

  // Unit regression: an executor restart/circuit cooldown can exceed the old
  // four-second retry window. Only the same idempotent probe may be repeated.
  it.each([{ outage: 30_000, calls: 7 }, { outage: 150_000, calls: 13 }])('waits for the original executor after a $outage ms outage', async ({ outage, calls }) => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    let online = false;
    const read = vi.fn(async () => {
      if (!online) throw { code: 'DEVICE_UNRESPONSIVE' };
      return 'original-executor';
    });
    const result = probeSharedTask('executor', read, () => {})
      .then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(outage);
    online = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toEqual({ value: 'original-executor' });
    expect(read).toHaveBeenCalledTimes(calls);
  });

  // #11595 review regression (unit): compose the real retry runner, breaker and
  // pre-invoke link recovery. The previous single-RPC approximation omitted
  // serial link/caps budgets, including readiness, admission and first write.
  // In-memory ports and fake time cover the whole cycle without network/I/O.
  it.each([
    { name: 'two serial RPCs', linkWaits: [30_000], capsWaits: [30_000], availableAt: 120_000, expectedProbes: 2 },
    { name: 'late recovery after two failed probes', linkWaits: [1_500, 29_999, 29_999], capsWaits: [29_999, 9_999, 29_999], availableAt: 400_000, expectedProbes: 3 },
    { name: 'recovery at the tolerated outage boundary', linkWaits: [1_500, 29_999, 29_999], capsWaits: [29_999, 9_999, 29_999], availableAt: 413_000, expectedProbes: 3 },
  ])('survives a complete breaker cycle with $name', async ({ linkWaits, capsWaits, availableAt, expectedProbes }) => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const peer = providerShareHostPeer('shared', 'executor-m');
    let offset = 0, warming = true, linkReady = false, probes = 0;
    const delay = async (waits: number[]) => {
      for (const ms of waits) await new Promise<void>(resolve => setTimeout(resolve, ms));
    };
    const timeout = () => new DeviceLinkError('INVOKE_TIMEOUT', 'probe timed out');
    const tracker = createResponsivenessTracker({
      now: () => offset + performance.now(),
      isProbeEligible: () => true,
      onUnresponsiveChanged: () => {},
      probeInvoke: async () => {
        if (warming) throw timeout();
        probes++;
        await ensureInvokeLinkReady(() => !linkReady, async () => {
          await delay(linkWaits);
          linkReady = true;
        }, () => {});
        // A request sent while unavailable cannot retroactively gain a reply.
        // Availability is external to the probe counter, including a second miss.
        const responds = performance.now() >= availableAt;
        await delay(capsWaits);
        if (!responds) { linkReady = false; throw timeout(); }
        return 'caps';
      },
    });
    for (let i = 0; i < 3; i++)
      await expect(tracker.guardInvoke(peer, REMOTE_AGENT_CHANNEL, async () => { throw timeout(); }))
        .rejects.toThrow('probe timed out');
    // Exercise the real exponential breaker up to its 120s cooldown.
    for (const cooldown of [10_000, 20_000, 40_000, 80_000]) {
      offset += cooldown;
      tracker.probeTick();
      await vi.advanceTimersByTimeAsync(0);
    }
    offset += 120_000;
    warming = false;
    tracker.probeTick(); // Already in flight when this task starts waiting.
    const result = probeSharedTask('capability', () => tracker.guardInvoke(peer, REMOTE_AGENT_CHANNEL,
      async () => 'original-executor'), () => {})
      .then(value => ({ value }), error => ({ error }));
    // Offset the 5s tick to exercise the cooldown's final partial tick.
    await vi.advanceTimersByTimeAsync(4_999);
    const tick = setInterval(() => tracker.probeTick(), 5_000);
    try {
      await expect(tracker.guardInvoke('other-peer', REMOTE_AGENT_CHANNEL, async () => 'healthy'))
        .resolves.toBe('healthy');
      await vi.advanceTimersByTimeAsync(826_000 - 4_999);
      await expect(result).resolves.toEqual({ value: 'original-executor' });
      expect(probes).toBe(expectedProbes);
      expect(tracker.isUnresponsive(peer)).toBe(false);
      expect(tracker.isUnresponsive('other-peer')).toBe(false);
    } finally {
      clearInterval(tick);
      tracker.resetAll();
    }
  });

  // #11595 (unit): fast breaker rejections plus extreme jitter used to exhaust
  // the attempt count or abandon the final delay before the elapsed-time budget.
  // This covers the runner's last permitted read, not a peer-availability
  // promise: peer recovery uses the separate outage horizon tested above.
  it.each([0, 0.5, 1])('keeps the last permitted read through the hard stop (random=%s)', async random => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(random);
    const started = performance.now();
    const attempts: number[] = [];
    const read = vi.fn(async () => {
      attempts.push(performance.now() - started);
      if (performance.now() - started < 826_000) throw { code: 'DEVICE_UNRESPONSIVE' };
      return 'original-executor';
    });
    const result = probeSharedTask('executor', read, () => {})
      .then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(826_000);
    await expect(result).resolves.toEqual({ value: 'original-executor' });
    expect(attempts.at(-1)).toBe(826_000);
    expect(attempts.length).toBeLessThanOrEqual(63);
  });

  it('cancels a delayed probe before another remote request', async () => {
    vi.useFakeTimers();
    let current = true;
    const read = vi.fn().mockRejectedValue({ code: 'TIMEOUT' });
    const result = probeSharedTask('executor', read, () => { if (!current) throw new Error('cancelled'); });
    const rejected = expect(result).rejects.toThrow('cancelled');
    await vi.advanceTimersByTimeAsync(0);
    current = false;
    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('preserves the classified error when the bounded probe retries are exhausted', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const read = vi.fn().mockRejectedValue({ code: 'TIMEOUT' });
    const rejected = expect(probeSharedTask('capability', read, () => {}))
      .rejects.toThrow('[SHARED_TASK_RECOVERY_timeout] [SHARED_TASK_STAGE_capability]');
    await vi.advanceTimersByTimeAsync(900_000);
    await rejected;
    expect(read).toHaveBeenCalledTimes(47);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds slow failed probes by elapsed time as well as attempt count', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const read = vi.fn(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 30_000));
      throw { code: 'TIMEOUT' };
    });
    const rejected = expect(probeSharedTask('capability', read, () => {}))
      .rejects.toThrow('[SHARED_TASK_RECOVERY_timeout]');
    await vi.advanceTimersByTimeAsync(900_000);
    await rejected;
    expect(read).toHaveBeenCalledTimes(19);
  });

  it('ends backoff immediately on cancellation without another probe or a leftover timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error('archived');
    const read = vi.fn().mockRejectedValue({ code: 'DEVICE_UNRESPONSIVE' });
    const rejected = expect(probeSharedTask('executor', read, () => {}, controller.signal)).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    controller.abort(reason);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not start a stale retry when its backoff timer runs after the deadline', async () => {
    vi.useFakeTimers();
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const read = vi.fn().mockRejectedValue({ code: 'TIMEOUT' });
    const rejected = expect(probeSharedTask('executor', read, () => {})).rejects.toThrow('[SHARED_TASK_RECOVERY_timeout]');
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    now.mockReturnValue(826_001);
    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each([0, 1])('jitters retry timing within its bounded window (random=%s)', async random => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(random);
    const read = vi.fn().mockRejectedValueOnce({ code: 'TIMEOUT' })
      .mockRejectedValueOnce({ code: 'TIMEOUT' }).mockResolvedValue('ready');
    const result = probeSharedTask('capability', read, () => {});
    const delay = random === 0 ? 750 : 1_250;
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('ready');
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

// #10848, unit: the public wrapper must retain bounded local diagnostics, not
// secret-bearing Error messages/stacks/metadata. Existing probes tested only
// the message and could not detect a dropped or unsafe cause.
describe('shared task bounded diagnostic cause', () => {
  it('retains a safe source code and classification without retaining the upstream object', () => {
    const source = Object.assign(new Error('https://private.invalid secret-account'), { code: 'TIMEOUT', privateData: 'secret' });
    const error = sharedTaskRecoveryError('owner', sharedTaskFailureReason(source), source);
    expect(error.cause).toEqual({ reason: 'timeout', code: 'TIMEOUT' });
    expect(error.cause).not.toBe(source);
    expect(Object.keys(error)).not.toContain('cause');
    expect(JSON.stringify(error.cause)).not.toMatch(/private|secret|https/);
    expect(error.message).toContain('[SHARED_TASK_CODE_TIMEOUT]');
  });

  it('does not guess a business reason or retain unknown source metadata', () => {
    const source = Object.assign(new Error('Provider share access is unavailable https://private.invalid'), { code: 'PRIVATE_CODE' });
    const error = sharedTaskRecoveryError('owner', sharedTaskFailureReason(source), source);
    expect(error.cause).toEqual({ reason: 'unknown' });
    expect(error.message).toContain('[SHARED_TASK_RECOVERY_unknown]');
    expect(error.message).not.toMatch(/PRIVATE_CODE|private|https/);
  });
});
