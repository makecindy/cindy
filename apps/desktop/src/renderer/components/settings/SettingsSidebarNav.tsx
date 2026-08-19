import type { ComponentType, ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { LucideProps } from 'lucide-react';
import {
  Boxes,
  CircleDollarSign,
  CircleHelp,
  FileUp,
  Info,
  Keyboard,
  MessageCircle,
  Mic,
  MonitorCog,
  MonitorSmartphone,
  Plug,
  Settings2,
  Sparkles,
  Wrench,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { TAB_LABEL_KEY, type SettingsTab, type VisibleSettingsTab } from '@/lib/tabLabels';

const NAV_ITEM_CLASS = 'flex h-9 items-center gap-2.5 rounded-full px-3 text-sm transition-colors';
const NAV_ITEM_IDLE_CLASS =
  'border border-transparent text-[var(--settings-menu-text)] hover:bg-sidebar-item-hover';
const NAV_ITEM_ACTIVE_CLASS =
  'border border-[var(--sidebar-item-active-border)] bg-sidebar-item-active font-medium text-[var(--sidebar-item-active-foreground)]';

/** Screen + top capsule: the Dynamic Island silhouette, not a generic window. */
function AgentIslandNavIcon({
  size = 15,
  strokeWidth = 1.8,
  className,
  ...props
}: LucideProps): ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...props}
    >
      <rect x="4.5" y="4.5" width="15" height="15" rx="3.75" />
      <rect x="7" y="6.25" width="10" height="3.6" rx="1.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

type SettingsNavIcon = ComponentType<LucideProps>;

const TAB_ICON: Record<VisibleSettingsTab, SettingsNavIcon> = {
  general: Settings2,
  billing: CircleDollarSign,
  personalization: Sparkles,
  providers: Boxes,
  'voice-input': Mic,
  shortcuts: Keyboard,
  'agent-island': AgentIslandNavIcon,
  import: FileUp,
  'remote-control': MonitorSmartphone,
  ghosts: Plug,
  'builtin-tools': Wrench,
  'computer-use': MonitorCog,
  'im-bot': MessageCircle,
  help: CircleHelp,
  about: Info,
};

interface SettingsSidebarNavProps {
  tabIds: readonly VisibleSettingsTab[];
  activeTab: SettingsTab;
  onSelectTab: (tab: SettingsTab) => void;
}

/** Settings left nav. Every item is an in-panel tab with a matching lucide mark. */
export function SettingsSidebarNav({ tabIds, activeTab, onSelectTab }: SettingsSidebarNavProps) {
  const { t } = useTranslation();

  return (
    <nav role="tablist" aria-label={t('settings.title')} className="flex flex-col gap-0.5">
      {tabIds.map((tabId) => {
        const selected = activeTab === tabId;
        const Icon = TAB_ICON[tabId];
        return (
          <button
            key={tabId}
            id={`settings-tab-${tabId}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`settings-panel-${tabId}`}
            onClick={() => onSelectTab(tabId)}
            className={cn(NAV_ITEM_CLASS, selected ? NAV_ITEM_ACTIVE_CLASS : NAV_ITEM_IDLE_CLASS)}
          >
            <Icon
              size={15}
              strokeWidth={1.8}
              aria-hidden="true"
              className={cn(
                'shrink-0',
                selected
                  ? 'text-sidebar-item-active-foreground'
                  : 'text-[var(--settings-menu-text)]',
              )}
            />
            <span className="leading-none">{t(TAB_LABEL_KEY[tabId])}</span>
          </button>
        );
      })}
    </nav>
  );
}
