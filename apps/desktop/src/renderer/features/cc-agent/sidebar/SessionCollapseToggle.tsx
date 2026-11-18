import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SidebarIconButton } from '@/components/sidebar/SidebarIconButton';

export function SessionCollapseToggle({ showAll, onChange }: {
  showAll: boolean;
  onChange: (showAll: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <SidebarIconButton
      icon={showAll ? ChevronsDownUp : ChevronsUpDown}
      label={t(showAll ? 'ccAgent.sidebar.collapseInactiveSessions' : 'ccAgent.sidebar.expandAllSessions')}
      className="h-6 w-6"
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onChange(!showAll);
      }}
    />
  );
}
