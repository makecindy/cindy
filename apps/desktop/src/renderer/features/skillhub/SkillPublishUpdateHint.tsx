import { useTranslation } from 'react-i18next';
import { useSkillPublishComparison, type PublishComparisonState } from './hooks/useSkillPublishComparison';
import { hasPublishableChanges } from './lib/publishUpdateState';

export function SkillPublishUpdateHint({ skill, knownCreator }: { skill: SkillhubSkill; knownCreator?: boolean }) {
  const { t } = useTranslation();
  const { comparison } = useSkillPublishComparison(knownCreator ? skill : null);
  if (comparison.status !== 'different' && comparison.status !== 'unavailable') return null;
  if (comparison.status === 'different' && !hasPublishableChanges(comparison)) return null;
  if (comparison.status === 'unavailable' && !knownCreator) return null;
  return (
    <span className="text-12 leading-4 text-[var(--text-secondary)]">
      {t(comparison.status === 'unavailable' ? 'skillhub.publishComparison.unavailable'
        : comparison.pending ? 'skillhub.publishComparison.pendingChanges' : 'skillhub.publishComparison.updateAvailable')}
    </span>
  );
}

export function SkillPublishComparisonNotice({ comparison, isCreator }: {
  comparison: PublishComparisonState;
  isCreator?: boolean;
}) {
  const { t } = useTranslation();
  if (comparison.status !== 'unavailable' || isCreator !== true) return null;
  return (
    <p className="shrink-0 px-4 pt-4 text-sm text-[var(--text-secondary)]">
      {t('skillhub.publishComparison.unavailable')}
    </p>
  );
}
