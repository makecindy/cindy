import { describe, expect, it } from 'vitest';

import {
  isStaleReviewFailureCode,
  readReviewFailureCode,
  readReviewRunMeta,
  reviewFailureCodeFromLegacyError,
} from '../reviewRun.js';

const base = {
  version: 1,
  runId: 'run-1',
  sourceSessionId: 'source-1',
  reviewerSessionId: 'reviewer-1',
  status: 'running',
  targetKind: 'changes',
  startedAt: 1,
} as const;

describe('ReviewRunMeta', () => {
  it('accepts a valid process-instance owner', () => {
    expect(
      readReviewRunMeta({
        ...base,
        owner: { instanceId: 'instance-1', processId: 123 },
      }),
    ).toMatchObject({ owner: { instanceId: 'instance-1', processId: 123 } });
  });

  it('keeps owner-less legacy cards readable but rejects malformed owners', () => {
    expect(readReviewRunMeta(base)).toMatchObject({ runId: 'run-1' });
    expect(readReviewRunMeta({ ...base, owner: { instanceId: '', processId: 123 } })).toBeNull();
    expect(
      readReviewRunMeta({ ...base, owner: { instanceId: 'instance-1', processId: 0 } }),
    ).toBeNull();
  });

  it('keeps pre-bootstrap cards readable without publishing a dead reviewer link', () => {
    const pending = { ...base, reviewerSessionId: undefined };
    expect(readReviewRunMeta(pending)).toMatchObject({ runId: 'run-1', status: 'running' });
    expect(readReviewRunMeta({ ...pending, reviewerSessionId: '' })).toBeNull();
    expect(readReviewRunMeta({ ...pending, reviewerSessionId: 123 })).toBeNull();
  });

  it('accepts stable failure codes and rejects malformed ones', () => {
    expect(
      readReviewRunMeta({ ...base, status: 'failed', failureCode: 'reviewer-closed' }),
    ).toMatchObject({ failureCode: 'reviewer-closed' });
    expect(readReviewRunMeta({ ...base, status: 'failed', failureCode: 'made-up' })).toBeNull();
    expect(readReviewFailureCode('artifact-changed')).toBe('artifact-changed');
    expect(isStaleReviewFailureCode('artifact-changed')).toBe(true);
    expect(isStaleReviewFailureCode('provider-failed')).toBe(false);
    expect(readReviewFailureCode(123)).toBeNull();
  });

  it('maps only known legacy internal messages to stable failure codes', () => {
    expect(reviewFailureCodeFromLegacyError('Reviewer returned no visible conclusion')).toBe(
      'no-visible-result',
    );
    expect(
      reviewFailureCodeFromLegacyError(
        'The task files changed while Review was running. Run /review again for the current result.',
      ),
    ).toBe('source-files-changed');
    expect(reviewFailureCodeFromLegacyError('provider-specific failure')).toBeNull();
  });
});
