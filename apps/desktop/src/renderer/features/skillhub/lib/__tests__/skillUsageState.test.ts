import { describe, expect, it } from 'vitest';

import {
  beginUsageSummaryRequest,
  buildUsageSummaryRequest,
  type SkillUsagePanelState,
  settleUsageSummaryFailure,
  settleUsageSummarySuccess,
} from '../skillUsageState';

function summary(skillName: string, totalUseCount: number): SkillUsageSummary {
  return {
    skillName,
    currentDocumentHash: null,
    totalUseCount,
    currentDocumentVersionUseCount: totalUseCount,
    unversionedUseCount: 0,
    documentVersionCoverageRate: null,
    latestSeenAt: null,
    agentBreakdown: { claude: 0, codex: totalUseCount, pi: 0 },
    sourceBreakdown: { strongActive: 0, semiActive: 0, passive: totalUseCount },
    readObservation: {
      fileReadCount: 0,
      sessionsWithFileRead: 0,
      averageFileReadsPerSession: 0,
      extraFileReadCount: 0,
      shortWindowRereadSessionCount: 0,
      shortWindowRereadRate: null,
    },
    currentDocumentSize: null,
    documentVersions: [],
    currentDocumentVersion: null,
    trend: [],
  };
}

describe('skill usage summary state', () => {
  it('includes the local day key in the usage summary request identity', () => {
    const first = buildUsageSummaryRequest({
      entryId: 'skill-a',
      name: 'word-doc',
      mdPath: '/skills/word-doc/SKILL.md',
      refreshNonce: 0,
      dayKey: '2026-06-21',
    });
    const second = buildUsageSummaryRequest({
      entryId: 'skill-a',
      name: 'word-doc',
      mdPath: '/skills/word-doc/SKILL.md',
      refreshNonce: 0,
      dayKey: '2026-06-22',
    });

    expect(first).toMatchObject({ entryId: 'skill-a', dayKey: '2026-06-21' });
    expect(second).toMatchObject({ entryId: 'skill-a', dayKey: '2026-06-22' });
    expect(second).not.toEqual(first);
  });

  it('keeps the previous summary while refreshing the same entry', () => {
    const previous: SkillUsagePanelState = {
      entryId: 'skill-a',
      loading: false,
      error: null,
      summary: summary('skill-a', 7),
    };

    expect(beginUsageSummaryRequest(previous, 'skill-a')).toEqual({
      ...previous,
      loading: true,
      error: null,
    });
  });

  it('clears the previous summary when switching entries', () => {
    const previous: SkillUsagePanelState = {
      entryId: 'skill-a',
      loading: false,
      error: null,
      summary: summary('skill-a', 7),
    };

    expect(beginUsageSummaryRequest(previous, 'skill-b')).toEqual({
      entryId: 'skill-b',
      loading: true,
      error: null,
      summary: null,
    });
  });

  it.each(['indexing', 'incomplete'] as const)('shows records but does not conclude zero during %s', (phase) => {
    const refreshing = phase === 'indexing';
    const next = settleUsageSummarySuccess('skill-a', {
      refreshing, phase, summary: summary('skill-a', 0),
    });
    expect(next.summary).toBeNull();
    expect(next.loading).toBe(refreshing);
    expect(settleUsageSummarySuccess('skill-a', {
      refreshing, phase, summary: summary('skill-a', 5),
    }).summary?.totalUseCount).toBe(5);
  });

  it('shows zero after completion and clears that conclusion on a new request', () => {
    const next = settleUsageSummarySuccess('skill-a', {
      refreshing: false, phase: 'complete', summary: summary('skill-a', 0),
    });
    expect(next.summary?.totalUseCount).toBe(0);
    expect(beginUsageSummaryRequest(next, 'skill-a').summary).toBeNull();
  });

  it('keeps the previous same-entry summary when a background refresh fails', () => {
    const oldSummary = summary('skill-a', 7);
    const previous: SkillUsagePanelState = {
      entryId: 'skill-a',
      loading: true,
      error: null,
      summary: oldSummary,
    };

    const next = settleUsageSummaryFailure(previous, 'skill-a', 'boom');

    expect(next).toEqual({
      entryId: 'skill-a',
      loading: false,
      error: 'boom',
      summary: oldSummary,
    });
  });
});
