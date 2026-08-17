import { describe, expect, it } from 'vitest';

import { marketPackageNeedsHostReview } from '../packagePermissionReview';

describe('marketPackageNeedsHostReview', () => {
  it('skips Host when the user already reviewed every permission in the real package', () => {
    expect(
      marketPackageNeedsHostReview({
        mode: 'manual',
        builtinOauthClientChanged: false,
        addedCount: null,
        unreviewedCount: 0,
        extrasVersusReviewedCount: 0,
      }),
    ).toBe(false);
  });

  it('reviews Host when the real package adds permissions the preview missed', () => {
    expect(
      marketPackageNeedsHostReview({
        mode: 'manual',
        builtinOauthClientChanged: false,
        addedCount: null,
        unreviewedCount: 0,
        extrasVersusReviewedCount: 1,
      }),
    ).toBe(true);
  });

  it('reviews a first manual install when no preview confirmation was supplied', () => {
    expect(
      marketPackageNeedsHostReview({
        mode: 'manual',
        builtinOauthClientChanged: false,
        addedCount: null,
        unreviewedCount: 0,
        extrasVersusReviewedCount: null,
      }),
    ).toBe(true);
  });

  it('skips a same-permission manual update when no preview confirmation was supplied', () => {
    expect(
      marketPackageNeedsHostReview({
        mode: 'manual',
        builtinOauthClientChanged: false,
        addedCount: 0,
        unreviewedCount: 0,
        extrasVersusReviewedCount: null,
      }),
    ).toBe(false);
  });

  it('always reviews when the built-in OAuth client changed', () => {
    expect(
      marketPackageNeedsHostReview({
        mode: 'manual',
        builtinOauthClientChanged: true,
        addedCount: 0,
        unreviewedCount: 0,
        extrasVersusReviewedCount: 0,
      }),
    ).toBe(true);
  });
});
