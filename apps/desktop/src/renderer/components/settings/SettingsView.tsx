import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSyncExternalStore } from 'react';
import { ArrowLeft } from 'lucide-react';

import { cn } from '@/lib/utils';
import { TAB_IDS, TAB_LABEL_KEY, isSettingsTab } from '@/lib/tabLabels';
import type { SettingsTab } from '@/lib/tabLabels';
import { UserProfileCard } from './UserProfileCard';
import { VoiceInputSection } from './VoiceInputSection';
import { AppearanceSection } from './AppearanceSection';
import { SubagentModelSection } from './SubagentModelSection';
import { ProvidersSection } from './ProvidersSection';
import { McpServersSection } from './McpServersSection';
import { RemoteControlSection } from './RemoteControlSection';
import { NotificationSection } from './NotificationSection';
import { WindowBehaviorSection } from './WindowBehaviorSection';
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
import { TipsSection } from './TipsSection';
import { ExperimentalSection } from './ExperimentalSection';
import { GitSafetySection } from './GitSafetySection';
import { SessionImportSection } from './SessionImportSection';
import { HelpSection } from './HelpSection';
import { HelpAssistantPanel } from './HelpAssistantPanel';
import { CollaborationSection } from './CollaborationSection';
import { BuiltinToolsSection } from './BuiltinToolsSection';
import { ContactsSection } from './contacts/ContactsSection';
import { ComputerUseSection } from './ComputerUseSection';
import { useAuth } from '@/contexts/AuthContext';
import { getLastWorkingDir, subscribeToLastWorkingDir } from '@/state/lastWorkingDir';
import { BillingSettingsSection } from '@/features/billing/BillingPage';
import { canAccessBillingSettings } from './billingVisibility';

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
  const shouldRedirectToPlugins =
    rawTab === 'ghosts' || rawTab === 'api-keys' || rawTab === 'connections';

  const activeTab = useMemo<SettingsTab>(() => {
    const raw = rawTab;
    // legacy 别名:旧「远端机器」(remote) /「设备互联」(devices) 已并入「远程控制」(remote-control)。
    if (raw === 'remote' || raw === 'devices') return 'remote-control';
    // legacy 别名:旧「飞书机器人」(feishu-bot) /「Slack 机器人」(slack-bot) 已并入「IM 机器人」(im-bot)。
    if (raw === 'feishu-bot' || raw === 'slack-bot') return 'im-bot';
    // legacy 别名:旧独立「Tina」(tina) 已并入「IM 机器人」(im-bot)。
    if (raw === 'tina') return 'im-bot';
    if (raw === 'billing' && !canAccessBilling) return 'general';
    if (raw === 'agent-island' && !isMac) return 'general';
    return isSettingsTab(raw) ? raw : 'general';
  }, [canAccessBilling, isMac, rawTab]);

  useEffect(() => {
    if (rawTab !== 'billing' || canAccessBilling) return;
    const next = new URLSearchParams(searchParams);
    next.delete('tab');
    setSearchParams(next, { replace: true });
  }, [canAccessBilling, rawTab, searchParams, setSearchParams]);

  // 「IM 机器人」页内分栏:?imGroup=cindy|personal 定位到某个 tab(深链可直达)。
  // 缺省/非法 imGroup 一律落到默认分栏:旧「飞书机器人」深链落「个人」(飞书在
  // 个人栏),其余(im-bot / slack-bot / tina)落「Cindy」。
  const activeImGroupRaw = activeTab === 'im-bot' ? searchParams.get('imGroup') : null;
  const activeImBotGroup: ImBotSettingsGroup | null = isImBotSettingsGroup(activeImGroupRaw)
    ? activeImGroupRaw
    : null;
  const imBotFallbackGroup: ImBotSettingsGroup =
    searchParams.get('tab') === 'feishu-bot' ? 'personal' : 'cindy';
  // 渲染层直接用兜底值,imGroup 缺省时不回写 URL(少一次 replace,深链语义不变)。
  const resolvedImBotGroup: ImBotSettingsGroup | null =
    activeTab === 'im-bot' ? (activeImBotGroup ?? imBotFallbackGroup) : null;

  // 切分区后外层滚动容器回顶:滚动偏移是容器的、不随内层 key 重挂归零,
  // 长页滚到底再切短页会停在中段(review 反馈)。瞬时回顶,不做平滑。
  const contentScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    contentScrollRef.current?.scrollTo({ top: 0 });
  }, [activeTab]);

  const handleSelectTab = useCallback(
    (tab: SettingsTab) => {
      if (tab === activeTab) return;
      const next = new URLSearchParams(searchParams);
      next.delete('openPanel');
      next.delete('ghost');
      next.delete('imGroup');
      next.delete('section');
      // providers 页深链参数(connect/wizard):切走 tab 即作废,防再切回来被误消费。
      next.delete('connect');
      next.delete('wizard');
      if (tab === 'general') {
        next.delete('tab');
      } else {
        next.set('tab', tab);
      }
      setSearchParams(next, { replace: true });
    },
    [activeTab, searchParams, setSearchParams],
  );

  const handleSelectImBotGroup = useCallback(
    (group: ImBotSettingsGroup) => {
      const next = new URLSearchParams(searchParams);
      next.delete('openPanel');
      next.set('tab', 'im-bot');
      next.set('imGroup', group);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

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
        (tabId) => (isMac || tabId !== 'agent-island') && (canAccessBilling || tabId !== 'billing'),
      ),
    [canAccessBilling, isMac],
  );

  // deep-link: ?section=... → scroll to a section inside General settings.
  useEffect(() => {
    const section = searchParams.get('section');
    const sectionId =
      section === 'collaboration'
        ? 'settings-collaboration'
        : section === 'notifications'
          ? 'settings-notifications'
          : null;
    if (!sectionId) return;
    const el = document.getElementById(sectionId);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [searchParams]);

  // The plugin catalog moved to the top-level /plugins route. Keep old links
  // working without leaving a second plugin management UI under Settings.
  if (shouldRedirectToPlugins) return <Navigate to="/plugins" replace />;

  return (
    <div
      className="h-full w-full overflow-hidden bg-[var(--settings-bg)]"
      role="main"
      aria-label={t('settings.title')}
    >
      {/* Outer container — page itself does not scroll; columns own their scroll behavior. */}
      <div className="flex h-full min-h-0 w-full justify-start pt-7 pb-5">
        {/* Inner sidebar mirrors the main sidebar width for a stable route transition. */}
        <aside
          className="flex h-full min-h-0 shrink-0 flex-col gap-2 overflow-y-auto pl-6 pr-4"
          style={{ width: menuWidth }}
          aria-label={t('settings.title')}
        >
          {/* Back navigation — gap 10, pb 18, aligned with menu items via px-3 */}
          <div className="flex items-center gap-2.5 px-3 pb-[18px]">
            <button
              type="button"
              onClick={() => navigate('/')}
              aria-label={t('settings.back')}
              className="flex items-center justify-center text-[var(--settings-back-icon)] transition-colors hover:text-[var(--settings-back-text)]"
            >
              <ArrowLeft size={20} />
            </button>
            <h1 className="text-24 font-medium leading-[1.1] text-[var(--settings-back-text)]">
              {t('settings.title')}
            </h1>
          </div>

          {/* Tab list —— 全部是普通 cell(「IM 机器人」的分栏切换在其页面内部) */}
          <nav role="tablist" aria-label={t('settings.title')} className="flex flex-col gap-0.5">
            {visibleTabIds.map((tabId) => {
              const selected = activeTab === tabId;
              return (
                <button
                  key={tabId}
                  id={`settings-tab-${tabId}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`settings-panel-${tabId}`}
                  onClick={() => handleSelectTab(tabId)}
                  className={cn(
                    'flex h-9 items-center rounded-full px-3 text-sm transition-colors',
                    selected
                      ? 'border border-[var(--sidebar-item-active-border)] bg-sidebar-item-active font-medium text-[var(--sidebar-item-active-foreground)]'
                      : 'border border-transparent text-[var(--settings-menu-text)] hover:bg-sidebar-item-hover',
                  )}
                >
                  {t(TAB_LABEL_KEY[tabId])}
                </button>
              );
            })}
          </nav>
        </aside>

        {/* Content column — capped and centered in the remaining space.
            right padding mirrors sidebar's 24px left inset.
            pt-[56px] pushes content top to align with the first nav tab (General),
            skipping the "Settings" header height (h1 24/1.1 + pb-18 + gap-2 ≈ 52px).
            scrollbar-gutter:stable —— 全局滚动条占位 12px,长短页(有/无滚动条)
            切换时预留 gutter,避免居中内容左右跳变。 */}
        <div
          ref={contentScrollRef}
          className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-y-auto pl-4 pr-6 pt-[56px] [scrollbar-gutter:stable]"
        >
          {/* key={activeTab}:切分区时 wrapper 重挂跑 150ms 淡入(面板内容本就
              按 activeTab 条件卸载重挂,key 不额外丢状态;滚动容器在外层不重挂)。 */}
          <div key={activeTab} className="mx-auto w-full max-w-[920px] pb-32 animate-fade-in">
            {activeTab === 'general' && (
              <div
                role="tabpanel"
                id="settings-panel-general"
                aria-labelledby="settings-tab-general"
              >
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

                {/* Section — Experimental (py 18)
                    内部按 EXPERIMENTAL_FEATURES 注册表渲染; admin-only 项对非 admin 用户
                    自动跳过。如果当前没有任何可见 feature, ExperimentalSection 自身返回 null,
                    section 容器仍占位 (空 padding) — 不显示空标题。 */}
                <section
                  id="settings-collaboration"
                  className="py-[18px]"
                  aria-label={t('settings.sections.collaboration')}
                >
                  <CollaborationSection />
                </section>

                {/* Section — Git safety savepoints (formal setting, not experimental). */}
                <section className="py-[18px]" aria-label={t('settings.sections.gitSafety')}>
                  <GitSafetySection />
                </section>

                {/* Section — Experimental (py 18)
                    内部按 EXPERIMENTAL_FEATURES 注册表渲染; 仅 admin 可见。
                    如果当前没有任何可见 feature, ExperimentalSection 自身返回 null。 */}
                <section className="py-[18px]" aria-label={t('settings.sections.experimental')}>
                  <ExperimentalSection />
                </section>

                {/* Section — Logout (pt 18) */}
                <section className="pt-[18px]" aria-label={t('settings.sections.logout')}>
                  <LogoutSection />
                </section>
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
                {mode !== 'local' && (
                  <section className="pb-[18px]" aria-label={t('settings.contacts.title')}>
                    <ContactsSection key={`contacts:${dataOwnerId ?? 'none'}`} />
                  </section>
                )}
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
              <div role="tabpanel" id="settings-panel-import" aria-labelledby="settings-tab-import">
                <section aria-label={t('settings.sections.import')}>
                  <SessionImportSection />
                </section>
              </div>
            )}

            {activeTab === 'im-bot' && (
              <div role="tabpanel" id="settings-panel-im-bot" aria-labelledby="settings-tab-im-bot">
                {/* 单页 + 页内分栏 tab:imGroup 缺省时渲染默认分栏 */}
                <section aria-label={t('settings.sections.imBot')}>
                  {resolvedImBotGroup && (
                    <ImBotSection
                      group={resolvedImBotGroup}
                      onGroupChange={handleSelectImBotGroup}
                    />
                  )}
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
