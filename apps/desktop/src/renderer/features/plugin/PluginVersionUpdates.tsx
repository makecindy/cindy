import type { ReactNode } from 'react';
import { History } from 'lucide-react';
import { PluginDetailRecordRow } from './PluginDetailRecord';
import { useTranslation } from 'react-i18next';

/** Updates stay secondary to the plugin's purpose and use controls. No persisted open state. */
export function PluginVersionUpdates({ children, attention, open, onOpenChange }: {
  children: ReactNode;
  attention?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  return <PluginDetailRecordRow icon={History} title={t('settings.ghosts.contribution.versionUpdates')}
    summary={attention} defaultOpen={open} onOpenChange={onOpenChange}>{children}</PluginDetailRecordRow>;
}
