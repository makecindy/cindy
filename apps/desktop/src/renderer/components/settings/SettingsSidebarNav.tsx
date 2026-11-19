import type { SettingsSearchContext } from './settingsSearchTypes';
import type { ComponentType, ReactElement } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LucideProps } from 'lucide-react';
import {
  Blocks,
  Boxes,
  ChartColumn,
  ChevronRight,
  CircleDollarSign,
  CircleHelp,
  Cpu,
  Database,
  FileUp,
  FolderArchive,
  Info,
  Keyboard,
  Link2,
  MessageCircle,
  Mic,
  MonitorCog,
  MonitorSmartphone,
  MousePointer2,
  Palette,
  Plug,
  Settings2,
  Sparkles,
  Waypoints,
  Wrench,
  Users,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { TAB_LABEL_KEY, type SettingsTab, type VisibleSettingsTab } from '@/lib/tabLabels';
import { SettingsSearchBox } from './SettingsSearchBox';
import type { SettingsSearchDocument } from './settingsSearchCatalog';
import type { PluginSettingsPage } from './pluginSettingsNavigation';
import { SectionCollapse } from '@/features/cc-agent/sidebar/SectionCollapse';

const NAV_ITEM_CLASS = 'flex min-h-9 items-center gap-2.5 rounded-full py-1.5 pr-3 text-left text-sm transition-colors';
const NAV_LABEL_CLASS = 'min-w-0 flex-1 hyphens-auto [overflow-wrap:break-word] [text-wrap:pretty] leading-tight';
const NAV_GROUP_TABS_CLASS =
  'relative flex flex-col gap-0.5 pl-1.5 before:pointer-events-none before:absolute before:inset-y-1.5 before:left-0.5 before:w-px before:bg-[var(--border-default)]';
const NAV_ITEM_IDLE_CLASS =
  'border border-transparent text-[var(--settings-menu-text)] hover:bg-sidebar-item-hover';
const NAV_ITEM_ACTIVE_CLASS =
  'border border-[var(--sidebar-item-active-border)] bg-sidebar-item-active font-medium text-[var(--sidebar-item-active-foreground)]';

const NAV_GROUPS = [
  ['models', 'settings.navGroups.models', Cpu],
  ['interaction', 'settings.navGroups.interaction', MousePointer2],
  ['connections', 'settings.navGroups.connections', Link2],
  ['extensions', 'settings.navGroups.extensions', Blocks],
  ['data', 'settings.navGroups.data', FolderArchive],
] as const;

type NavGroup = (typeof NAV_GROUPS)[number][0];
type NavSection = NavGroup | 'preferences' | 'support';

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

export const SETTINGS_NAV_ENTRIES: Record<VisibleSettingsTab, readonly [NavSection, SettingsNavIcon]> = {
  about: ['support', Info],
  'agent-island': ['interaction', AgentIslandNavIcon],
  appearance: ['preferences', Palette],
  billing: ['models', CircleDollarSign],
  'builtin-tools': ['extensions', Wrench],
  'computer-use': ['extensions', MonitorCog],
  general: ['preferences', Settings2],
  ghosts: ['extensions', Plug],
  help: ['support', CircleHelp],
  'im-bot': ['connections', MessageCircle],
  import: ['data', FileUp],
  'model-groups': ['models', Waypoints],
  personalization: ['preferences', Sparkles],
  providers: ['models', Boxes],
  'remote-control': ['connections', MonitorSmartphone],
  'shared-tasks': ['connections', Users],
  shortcuts: ['interaction', Keyboard],
  storage: ['data', Database],
  usage: ['models', ChartColumn],
  'voice-input': ['interaction', Mic],
};

function settingsTabSection(tab: SettingsTab): NavSection | undefined {
  return (SETTINGS_NAV_ENTRIES as Partial<Record<SettingsTab, readonly [NavSection, SettingsNavIcon]>>)[tab]?.[0];
}

interface SettingsSidebarNavProps {
  requestedQuery?: string;
  tabIds: readonly VisibleSettingsTab[];
  searchContext?: SettingsSearchContext;
  activeTab: SettingsTab;
  onSelectTab: (tab: SettingsTab) => void;
  onSelectSearchResult?: (result: { tab: SettingsTab; sectionId: string }) => void;
  pluginPages?: readonly PluginSettingsPage[];
  pluginSearchDocuments?: readonly SettingsSearchDocument[];
  selectedPluginPage?: string;
  onSelectPluginPage?: (page: PluginSettingsPage) => void;
  navigationKey?: string;
}

export function SettingsSidebarNav({
  requestedQuery,
  tabIds,
  searchContext,
  activeTab,
  onSelectTab,
  onSelectSearchResult,
  pluginPages,
  pluginSearchDocuments,
  selectedPluginPage,
  onSelectPluginPage,
  navigationKey,
}: SettingsSidebarNavProps) {
  const { t } = useTranslation();
  const destination = selectedPluginPage ?? activeTab;
  const activeSection = selectedPluginPage ? 'extensions' : settingsTabSection(activeTab);
  const [disclosure, setDisclosure] = useState({ destination, navigationKey, openSection: activeSection });
  if (disclosure.destination !== destination || disclosure.navigationKey !== navigationKey) {
    // Route changes include search, deep links and history navigation.
    setDisclosure({ destination, navigationKey, openSection: activeSection });
  }

  const renderTab = (tabId: VisibleSettingsTab, grouped = false) => {
    const selected = activeTab === tabId && !selectedPluginPage;
    const [, Icon] = SETTINGS_NAV_ENTRIES[tabId];
    const label = t(TAB_LABEL_KEY[tabId]);
    return (
      <button
        key={tabId}
        id={`settings-tab-${tabId}`}
        type="button"
        role="tab"
        aria-selected={selected}
        aria-controls={`settings-panel-${tabId}`}
        data-settings-search-action="Navigate to a settings page"
        onClick={() => onSelectTab(tabId)}
        className={cn(NAV_ITEM_CLASS, grouped ? 'pl-1.5' : 'pl-3', selected ? NAV_ITEM_ACTIVE_CLASS : NAV_ITEM_IDLE_CLASS)}
      >
        <Icon size={15} strokeWidth={1.8} aria-hidden="true" className="shrink-0" />
        <span className={NAV_LABEL_CLASS}>{label}</span>
      </button>
    );
  };

  const renderDirectTabs = (section: 'preferences' | 'support', label: string) => {
    const tabs = tabIds.filter((tabId) => settingsTabSection(tabId) === section);
    if (!tabs.length) return null;
    return (
      <div role="tablist" aria-label={label} aria-orientation="vertical" className="flex flex-col gap-0.5">
        {tabs.map((tabId) => renderTab(tabId))}
      </div>
    );
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
        <SettingsSearchBox
          requestedQuery={requestedQuery}
          visibleTabIds={tabIds}
          searchContext={searchContext}
          additionalDocuments={pluginSearchDocuments}
          onSelect={(result) => {
            if (!onSelectSearchResult) return;
            setDisclosure({ destination, navigationKey, openSection: settingsTabSection(result.tab) });
            onSelectSearchResult(result);
          }}
        />
        <nav aria-label={t('settings.title')} className="flex flex-col gap-0.5">
          {renderDirectTabs('preferences', t('settings.navGroups.preferences'))}
          <div className="flex flex-col gap-0.5">
            {NAV_GROUPS.map(([group, labelKey, Icon]) => {
              const tabs = tabIds.filter((tabId) => settingsTabSection(tabId) === group);
              const pages = group === 'extensions' ? pluginPages : undefined;
              if (!tabs.length && !pages?.length) return null;

              const expanded = disclosure.openSection === group;
              const buttonId = `settings-nav-${group}`;
              const panelId = `${buttonId}-tabs`;
              const label = t(labelKey);
              return (
                <div key={group}>
                  <button
                    id={buttonId}
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={panelId}
                    aria-current={!expanded && activeSection === group ? 'location' : undefined}
                    data-settings-search-action="Expand or collapse a settings navigation group"
                    onClick={() => setDisclosure({ destination, navigationKey, openSection: expanded ? undefined : group })}
                    className={cn(
                      NAV_ITEM_CLASS,
                      'w-full pl-3 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]',
                      !expanded && activeSection === group ? NAV_ITEM_ACTIVE_CLASS : NAV_ITEM_IDLE_CLASS,
                    )}
                  >
                    <Icon size={15} strokeWidth={1.8} aria-hidden="true" className="shrink-0" />
                    <span className={NAV_LABEL_CLASS}>{label}</span>
                    <span aria-hidden="true" className={cn('ml-auto shrink-0 transition-transform duration-[var(--motion-base,200ms)] ease-[var(--motion-ease-move)] motion-reduce:transition-none', expanded && 'rotate-90')}>
                      <ChevronRight size={15} strokeWidth={1.8} />
                    </span>
                  </button>
                  <SectionCollapse id={panelId} collapsed={!expanded} keepMounted>
                    <div role="tablist" inert={!expanded} aria-labelledby={buttonId} aria-orientation="vertical" className={NAV_GROUP_TABS_CLASS}>
                      {tabs.map((tabId) => renderTab(tabId, true))}
                      {!!pages?.length && (
                        <div className="pl-8 pr-3 pt-2 pb-1 text-12 text-[var(--text-secondary)]">
                          {t('pluginUi.settings')}
                        </div>
                      )}
                      {pages?.map((page) => {
                        const selected = selectedPluginPage === page.id;
                        return (
                          <button
                            key={page.id}
                            id={`settings-tab-${page.id}`}
                            type="button"
                            role="tab"
                            aria-selected={selected}
                            aria-controls={page.id}
                            data-settings-search-action="Open plugin settings indexed from the approved manifest"
                            onClick={() => onSelectPluginPage?.(page)}
                            className={cn(NAV_ITEM_CLASS, 'pl-1.5', selected ? NAV_ITEM_ACTIVE_CLASS : NAV_ITEM_IDLE_CLASS)}
                          >
                            <Plug size={15} strokeWidth={1.8} className="shrink-0" aria-hidden="true" />
                            <span className="truncate leading-none" title={page.title}>{page.title}</span>
                          </button>
                        );
                      })}
                    </div>
                  </SectionCollapse>
                </div>
              );
            })}
          </div>
          {renderDirectTabs('support', t('settings.tabs.help'))}
        </nav>
      </div>
  );
}
