import { describe, expect, it } from 'vitest';

import {
  activePublishedReviewVersion,
  effectivePublishedStatus,
  effectivePublishedStatusVersion,
  isActivePublishedReview,
  isEffectiveActivePublishedReview,
  publishedStatusClass,
  publishedStatusLabelKey,
  rejectedPublishedReviewFromVersions,
  specialPublishedStatus,
} from '../publishedStatus';

describe('published status badges', () => {
  it('shows badges only for special review states', () => {
    expect(specialPublishedStatus('published')).toBeNull();
    expect(specialPublishedStatus('passed')).toBeNull();
    expect(specialPublishedStatus('approved')).toBeNull();

    expect(specialPublishedStatus('pending')).toBe('pending');
    expect(specialPublishedStatus('scanning')).toBe('scanning');
    expect(specialPublishedStatus('quarantine')).toBe('quarantine');
    expect(specialPublishedStatus('rejected')).toBe('rejected');
  });

  it('maps special states to the user-facing review label keys', () => {
    expect(publishedStatusLabelKey('pending')).toBe('skillhub.publishedStatus.waitingReview');
    expect(publishedStatusLabelKey('scanning')).toBe('skillhub.publishedStatus.machineReviewing');
    expect(publishedStatusLabelKey('quarantine')).toBe('skillhub.publishedStatus.manualReviewing');
    expect(publishedStatusLabelKey('rejected')).toBe('skillhub.publishedStatus.rejected');
  });

  it('treats in-progress review states as action-blocking, but not rejected or published', () => {
    expect(isActivePublishedReview('pending')).toBe(true);
    expect(isActivePublishedReview('scanning')).toBe(true);
    expect(isActivePublishedReview('quarantine')).toBe(true);
    expect(isActivePublishedReview('rejected')).toBe(false);
    expect(isActivePublishedReview('published')).toBe(false);
  });

  it('uses pendingVersion status before top-level published status', () => {
    const source = {
      moderationStatus: 'published',
      latestVersion: '1.0.0',
      pendingVersion: { version: '1.0.2', status: 'scanning' },
    };

    expect(effectivePublishedStatus(source)).toBe('scanning');
    expect(isEffectiveActivePublishedReview(source)).toBe(true);
    expect(activePublishedReviewVersion(source)).toBe('1.0.2');
    expect(effectivePublishedStatusVersion(source)).toBe('1.0.2');
  });

  it('falls back to top-level review status when pendingVersion is absent', () => {
    const source = {
      moderationStatus: 'scanning',
      latestVersion: '1.0.0',
    };

    expect(effectivePublishedStatus(source)).toBe('scanning');
    expect(isEffectiveActivePublishedReview(source)).toBe(true);
    expect(activePublishedReviewVersion(source)).toBe('1.0.0');
    expect(effectivePublishedStatusVersion(source)).toBe('1.0.0');
  });

  it('keeps rejected pendingVersion visible without treating it as active polling work', () => {
    const source = {
      moderationStatus: 'published',
      latestVersion: '1.0.0',
      pendingVersion: { version: '1.0.2', status: 'rejected' },
    };

    expect(effectivePublishedStatus(source)).toBe('rejected');
    expect(isEffectiveActivePublishedReview(source)).toBe(false);
    expect(activePublishedReviewVersion(source)).toBeNull();
    expect(effectivePublishedStatusVersion(source)).toBe('1.0.2');
  });

  it('ignores historical rejected versions once a newer version is published', () => {
    const versions = [
      { version: '1.0.4', status: 'published' },
      { version: '1.0.3', status: 'rejected' },
      { version: '1.0.2', status: 'published' },
    ];

    expect(rejectedPublishedReviewFromVersions(versions, '1.0.4')).toBeNull();
  });

  it('keeps rejected status for a newer rejected version than the current published version', () => {
    const versions = [
      { version: '1.0.4', status: 'rejected' },
      { version: '1.0.3', status: 'published' },
    ];

    expect(rejectedPublishedReviewFromVersions(versions, '1.0.3')).toEqual({
      version: '1.0.4',
      status: 'rejected',
    });
  });

  it('styles badges with theme tokens instead of hardcoded palette classes', () => {
    expect(publishedStatusClass('rejected')).toBe(
      'border-[var(--error-border)] bg-[var(--error-bg)] text-[var(--error-fg)]',
    );
    expect(publishedStatusClass('quarantine')).toBe(
      'border-[var(--skillhub-review-quarantine-border)] bg-[var(--skillhub-review-quarantine-bg)] text-[var(--skillhub-review-quarantine-fg)]',
    );
    for (const status of ['pending', 'scanning'] as const) {
      expect(publishedStatusClass(status)).toBe(
        'border-[var(--skillhub-review-pending-border)] bg-[var(--skillhub-review-pending-bg)] text-[var(--skillhub-review-pending-fg)]',
      );
    }
  });
});
