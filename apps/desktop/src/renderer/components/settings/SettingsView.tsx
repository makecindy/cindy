import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSyncExternalStore } from 'react';
import { ArrowLeft, ChevronRight, Puzzle } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';
import { TAB_IDS, isSettingsTab } from '@/lib/tabLabels';
import type { SettingsTab } from '@/lib/tabLabels';
import { SettingsSidebarNav } from './SettingsSidebarNav';
import { UserProfileCard } from './UserProfileCard';
import { VoiceInputSection } from './VoiceInputSection';
import { AppearanceSection } from './AppearanceSection';
import { SubagentModelSection } from './SubagentModelSection';
import { AuxiliaryModelSection } from './AuxiliaryModelSection';
import { VisionBridgeSection } from './VisionBridgeSection';
import { ProvidersSection } from './ProvidersSection';
import { McpServersSection } from './McpServersSection';
import { RemoteControlSection } from './RemoteControlSection';
import { NotificationSection } from './NotificationSection';
import { WindowBehaviorSection } from './WindowBehaviorSection';
import { ComposerSendShortcutSection } from './ComposerSendShortcutSection';
import { KeyboardShortcutsSection } from './KeyboardShortcutsSection';
import { AgentIslandSection } from './AgentIslandSection';
import { LanguageSection } from './LanguageSection';
import { LogoutSection } from './LogoutSection';
import { ImBotSection, isImBotSettingsGroup, type ImBotSettingsGroup } from './ImBotSection';
import { AboutSection } from './AboutSection';
import { UserPromptSection } from './UserPromptSection';
import { MemorySection } from './MemorySection';
import { CompactionSection } from './CompactionSection';
import { TerminalShellSection } from './TerminalShellSection';
import { LinkOpenSection } from './LinkOpenSection';
import { StreamFadeSection } from './StreamFadeSection';
import { TipsSection } from './TipsSection';
import { ExperimentalSection } from './ExperimentalSection';
import { GitSafetySection } from './GitSafetySection';
import { SessionImportSection } from './SessionImportSection';
import { HelpSection } from './HelpSection';
import { HelpAssistantPanel } from './HelpAssistantPanel';
import { AgentResourceSection } from './AgentResourceSection';
import { PiPackagesSection } from './PiPackagesSection';
import { CollaborationSection } from './CollaborationSection';
import { BuiltinToolsSection } from './BuiltinToolsSection';
import { ContactsSection } from './contacts/ContactsSection';
import { ComputerUseSection } from './ComputerUseSection';
import { useAuth } from '@/contexts/AuthContext';
import { SettingsCatalogPanel } from './SettingsCatalogPanel';
import { getLastWorkingDir, subscribeToLastWorkingDir } from '@/state/lastWorkingDir';
import { BillingSettingsSection } from '@/features/billing/BillingPage';
import { canAccessBillingSettings } from './billingVisibility';
import { canAccessUsageSettings } from './usageVisibility';
import { UsageHistorySection } from './usage/UsageHistorySection';

const DEFAULT_SETTINGS_MENU_WIDTH = 260;

interface SettingsOutletContext {
  sidebarWidth?: number;
}

export function SettingsView() {
  const navigate = useNavigate();
  const outletContext = useOutletContext<SettingsOutletContext | null>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { t } = useTranslation();
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
    return isSettingsTab(raw) ? raw : 'general';
  }, [canAccessBilling, canAccessUsage, isMac, rawTab]);
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

  // deep-link: ?section=... → scroll to a section inside the active tab.
  useEffect(() => {
    const section = searchParams.get('section');
    const sectionId =
      section === 'collaboration'
        ? 'settings-collaboration'
        : section === 'notifications'
          ? 'settings-notifications'
          : section === 'contacts'
            ? 'settings-contacts'
            : null;
    if (!sectionId) return;
    const el = document.getElementById(sectionId);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [searchParams]);

  // 旧「工具密钥」「第三方平台」深链落到设置里的插件分区,不再离开设置。
  if (shouldRedirectLegacyPluginTabs) {
    return <Navigate to="/settings?tab=ghosts" replace />;
  }

  return (
    <div
      className="h-full w-full overflow-hidden bg-[var(--settings-bg)]"
      role="main"
      aria-label={t('settings.title')}
    >
      {/* Outer container — page itself does not scroll; columns own their scroll behavior.
          左侧保留原来的页头位置；右侧不再为页头预留 56px，贴着 46px 标题栏起排。 */}
      <div className="flex h-full min-h-0 w-full justify-start pb-5">
        {/* Inner sidebar mirrors the main sidebar width for a stable route transition. */}
        <aside
          className="flex h-full min-h-0 shrink-0 flex-col gap-2 overflow-y-auto pl-6 pr-4 pt-7"
          style={{ width: menuWidth }}
          aria-label={t('settings.title')}
        >
          {/* Back navigation — gap 10, pb 18, aligned with menu items via px-3 */}
          <div className="flex items-center gap-2.5 px-3 pb-[18px]">
            <Tip text={t('settings.back')} side="bottom">
              <button
                type="button"
                onClick={() => navigate('/')}
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
            activeTab={activeTab}
            onSelectTab={handleSelectTab}
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
            activeTab === 'import' || activeTab === 'ghosts'
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
              activeTab === 'import' || activeTab === 'ghosts' ? 'h-full min-h-0' : 'pb-32',
              activeTab === 'ghosts' && 'max-w-none px-0',
            )}
          >
            {activeTab === 'general' && (
              <div
                role="tabpanel"
                id="settings-panel-general"
                aria-labelledby="settings-tab-general"
              >
                {piExtensionsPanelOpen ? (
                  <>
                    <button
                      type="button"
                      onClick={handleClosePiExtensions}
                      className="mb-5 inline-flex h-8 items-center gap-2 rounded-full px-2 text-13 font-medium text-[var(--settings-section-sublabel)] transition-colors hover:bg-sidebar-item-hover hover:text-[var(--settings-section-title)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                    >
                      <ArrowLeft size={16} />
                      {t('settings.piPackages.backToGeneral')}
                    </button>
                    <section className="pb-[18px]" aria-label={t('settings.piPackages.title')}>
                      <PiPackagesSection />
                    </section>
                  </>
                ) : (
                  <>
                    {/* Section — User Info (pb 18) */}
                    <section className="pb-[18px]" aria-label={t('settings.sections.user')}>
                      <UserProfileCard />
                    </section>

                    {/* Section — Appearance (py 18) */}
                    <section className="py-[18px]" aria-label={t('settings.sections.appearance')}>
                      <AppearanceSection />
                    </section>

                    {/* Section — Language (py 18) */}
                    <section className="py-[18px]" aria-label={t('settings.sections.language')}>
                      <LanguageSection />
                    </section>

                    {/* Pi 扩展只在通用页提供一行入口，不占用设置一级菜单。 */}
                    <section className="py-[18px]" aria-label={t('settings.piPackages.entryTitle')}>
                      <button
                        type="button"
                        onClick={handleOpenPiExtensions}
                        className="flex w-full items-center gap-3 rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] px-5 py-4 text-left transition-colors hover:bg-[var(--settings-menu-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--settings-btn-secondary-border)] bg-[var(--surface)] text-[var(--settings-section-desc)]">
                          <Puzzle size={18} />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="text-14 font-medium leading-tight text-[var(--settings-section-title)]">
                            {t('settings.piPackages.entryTitle')}
                          </span>
                          <span className="text-13 leading-tight text-[var(--settings-integration-subtitle)]">
                            {t('settings.piPackages.entryDescription')}
                          </span>
                        </span>
                        <ChevronRight size={18} className="shrink-0 text-[var(--text-tertiary)]" />
                      </button>
                    </section>

                    {/* Section — Notifications (py 18) */}
                    <section
                      id="settings-notifications"
                      className="py-[18px]"
                      aria-label={t('settings.sections.notifications')}
                    >
                      <NotificationSection />
                    </section>

                    {/* Section — App Behavior(「应用行为」)
                        「保持电脑唤醒」跨平台生效,故 section 常驻;其中
                        「后台窗口首次左键点击仅激活不透传」仅 mac/win 有效,由
                        WindowBehaviorSection 内部按平台隐藏该行。 */}
                    <section
                      id="settings-window-behavior"
                      className="py-[18px]"
                      aria-label={t('settings.sections.windowBehavior')}
                    >
                      <WindowBehaviorSection />
                    </section>

                    {/* Section — Composer send shortcut (应用级、本地输入偏好)。 */}
                    <section
                      id="settings-composer"
                      className="py-[18px]"
                      aria-label={t('settings.sections.composer')}
                    >
                      <ComposerSendShortcutSection />
                    </section>

                    {/* Section — Collaboration. */}
                    <section
                      id="settings-collaboration"
                      className="py-[18px]"
                      aria-label={t('settings.sections.collaboration')}
                    >
                      <CollaborationSection />
                    </section>

                    {/* Section — Agent resource usage (命令并发/进程优先级/工具链限核)。 */}
                    <section
                      id="settings-agent-resource"
                      className="py-[18px]"
                      aria-label={t('settings.sections.agentResource')}
                    >
                      <AgentResourceSection />
                    </section>

                    {/* Section — Git safety savepoints (formal setting, not experimental). */}
                    <section className="py-[18px]" aria-label={t('settings.sections.gitSafety')}>
                      <GitSafetySection />
                    </section>

                    {/* Section — Experimental (py 18). */}
                    <section className="py-[18px]" aria-label={t('settings.sections.experimental')}>
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
                id="settings-panel-billing"
                aria-labelledby="settings-tab-billing"
              >
                <section aria-label={t('settings.sections.billing')}>
                  <BillingSettingsSection
                    key={`billing:${dataOwnerId ?? 'none'}`}
                    accountId={dataOwnerId}
                  />
                </section>
              </div>
            )}

            {activeTab === 'usage' && (
              <div role="tabpanel" id="settings-panel-usage" aria-labelledby="settings-tab-usage">
                <section aria-label={t('settings.tabs.usage')}>
                  <UsageHistorySection />
                </section>
              </div>
            )}

            {activeTab === 'personalization' && (
              <div
                role="tabpanel"
                id="settings-panel-personalization"
                aria-labelledby="settings-tab-personalization"
              >
                <section className="pb-[18px]" aria-label={t('settings.sections.personalization')}>
                  <UserPromptSection />
                </section>
                <section className="pb-[18px]" aria-label={t('settings.sections.memory')}>
                  <MemorySection />
                </section>
                <section className="pb-[18px]" aria-label={t('settings.sections.subagentModels')}>
                  <SubagentModelSection key={`subagent-models:${mode}:${dataOwnerId ?? 'none'}`} />
                </section>
                <section className="pb-[18px]" aria-label={t('settings.sections.auxiliaryModels')}>
                  <AuxiliaryModelSection
                    key={`auxiliary-models:${mode}:${dataOwnerId ?? 'none'}`}
                  />
                </section>
                <section className="pb-[18px]" aria-label={t('settings.sections.visionBridge')}>
                  <VisionBridgeSection key={`vision-bridge:${mode}:${dataOwnerId ?? 'none'}`} />
                </section>
                {/* 通讯录是本机全局库(数据与开关都不依赖云端账号),local 模式同样可用 */}
                <section
                  id="settings-contacts"
                  className="pb-[18px]"
                  aria-label={t('settings.contacts.title')}
                >
                  <ContactsSection key={`contacts:${dataOwnerId ?? 'none'}`} />
                </section>
                <section className="pb-[18px]" aria-label={t('settings.sections.compaction')}>
                  <CompactionSection key={`compaction:${mode}:${dataOwnerId ?? 'none'}`} />
                </section>
                {/* RSB 默认终端 shell —— 改默认只影响新建 tab,已有 tab 不动 */}
                <section className="pb-[18px]" aria-label={t('settings.sections.terminalShell')}>
                  <TerminalShellSection />
                </section>
                {/* 消息流链接/HTML 文件左键的默认打开位置(内置侧边栏 / 系统浏览器) */}
                <section className="pb-[18px]" aria-label={t('settings.sections.linkOpen')}>
                  <LinkOpenSection />
                </section>
                {/* 流式输出淡入动效开关(默认开;reduced-motion 时无条件关) */}
                <section className="pb-[18px]" aria-label={t('settings.sections.streamFade')}>
                  <StreamFadeSection />
                </section>
                {/* "小技巧" section —— TipsSection 内部把多个功能性 cell
                    (SilentEncryptedRetryCell / ChatEmbeddingCell) 装在一个共享灰底 container,
                    形态跟 MemorySection 对齐 (单标题 + 多 cell + divider)。 */}
                <section className="pb-[18px]" aria-label={t('settings.sections.compatMode')}>
                  <TipsSection />
                </section>
              </div>
            )}

            {activeTab === 'voice-input' && (
              <div
                role="tabpanel"
                id="settings-panel-voice-input"
                aria-labelledby="settings-tab-voice-input"
              >
                <section aria-label={t('settings.sections.voiceInput')}>
                  <VoiceInputSection key={`voice-input:${mode}:${dataOwnerId ?? 'none'}`} />
                </section>
              </div>
            )}

            {activeTab === 'shortcuts' && (
              <div
                role="tabpanel"
                id="settings-panel-shortcuts"
                aria-labelledby="settings-tab-shortcuts"
              >
                {/* 应用级快捷键改绑; registry 见 shared/appShortcuts.ts。 */}
                <section aria-label={t('settings.sections.shortcuts')}>
                  <KeyboardShortcutsSection />
                </section>
              </div>
            )}

            {activeTab === 'providers' && (
              <div
                role="tabpanel"
                id="settings-panel-providers"
                aria-labelledby="settings-tab-providers"
              >
                <section className="pb-[18px]" aria-label={t('settings.sections.providers')}>
                  <ProvidersSection />
                </section>
              </div>
            )}

            {activeTab === 'remote-control' && (
              <div
                role="tabpanel"
                id="settings-panel-remote-control"
                aria-labelledby="settings-tab-remote-control"
              >
                <section aria-label={t('settings.sections.remoteControl')}>
                  <RemoteControlSection />
                </section>
              </div>
            )}

            {activeTab === 'ghosts' && (
              <div
                role="tabpanel"
                id="settings-panel-ghosts"
                aria-labelledby="settings-tab-ghosts"
                className="h-full min-h-0"
              >
                <SettingsCatalogPanel />
              </div>
            )}

            {activeTab === 'builtin-tools' && (
              <div
                role="tabpanel"
                id="settings-panel-builtin-tools"
                aria-labelledby="settings-tab-builtin-tools"
              >
                <section className="pb-[18px]" aria-label={t('settings.builtinTools.title')}>
                  <BuiltinToolsSection workingDir={workingDir ?? undefined} />
                </section>
                {/* 外部(自定义)MCP 与内置工具同页管理:内置在上、外部在下,组成「工具」页。 */}
                <section className="pb-[18px]" aria-label={t('settings.sections.mcpServers')}>
                  <McpServersSection />
                </section>
              </div>
            )}

            {activeTab === 'computer-use' && (
              <div
                role="tabpanel"
                id="settings-panel-computer-use"
                aria-labelledby="settings-tab-computer-use"
              >
                <section className="pb-[18px]" aria-label={t('settings.computerUse.title')}>
                  <ComputerUseSection workingDir={workingDir ?? undefined} />
                </section>
              </div>
            )}

            {isMac && activeTab === 'agent-island' && (
              <div
                role="tabpanel"
                id="settings-panel-agent-island"
                aria-labelledby="settings-tab-agent-island"
              >
                <section className="pb-[18px]" aria-label={t('settings.sections.agentIsland')}>
                  <AgentIslandSection />
                </section>
              </div>
            )}

            {activeTab === 'import' && (
              <div
                role="tabpanel"
                id="settings-panel-import"
                aria-labelledby="settings-tab-import"
                className="h-full min-h-0"
              >
                <section className="h-full min-h-0" aria-label={t('settings.sections.import')}>
                  <SessionImportSection />
                </section>
              </div>
            )}

            {activeTab === 'im-bot' && (
              <div role="tabpanel" id="settings-panel-im-bot" aria-labelledby="settings-tab-im-bot">
                {/* 官方/个人纵向同页展示；imGroup 只保留深链定位语义。 */}
                <section aria-label={t('settings.sections.imBot')}>
                  <ImBotSection targetGroup={imBotTargetGroup} />
                </section>
              </div>
            )}

            {activeTab === 'help' && (
              <div role="tabpanel" id="settings-panel-help" aria-labelledby="settings-tab-help">
                <section aria-label={t('settings.sections.help')}>
                  <HelpSection onAskHelp={() => setHelpAssistantOpen(true)} />
                </section>
              </div>
            )}

            {activeTab === 'about' && (
              <div role="tabpanel" id="settings-panel-about" aria-labelledby="settings-tab-about">
                <section aria-label={t('settings.sections.about')}>
                  <AboutSection />
                </section>
              </div>
            )}
          </div>
        </div>
      </div>
      <HelpAssistantPanel open={helpAssistantOpen} onClose={() => setHelpAssistantOpen(false)} />
    </div>
  );
}
