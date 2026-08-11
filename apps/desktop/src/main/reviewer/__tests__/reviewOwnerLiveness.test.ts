import { afterEach, describe, expect, it } from 'vitest';

import {
  probeReviewOwnerLiveness,
  startReviewOwnerLiveness,
  type ReviewOwnerLivenessHandle,
} from '../reviewOwnerLiveness.js';

describe('Review owner exact liveness', () => {
  let handle: ReviewOwnerLivenessHandle | null = null;

  afterEach(async () => {
    await handle?.close();
    handle = null;
  });

  it('recognizes only the exact live Main instance challenge', async () => {
    handle = await startReviewOwnerLiveness();

    await expect(probeReviewOwnerLiveness(handle.identity)).resolves.toBe('alive');
    await expect(
      probeReviewOwnerLiveness({ ...handle.identity, token: 'wrong-instance-token' }),
    ).resolves.toBe('ended');
  });

  it('reports the owner ended after its endpoint closes', async () => {
    handle = await startReviewOwnerLiveness();
    const identity = handle.identity;
    await handle.close();
    handle = null;

    await expect(probeReviewOwnerLiveness(identity)).resolves.toBe('ended');
  });
});
