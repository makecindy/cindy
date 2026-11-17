import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

/** Only mount for a task running on this computer; remote settings belong to its execution host. */
export function AutoReviewRecoveryActions() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  return <>
    <Button size="sm" compact type="button" data-split-pane-route-action=""
      onClick={() => navigate('/settings?tab=providers')}>
      {t('settings.tabs.providers')}
    </Button>
    <Button size="sm" compact type="button" data-split-pane-route-action=""
      onClick={() => navigate('/settings?tab=personalization&section=personalization.auxiliaryModels')}>
      {t('settings.sections.auxiliaryModels')}
    </Button>
  </>;
}
