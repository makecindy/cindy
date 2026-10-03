import { describe, expect, it } from 'vitest';

import {
  MIN_VERSION_COMPARISON_USE_COUNT,
  selectSkillUsageVersionComparison,
} from '../skillUsageViewModel';

function readObservation(): SkillUsageReadObservation {
  return {
    fileReadCount: 0,
    sessionsWithFileRead: 0,
    averageFileReadsPerSession: 0,
    extraFileReadCount: 0,
    shortWindowRereadSessionCount: 0,
    shortWindowRereadRate: null,
  };
}

function version(
  skillDocumentHash: string,
  useCount: number,
  latestSeenAt: number,
  metrics: Partial<SkillUsageDocumentVersionSummary> = {},
): SkillUsageDocumentVersionSummary {
  return {
    skillDocumentHash,
    useCount,
    firstSeenAt: latestSeenAt - 100,
    latestSeenAt,
    agentBreakdown: { claude: 0, codex: useCount, pi: 0 },
    sourceBreakdown: { strongActive: 0, semiActive: useCount, passive: 0 },
    readObservation: readObservation(),
    toolCallCount: 0,
    repeatedToolCallCount: 0,
    toolErrorCount: 0,
    commandCallCount: 0,
    commandFailureCount: 0,
    averageToolCalls: 0,
    averageRepeatedToolCalls: 0,
    commandFailureRate: null,
    ...metrics,
  };
}

function summary(current: SkillUsageDocumentVersionSummary | null, versions: SkillUsageDocumentVersionSummary[]): SkillUsageSummary {
  return {
    skillName: 'word-doc',
    currentDocumentHash: current?.skillDocumentHash ?? null,
    totalUseCount: versions.reduce((total, item) => total + item.useCount, 0),
    currentDocumentVersionUseCount: current?.useCount ?? 0,
    unversionedUseCount: 0,
    documentVersionCoverageRate: 1,
    latestSeenAt: versions[0]?.latestSeenAt ?? null,
    agentBreakdown: { claude: 0, codex: versions.reduce((total, item) => total + item.useCount, 0), pi: 0 },
    sourceBreakdown: { strongActive: 0, semiActive: 0, passive: 0 },
    readObservation: readObservation(),
    currentDocumentSize: null,
    documentVersions: versions,
    currentDocumentVersion: current,
    trend: [],
  };
}

describe('skill usage view model', () => {
  it('selects the current version and the latest previous version with enough samples', () => {
    const current = version('doc-current', MIN_VERSION_COMPARISON_USE_COUNT, 4_000, {
      averageToolCalls: 3,
      averageRepeatedToolCalls: 0.4,
      commandFailureRate: 0.1,
    });
    const lowSample = version('doc-low-sample', MIN_VERSION_COMPARISON_USE_COUNT - 1, 5_000, {
      averageToolCalls: 99,
      commandFailureRate: 1,
    });
    const previous = version('doc-previous', MIN_VERSION_COMPARISON_USE_COUNT + 2, 3_000, {
      averageToolCalls: 5,
      averageRepeatedToolCalls: 0.8,
      commandFailureRate: 0.3,
    });

    const comparison = selectSkillUsageVersionComparison(summary(current, [current, previous, lowSample]));

    expect(comparison.status).toBe('comparable');
    if (comparison.status !== 'comparable') return;
    expect(comparison?.current).toBe(current);
    expect(comparison?.previous).toBe(previous);
    expect(comparison?.averageToolCallsDelta).toBe(-2);
    expect(comparison?.averageRepeatedToolCallsDelta).toBeCloseTo(-0.4);
    expect(comparison?.commandFailureRateDelta).toBeCloseTo(-0.2);
  });

  it('reports when the current version has too few samples', () => {
    const current = version('doc-current', MIN_VERSION_COMPARISON_USE_COUNT - 1, 4_000);
    const previous = version('doc-previous', MIN_VERSION_COMPARISON_USE_COUNT, 3_000);

    expect(selectSkillUsageVersionComparison(summary(current, [current, previous]))).toEqual({
      status: 'current_low_sample',
      current,
      previous,
    });
  });

  it('reports when no previous version exists', () => {
    const current = version('doc-current', MIN_VERSION_COMPARISON_USE_COUNT, 4_000);

    expect(selectSkillUsageVersionComparison(summary(current, [current]))).toEqual({
      status: 'no_previous',
      current,
    });
  });

  it('reports when the previous version has too few samples', () => {
    const current = version('doc-current', MIN_VERSION_COMPARISON_USE_COUNT, 4_000);
    const previous = version('doc-previous', MIN_VERSION_COMPARISON_USE_COUNT - 1, 3_000);

    expect(selectSkillUsageVersionComparison(summary(current, [current, previous]))).toEqual({
      status: 'previous_low_sample',
      current,
      previous,
    });
  });

  it('does not skip a low-sample previous version to compare with an older version', () => {
    const current = version('doc-current', MIN_VERSION_COMPARISON_USE_COUNT, 4_000);
    const previous = version('doc-previous', MIN_VERSION_COMPARISON_USE_COUNT - 1, 3_000);
    const older = version('doc-older', MIN_VERSION_COMPARISON_USE_COUNT + 10, 2_000);

    expect(selectSkillUsageVersionComparison(summary(current, [current, previous, older]))).toEqual({
      status: 'previous_low_sample',
      current,
      previous,
    });
  });
});
