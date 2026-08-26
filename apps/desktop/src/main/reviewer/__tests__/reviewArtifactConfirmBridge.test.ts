import { describe, expect, it, vi } from 'vitest';

import type { ReviewArtifactConfirmRequest } from '../../../shared/reviewArtifactConfirm.js';
import {
  ReviewArtifactConfirmBridge,
  type ReviewArtifactConfirmTarget,
} from '../reviewArtifactConfirmBridge.js';

const MODEL = {
  title: 'Confirm',
  message: 'Send one item',
  detail: 'Review this path',
  items: [{ kind: 'external-path' as const, label: 'report.pdf', path: 'D:\\report.pdf' }],
  allowText: 'Allow',
  cancelText: 'Cancel',
};

function createTarget(id = 7, sendResult = true) {
  const sent: ReviewArtifactConfirmRequest[] = [];
  const dismissed: string[] = [];
  let destroyed: (() => void) | null = null;
  const target: ReviewArtifactConfirmTarget = {
    id,
    send: (payload) => {
      sent.push(payload);
      return sendResult;
    },
    dismiss: (requestId) => {
      dismissed.push(requestId);
      return true;
    },
    onDestroyed: (callback) => {
      destroyed = callback;
      return () => {
        destroyed = null;
      };
    },
  };
  return { target, sent, dismissed, destroy: () => destroyed?.() };
}

describe('ReviewArtifactConfirmBridge', () => {
  it('accepts only an explicit approval from the initiating window', async () => {
    const bridge = new ReviewArtifactConfirmBridge({ timeoutMs: 60_000 });
    const { target, sent } = createTarget();
    const pending = bridge.request(target, MODEL);

    expect(bridge.resolve(8, sent[0].requestId, true)).toBe(false);
    expect(bridge.pendingCount).toBe(1);
    expect(bridge.resolve(7, sent[0].requestId, true)).toBe(true);
    await expect(pending).resolves.toBe(true);
    expect(bridge.resolve(7, sent[0].requestId, false)).toBe(false);
  });

  it('denies malformed responses, delivery failures, owner close, and timeout', async () => {
    const warn = vi.fn();

    const malformedBridge = new ReviewArtifactConfirmBridge({ timeoutMs: 60_000, log: { warn } });
    const malformedTarget = createTarget();
    const malformed = malformedBridge.request(malformedTarget.target, MODEL);
    malformedBridge.resolve(7, malformedTarget.sent[0].requestId, 'true');
    await expect(malformed).resolves.toBe(false);

    const failedBridge = new ReviewArtifactConfirmBridge({ timeoutMs: 60_000 });
    await expect(failedBridge.request(createTarget(7, false).target, MODEL)).resolves.toBe(false);

    const brokenOwnerBridge = new ReviewArtifactConfirmBridge({ timeoutMs: 60_000 });
    const brokenOwner = createTarget().target;
    brokenOwner.onDestroyed = () => {
      throw new Error('owner unavailable');
    };
    await expect(brokenOwnerBridge.request(brokenOwner, MODEL)).resolves.toBe(false);
    expect(brokenOwnerBridge.pendingCount).toBe(0);

    const closedBridge = new ReviewArtifactConfirmBridge({ timeoutMs: 60_000 });
    const closedTarget = createTarget();
    const closed = closedBridge.request(closedTarget.target, MODEL);
    closedTarget.destroy();
    await expect(closed).resolves.toBe(false);

    const timedOutBridge = new ReviewArtifactConfirmBridge({ timeoutMs: 1 });
    const timedOutTarget = createTarget();
    await expect(timedOutBridge.request(timedOutTarget.target, MODEL)).resolves.toBe(false);
    expect(timedOutTarget.dismissed).toEqual([timedOutTarget.sent[0].requestId]);
  });
});
