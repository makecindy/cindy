import { describe, expect, it, vi } from 'vitest';

import type { GhostInstallConsentRequest } from '../../../shared/ghostInstallConsent.js';
import { GhostInstallConsentWindowBridge } from '../ghostInstallConsentWindowBridge.js';

vi.mock('../../maker-ipc/hostConfirmTiming.js', () => ({ HOST_CONFIRM_TIMEOUT_MS: 60_000 }));

const REQUEST: Omit<GhostInstallConsentRequest, 'requestId'> = {
  initiator: 'user',
  origin: 'market',
  facts: { kind: 'install', ghostId: 'weather-chip', name: 'Weather', version: '1.0.0', permissions: [] },
};

function target(id: number, delivered = true) {
  const sent: GhostInstallConsentRequest[] = [];
  const dismissed: string[] = [];
  return {
    sent,
    dismissed,
    target: {
      id,
      send: (request: GhostInstallConsentRequest) => {
        sent.push(request);
        return delivered;
      },
      dismiss: (requestId: string) => dismissed.push(requestId),
    },
  };
}

describe('GhostInstallConsentWindowBridge', () => {
  it('only accepts the answer from the window that started the install', async () => {
    const bridge = new GhostInstallConsentWindowBridge();
    const window = target(7);
    const pending = bridge.request(window.target, REQUEST);
    const requestId = window.sent[0]!.requestId;
    expect(bridge.resolve(8, requestId, true)).toBe(false);
    expect(bridge.resolve(7, requestId, true)).toBe(true);
    await expect(pending).resolves.toBe(true);
    expect(window.dismissed).toEqual([requestId]);
    expect(bridge.pendingCount).toBe(0);
  });

  it('treats a malformed answer, a closed window or an account switch as cancel', async () => {
    const bridge = new GhostInstallConsentWindowBridge();
    const a = target(1);
    const b = target(2);
    const c = target(3);
    const malformed = bridge.request(a.target, REQUEST);
    bridge.resolve(1, a.sent[0]!.requestId, 'yes');
    await expect(malformed).resolves.toBe(false);
    const closed = bridge.request(b.target, REQUEST);
    bridge.cancelRequester(2);
    await expect(closed).resolves.toBe(false);
    const boundary = bridge.request(c.target, REQUEST);
    bridge.cancelAll();
    await expect(boundary).resolves.toBe(false);
    expect(c.dismissed).toHaveLength(1);
  });

  it('times out as cancel and asks the window to close the dialog', async () => {
    vi.useFakeTimers();
    try {
      const bridge = new GhostInstallConsentWindowBridge({ timeoutMs: 1000 });
      const window = target(4);
      const pending = bridge.request(window.target, REQUEST);
      vi.advanceTimersByTime(1000);
      await expect(pending).resolves.toBe(false);
      expect(window.dismissed).toEqual([window.sent[0]!.requestId]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when the window cannot receive the request', async () => {
    const bridge = new GhostInstallConsentWindowBridge();
    await expect(bridge.request(target(5, false).target, REQUEST)).rejects.toThrow();
    expect(bridge.pendingCount).toBe(0);
  });
});
