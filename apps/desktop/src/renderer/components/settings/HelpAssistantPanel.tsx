import { Button } from '@/components/ui/button';
import { useTranslation } from 'react-i18next';

import { DiffPanelShell } from '@/components/diff-panel/DiffPanelShell';
import { resetHelpThread, useHelpThread } from '@/lib/helpThreadStore';
import { HelpThreadView } from './HelpThreadView';

interface HelpAssistantPanelProps {
  open: boolean;
  onClose: () => void;
}

export function HelpAssistantPanel({ open, onClose }: HelpAssistantPanelProps) {
  const { t } = useTranslation();
  const { messages } = useHelpThread();

  return (
    <DiffPanelShell
      open={open}
      onClose={onClose}
      ariaLabel={t('settings.help.panelAriaLabel')}
      title={t('settings.help.panelTitle')}
      defaultWidth={520}
      storageKey="diff-panel-shell:help-assistant-width"
      headerActions={
        messages.length > 0 ? (
          <Button variant="secondary" size="sm" compact type="button" onClick={resetHelpThread}>
            {t('settings.help.newSession')}
          </Button>
        ) : undefined
      }
    >
      <HelpThreadView />
    </DiffPanelShell>
  );
}
