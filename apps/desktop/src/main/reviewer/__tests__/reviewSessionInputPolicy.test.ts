import { describe, expect, it, vi } from 'vitest';

import { assertReviewSessionExternalInputAllowed } from '../reviewSessionInputPolicy.js';

describe('Review external input policy', () => {
  it('rejects an isolated Review task before input dispatch', async () => {
    const readSource = vi.fn().mockResolvedValue('review');

    await expect(
      assertReviewSessionExternalInputAllowed('review-1', readSource),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(readSource).toHaveBeenCalledWith('review-1');
  });

  it('allows ordinary and not-yet-persisted tasks', async () => {
    await expect(
      assertReviewSessionExternalInputAllowed('desktop-1', async () => 'desktop'),
    ).resolves.toBeUndefined();
    await expect(
      assertReviewSessionExternalInputAllowed('draft-1', async () => null),
    ).resolves.toBeUndefined();
  });
});
