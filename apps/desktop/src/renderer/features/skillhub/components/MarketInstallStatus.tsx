import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { MarketSkill } from '../hooks/useMarketList';

export interface MarketInstallStatusProps {
  skill: MarketSkill;
  onUpdate?: (skill: MarketSkill) => void;
  updating?: boolean;
}

export function MarketInstallStatus({ skill, onUpdate, updating = false }: MarketInstallStatusProps) {
  const { t } = useTranslation();
  if (skill.updateAvailable || updating) {
    return (
      // Keep disabled-button clicks from bubbling into the card's detail action.
      <span className="inline-flex shrink-0" onClick={(event) => event.stopPropagation()}>
        <Button
          variant="secondary"
          className="px-3"
          loading={updating}
          aria-label={updating ? t('skillhub.detail.updating') : undefined}
          disabled={!onUpdate}
          onClick={() => onUpdate?.(skill)}
        >
          {t('skillhub.marketCard.updateAvailable')}
        </Button>
      </span>
    );
  }
  return skill.installedLocally ? (
    <span className="shrink-0 rounded-full bg-[var(--chat-input-chip-bg)] px-1.5 py-0.5 text-10 text-[var(--cmd-palette-item-meta)]">
      {t('skillhub.home.installed')}
    </span>
  ) : null;
}
