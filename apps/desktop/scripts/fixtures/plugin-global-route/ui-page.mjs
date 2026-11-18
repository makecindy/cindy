import assert from 'node:assert/strict';

// Keep the actual MainLayout state, visibility subscription, layout engine and
// fixed controls. Unrelated background hosts are inert in this isolated page.
const inert = Object.fromEntries([
  ['features/first-run-guide/FirstRunGuide', 'FirstRunGuide'],
  ['components/performance-trace/PerformanceTrace', 'PerformanceTrace,openPerformanceTrace'],
  ['features/bots/ChatInviteHost', 'ChatInviteHost,reportMalformedChatInvite,requestChatInvite'],
  ['features/device-link/JoinSharedTaskDialog', 'JoinSharedTaskDialog'],
  ['components/layout/BrowserWebviewPool', 'BrowserWebviewPool'],
  ['components/layout/ChromeActions', 'ChromeActions'],
  ['components/sidebar/Sidebar', 'Sidebar'],
  ['layout/PanelDragController', 'PanelDragController'],
  ['features/right-sidebar/TabDragController', 'TabDragController'],
  ['cindy-brain/GhostMediaLightboxHost', 'GhostMediaLightboxHost'],
  ['components/title-bar/WindowControls', 'WindowControls'],
  ['components/UpdateNoticeDialog', 'UpdateNoticeDialog'],
  ['components/feishuBot/FeishuConflictDialogHost', 'FeishuConflictDialogHost'],
  ['components/log-support/StartupRecoveryDialogs', 'StartupRecoveryDialogs'],
  ['components/layout/GlobalDropImportListener', 'GlobalDropImportListener'],
  ['components/settings/SessionShareImportWizard', 'SessionShareImportWizard'],
  ['features/remote-device/ControlledBanner', 'ControlledBanner'],
  ['features/remote-desktop/TaskRemoteDesktopButton', 'TaskRemoteDesktopButton'],
  ['components/layout/CredentialStoreBanner', 'CredentialStoreBanner'],
  ['features/scheduler/components/ScheduleSessionIndexOwner', 'ScheduleSessionIndexOwner'],
  ['features/bots/voice/GlobalVoiceCall', 'GlobalVoiceCallHost,RemoteVoiceCallSurface,VoiceCallFloatingSlot'],
  ['features/provider-share/ProviderShareGlobalHost', 'ProviderShareGlobalHost'],
  ['features/relay-share/RelayShareGlobalHost', 'RelayShareGlobalHost'],
  ['components/sidebar/UpdateBanner', 'FloatingUpdateBanner'],
  ['hooks/usePendingAlertAttention', 'usePendingAlertAttention'],
  ['hooks/useCorruptionRestoredToast', 'useCorruptionRestoredToast'],
  ['hooks/useSchemaDriftWarningToast', 'useSchemaDriftWarningToast'],
  ['hooks/useVoiceInputShortcutRecoveryToast', 'useVoiceInputShortcutRecoveryToast'],
  ['hooks/usePluginRemovalNoticeToast', 'usePluginRemovalNoticeToast'],
  ['features/device-link/useDeviceLinkRemoteProjects', 'useDeviceLinkRemoteProjects'],
  ['features/device-link/agentIslandRemoteSessions', 'useAgentIslandRemoteSessionsSync'],
  ['features/bots/useSessionEntryLocationCommits', 'useSessionEntryLocationCommits'],
].map(([path, names]) => [`src/renderer/${path}`,
  names.split(',').map(name => `export const ${name} = () => null;`).join('\n')]));

export default {
  name: 'plugin-global-route', entry: './fixture.tsx', viewport: { width: 960, height: 640 },
  real: 'MainLayout (including initial collapsed state and visibility events), openPluginUiView, global tabs, LayoutRoot, RightSidebar and fixed show controls',
  notCovered: 'Actual plugin installation, MCP App communication, native OS window lifecycle. Unrelated background UI/hosts are inert; the iframe is labeled fixture content.',
  stubs: {
    ...inert,
    'src/renderer/contexts/AuthContext': 'export const useAuth = () => ({ dataOwnerId: "fixture", dataOwnerGeneration: 1, dataOwnerRecoveryEpoch: 0 }); export const useOptionalDataOwnerGeneration = () => 1; export const useOptionalAuthDeviceId = () => null; export const useOptionalAuthUser = () => null;',
    'src/renderer/hooks/useUpdateNotice': 'export const useUpdateNotice = () => ({ open: false, releaseNotes: null });',
    'src/renderer/features/cc-agent/useSessionBrowseHistory': 'export const useSessionBrowseHistory = () => ({});',
    'src/renderer/features/remote-desktop/useTaskLiveScreens': 'export const useTaskLiveScreens = () => [];',
    'src/renderer/features/remote-desktop/TaskLiveScreenButtons': 'export const useAutoOpenTaskLiveScreens = () => []; export const TaskLiveScreenButtons = () => null; export const TASK_LIVE_SCREEN_LIMIT = 4;',
    'src/renderer/features/bots/botStore': { partial: 'const empty = []; export const useBotProfiles = () => empty; export const getBotProfiles = () => empty; export const ensureBotProfilesLoaded = async () => {};' },
    'src/renderer/cindy-brain/PluginUiContributions': 'const empty = []; export const usePluginUiWindowCandidates = () => ({ settings: empty, sidebarSections: empty, titlebarEntries: empty }); export const PluginUiSlotControls = () => null;',
    'src/renderer/cindy-brain/ghostPanels': 'export const ensureGhostPanelsRegistered = () => {}; export const useGhostPanelsSync = () => {};',
    'src/renderer/features/right-sidebar/RightSidebarShell': `
      import React from 'react';
      import { useGlobalTabs } from '@/features/right-sidebar/globalTabs';
      import { RightSidebarToggle } from '@/components/layout/RightSidebarToggle';
      export function RightSidebarShell({ onCloseSidebar }) {
        const tabs = useGlobalTabs();
        return tabs.length ? React.createElement(React.Fragment, null,
          React.createElement(RightSidebarToggle, { action: 'close', collapsed: false, onToggle: onCloseSidebar }),
          React.createElement('iframe', { title: '全局插件页面',
          style: { width: '100%', height: '100%', border: 0 },
          srcDoc: '<!doctype html><html style="color-scheme:' + window.__uiPage.ctx.theme +
            ';font-family:system-ui"><body style="background:Canvas;color:CanvasText"><h1>全局具名页</h1><p>隔离验收内容</p></body></html>' })) : null;
      }`,
    'src/renderer/features/right-sidebar/TabGroupPanel': 'export const tabGroupPanelComponent = () => () => null;',
  },
  cases: {
    default: { about: 'Cold start on /plugins: explicit open, collapse, reopen and remove the named global page' },
    task: { about: 'The existing task-route sidebar stays visible' },
  },
  async ready(page) { await page.getByRole('button', { name: '打开全局页' }).waitFor(); },
  async check(page, ui) {
    if (ui.case === 'default') {
      assert.equal(await page.getByTitle('全局插件页面').count(), 0);
      assert.equal(await page.getByTestId('right-sidebar-fixed-trigger').count(), 0);
    }
    await page.getByRole('button', { name: '打开全局页' }).click();
    const frame = page.getByTitle('全局插件页面');
    await frame.waitFor({ state: 'attached' });
    const rect = await frame.boundingBox();
    const trigger = page.getByTestId('right-sidebar-fixed-trigger').getByRole('button');
    assert.deepEqual({ visible: Boolean(rect && rect.width > 300 && rect.height > 200),
      showControls: await trigger.count() }, { visible: true, showControls: 1 },
      `explicit open must expand the actual MainLayout state and expose the control: ${JSON.stringify(rect)}`);
    await ui.capture('visible-global-page');
    if (ui.platform !== 'darwin') {
      assert.equal(await page.locator('[data-panel-drag-root="chat-main"]').evaluate(el =>
        el.style.getPropertyValue('--content-top-right-actions-inset')), '32px');
    }
    await page.getByRole('button', { name: await ui.t('rightSidebar.tabs.controls.closeAria'), exact: true }).click();
    await page.waitForFunction(() => document.querySelector('iframe')?.getBoundingClientRect().width === 0);
    await trigger.click();
    await page.waitForFunction(() => (document.querySelector('iframe')?.getBoundingClientRect().width ?? 0) > 300);
    await ui.capture('reopened-global-page');
    await page.getByRole('button', { name: '关闭全局页', exact: true }).click();
    await frame.waitFor({ state: 'detached' });
    if (ui.case === 'default') assert.equal(await trigger.count(), 0);
    await page.getByRole('button', { name: '打开全局页' }).click();
    await page.waitForFunction(() => (document.querySelector('iframe')?.getBoundingClientRect().width ?? 0) > 300);
  },
};
