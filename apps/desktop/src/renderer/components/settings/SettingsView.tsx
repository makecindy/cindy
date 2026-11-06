import { generalSettings } from './GeneralSettings.settings-search';
import { billingSettings } from './BillingSettings.settings-search';
import { usageHistorySettings } from './usage/UsageHistorySection.settings-search';
import { appearanceSettings } from './AppearanceSection.settings-search';
import { personalizationSettings } from './PersonalizationSettings.settings-search';
import { personalizationDetailsSettings } from './PersonalizationDetails.settings-search';
import { voiceInputSettings } from './VoiceInputSection.settings-search';
import { keyboardShortcutsSettings } from './KeyboardShortcutsSection.settings-search';
import { providersSettings } from './ProvidersSection.settings-search';
import { remoteControlSettings } from './RemoteControlSection.settings-search';
import { localAgentSettings } from './LocalAgentSection.settings-search';
import { sharedTasksSettings } from './SharedTasks.settings-search';
import { settingsCatalogPanelSettings } from './SettingsCatalogPanel.settings-search';
import { builtinToolsSettings } from './BuiltinToolsSection.settings-search';
import { computerUseSettings } from './ComputerUseSection.settings-search';
import { agentIslandSettings } from './AgentIslandSection.settings-search';
import { sessionImportSettings } from './SessionImportSection.settings-search';
import { imBotSettings } from './ImBotSection.settings-search';
import { helpSettings } from './HelpSection.settings-search';
import { aboutSettings } from './AboutSection.settings-search';
import { storageManagementCardSettings } from './StorageManagementCard.settings-search';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSyncExternalStore } from 'react';
import { ArrowLeft, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';
import { TAB_IDS, isSettingsTab } from '@/lib/tabLabels';
import type { SettingsTab } from '@/lib/tabLabels';
import { SettingsSidebarNav } from './SettingsSidebarNav';
import { isLegacyAppearanceDeepLink, resolveSettingsSearchEntry } from './settingsSearchCatalog';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_ROW_CLASS,
  SETTINGS_ROW_HINT_CLASS,
  SETTINGS_ROW_LABEL_CLASS,
  SETTINGS_SECTION_TITLE_CLASS,
} from './settingsRowClasses';
import { SettingsSearchNavigationContext } from './SettingsSearchNavigation';
import type { SettingsSearchContext } from './settingsSearchTypes';
import { useSettingsSectionTarget } from './useSettingsSectionTarget';
import { useSettingsEscape } from './useSettingsEscape';
import { UserProfileCard } from './UserProfileCard';
import { VoiceInputSection } from './VoiceInputSection';
import { AppearanceSection } from './AppearanceSection';
import { SubagentModelSection } from './SubagentModelSection';
import { AuxiliaryModelSection } from './AuxiliaryModelSection';
import { VisionBridgeSection } from './VisionBridgeSection';
import { ProvidersSection } from './ProvidersSection';
import { McpServersSection } from './McpServersSection';
import { RemoteControlSection } from './RemoteControlSection';
import { LocalAgentSection } from './LocalAgentSection';
import { SharedTaskDialog } from '@/features/device-link/SharedTaskDialog';
import { NotificationSection } from './NotificationSection';
import { WindowBehaviorSection } from './WindowBehaviorSection';
import { ComposerSendShortcutSection } from './ComposerSendShortcutSection';
import { KeyboardShortcutsSection } from './KeyboardShortcutsSection';
import { AgentIslandSection } from './AgentIslandSection';
import { LanguageSection } from './LanguageSection';
import { LogoutSection } from './LogoutSection';
import { ImBotSection, isImBotSettingsGroup, type ImBotSettingsGroup } from './ImBotSection';
import { AboutSection } from './AboutSection';
import { WorktreeRecycleCard } from './WorktreeRecycleCard';
import { StorageManagementCard } from './StorageManagementCard';
import { UserPromptSection } from './UserPromptSection';
import { MemorySection } from './MemorySection';
import { TerminalShellSection } from './TerminalShellSection';
import { LinkOpenSection } from './LinkOpenSection';
import { StreamFadeSection } from './StreamFadeSection';
import { TipsSection } from './TipsSection';
import { ExperimentalSection } from './ExperimentalSection';
import { GitSafetySection } from './GitSafetySection';
import { SessionImportSection } from './SessionImportSection';
import { HelpSection } from './HelpSection';
import { HelpAssistantPanel } from './HelpAssistantPanel';
import { NewChatDefaultPermissionSection } from './NewChatDefaultPermissionSection';
import { AgentResourceSection } from './AgentResourceSection';
import { PiPackagesSection } from './PiPackagesSection';
import { CollaborationSection } from './CollaborationSection';
import { SetupMigrationSection } from './SetupMigrationSection';
import { BuiltinToolsSection } from './BuiltinToolsSection';
import { ComputerUseSection } from './ComputerUseSection';
import { useAuth } from '@/contexts/AuthContext';
import { useLocale } from '@/hooks/useLocale';
import { useWallpaperSettings } from '@/hooks/useWallpaperSettings';
import { isSceneWallpaper } from '@/lib/wallpaper';
import { isCustomWallpaperVideo } from '../../../shared/appearanceSettings';
import { SettingsCatalogPanel } from './SettingsCatalogPanel';
import { getLastWorkingDir, subscribeToLastWorkingDir } from '@/state/lastWorkingDir';
import { BillingSettingsSection } from '@/features/billing/BillingPage';
import { BotsGlobalSettingsSection } from '@/features/bots/BotsGlobalSettingsSection';
import { canAccessBillingSettings } from './billingVisibility';
import { canAccessUsageSettings } from './usageVisibility';
import { UsageHistorySection } from './usage/UsageHistorySection';
import { CURRENT_CINDY_REGION } from '../../../shared/brandRegion';
import { useVoiceInputModelSelection } from '@/hooks/useVoiceInputModelSelection';
import { useVoiceSpeakerFilterStatus } from '@/hooks/useVoiceSpeakerFilterStatus';
import { getVoiceInputSettings } from '@/hooks/useVoiceInputSettings';
import { getAgentIslandEnabled, getAgentIslandSoundSettings, isAgentIslandSupported, subscribeAgentIslandSettings } from '@/hooks/useAgentIslandSettings';

const DEFAULT_SETTINGS_MENU_WIDTH = 260;

const subscribeVoiceSettings = (onChange: () => void) => window.electronAPI.voiceInput.onDataChanged(onChange);
const getVoiceRefinementEnabled = () => getVoiceInputSettings().refinementEnabled;
const getAgentIslandSoundEnabled = () => getAgentIslandSoundSettings().enabled;

interface SettingsOutletContext {
  sidebarWidth?: number;
}

export function SettingsView() {
  const { mode, dataOwnerId } = useAuth();
  // Share one live voice selection with search and the page; discard it on account changes.
  return <SettingsViewContent key={`${mode}:${dataOwnerId ?? 'none'}`} />;
}

function SettingsViewContent() {
  const { locale } = useLocale();
  const { wallpaperId, customWallpaperUrl } = useWallpaperSettings();
  const wallpaperMotionAvailable = isSceneWallpaper(wallpaperId) ||
    (wallpaperId === 'custom' && isCustomWallpaperVideo(customWallpaperUrl));
  const voiceModelSelection = useVoiceInputModelSelection();
  const { status: speakerFilterStatus } = useVoiceSpeakerFilterStatus(
    (window.electronAPI?.platform === 'darwin' || window.electronAPI?.platform === 'win32') &&
    Boolean(window.electronAPI?.voiceInput?.speakerFilter),
  );
  const voiceRefinementEnabled = useSyncExternalStore(subscribeVoiceSettings, getVoiceRefinementEnabled);
  const agentIslandEnabled = useSyncExternalStore(subscribeAgentIslandSettings, getAgentIslandEnabled);
  const agentIslandSoundEnabled = useSyncExternalStore(subscribeAgentIslandSettings, getAgentIslandSoundEnabled);
  const agentIslandSupported = isAgentIslandSupported();
  const navigate = useNavigate();
  const outletContext = useOutletContext<SettingsOutletContext | null>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { t } = useTranslation();
  const [searchActivation, setSearchActivation] = useState(0);
  const { mode, dataOwnerId, user } = useAuth();
  const menuWidth = outletContext?.sidebarWidth ?? DEFAULT_SETTINGS_MENU_WIDTH;
  const isMac = window.electronAPI?.platform === 'darwin';
  const [helpAssistantOpen, setHelpAssistantOpen] = useState(false);
  const workingDir = useSyncExternalStore(
    subscribeToLastWorkingDir,
    getLastWorkingDir,
    getLastWorkingDir,
  );
  const rawTab = searchParams.get('tab');
  const rawSection = searchParams.get('section');
  const canAccessBilling = canAccessBillingSettings({
    mode,
    membershipKind: user?.membershipKind ?? null,
  });
  const shouldRedirectLegacyPluginTabs = rawTab === 'api-keys' || rawTab === 'connections';
  // 用量历史对所有**已登录**身份开放 (local / cloud personal / cloud org),
  // 与 billing 的 canAccessBillingSettings 无关 —— #2785 维护者裁决。
  const canAccessUsage = canAccessUsageSettings({ mode });

  const activeTab = useMemo<SettingsTab>(() => {
    const raw = rawTab;
    // legacy 别名:旧「远端机器」(remote) /「设备互联」(devices) 已并入「远程控制」(remote-control)。
    if (raw === 'remote' || raw === 'devices') return 'remote-control';
    // legacy 别名:旧「飞书机器人」(feishu-bot) /「Slack 机器人」(slack-bot) 已并入「IM 机器人」(im-bot)。
    if (raw === 'feishu-bot' || raw === 'slack-bot') return 'im-bot';
    // legacy 别名:旧独立「Tina」(tina) 已并入「IM 机器人」(im-bot)。
    if (raw === 'tina') return 'im-bot';
    if (raw === 'billing' && !canAccessBilling) return 'general';
    if (raw === 'usage' && !canAccessUsage) return 'general';
    if (raw === 'agent-island' && !isMac) return 'general';
    // legacy 深链:外观设置原在「通用」、回复动效原在「个性化」,旧 section 深链落到「外观」。
    if (isLegacyAppearanceDeepLink(raw, rawSection)) return 'appearance';
    return isSettingsTab(raw) ? raw : 'general';
  }, [canAccessBilling, canAccessUsage, isMac, rawSection, rawTab]);
  const previousTabRef = useRef(activeTab);
  const refreshVoiceModelSelection = voiceModelSelection.refresh;
  useEffect(() => {
    // The shared hook outlives each tab; restore the old voice-page remount refresh.
    if (previousTabRef.current !== activeTab && activeTab === 'voice-input') {
      void refreshVoiceModelSelection();
    }
    previousTabRef.current = activeTab;
  }, [activeTab, refreshVoiceModelSelection]);

  const piExtensionsPanelOpen =
    activeTab === 'general' &&
    (rawTab === 'pi-extensions' || searchParams.get('openPanel') === 'pi-extensions');

  useEffect(() => {
    if (rawTab !== 'billing' || canAccessBilling) return;
    const next = new URLSearchParams(searchParams);
    next.delete('tab');
    // 计费页不可见时它的深链意图(intent=topup)也一并作废,不留在 URL 上等着
    // 用户切到别的 tab 再被误消费。
    next.delete('intent');
    setSearchParams(next, { replace: true });
  }, [canAccessBilling, rawTab, searchParams, setSearchParams]);

  useEffect(() => {
    if (rawTab !== 'cindy-make') return;
    const next = new URLSearchParams(searchParams);
    next.delete('tab');
    setSearchParams(next, { replace: true });
  }, [rawTab, searchParams, setSearchParams]);

  // 「IM 机器人」官方/个人已纵向同页展示；?imGroup=cindy|personal 只负责把
  // 深链滚动到对应分区。旧「飞书机器人」深链继续定位到「个人」。
  const activeImGroupRaw = activeTab === 'im-bot' ? searchParams.get('imGroup') : null;
  const activeImBotGroup: ImBotSettingsGroup | null = isImBotSettingsGroup(activeImGroupRaw)
    ? activeImGroupRaw
    : null;
  const imBotTargetGroup: ImBotSettingsGroup | null =
    activeTab === 'im-bot'
      ? (activeImBotGroup ?? (searchParams.get('tab') === 'feishu-bot' ? 'personal' : null))
      : null;
  // 切分区后外层滚动容器回顶:滚动偏移是容器的、不随内层 key 重挂归零,
  // 长页滚到底再切短页会停在中段(review 反馈)。瞬时回顶,不做平滑。
  const contentScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    contentScrollRef.current?.scrollTo({ top: 0 });
  }, [activeTab, piExtensionsPanelOpen]);

  const handleSelectTab = useCallback(
    (tab: SettingsTab) => {
      if (tab === activeTab && !piExtensionsPanelOpen) return;
      const next = new URLSearchParams(searchParams);
      next.delete('openPanel');
      next.delete('ghost');
      next.delete('panel');
      next.delete('imGroup');
      next.delete('section');
      // providers 页深链参数(connect/wizard)与计费页深链参数(intent):切走 tab 即
      // 作废,防再切回来被误消费。
      next.delete('connect');
      next.delete('wizard');
      next.delete('intent');
      if (tab === 'general') {
        next.delete('tab');
      } else {
        next.set('tab', tab);
      }
      setSearchParams(next, { replace: true });
    },
    [activeTab, piExtensionsPanelOpen, searchParams, setSearchParams],
  );

  const handleSelectSearchResult = useCallback(
    ({ tab, sectionId }: { tab: SettingsTab; sectionId: string }) => {
      setSearchActivation((value) => value + 1);
      const next = new URLSearchParams(searchParams);
      for (const key of ['openPanel', 'ghost', 'panel', 'imGroup', 'connect', 'wizard', 'intent']) {
        next.delete(key);
      }
      if (tab === 'general') next.delete('tab');
      else next.set('tab', tab);
      next.set('section', sectionId);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const handleOpenPiExtensions = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('tab');
    next.set('openPanel', 'pi-extensions');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const handleClosePiExtensions = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('tab');
    next.delete('openPanel');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // 设置是主窗口里的路由，Esc 与左上角返回按钮走同一出口，不关窗。
  const exitSettings = useCallback(() => navigate('/'), [navigate]);
  const settingsRootRef = useRef<HTMLDivElement | null>(null);

  // Esc 逐层返回：PI 扩展子页先回到「通用」，其余退出设置；帮助面板开着时归它。
  const handleSettingsEscape = useCallback(() => {
    if (piExtensionsPanelOpen) handleClosePiExtensions();
    else exitSettings();
  }, [exitSettings, handleClosePiExtensions, piExtensionsPanelOpen]);
  useSettingsEscape(settingsRootRef, !helpAssistantOpen, handleSettingsEscape);

  useEffect(() => {
    if (activeTab !== 'help') {
      setHelpAssistantOpen(false);
      return;
    }
    if (searchParams.get('openPanel') !== 'help') return;
    setHelpAssistantOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete('openPanel');
    setSearchParams(next, { replace: true });
  }, [activeTab, searchParams, setSearchParams]);

  const visibleTabIds = useMemo(
    () =>
      TAB_IDS.filter(
        (tabId) =>
          (isMac || tabId !== 'agent-island') &&
          (canAccessBilling || tabId !== 'billing') &&
          (canAccessUsage || tabId !== 'usage'),
      ),
    [canAccessBilling, canAccessUsage, isMac],
  );
  const searchContext = useMemo<SettingsSearchContext>(() => ({
    locale,
    wallpaperMotionAvailable,
    region: CURRENT_CINDY_REGION,
    mode,
    membershipKind: user?.membershipKind ?? null,
    platform: window.electronAPI?.platform ?? '',
    supportsBetaUpdateChannel: window.electronAPI?.supportsBetaUpdateChannel,
    voiceRefinementEnabled,
    speakerFilter: speakerFilterStatus ? {
      supported: speakerFilterStatus.supported, enrolled: speakerFilterStatus.enrolled,
    } : undefined,
    agentIsland: { enabled: agentIslandEnabled, supported: agentIslandSupported, soundEnabled: agentIslandSoundEnabled },
    voiceInput: voiceModelSelection.ready && voiceModelSelection.selection ? {
      serviceMode: voiceModelSelection.selection.serviceMode,
      asrProvider: voiceModelSelection.selection.asrProvider,
    } : undefined,
  }), [locale, wallpaperMotionAvailable, mode, user?.membershipKind, voiceModelSelection.ready, voiceModelSelection.selection, voiceRefinementEnabled, speakerFilterStatus?.supported, speakerFilterStatus?.enrolled, agentIslandEnabled, agentIslandSupported, agentIslandSoundEnabled]);
  const requestedEntry = resolveSettingsSearchEntry(activeTab, searchParams.get('section'));
  const searchEntry = piExtensionsPanelOpen || (requestedEntry?.isVisible && !requestedEntry.isVisible(searchContext))
    ? null : requestedEntry;
  const searchNavigation = useMemo(() => ({ entry: searchEntry, activation: searchActivation }), [searchEntry, searchActivation]);
  useSettingsSectionTarget(searchEntry?.targetId ?? null, contentScrollRef, searchParams.toString() + ':' + searchActivation, searchEntry?.fallbackTargetId);

  // 旧「工具密钥」「第三方平台」深链落到设置里的插件分区,不再离开设置。
  if (shouldRedirectLegacyPluginTabs) {
    return <Navigate to="/settings?tab=ghosts" replace />;
  }

  return (
    <SettingsSearchNavigationContext.Provider value={searchNavigation}>
    <div
      ref={settingsRootRef}
      className="h-full w-full overflow-hidden bg-[var(--settings-bg)]"
      role="main"
      aria-label={t('settings.title')}
    >
      {/* Outer container — page itself does not scroll; columns own their scroll behavior.
          左侧保留原来的页头位置；右侧不再为页头预留 56px，贴着 46px 标题栏起排。 */}
      <div className="flex h-full min-h-0 w-full justify-start pb-5">
        {/* Inner sidebar mirrors the main sidebar width for a stable route transition. */}
        <aside
          data-plugin-ui-element="sidebar"
          className="flex h-full min-h-0 shrink-0 flex-col gap-2 overflow-y-auto pl-6 pr-4 pt-7"
          style={{ width: menuWidth }}
          aria-label={t('settings.title')}
        >
          {/* Back navigation — gap 10, pb 18, aligned with menu items via px-3 */}
          <div className="flex items-center gap-2.5 px-3 pb-[18px]">
            <Tip text={t('settings.back')} side="bottom">
              <button data-settings-search-action="Return from settings or close the extensions subpage"
                type="button"
                onClick={exitSettings}
                aria-label={t('settings.back')}
                className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--settings-back-icon)] transition-[color,background-color,transform] duration-150 hover:bg-titlebar-button-hover hover:text-[var(--settings-back-text)] active:scale-[0.98]"
              >
                <ArrowLeft size={20} />
              </button>
            </Tip>
            <h1 className="text-24 font-medium leading-[1.1] text-[var(--settings-back-text)]">
              {t('settings.title')}
            </h1>
          </div>

          <SettingsSidebarNav
            tabIds={visibleTabIds}
            searchContext={searchContext}
            activeTab={activeTab}
            onSelectTab={handleSelectTab}
            onSelectSearchResult={handleSelectSearchResult}
          />
        </aside>

        {/* Content column — capped and centered in the remaining space.
            Most tabs scroll as a page; Session Import and Plugins use a fixed-height
            workspace so only their inner lists scroll.
            right padding mirrors sidebar's 24px left inset.
            右侧贴 46px 标题栏起排，不跟随左侧页头高度下移。
            scrollbar-gutter:stable —— 所有分区都预留同一滚动条槽位；即使
            Session Import 自身不滚动，也要保持与普通滚动页相同的内容宽度。 */}
        <div
          ref={contentScrollRef}
          className={cn(
            'flex h-full min-h-0 min-w-0 flex-1 flex-col pl-4 pr-6 [scrollbar-gutter:stable]',
            // providers 与 import / ghosts 同属「内部自己滚」:模型列表要贴着窗口底,
            // 外层再滚一层会让卡片高度只能靠猜(原先卡片写 calc(100vh-14rem),
            // 扣除量与真实 chrome 不符时下方就空出一条 —— 正是 pb-32 那 128px)。
            activeTab === 'import' || activeTab === 'ghosts' || activeTab === 'providers'
              ? 'overflow-hidden'
              : 'overflow-y-auto',
          )}
        >
          {/* key={activeTab}:切分区时 wrapper 重挂跑 150ms 淡入(面板内容本就
              按 activeTab 条件卸载重挂,key 不额外丢状态;滚动容器在外层不重挂)。 */}
          <div
            key={`${activeTab}:${piExtensionsPanelOpen ? 'pi-extensions' : 'root'}`}
            className={cn(
              'mx-auto w-full min-w-0 max-w-[920px] px-1 animate-fade-in',
              activeTab === 'import' || activeTab === 'ghosts' || activeTab === 'providers'
                ? 'h-full min-h-0'
                : 'pb-32',
              activeTab === 'ghosts' && 'max-w-none px-0',
            )}
          >
            {activeTab === 'general' && (
              <div
                role="tabpanel"
                id={generalSettings.general.targetId}
                aria-labelledby="settings-tab-general"
              >
                {piExtensionsPanelOpen ? (
                  <>
                    <button data-settings-search-action="Return from settings or close the extensions subpage"
                      type="button"
                      onClick={handleClosePiExtensions}
                      className="mb-5 inline-flex h-8 items-center gap-2 rounded-full px-2 text-13 font-medium text-[var(--settings-section-sublabel)] transition-colors hover:bg-sidebar-item-hover hover:text-[var(--settings-section-title)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                    >
                      <ArrowLeft size={16} />
                      {t('settings.piPackages.backToGeneral')}
                    </button>
                    <section id={generalSettings.piExtensions.targetId} className="pb-[18px]" aria-label={t('settings.piPackages.title')}>
                      <PiPackagesSection />
                    </section>
                  </>
                ) : (
                  <>
                    {/* Section — User Info (pb 18) */}
                    <section id={generalSettings.user.targetId} className="pb-[18px]" aria-label={t(generalSettings.user.titleKey)}>
                      <UserProfileCard />
                    </section>

                    {/* Section — 新电脑设置：从同账号另一台电脑迁移，并保留一次性配置清单。 */}
                    <section id="settings-setup-migration" className="py-[18px]" aria-label={t('setupMigration.settings.title')}>
                      <SetupMigrationSection />
                    </section>

                    {/* Section — Language (py 18) */}
                    <section id={generalSettings.language.targetId} className="py-[18px]" aria-label={t(generalSettings.language.titleKey)}>
                      <LanguageSection />
                    </section>

                    {/* Section — Notifications (py 18) */}
                    <section
                      id={generalSettings.notifications.targetId}
                      className="py-[18px]"
                      aria-label={t(generalSettings.notifications.titleKey)}
                    >
                      <NotificationSection />
                    </section>

                    {/* Section — App Behavior(「应用行为」)
                        「保持电脑唤醒」跨平台生效,故 section 常驻;其中
                        「后台窗口首次左键点击仅激活不透传」仅 mac/win 有效,由
                        WindowBehaviorSection 内部按平台隐藏该行。 */}
                    <section
                      id={generalSettings.windowBehavior.targetId}
                      className="py-[18px]"
                      aria-label={t(generalSettings.windowBehavior.titleKey)}
                    >
                      <WindowBehaviorSection />
                    </section>

                    {/* Section — Composer send shortcut (应用级、本地输入偏好)。 */}
                    <section
                      id={generalSettings.composer.targetId}
                      className="py-[18px]"
                      aria-label={t(generalSettings.composer.titleKey)}
                    >
                      <ComposerSendShortcutSection />
                    </section>

                    {/* Section — 伙伴（功能级设置：怎么提醒你 + 带走/接回一个伙伴）。
                        单个伙伴的性格、记忆、能力与日程仍在 TA 自己的设置页里。 */}
                    <section
                      id={generalSettings.bots.targetId}
                      className="py-[18px]"
                      aria-label={t(generalSettings.bots.titleKey)}
                    >
                      <BotsGlobalSettingsSection />
                    </section>

                    {/* Section — Collaboration. */}
                    <section
                      id={generalSettings.collaboration.targetId}
                      className="py-[18px]"
                      aria-label={t(generalSettings.collaboration.titleKey)}
                    >
                      <CollaborationSection />
                    </section>

                    <section id={generalSettings.newChatPermission.targetId} className="py-[18px]"
                      aria-label={t(generalSettings.newChatPermission.titleKey)}>
                      <NewChatDefaultPermissionSection />
                    </section>

                    {/* Section — Agent resource usage (命令并发/进程优先级/工具链限核)。 */}
                    <section
                      id={generalSettings.agentResource.targetId}
                      className="py-[18px]"
                      aria-label={t(generalSettings.agentResource.titleKey)}
                    >
                      <AgentResourceSection />
                    </section>

                    {/* Section — Git safety savepoints (formal setting, not experimental). */}
                    <section id={generalSettings.gitSafety.targetId} className="py-[18px]" aria-label={t(generalSettings.gitSafety.titleKey)}>
                      <GitSafetySection />
                    </section>

                    {/* Pi 扩展只在通用页提供一行入口，不占用设置一级菜单；与 Agent 相关设置放在一起。 */}
                    <section id={generalSettings.piExtensions.targetId} className="py-[18px]" aria-label={t('settings.piPackages.title')}>
                      <div className="flex flex-col gap-[14px]">
                        <h2 className={SETTINGS_SECTION_TITLE_CLASS}>{t('settings.piPackages.title')}</h2>
                        <div className={SETTINGS_CARD_CLASS}>
                          <button data-setting-id={generalSettings.piExtensions.id}
                            type="button"
                            onClick={handleOpenPiExtensions}
                            className={cn(
                              SETTINGS_ROW_CLASS,
                              'w-full rounded-xl text-left transition-colors hover:bg-[var(--settings-menu-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                            )}
                          >
                            <span className="flex min-w-0 flex-col gap-1">
                              <span className={SETTINGS_ROW_LABEL_CLASS} style={{ letterSpacing: '0.12px' }}>
                                {t('settings.piPackages.manageLabel')}
                              </span>
                              <span className={SETTINGS_ROW_HINT_CLASS}>
                                {t('settings.piPackages.entryDescription')}
                              </span>
                            </span>
                            <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />
                          </button>
                        </div>
                      </div>
                    </section>

                    {/* Section — Experimental (py 18). */}
                    <section id={generalSettings.experimental.targetId} className="py-[18px]" aria-label={t(generalSettings.experimental.titleKey)}>
                      <ExperimentalSection />
                    </section>

                    {/* Section — Logout (pt 18) */}
                    <section className="pt-[18px]" aria-label={t('settings.sections.logout')}>
                      <LogoutSection />
                    </section>
                  </>
                )}
              </div>
            )}

            {activeTab === 'billing' && (
              <div
                role="tabpanel"
                id={billingSettings.billing.targetId}
                aria-labelledby="settings-tab-billing"
              >
                <section aria-label={t(billingSettings.billing.sectionKey)}>
                  <BillingSettingsSection
                    key={`billing:${dataOwnerId ?? 'none'}`}
                    accountId={dataOwnerId}
                  />
                </section>
              </div>
            )}

            {activeTab === 'usage' && (
              <div role="tabpanel" id={usageHistorySettings.usage.targetId} aria-labelledby="settings-tab-usage">
                <section aria-label={t(usageHistorySettings.usage.titleKey)}>
                  <UsageHistorySection />
                </section>
              </div>
            )}

            {activeTab === 'appearance' && (
              <div
                role="tabpanel"
                id={appearanceSettings.appearance.targetId}
                aria-labelledby="settings-tab-appearance"
              >
                <section className="pb-[18px]" aria-label={t('settings.sections.appearance')}>
                  <AppearanceSection />
                </section>
                {/* 流式输出淡入动效开关(默认开;reduced-motion 时无条件关);与外观各节同为 36px 节距 */}
                <section id={appearanceSettings.streamFade.targetId} className="pt-[18px] pb-[18px]" aria-label={t(appearanceSettings.streamFade.titleKey)}>
                  <StreamFadeSection />
                </section>
              </div>
            )}

            {activeTab === 'personalization' && (
              <div
                role="tabpanel"
                id={personalizationSettings.personalization.targetId}
                aria-labelledby="settings-tab-personalization"
              >
                <section id={personalizationSettings.userPrompt.targetId} className="pb-[18px]" aria-label={t(personalizationSettings.userPrompt.titleKey)}>
                  <UserPromptSection />
                </section>
                <section id={personalizationDetailsSettings.memoryMakerLabel.targetId} className="pb-[18px]" aria-label={t(personalizationSettings.memory.titleKey)}>
                  <MemorySection />
                </section>
                <section id={personalizationSettings.subagents.targetId} className="pb-[18px]" aria-label={t(personalizationSettings.subagents.titleKey)}>
                  <SubagentModelSection key={`subagent-models:${mode}:${dataOwnerId ?? 'none'}`} />
                </section>
                <section id={personalizationDetailsSettings.auxiliaryModelsTitle.targetId} className="pb-[18px]" aria-label={t(personalizationSettings.auxiliaryModels.titleKey)}>
                  <AuxiliaryModelSection
                    key={`auxiliary-models:${mode}:${dataOwnerId ?? 'none'}`}
                  />
                </section>
                <section id={personalizationSettings.visionBridge.targetId} className="pb-[18px]" aria-label={t(personalizationSettings.visionBridge.titleKey)}>
                  <VisionBridgeSection key={`vision-bridge:${mode}:${dataOwnerId ?? 'none'}`} />
                </section>
                {/* RSB 默认终端 shell —— 改默认只影响新建 tab,已有 tab 不动 */}
                <section id={personalizationDetailsSettings.terminalShellCardLabel.targetId} className="pb-[18px]" aria-label={t(personalizationSettings.terminalShell.titleKey)}>
                  <TerminalShellSection />
                </section>
                {/* 消息流链接/HTML 文件左键的默认打开位置(内置侧边栏 / 系统浏览器) */}
                <section id={personalizationSettings.linkOpen.targetId} className="pb-[18px]" aria-label={t(personalizationSettings.linkOpen.titleKey)}>
                  <LinkOpenSection />
                </section>
                {/* "小技巧" section —— TipsSection 内部把多个功能性 cell
                    (SilentEncryptedRetryCell / ChatEmbeddingCell) 装在一个共享灰底 container,
                    形态跟 MemorySection 对齐 (单标题 + 多 cell + divider)。 */}
                <section id={personalizationDetailsSettings.compatModeTitle.targetId} className="pb-[18px]" aria-label={t(personalizationSettings.tips.titleKey)}>
                  <TipsSection />
                </section>
              </div>
            )}

            {activeTab === 'voice-input' && (
              <div
                role="tabpanel"
                id={voiceInputSettings.voiceInput.targetId}
                aria-labelledby="settings-tab-voice-input"
              >
                <section aria-label={t(voiceInputSettings.voiceInput.sectionKey)}>
                  <VoiceInputSection key={`voice-input:${mode}:${dataOwnerId ?? 'none'}`} modelSelection={voiceModelSelection} />
                </section>
              </div>
            )}

            {activeTab === 'shortcuts' && (
              <div
                role="tabpanel"
                id={keyboardShortcutsSettings.shortcuts.targetId}
                aria-labelledby="settings-tab-shortcuts"
              >
                {/* 应用级快捷键改绑; registry 见 shared/appShortcuts.ts。 */}
                <section aria-label={t(keyboardShortcutsSettings.shortcuts.sectionKey)}>
                  <KeyboardShortcutsSection />
                </section>
              </div>
            )}

            {activeTab === 'providers' && (
              <div
                role="tabpanel"
                id={providersSettings.modelCompaction.targetId}
                aria-labelledby="settings-tab-providers"
                className="h-full min-h-0"
              >
                <section
                  className="flex h-full min-h-0 flex-col pb-[18px]"
                  aria-label={t(providersSettings.providers.sectionKey)}
                >
                  <ProvidersSection />
                </section>
              </div>
            )}

            {activeTab === 'remote-control' && (
              <div
                role="tabpanel"
                id={remoteControlSettings.remoteControl.targetId}
                aria-labelledby="settings-tab-remote-control"
              >
                <section aria-label={t(localAgentSettings.connections.sectionKey)}>
                  <RemoteControlSection />
                  <LocalAgentSection />
                </section>
              </div>
            )}
            {activeTab === 'shared-tasks' && (
              <div role="tabpanel" id={sharedTasksSettings.sharedTasks.targetId} aria-labelledby="settings-tab-shared-tasks">
                <SharedTaskDialog open presentation="settings" onOpenChange={() => undefined} />
              </div>
            )}

            {activeTab === 'ghosts' && (
              <div
                role="tabpanel"
                id={settingsCatalogPanelSettings.plugins.targetId}
                aria-labelledby="settings-tab-ghosts"
                className="h-full min-h-0"
              >
                <SettingsCatalogPanel />
              </div>
            )}

            {activeTab === 'builtin-tools' && (
              <div
                role="tabpanel"
                id={builtinToolsSettings.builtinTools.targetId}
                aria-labelledby="settings-tab-builtin-tools"
              >
                <section className="pb-[18px]" aria-label={t(builtinToolsSettings.title.titleKey)}>
                  <BuiltinToolsSection workingDir={workingDir ?? undefined} />
                </section>
                {/* 外部(自定义)MCP 与内置工具同页管理:内置在上、外部在下,组成「工具」页。 */}
                <section className="pb-[18px]" aria-label={t(builtinToolsSettings.builtinTools.sectionKey)}>
                  <McpServersSection />
                </section>
              </div>
            )}

            {activeTab === 'computer-use' && (
              <div
                role="tabpanel"
                id={computerUseSettings.computerUse.targetId}
                aria-labelledby="settings-tab-computer-use"
              >
                <section className="pb-[18px]" aria-label={t(computerUseSettings.computerUse.sectionKey)}>
                  <ComputerUseSection workingDir={workingDir ?? undefined} />
                </section>
              </div>
            )}

            {isMac && activeTab === 'agent-island' && (
              <div
                role="tabpanel"
                id={agentIslandSettings.agentIsland.targetId}
                aria-labelledby="settings-tab-agent-island"
              >
                <section className="pb-[18px]" aria-label={t(agentIslandSettings.agentIsland.sectionKey)}>
                  <AgentIslandSection />
                </section>
              </div>
            )}

            {activeTab === 'import' && (
              <div
                role="tabpanel"
                id={sessionImportSettings.import.targetId}
                aria-labelledby="settings-tab-import"
                className="h-full min-h-0"
              >
                <section className="h-full min-h-0" aria-label={t(sessionImportSettings.import.sectionKey)}>
                  <SessionImportSection />
                </section>
              </div>
            )}

            {activeTab === 'im-bot' && (
              <div role="tabpanel" id={imBotSettings.imBot.targetId} aria-labelledby="settings-tab-im-bot">
                {/* 官方/个人纵向同页展示；imGroup 只保留深链定位语义。 */}
                <section aria-label={t(imBotSettings.imBot.sectionKey)}>
                  <ImBotSection targetGroup={imBotTargetGroup} />
                </section>
              </div>
            )}

            {activeTab === 'help' && (
              <div role="tabpanel" id={helpSettings.help.targetId} aria-labelledby="settings-tab-help">
                <section aria-label={t(helpSettings.help.sectionKey)}>
                  <HelpSection onAskHelp={() => setHelpAssistantOpen(true)} />
                </section>
              </div>
            )}

            {activeTab === 'about' && (
              <div role="tabpanel" id={aboutSettings.about.targetId} aria-labelledby="settings-tab-about">
                <section aria-label={t(aboutSettings.about.sectionKey)}>
                  <AboutSection />
                </section>
              </div>
            )}

            {activeTab === 'storage' && (
              <div
                role="tabpanel"
                id={storageManagementCardSettings.storage.targetId}
                aria-labelledby="settings-tab-storage"
              >
                <section aria-label={t(storageManagementCardSettings.storage.sectionKey)}>
                  <StorageManagementCard />
                  <WorktreeRecycleCard />
                </section>
              </div>
            )}
          </div>
        </div>
      </div>
      <HelpAssistantPanel open={helpAssistantOpen} onClose={() => setHelpAssistantOpen(false)} />
    </div>
    </SettingsSearchNavigationContext.Provider>
  );
}
