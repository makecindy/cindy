import type { PublishComparisonState } from '../hooks/useSkillPublishComparison';

export function hasPublishableChanges(comparison: PublishComparisonState | undefined): boolean {
  return comparison?.status === 'different'
    && comparison.localChanges !== 'unchanged' && comparison.localChanges !== 'unknown';
}
