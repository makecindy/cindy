import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

/** The native CLI owns installation and login; Cindy only offers instructions and model discovery. */
export function CursorProviderSetup() {
  const { t } = useTranslation();
  return (
    <div data-testid="cursor-provider-setup" className="flex flex-col items-start gap-3">
      <p className="text-13 leading-relaxed text-[var(--text-secondary)]">
        {t('settings.providers.cursor.setup')}
      </p>
      <code className="text-12 leading-relaxed text-[var(--text-primary)]">cursor-agent login</code>
      <Button
        variant="secondary"
        size="lg"
        type="button"
        onClick={() =>
          void window.electronAPI.openExternal('https://cursor.com/docs/cli/installation')
        }
      >
        {t('settings.providers.cursor.installGuide')}
      </Button>
    </div>
  );
}
