import { ipcMain, screen, BrowserWindow, dialog, type BrowserWindow as Window, type IpcMainInvokeEvent } from 'electron';
import { clearSessionAttention as clearAppBadgeSessionAttention, hasSessionAttention as hasAppBadgeSessionAttention } from '../appBadgeService.js';
import { openMainWindowSession } from '../deepLink.js';
import { getSessionRowSnapshot, patchSessionMetaInDb } from '../localDb/ipc/sessions.js';
import { withSessionRouteLock } from '../localDb/sessionRouteLock.js';
import { confirmIslandArchive } from './archiveConfirmation.js';
import { remoteInvoke } from '../device-link/index.js';
import { bindingStore } from '../im/binding.js';
import { setAgentIslandCompanionChangeSink } from '../localDb/agentIslandSessionPatch.js';
import { companionAvatarHasArtwork, companionAvatarThumbnail, companionSnapshotWithoutArtwork, readAgentIslandCompanion } from './companionIdentity.js';
import { createLogger } from '../logger.js';
import { t } from '../i18n.js';
import { isAppContentWindow, isFocusedAppContentWindow } from '../windowFocusClassifier.js';
import { createLocalizedToolRowWording } from './toolWording.js';
import { MacAgentIslandNativeHost } from './MacAgentIslandNativeHost.js';
import { readAgentIslandDetachedLayoutPreferences, readAgentIslandLayoutPreferences, writeAgentIslandLayoutPreference, writeAgentIslandLayoutPreferences } from './layoutPreferenceStore.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { getActiveAppSession } from '../appSessionState.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { isDeviceLinkInvoke } from '../device-link/invoke-context.js';
import { tapWindowBroadcast } from '../device-link/broadcast-tap.js';
import { beginProtectedFolderCheck, detectProtectedFolderEperm, endProtectedFolderCheck, markEpermGuidanceShown, openFolderPrivacySettings, probeProtectedFolderAccess, releaseEpermGuidance, type ProtectedFolderKind } from '../file-access/permissions.js';
import { createAgentIslandRuntime } from '@cindy/app-runtime/session-activity/service';
export type { AgentIslandServiceDeps } from '@cindy/app-runtime/session-activity/service';
const log = createLogger('agent-island');
const runtime = createAgentIslandRuntime<Window, IpcMainInvokeEvent>({
  log, t, ipcMain, getSessionRowSnapshot, patchSessionMetaInDb, withSessionRouteLock, remoteInvoke,
  setAgentIslandCompanionChangeSink, clearAppBadgeSessionAttention, hasAppBadgeSessionAttention,
  isDeviceLinkInvoke, tapWindowBroadcast, createLocalizedToolRowWording, throwIpcError, assertTrustedAppRendererEvent,
  getActiveAppSession,
  readAgentIslandCompanion, companionAvatarHasArtwork, companionAvatarThumbnail, companionSnapshotWithoutArtwork,
  hasImBinding: id => !!bindingStore.findByTarget(id),
  ui: {
    screen, getAllWindows: () => BrowserWindow.getAllWindows(),
    windowForEvent: event => BrowserWindow.fromWebContents(event.sender),
    isMainWindowSender: (window, event) => window.webContents === event.sender,
    isAppContentWindow, isFocusedAppContentWindow, openMainWindowSession, confirmIslandArchive,
    createNativeHost: options => new MacAgentIslandNativeHost(options),
    readAgentIslandDetachedLayoutPreferences, readAgentIslandLayoutPreferences,
    writeAgentIslandLayoutPreference, writeAgentIslandLayoutPreferences,
    showOpenDialog: (owner, options) => owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options),
    showActionError: message => { void dialog.showMessageBox({ type: 'error', message }); },
    onToolResultFull: (event, getMainWindow) => {
      if (process.platform !== 'darwin') return;
      const data = event.data as { fullText?: string; isError?: boolean } | undefined;
      const folderKind = data?.isError !== false && data?.fullText ? detectProtectedFolderEperm(data.fullText) : null;
      if (folderKind) void resolveProtectedFolderDenial(folderKind, getMainWindow).catch((error: unknown) => {
        log.warn('protected folder guidance flow failed', { kind: folderKind, error });
      });
    },
  },
});
export const { AgentIslandService, initAgentIslandService, getAgentIslandService } = runtime;
export type AgentIslandService = InstanceType<typeof AgentIslandService>;

  /**
   * agent 输出里的关键词只是粗筛,真相由 Main 亲自向系统核实一次:
   *
   * - 读得动 → 那条 EPERM 与 TCC 无关(agent 常常只是读到了**写着这个词的文件内容**),
   *   什么都不做,也不消耗该目录的提醒名额。
   * - 读不动 → 确认被拒,才提示用户。这次探测同时把 TCC 归因落到 Cindy.app 上,系统
   *   自己的授权弹窗有机会出现;用户在系统弹窗里点了允许,readdir 随即成功,这里就不再
   *   叠一个自制弹窗。只有系统确实不肯再问(此前被拒过)才走到引导去系统设置这一步。
   */
async function resolveProtectedFolderDenial(kind: ProtectedFolderKind, getMainWindow: () => Window | null): Promise<void> {
    if (!beginProtectedFolderCheck(kind)) return;
    try {
      const access = await probeProtectedFolderAccess(kind);
      if (access !== 'denied') {
        log.debug(`protected folder guidance skipped: kind=${kind} access=${access}`);
        return;
      }
      markEpermGuidanceShown(kind);
      try {
        await showFolderEpermGuidance(kind, getMainWindow);
      } catch (error) {
        releaseEpermGuidance(kind);
        log.warn('failed to show folder access guidance', { kind, error });
      }
    } finally {
      endProtectedFolderCheck(kind);
    }
  }

async function showFolderEpermGuidance(kind: ProtectedFolderKind, getMainWindow: () => Window | null): Promise<void> {
    const folderName = t(`fileAccess.epermGuidance.folderNames.${kind.toLowerCase()}`);
    const options = {
      type: 'warning' as const,
      title: t('fileAccess.epermGuidance.title'),
      message: t('fileAccess.epermGuidance.message').replace('{{folder}}', folderName),
      detail: t('fileAccess.epermGuidance.detail'),
      buttons: [
        t('fileAccess.epermGuidance.openSystemSettings'),
        t('fileAccess.epermGuidance.cancel'),
      ],
      defaultId: 0,
      cancelId: 1,
    };
    const mainWindow = getMainWindow();
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    if (result.response === 0) {
      await openFolderPrivacySettings(kind);
    }
  }
