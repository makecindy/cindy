import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { registerTabKind } from '../../registry';
import type { TabKindPlugin, TabKindBodyProps } from '../../types';

interface RetiredTabState {
  pluginId?: string;
}
const plugin: TabKindPlugin<RetiredTabState> = {
  kind: 'retired-feature',
  menu: {
    kind: 'retired-feature',
    labelKey: 'settings.ghosts.retirement.status',
    icon: Info,
    order: 0,
    enabled: false,
    hiddenFromMenu: true,
  },
  TabPillTitle: ({ t }) => <>{t('settings.ghosts.retirement.status')}</>,
  TabPillIcon: () => <Info size={13} />,
  TabBody: ({ state }: TabKindBodyProps<RetiredTabState>) => {
    const { t } = useTranslation();
    return (
      <div className="flex h-full flex-col items-start justify-center gap-4 p-6 text-[var(--text-primary)]">
        <Info size={24} className="text-[var(--text-tertiary)]" />
        <h2 className="text-16 font-medium">{t('settings.ghosts.retirement.status')}</h2>
        <p className="text-13 leading-5 text-[var(--text-secondary)]">
          {t('settings.ghosts.retirement.sidebarNotice')}
        </p>
        {state.pluginId && (
          <Button
            variant="secondary"
            onClick={() => {
              void window.electronAPI.ghosts
                .openRetirement(state.pluginId!)
                .catch(() => toast.error(t('settings.ghosts.retirement.openFailed')));
            }}
          >
            {t('settings.ghosts.retirement.view')}
          </Button>
        )}
      </div>
    );
  },
  defaultState: () => ({}),
  serializeState: (state) => state,
  hydrateState: (raw) => (raw && typeof raw === 'object' ? (raw as RetiredTabState) : {}),
};
registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
