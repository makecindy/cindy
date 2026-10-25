import { isRemoteAgentLimitsPatch } from '../../shared/remoteAgentLimits.js';
import { supportsSubscriptionFastPolicy } from '@cindy/model-providers';
import { providerFastPolicy } from '../maker-host/provider-fast-policy-store.js';
import { notifySubscriptionFastPolicyChanged } from '../maker-host/subscription-fast-policy.js';
import { notifyProviderShareCatalogChanged } from './dispatch.js';
import { DEVICE_LINK_PUSH } from '../../shared/deviceLinkIpc.js';
import { readRemoteAgentLimitsState, saveRemoteAgentLimits } from '../remote-agent/host/limitsStore.js';
import { remoteAgentLimitUsage, revalidateRemoteModelAccess } from './dispatch.js';
/**
 * 供应商分享的本机接线：分享者与受邀者两侧运行时的起停、推送给 Renderer、系统通知，以及
 * Renderer 的命令通道。账号操作只接受本机应用窗口，不能经设备互联从别的电脑调用。
 */
import { app, BrowserWindow, ipcMain, Notification } from 'electron';
import { PROVIDER_MEDIA_FIELDS } from '@cindy/model-providers';

import {
  PROVIDER_SHARE_LINK_TTL_MS,
  PROVIDER_SHARE_NEUTRAL_DEVICE_NAME,
  PROVIDER_SHARE_RECEIVED_CATALOGS_CHANNEL,
  MAX_FRAME_BYTES,
  parseProviderSharePeer,
  scrubProviderShareLabel,
  scrubSharedProviderCatalog,
  type InvokeResultPayload,
  type ProviderShareReceived,
  type ProviderShareReceivedCatalog,
} from '@cindy/device-link';

import {
  PROVIDER_SHARE_IPC,
  type ProviderShareCommand,
  type ProviderShareLinkCreated,
  type ProviderShareMemberView,
  type ProviderShareModelUsageView,
  type ProviderShareMoney,
  type ProviderShareOwnerState,
  type ProviderShareUsageRange,
  type ProviderOwnUsageView,
  type ProviderPartyUsageView,
  type ProviderUsageDayView,
  type ProviderUsageHistoryView,
} from '../../shared/providerShare.js';
import { getAuthState, getDeviceId } from '../authManager.js';
import { parseProviderShareInsights, PROVIDER_SHARE_INSIGHTS_CHANNEL } from '../../shared/providerShareInsights.js';
import { isProviderGroupProviderId } from '../../shared/providerGroup.js';
import { providerShareVisibility } from './providerShareVisibility.js';
import { remoteModelAccess } from './remoteModelAccess.js';
import { isRemoteModelSelection, type RemoteModelAccessView } from '../../shared/remoteModelAccess.js';
import { createProviderShareInsightsReader } from './providerShareInsights.js';
import { readProviderShareQuota, readProviderShareQuotaAccount } from './providerShareQuota.js';
import { isDataOwnerPushStamp } from '../../shared/dataOwnerPush.js';
import { t } from '../i18n.js';
import { createLogger } from '../logger.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { isRemoteProviderInvocationAllowed } from '../maker-host/remote-provider-access-store.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { currentLedgerCurrency } from '../usage/ledgerCurrency.js';
import { getGatewayModelPricing, getModelPriceQuote } from '../usage/modelPricing.js';
import { computePriceQuoteTurnMoney, normalizeModelIdForPricing } from '../usage/turnCostCalculator.js';
import { rememberIssuedClipboardText } from '../textClipboard.js';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { normalizeProviderShareMemberNote, PROVIDER_SHARE_MEMBER_NOTE_MAX_LENGTH } from '../../shared/providerShareMemberNote.js';
import { providerShareMemberNotes } from './providerShareMemberNotes.js';
import { captureProviderManagementScope } from '../provider-group/managementScope.js';
import { readProviderManagementShares } from '../provider-group/managementClient.js';
import type { ProviderShareManagementCommand } from '../../shared/providerManagement.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  abortProviderShareReshareRuns,
  getControllerDisplayName,
  providerShareActiveControllers,
  revokeProviderShareControllers,
  setProviderShareAccess,
} from './dispatch.js';
import { getDeviceLinkInvokeContext } from './invoke-context.js';
import { tapWindowBroadcast } from './broadcast-tap.js';
import { MAKER_PUSH } from '../maker-ipc/channels.js';
import { broadcast as broadcastLocal } from './index.js';
import { fetchIdentityCard, providerShareApi, providerShareLinkFor, sha256Hex } from './providerShareApi.js';
import { configureProviderShareApprovalWindows } from './providerShareApprovalWindows.js';
import {
  findReceivedShare,
  providerShareReceivedRevision,
  getReceivedShares,
  isReceivedSharesReady,
  getReceivedSharesSnapshot,
  leaveProviderShare,
  previewProviderShare,
  refreshReceivedShares,
  sendProviderShareRequest,
  getProviderShareRequest,
  startProviderShareGuest,
  stopProviderShareGuest,
  withdrawProviderShareRequest,
} from './providerShareGuest.js';
import {
  configureProviderShareGuestPrefs,
  invalidateProviderShareGuestPrefsCache,
  isProviderShareCredentialConsentSkipped,
} from './providerShareGuestPrefs.js';
import { setProviderShareCredentialConsentFromIpc } from './providerShareGuestPrefsIpc.js';
import {
  applyLocalMemberChange,
  applyLocalRequestDecision,
  clearProviderShareRequestQuiet,
  ensureProviderSharePeerKnown,
  getProviderShareHostSnapshot,
  getProviderShareQuietRequestIds,
  getProviderShareWatchedRequests,
  markProviderShareHostActive,
  providerShareGuestAccess,
  providerShareAccessRevision,
  providerShareGuestDenial,
  providerShareMemberMatcher,
  quietProviderShareRequests,
  refreshProviderShareHost,
  startProviderShareHost,
  stopProviderShareHost,
} from './providerShareHost.js';
import {
  decideProviderShareReshare,
  listProviderShareReshares,
  pruneProviderShareReshares,
  setProviderShareReshareEvents,
  type ProviderShareResharePeer,
  type ProviderShareReshareEvents,
  type ProviderShareReshareRecord,
} from './providerShareReshare.js';
import { getProviderShareUsageStore, providerUsageLocalDay } from './providerShareUsageStore.js';
import { readDeviceLinkSettings, readLastKnownDeviceNames } from './settings-store.js';
import { currentProviderPartyUsageStore, type ProviderPartyUsage } from '../usage/providerPartyUsageStore.js';

const log = createLogger('provider-share');

type Broadcast = (channel: string, payload: unknown) => void;
/** 经设备互联读分享者电脑的目录(index.ts 注入 remoteBackgroundInvoke，避免循环依赖)。 */
type ShareInvoke = (agentDeviceId: string, channel: string, args: unknown[], options?: { preSend?: () => void }) => Promise<InvokeResultPayload>;

let broadcastFn: Broadcast | null = null;
let shareInvoke: ShareInvoke | null = null;
let running = false;
const liveNotifications = new Set<Notification>();

function emit(channel: string, payload: unknown): void {
  try {
    broadcastFn?.(channel, payload);
  } catch (error) {
    log.warn('provider share broadcast failed', { channel, error: String(error) });
  }
}

function focusMainWindow(): void {
  const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.setAlwaysOnTop(true);
  win.show();
  win.focus();
  win.setAlwaysOnTop(false);
}

function appInForeground(): boolean {
  return BrowserWindow.getAllWindows().some((win) => !win.isDestroyed() && win.isVisible() && win.isFocused());
}

/** 系统通知：不含配对码(产品规则 §6.1)。点击把窗口拉到前台并打开对应界面。 */
async function notify(title: string, body: string, onClick: () => void): Promise<void> {
  if (appInForeground() || !Notification.isSupported()) return;
  try {
    const { getDesktopNotificationsEnabled } = await import('../notificationService.js');
    if (!getDesktopNotificationsEnabled()) return;
  } catch {
    return;
  }
  const notification = new Notification({ title, body });
  liveNotifications.add(notification);
  const release = () => liveNotifications.delete(notification);
  notification.on('click', () => {
    focusMainWindow();
    onClick();
    release();
  });
  notification.on('close', release);
  notification.on('failed', release);
  notification.show();
}

function format(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{{${key}}}`, value), template);
}

function revoke(match: (controller: string) => boolean, purge: boolean): void {
  void revokeProviderShareControllers(match, purge).catch((error) => {
    log.warn('provider share revoke failed', { purge, error: error instanceof Error ? error.message : String(error) });
  });
}

/** 转分享记录所属的那台组所在电脑(受邀者对端)。 */
function reshareControllerMatcher(record: ProviderShareResharePeer): (controller: string) => boolean {
  return (controller) => {
    const peer = parseProviderSharePeer(controller);
    return peer?.role === 'guest' && peer.shareId === record.shareId && peer.memberId === record.memberId
      && peer.deviceId === record.deviceId;
  };
}

/** 撤回了对这些人的同意：结束受邀者的组替他们转来的任务(provider-sharing.md §4.3)。 */
function abortReshares(records: readonly ProviderShareReshareRecord[]): void {
  for (const record of records) {
    void abortProviderShareReshareRuns(reshareControllerMatcher(record), record.key).catch((error) => {
      log.warn('provider share reshare abort failed', { error: error instanceof Error ? error.message : String(error) });
    });
  }
}

/** 删掉成员(或已不在这台的分享)名下的转分享记录；删了就让管理页重读。 */
function pruneReshares(match: (record: ProviderShareReshareRecord) => boolean): void {
  void pruneProviderShareReshares(match).then((removed) => {
    if (removed.length > 0) emit(PROVIDER_SHARE_IPC.OWNED_CHANGED, null);
  }).catch((error: unknown) => {
    log.warn('provider share reshare cleanup failed', { error: error instanceof Error ? error.message : String(error) });
  });
}

const reshareEvents: ProviderShareReshareEvents = {
  requested(records) {
    emit(PROVIDER_SHARE_IPC.OWNED_CHANGED, null);
    emit(PROVIDER_SHARE_IPC.RESHARE_REQUESTED, null);
    const first = records[0];
    if (!first) return;
    const share = getProviderShareHostSnapshot().find((item) => item.shareId === first.shareId);
    const owner = share?.members.find((member) => member.memberId === first.memberId)?.displayName ?? '';
    if (!share) return;
    void notify(
      t('providerShare.notification.reshareTitle'),
      format(t('providerShare.notification.reshareBody'), { owner, name: first.name, provider: share.providerLabel }),
      () => emit(PROVIDER_SHARE_IPC.OPEN_MANAGE, { providerId: share.providerId }),
    );
  },
  changed() {
    emit(PROVIDER_SHARE_IPC.OWNED_CHANGED, null);
  },
  revoked(records) {
    abortReshares(records);
  },
};

/** 设备互联连上(本实例持有连接)时启动；断开、登出或失去持有权时停止。 */
export function startProviderShareRuntime(broadcast: Broadcast, options: { invoke?: ShareInvoke } = {}): void {
  // 启动仲裁可能早于 IPC 注册；必须在 host 的第一轮快照前配置持久归属。
  configureProviderShareApprovalWindows({
    filePath: () => ownerScopedUserDataPath('provider-share-approval-windows.json'),
    scopeKey: () => {
      captureProviderManagementScope();
      return ownerScopedUserDataPath();
    },
  });
  invalidateProviderShareGuestPrefsCache();
  broadcastFn = broadcast;
  shareInvoke = options.invoke ?? null;
  const readInvoke = options.invoke;
  running = true;
  setProviderShareReshareEvents(reshareEvents);
  startProviderShareHost({
    changed() {
      emit(PROVIDER_SHARE_IPC.OWNED_CHANGED, null);
    },
    requested(request, share, quiet) {
      emit(PROVIDER_SHARE_IPC.REQUESTED, {
        request,
        share: { shareId: share.shareId, providerId: share.providerId, providerLabel: share.providerLabel },
        ...(quiet ? { quiet: true } : {}),
      });
      // 链接由另一台电脑生成：那台弹窗并发通知，这里只进管理页与提示点。
      if (quiet) return;
      void notify(
        t('providerShare.notification.requestTitle'),
        format(t('providerShare.notification.requestBody'), { name: request.displayName, provider: share.providerLabel }),
        () => emit(PROVIDER_SHARE_IPC.OPEN_MANAGE, { providerId: share.providerId }),
      );
    },
    watchedRequested(item) {
      emit(PROVIDER_SHARE_IPC.REQUESTED, item);
      // 审批弹窗已在排队：点通知只把窗口拉到前台。
      void notify(
        t('providerShare.notification.requestTitle'),
        format(t('providerShare.notification.requestBody'), { name: item.request.displayName, provider: item.share.providerLabel }),
        () => undefined,
      );
    },
    revoked(member, purge) {
      revoke(providerShareMemberMatcher(member), purge);
      // 成员被删除或退出：他报上来的转分享请求一并删掉(暂停时保留，恢复后照旧)。
      if (purge) pruneReshares((record) => record.shareId === member.shareId && record.memberId === member.memberId);
    },
    reconcile(owned) {
      // 分享者电脑离线期间被删除或退出的成员：清理他们留在本机的会话数据。
      revoke((controller) => {
        const peer = parseProviderSharePeer(controller);
        if (peer?.role !== 'guest') return false;
        const members = owned.get(peer.shareId);
        return !!members && !members.has(peer.memberId);
      }, true);
      // 转分享记录按账号存放，只会属于这台电脑上的分享：已不在快照里的成员与分享一并删掉。
      pruneReshares((record) => !owned.get(record.shareId)?.has(record.memberId));
    },
  }, { readWatchedShares: readInvoke ? (hostDeviceId) => readProviderManagementShares(readInvoke, hostDeviceId) : undefined });
  startProviderShareGuest({
    catalogChanged(deviceId) { emit(DEVICE_LINK_PUSH.REMOTE_PUSH, { deviceId, channel: 'maker:provider:changed', payload: {} }); },
    changed(received) {
      emit(PROVIDER_SHARE_IPC.RECEIVED_CHANGED, received);
    },
    settled(state, preview) {
      emit(PROVIDER_SHARE_IPC.SETTLED, { state, preview });
      if (state.status !== 'approved' && state.status !== 'rejected') return;
      const name = preview?.owner.displayName ?? '';
      const provider = preview?.providerLabel ?? '';
      void notify(
        t(state.status === 'approved' ? 'providerShare.notification.approvedTitle' : 'providerShare.notification.rejectedTitle'),
        format(t(state.status === 'approved' ? 'providerShare.notification.approvedBody' : 'providerShare.notification.rejectedBody'), { name, provider }),
        () => undefined,
      );
    },
  }, { userDataDir: app.getPath('userData') });
}

export function stopProviderShareRuntime(): void {
  invalidateProviderShareGuestPrefsCache();
  running = false;
  shareInvoke = null;
  setProviderShareReshareEvents(null);
  stopProviderShareHost();
  stopProviderShareGuest();
  emit(PROVIDER_SHARE_IPC.OWNED_CHANGED, null);
  emit(PROVIDER_SHARE_IPC.RECEIVED_CHANGED, [] satisfies ProviderShareReceived[]);
}

// ─── 命令 ───────────────────────────────────────────────────────

function requireRunning(): void {
  if (!running) throwIpcError('DEVICE_LINK_NOT_CONNECTED', 'Provider sharing is not ready');
}

function text(value: unknown, field: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throwIpcError('INVALID_PARAMS', `${field} is required`);
  return value.trim();
}

function usageRange(range: unknown): ProviderShareUsageRange {
  if (range !== '7d' && range !== 'month' && range !== 'all') throwIpcError('INVALID_PARAMS', 'Invalid range');
  return range;
}

export function parseProviderShareCommand(raw: unknown): ProviderShareCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throwIpcError('INVALID_PARAMS', 'Invalid command');
  const value = raw as Record<string, unknown>;
  switch (value.action) {
    case 'get-fast-policy':
    case 'set-fast-policy': {
      if (!isProviderGroupProviderId(value.providerId)) throwIpcError('INVALID_PARAMS', 'Invalid providerId');
      if (value.action === 'get-fast-policy') return { action: value.action, providerId: value.providerId };
      if (typeof value.allowFast !== 'boolean') throwIpcError('INVALID_PARAMS', 'allowFast must be a boolean');
      return { action: value.action, providerId: value.providerId, allowFast: value.allowFast };
    }
    case 'get-model-access':
    case 'set-model-access': {
      if (!isProviderGroupProviderId(value.providerId)) throwIpcError('INVALID_PARAMS', 'Invalid providerId');
      const memberId = value.memberId === undefined ? undefined : text(value.memberId, 'memberId', 128);
      const scope = { providerId: value.providerId, ...(memberId !== undefined ? { memberId } : {}) };
      if (value.action === 'get-model-access') return { action: value.action, ...scope };
      if (!isRemoteModelSelection(value.models)) throwIpcError('INVALID_PARAMS', 'Invalid remote model selection');
      return { action: value.action, ...scope, models: value.models === null ? null : [...value.models] };
    }
    case 'get-visibility':
    case 'quota-account':
      if (!isProviderGroupProviderId(value.providerId)) throwIpcError('INVALID_PARAMS', 'Invalid providerId');
      return { action: value.action, providerId: value.providerId };
    case 'set-visibility': {
      if (!isProviderGroupProviderId(value.providerId)) throwIpcError('INVALID_PARAMS', 'Invalid providerId');
      const patch = value.visibility;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)
        || Object.keys(patch).length === 0 || Object.entries(patch).some(([key, entry]) =>
          !['quota', 'usage'].includes(key) || typeof entry !== 'boolean')) {
        throwIpcError('INVALID_PARAMS', 'Invalid share visibility');
      }
      return { action: 'set-visibility', providerId: value.providerId, visibility: patch };
    }
    case 'insights':
      if (typeof value.includeUsage !== 'boolean') throwIpcError('INVALID_PARAMS', 'Invalid insights scope');
      return { action: 'insights', shareId: text(value.shareId, 'shareId', 128), includeUsage: value.includeUsage };
    case 'get-run-limits':
    case 'reset-run-limits':
      return { action: value.action };
    case 'set-run-limits':
      if (!isRemoteAgentLimitsPatch(value.limits)) throwIpcError('INVALID_PARAMS', 'Invalid remote task limits');
      return { action: value.action, limits: { ...value.limits } };
    case 'owned':
      return { action: 'owned', range: usageRange(value.range) };
    case 'own-usage':
      return { action: 'own-usage', providerId: text(value.providerId, 'providerId'), range: usageRange(value.range) };
    case 'usage-history':
      return { action: 'usage-history', providerId: text(value.providerId, 'providerId') };
    case 'create-link':
      return { action: 'create-link', providerId: text(value.providerId, 'providerId') };
    case 'approve':
    case 'reject':
      return { action: value.action, requestId: text(value.requestId, 'requestId', 128) };
    case 'set-member': {
      const status = value.status;
      if (status !== 'pause' && status !== 'resume' && status !== 'remove') throwIpcError('INVALID_PARAMS', 'Invalid status');
      return { action: 'set-member', memberId: text(value.memberId, 'memberId', 128), status };
    }
    case 'set-member-note': {
      if (typeof value.note !== 'string' || value.note.length > PROVIDER_SHARE_MEMBER_NOTE_MAX_LENGTH) {
        throwIpcError('INVALID_PARAMS', 'Invalid member note');
      }
      return { action: 'set-member-note', memberId: text(value.memberId, 'memberId', 128), note: normalizeProviderShareMemberNote(value.note) };
    }
    case 'reshare-decide': {
      const decision = value.decision;
      if (decision !== 'approve' && decision !== 'reject') throwIpcError('INVALID_PARAMS', 'Invalid decision');
      return { action: 'reshare-decide', id: text(value.id, 'id', 64), decision };
    }
    case 'received':
      return { action: 'received' };
    case 'received-snapshot': {
      if (value.favoriteRecovery === undefined) return { action: 'received-snapshot' };
      const recovery = value.favoriteRecovery as Record<string, unknown> | null;
      if (!recovery || !isDataOwnerPushStamp(recovery.ownerStamp) || !Array.isArray(recovery.regions) ||
          recovery.regions.length > 2 || !recovery.regions.every((region) => region === 'cn' || region === 'global'))
        throwIpcError('INVALID_PARAMS', 'Invalid favorite recovery');
      return { action: 'received-snapshot', favoriteRecovery: { ownerStamp: recovery.ownerStamp, regions: recovery.regions } };
    }
    case 'preview':
    case 'send-request':
      return { action: value.action, link: text(value.link, 'link', 4096) };
    case 'get-request':
    case 'withdraw':
      return { action: value.action, requestId: text(value.requestId, 'requestId', 128) };
    case 'leave':
      return { action: 'leave', memberId: text(value.memberId, 'memberId', 128) };
    case 'get-credential-consent':
      return { action: 'get-credential-consent', shareId: text(value.shareId, 'shareId', 128) };
    case 'set-credential-consent':
      if (typeof value.skip !== 'boolean') throwIpcError('INVALID_PARAMS', 'skip is required');
      return { action: 'set-credential-consent', shareId: text(value.shareId, 'shareId', 128), skip: value.skip };
    default:
      throwIpcError('INVALID_PARAMS', 'Unknown command');
  }
}

async function estimate(row: Omit<ProviderShareModelUsageView, 'amount'> & { sdkCostUsd: number }): Promise<ProviderShareMoney | null> {
  try {
    const pricing = await getGatewayModelPricing();
    const agent = row.kind === 'claude-code' || row.kind === 'codex' || row.kind === 'pi' ? row.kind : undefined;
    const price = getModelPriceQuote(pricing, row.providerId, normalizeModelIdForPricing(row.model), agent);
    const money = computePriceQuoteTurnMoney(row, price, currentLedgerCurrency());
    if (money) return { amount: money.amount, currency: money.currency };
  } catch (error) {
    log.warn('provider share usage estimate failed', { error: String(error) });
  }
  return row.sdkCostUsd > 0 ? { amount: row.sdkCostUsd, currency: 'USD' } : null;
}

async function ownerState(range: ProviderShareUsageRange): Promise<ProviderShareOwnerState> {
  if (!running) return { ready: false, shares: [] };
  const shares = getProviderShareHostSnapshot();
  const usage = getProviderShareUsageStore()?.query(new Set(shares.map((share) => share.shareId)), range) ?? [];
  const reshares = listProviderShareReshares();
  const notes = providerShareMemberNotes.read();
  const runningTasks = new Map<string, number>();
  for (const controller of providerShareActiveControllers()) {
    const peer = parseProviderSharePeer(controller);
    if (peer?.role !== 'guest') continue;
    const key = `${peer.shareId}\u0000${peer.memberId}`;
    runningTasks.set(key, (runningTasks.get(key) ?? 0) + 1);
  }
  return {
    ready: true,
    shares: await Promise.all(shares.map(async (share) => ({
      shareId: share.shareId,
      providerId: share.providerId,
      providerLabel: share.providerLabel,
      createdAt: share.createdAt,
      requests: share.requests,
      members: await Promise.all(share.members.map(async (member): Promise<ProviderShareMemberView> => {
        const record = usage.find((item) => item.shareId === share.shareId && item.memberId === member.memberId);
        return {
          ...member,
          note: notes[member.memberId] ?? null,
          lastUsedAt: record?.lastUsedAt ?? null,
          runningTasks: runningTasks.get(`${share.shareId}\u0000${member.memberId}`) ?? 0,
          reshares: reshares
            .filter((item) => item.shareId === share.shareId && item.memberId === member.memberId)
            .map((item) => ({
              id: item.id,
              name: item.name,
              avatarUrl: item.avatar,
              state: item.state,
              requestedAt: item.requestedAt,
              decidedAt: item.decidedAt ?? null,
            })),
          models: await Promise.all((record?.models ?? []).map(async (model) => ({
            kind: model.kind,
            providerId: model.providerId,
            memberKey: model.memberKey,
            model: model.model,
            turns: model.turns,
            inputTokens: model.inputTokens,
            outputTokens: model.outputTokens,
            cacheReadTokens: model.cacheReadTokens,
            cacheCreateTokens: model.cacheCreateTokens,
            amount: await estimate(model),
          }))),
        };
      })),
    }))),
    quietRequestIds: getProviderShareQuietRequestIds(),
    watchedRequests: getProviderShareWatchedRequests(),
  };
}

/** 这个供应商按使用方的用量：本机与同账号的其他电脑(provider-groups.md §7)。只读本机账本，不经分享服务。 */
async function ownUsage(providerId: string, range: ProviderShareUsageRange): Promise<ProviderOwnUsageView> {
  const { local, devices, relays } = currentProviderPartyUsageStore().query(providerId, range);
  const lastKnownNames = readLastKnownDeviceNames();
  const view = async (party: ProviderPartyUsage): Promise<ProviderPartyUsageView> => ({
    deviceId: party.deviceId,
    deviceName: party.deviceId
      ? (getControllerDisplayName(party.deviceId) ?? lastKnownNames[party.deviceId] ?? null)
      : null,
    lastUsedAt: party.lastUsedAt,
    models: await Promise.all(party.models.map(async (model) => ({
      kind: model.kind,
      providerId,
      memberKey: model.memberKey,
      model: model.model,
      turns: model.turns,
      inputTokens: model.inputTokens,
      outputTokens: model.outputTokens,
      cacheReadTokens: model.cacheReadTokens,
      cacheCreateTokens: model.cacheCreateTokens,
      amount: await estimate({ ...model, providerId }),
    }))),
  });
  return {
    providerId,
    local: local ? await view(local) : null,
    devices: await Promise.all(devices.map(view)),
    relays: await Promise.all(relays.map(view)),
  };
}

/**
 * 按天明细的预算：远程管理时整份经设备互联回包(单帧 2MB)。行数预算先保留最新的行，
 * 再按实际 UTF-8 JSON 大小预留 invoke 信封空间；两种裁剪都会通过 coverageStart 告知界面。
 */
const USAGE_HISTORY_MAX_ROWS = 5_000;
const USAGE_HISTORY_FRAME_SAFETY_BYTES = 1_024;
const USAGE_HISTORY_MAX_BYTES = MAX_FRAME_BYTES - USAGE_HISTORY_FRAME_SAFETY_BYTES;

type UsageHistoryRowRef =
  | { group: 'self'; row: number; day: string; order: number }
  | { group: 'relay'; party: number; row: number; day: string; order: number }
  | { group: 'member'; party: number; row: number; day: string; order: number };

/**
 * 让 usage-history 回包同时满足行数和物理帧预算。按日期从新到旧选行；同一天保持 self、relay、member
 * 及各自账本的既有顺序。二分查找保留前 N 行，避免每删一行都重新序列化整份历史。
 */
export function trimProviderUsageHistory(history: ProviderUsageHistoryView): ProviderUsageHistoryView {
  const refs: UsageHistoryRowRef[] = [];
  let order = 0;
  history.self.days.forEach((row, index) => refs.push({ group: 'self', row: index, day: row.day, order: order++ }));
  history.relays.forEach((party, partyIndex) => {
    party.days.forEach((row, rowIndex) => refs.push({ group: 'relay', party: partyIndex, row: rowIndex, day: row.day, order: order++ }));
  });
  history.members.forEach((party, partyIndex) => {
    party.days.forEach((row, rowIndex) => refs.push({ group: 'member', party: partyIndex, row: rowIndex, day: row.day, order: order++ }));
  });
  refs.sort((a, b) => b.day.localeCompare(a.day) || a.order - b.order);

  const materialize = (count: number): ProviderUsageHistoryView => {
    const kept = refs.slice(0, count);
    const selfRows = new Set(kept.filter((ref) => ref.group === 'self').map((ref) => ref.row));
    const relayRows = new Map<number, Set<number>>();
    const memberRows = new Map<number, Set<number>>();
    for (const ref of kept) {
      if (ref.group === 'relay') {
        const rows = relayRows.get(ref.party) ?? new Set<number>();
        rows.add(ref.row);
        relayRows.set(ref.party, rows);
      } else if (ref.group === 'member') {
        const rows = memberRows.get(ref.party) ?? new Set<number>();
        rows.add(ref.row);
        memberRows.set(ref.party, rows);
      }
    }
    const truncated = count < refs.length;
    // 二次裁剪(估价后)若没有再删行，保留第一次裁剪已经记录的覆盖起点。
    const coverageStart = truncated && kept.length > 0
      ? kept.reduce((day, ref) => day < ref.day ? day : ref.day, kept[0]!.day)
      : history.coverageStart;
    return {
      ...history,
      coverageStart,
      self: { ...history.self, days: history.self.days.filter((_, index) => selfRows.has(index)) },
      relays: history.relays.map((party, partyIndex) => ({
        ...party,
        days: party.days.filter((_, rowIndex) => relayRows.get(partyIndex)?.has(rowIndex) ?? false),
      })),
      members: history.members.map((party, partyIndex) => ({
        ...party,
        days: party.days.filter((_, rowIndex) => memberRows.get(partyIndex)?.has(rowIndex) ?? false),
      })),
    };
  };

  const fits = (count: number): boolean => Buffer.byteLength(JSON.stringify(materialize(count)), 'utf8') <= USAGE_HISTORY_MAX_BYTES;
  let count = Math.min(refs.length, USAGE_HISTORY_MAX_ROWS);
  if (!fits(count)) {
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(middle)) low = middle;
      else high = middle - 1;
    }
    count = low;
  }
  return materialize(count);
}

/**
 * 这个供应商的用量按天明细(provider-groups.md §7)：你自己与经其他电脑转来的读本机账本，分享的人读分享账本
 * (只含这个供应商的分享里现在的成员)。时间段、人与组内电脑由界面筛选。
 */
async function usageHistory(providerId: string): Promise<ProviderUsageHistoryView> {
  const own = currentProviderPartyUsageStore().history(providerId);
  const shares = running ? getProviderShareHostSnapshot().filter((share) => share.providerId === providerId) : [];
  const memberKeys = new Set(shares.flatMap((share) => share.members.map((member) => JSON.stringify([share.shareId, member.memberId]))));
  // 多取一行作为裁剪哨兵，使上层知道历史未完整展开；删除的成员在展开前就排除。
  const members = getProviderShareUsageStore()?.history(new Set(shares.map((share) => share.shareId)), {
    maxRows: USAGE_HISTORY_MAX_ROWS + 1,
    memberKeys,
  }) ?? [];
  const lastKnownNames = readLastKnownDeviceNames();
  const history = trimProviderUsageHistory({
    providerId,
    todayKey: providerUsageLocalDay(Date.now()),
    coverageStart: null,
    self: {
      ...own.self,
      days: own.self.days.map((row) => ({ ...row, providerId, amount: null })),
    },
    relays: own.relays.map((relay) => ({
      ...relay,
      deviceName: getControllerDisplayName(relay.deviceId) ?? lastKnownNames[relay.deviceId] ?? null,
      days: relay.days.map((row) => ({ ...row, providerId, amount: null })),
    })),
    members: members.map((member) => ({
      ...member,
      days: member.days.map((row) => ({ ...row, amount: null })),
    })),
  });

  const days = async (
    rows: ReadonlyArray<ProviderUsageDayView & { sdkCostUsd?: number }>,
  ): Promise<ProviderUsageDayView[]> =>
    Promise.all(rows.map(async (row) => {
      const usage = { ...row, sdkCostUsd: row.sdkCostUsd ?? 0 };
      return {
        day: usage.day,
        kind: usage.kind,
        providerId: usage.providerId,
        memberKey: usage.memberKey,
        model: usage.model,
        turns: usage.turns,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreateTokens: usage.cacheCreateTokens,
        amount: await estimate(usage),
      };
    }));
  return trimProviderUsageHistory({
    ...history,
    self: { ...history.self, days: await days(history.self.days) },
    relays: await Promise.all(history.relays.map(async (relay) => ({
      ...relay,
      days: await days(relay.days),
    }))),
    members: await Promise.all(history.members.map(async (member) => ({
      ...member,
      days: await days(member.days),
    }))),
  });
}

async function createLink(
  providerId: string,
  assertCurrent: () => void = () => undefined,
  requireLinkId = false,
): Promise<ProviderShareLinkCreated> {
  assertCurrent();
  requireRunning();
  // 逐级开启：允许远程控制 → 允许被远程调用 → 分享。
  if (!readDeviceLinkSettings().remoteControlEnabled) throwIpcError('PRECONDITION_FAILED', 'Remote control is off');
  if (!isRemoteProviderInvocationAllowed(providerId)) throwIpcError('PRECONDITION_FAILED', 'Remote invocation is off for this provider');
  const providers = await getDesktopProviderService().listProviders({ allowSideEffects: false });
  assertCurrent();
  const provider = providers.find((item) => item.id === providerId);
  if (!provider || !provider.connected || provider.agents.length === 0) throwIpcError('PRECONDITION_FAILED', 'Provider is not available');
  const hostDeviceId = getDeviceId();
  if (!hostDeviceId) throwIpcError('DEVICE_LINK_NOT_CONNECTED', 'Device is not registered');
  const identityCard = await fetchIdentityCard('share-link', sha256Hex(`${hostDeviceId}:${providerId}`));
  assertCurrent();
  const created = await providerShareApi.createLink({
    providerId,
    // 名称可能自动带上登录身份(如「OpenAI · 邮箱」)，分享出去前去掉。
    providerLabel: scrubProviderShareLabel(provider.name, [provider.subscriptionAccount?.identity, provider.openAiAccount?.identity], provider.id),
    // 电脑名不给受邀者(provider-sharing.md §6)：字段必填(旧版受邀者按必填解析)，填固定占位。
    deviceName: PROVIDER_SHARE_NEUTRAL_DEVICE_NAME,
    identityCard,
  });
  assertCurrent();
  if (requireLinkId && !created.linkId) {
    throwIpcError('UNSUPPORTED_CAPABILITY', 'Remote share links require an update to the provider share server');
  }
  markProviderShareHostActive();
  void refreshProviderShareHost('link');
  // 倒计时按本机收到响应的时刻计算：链接刚签发，服务端从签发起算 5 分钟。不拿服务端的绝对时间
  // 和本机时钟相减(两边时钟可能有偏差，偏快会一生成就显示已过期)，并留出请求往返的余量。
  const expiresAt = new Date(Date.now() + PROVIDER_SHARE_LINK_TTL_MS - LINK_TTL_SAFETY_MS).toISOString();
  const link = providerShareLinkFor(created.invitation);
  return { link, expiresAt, ...(created.linkId ? { linkId: created.linkId } : {}) };
}

async function execute(command: ProviderShareCommand, assertCurrent: () => void = () => undefined): Promise<unknown> {
  assertCurrent();
  switch (command.action) {
    case 'get-fast-policy':
    case 'set-fast-policy': {
      const assertOwner = captureProviderManagementScope();
      const assertScope = () => { assertCurrent(); assertOwner(); };
      const providers = await getDesktopProviderService().listProviders({ allowSideEffects: false });
      assertScope();
      const provider = providers.find(entry => entry.id === command.providerId);
      const supported = supportsSubscriptionFastPolicy(provider);
      if (command.action === 'set-fast-policy') {
        if (!supported) throwIpcError('INVALID_PARAMS', 'Fast policy is available only for supported subscription accounts');
        await providerFastPolicy.set(command.providerId, command.allowFast, assertScope);
        // Publish catalog invalidation even if a native live update needs retrying.
        emit(PROVIDER_SHARE_IPC.OWNED_CHANGED, null);
        // Local subscription use also works without a running account/share transport.
        broadcastLocal(MAKER_PUSH.PROVIDER_CHANGED, {});
        tapWindowBroadcast(MAKER_PUSH.PROVIDER_CHANGED, {});
        notifyProviderShareCatalogChanged(command.providerId);
        await notifySubscriptionFastPolicyChanged();
        assertScope();
      }
      return { supported, allowFast: supported ? providerFastPolicy.allows(command.providerId) : true };
    }
    case 'get-model-access':
    case 'set-model-access': {
      const assertOwner = captureProviderManagementScope();
      const assertScope = () => { assertCurrent(); assertOwner(); };
      if (command.memberId) {
        requireRunning();
        await refreshProviderShareHost('management');
        assertScope();
        const found = getProviderShareHostSnapshot().some((share) => share.providerId === command.providerId
          && share.members.some((member) => member.memberId === command.memberId));
        if (!found) throwIpcError('NOT_FOUND', 'This shared provider member is no longer available');
      }
      const providers = await getDesktopProviderService().listProviders({ allowSideEffects: false });
      assertScope();
      const provider = providers.find((entry) => entry.id === command.providerId);
      if (!provider) throwIpcError('NOT_FOUND', 'This provider is no longer available');
      if (command.action === 'set-model-access') {
        await remoteModelAccess.set(command.providerId, command.models, command.memberId, assertScope);
        assertScope();
        await revalidateRemoteModelAccess();
        assertScope();
        emit(PROVIDER_SHARE_IPC.OWNED_CHANGED, null);
        emit(MAKER_PUSH.PROVIDER_CHANGED, {});
        tapWindowBroadcast(MAKER_PUSH.PROVIDER_CHANGED, {});
      }
      const availableModels = new Map<string, { id: string; name: string }>();
      for (const entries of [...Object.values(provider.models), ...PROVIDER_MEDIA_FIELDS.map(field => provider[field])]) for (const model of entries ?? []) {
        if (!model.disabled) availableModels.set(model.id, { id: model.id, name: model.name || model.id });
      }
      return { version: 1, ...remoteModelAccess.read(command.providerId, command.memberId),
        availableModels: [...availableModels.values()] } satisfies RemoteModelAccessView;
    }
    case 'get-visibility':
      return providerShareVisibility.read(command.providerId);
    case 'set-visibility': {
      const assertOwner = captureProviderManagementScope();
      const result = await providerShareVisibility.set(command.providerId, command.visibility, () => { assertCurrent(); assertOwner(); });
      emit(PROVIDER_SHARE_IPC.OWNED_CHANGED, null);
      return result;
    }
    case 'quota-account':
      return readProviderShareQuotaAccount(command.providerId);
    case 'insights': {
      const assertOwner = captureProviderManagementScope();
      const share = findReceivedShare(command.shareId);
      const revision = providerShareReceivedRevision();
      if (!share || share.status !== 'active') throwIpcError('PERMISSION_DENIED', 'Provider share is not available');
      if (!share.hostOnline) throwIpcError('DEVICE_LINK_DEVICE_OFFLINE', 'Provider share host is offline');
      if (!shareInvoke) throwIpcError('DEVICE_LINK_NOT_CONNECTED', 'Provider share connection is not ready');
      const assertShare = () => {
        assertOwner();
        const latest = findReceivedShare(command.shareId);
        if (providerShareReceivedRevision() !== revision || !latest || latest.memberId !== share.memberId || latest.status !== 'active' || !latest.hostOnline) {
          throwIpcError('PERMISSION_DENIED', 'Provider share changed');
        }
      };
      const response = await shareInvoke(`share:${command.shareId}`, PROVIDER_SHARE_INSIGHTS_CHANNEL, [{ version: 1, includeUsage: command.includeUsage }], { preSend: assertShare });
      assertShare();
      if (!response.ok) {
        throwIpcError(response.error.code === 'CHANNEL_NOT_ALLOWED' ? 'UNSUPPORTED_CAPABILITY'
          : response.error.code === 'DEVICE_OFFLINE' ? 'DEVICE_LINK_DEVICE_OFFLINE'
          : response.error.code === 'INVOKE_TIMEOUT' ? 'DEVICE_LINK_TIMEOUT'
          : response.error.code === 'NOT_CONNECTED' || response.error.code === 'LINK_NOT_OPEN' ? 'DEVICE_LINK_NOT_CONNECTED'
          : 'PERMISSION_DENIED', 'Provider share insights are not available');
      }
      const result = parseProviderShareInsights(response.result);
      if (!result || (command.includeUsage && result.status.usage === 'not-requested') || (!command.includeUsage && (result.usage !== null || !['disabled', 'not-requested'].includes(result.status.usage)))) {
        throwIpcError('UNSUPPORTED_CAPABILITY', 'Provider share insights require an update');
      }
      return result;
    }
    case 'get-run-limits':
    case 'set-run-limits':
    case 'reset-run-limits': {
      if (command.action !== 'get-run-limits') {
        await saveRemoteAgentLimits(command.action === 'reset-run-limits' ? null : command.limits);
        assertCurrent();
      }
      return { ...readRemoteAgentLimitsState(), usage: remoteAgentLimitUsage() };
    }
    case 'owned':
      if (running) markProviderShareHostActive(60_000);
      return ownerState(command.range);
    case 'own-usage':
      return ownUsage(command.providerId, command.range);
    case 'usage-history':
      return usageHistory(command.providerId);
    case 'create-link': {
      const created = await createLink(command.providerId, assertCurrent);
      await clearProviderShareRequestQuiet(command.providerId);
      assertCurrent();
      rememberIssuedClipboardText(created.link, created.expiresAt);
      return created;
    }
    case 'approve':
    case 'reject':
      requireRunning();
      if (command.action === 'approve') await providerShareApi.approve(command.requestId);
      else await providerShareApi.reject(command.requestId);
      assertCurrent();
      applyLocalRequestDecision(command.requestId);
      void refreshProviderShareHost(command.action);
      return { ok: true };
    case 'set-member': {
      requireRunning();
      const result = await providerShareApi.setMember(command.memberId, command.status);
      assertCurrent();
      applyLocalMemberChange(command.memberId, result.status);
      void refreshProviderShareHost('member');
      return { ok: true };
    }
    case 'set-member-note': {
      const assertOwner = captureProviderManagementScope();
      requireRunning();
      // 本机 IPC 与同账号管理共用刷新，避免用旧名单给已退出的成员保存备注。
      await refreshProviderShareHost('management');
      assertCurrent();
      assertOwner();
      const member = getProviderShareHostSnapshot().some((share) => share.members.some((item) => item.memberId === command.memberId));
      if (!member) throwIpcError('NOT_FOUND', 'This shared provider member is no longer available');
      await providerShareMemberNotes.set(command.memberId, command.note, () => { assertCurrent(); assertOwner(); });
      emit(PROVIDER_SHARE_IPC.OWNED_CHANGED, null);
      return { ok: true };
    }
    case 'reshare-decide': {
      // 只改本机记录(不经服务端)；撤回立即结束这个人经组转来的任务。
      const decided = await decideProviderShareReshare(command.id, command.decision, Date.now(), assertCurrent);
      assertCurrent();
      if (!decided) throwIpcError('NOT_FOUND', 'This request is no longer pending');
      if (decided.previous === 'approved' && decided.record.state !== 'approved') abortReshares([decided.record]);
      emit(PROVIDER_SHARE_IPC.OWNED_CHANGED, null);
      return { ok: true };
    }
    case 'received':
      if (running) void refreshReceivedShares('ui');
      return getReceivedShares();
    case 'received-snapshot':
      return getReceivedSharesSnapshot(command.favoriteRecovery);
    case 'preview':
      return previewProviderShare(command.link);
    case 'send-request':
      return sendProviderShareRequest(command.link);
    case 'get-request':
      return getProviderShareRequest(command.requestId);
    case 'withdraw':
      await withdrawProviderShareRequest(command.requestId);
      return { ok: true };
    case 'leave':
      await leaveProviderShare(command.memberId);
      return { ok: true };
    case 'get-credential-consent':
      return { skip: isProviderShareCredentialConsentSkipped(command.shareId) };
    case 'set-credential-consent': {
      // 只能对现在还在名单里的分享设置；分享的区域记下来，清理时按已确认区域判断。
      const share = findReceivedShare(command.shareId);
      if (!share) throwIpcError('NOT_FOUND', 'This shared provider is no longer available');
      await setProviderShareCredentialConsentFromIpc(command.shareId, share.owner.region, command.skip);
      return { skip: isProviderShareCredentialConsentSkipped(command.shareId) };
    }
  }
}

/**
 * 同账号管理只执行分享者操作；申请和成员必须属于这台电脑的分享。经管理生成的链接由发起的那台电脑
 * 弹审批窗，本机在窗口期内静默；返回的 owned 只含这台电脑的分享，不带本机自己的弹窗安排。
 */
export async function executeProviderShareManagementCommand(command: ProviderShareManagementCommand): Promise<unknown> {
  const assertCurrent = captureProviderManagementScope();
  if (command.action === 'approve' || command.action === 'reject' || command.action === 'set-member') {
    requireRunning();
    await refreshProviderShareHost('management');
    assertCurrent();
    const shares = getProviderShareHostSnapshot();
    const found = command.action === 'set-member'
      ? shares.some((share) => share.members.some((member) => member.memberId === command.memberId))
      : shares.some((share) => share.requests.some((request) => request.requestId === command.requestId));
    if (!found) throwIpcError('NOT_FOUND', 'The share request or member is no longer on this computer');
  }
  if (command.action === 'create-link') {
    const created = await createLink(command.providerId, assertCurrent, true);
    assertCurrent();
    await quietProviderShareRequests(command.providerId, created.linkId);
    assertCurrent();
    rememberIssuedClipboardText(created.link, created.expiresAt);
    return created;
  }
  const result = await execute(command, assertCurrent);
  assertCurrent();
  if (command.action === 'owned') {
    const { ready, shares } = result as ProviderShareOwnerState;
    return { ready, shares } satisfies ProviderShareOwnerState;
  }
  return result;
}

const CATALOG_READ_TIMEOUT_MS = 10_000;
const LINK_TTL_SAFETY_MS = 5_000;

/**
 * 手机(同账号)经被控电脑读取这台电脑收到的分享与各自的模型目录。目录由分享者电脑过滤为
 * 分享的那个供应商；读不到(离线、已暂停)时 catalog 为 null，不影响其他分享。
 * `includeCatalog: false` 只返回分享元数据，供远控候选筛选使用，避免把完整目录读取的等待
 * 传播到分享发现。
 */
async function receivedCatalogs(args: unknown[]): Promise<{ ready: boolean; shares: ProviderShareReceivedCatalog[] }> {
  if (!running) return { ready: false, shares: [] };
  const invoke = shareInvoke;
  const listArgs = Array.isArray(args) ? args.slice(0, 1) : [];
  const includeCatalog = !(
    listArgs[0] && typeof listArgs[0] === 'object' && !Array.isArray(listArgs[0])
    && (listArgs[0] as { includeCatalog?: unknown }).includeCatalog === false
  );
  // 未全部就绪时也返回已加载的区域，但账号切换期间不得返回旧账号名单。
  const shares = getReceivedSharesSnapshot().received;
  return {
    ready: isReceivedSharesReady(),
    shares: await Promise.all(shares.map(async (share): Promise<ProviderShareReceivedCatalog> => {
      const agentDeviceId = `share:${share.shareId}`;
      let catalog: unknown = null;
      if (includeCatalog && invoke && share.status === 'active') {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            invoke(agentDeviceId, 'maker:provider:list', listArgs),
            new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), CATALOG_READ_TIMEOUT_MS); }),
          ]);
          if (result?.ok) catalog = scrubSharedProviderCatalog(result.result);
        } catch {
          catalog = null;
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      return {
        agentDeviceId,
        shareId: share.shareId,
        providerId: share.providerId,
        providerLabel: share.providerLabel,
        // 服务端存着旧链接里分享者的电脑名，不转给手机；旧版手机仍按必填解析，填占位。
        deviceName: PROVIDER_SHARE_NEUTRAL_DEVICE_NAME,
        owner: { displayName: share.owner.displayName, avatarUrl: share.owner.avatarUrl },
        status: share.status,
        hostOnline: share.hostOnline,
        catalog,
      };
    })),
  };
}

export function registerProviderShareIpc(): void {
  // 受邀者对每个分享的本机偏好(「信任 {分享者}」)：按当前账号存放，读写时解析。
  configureProviderShareGuestPrefs({ resolvePath: () => ownerScopedUserDataPath('provider-share-guest-prefs.json') });
  const insights = createProviderShareInsightsReader({
    scopeKey: activeOwnerScopeKey,
    captureScope: captureProviderManagementScope,
    access: providerShareGuestAccess,
    revision: providerShareAccessRevision,
    visibility: (providerId) => providerShareVisibility.read(providerId),
    shares: getProviderShareHostSnapshot,
    owner: () => ({ displayName: getAuthState().user?.name ?? '', avatarUrl: getAuthState().user?.avatar ?? null }),
    history: usageHistory,
    quota: readProviderShareQuota,
  });
  setProviderShareAccess({
    remoteModels: (providerId) => {
      try { return remoteModelAccess.read(providerId).providerModels; } catch { return []; }
    },
    modelAllowed: (controller, providerId, model) => {
      const access = providerShareGuestAccess(controller);
      return access?.providerId === providerId && remoteModelAccess.allows(providerId, model, access.memberId);
    },
    insights,
    insightsCurrent: insights.isCurrent,
    guestAccess: providerShareGuestAccess,
    ensureKnown: ensureProviderSharePeerKnown,
    hasShares: () => getProviderShareHostSnapshot().length > 0,
    denial: providerShareGuestDenial,
  });
  // 同账号的手机经设备互联调用(已在同账号 allowlist)；本机窗口也可调用。
  ipcMain.handle(PROVIDER_SHARE_RECEIVED_CATALOGS_CHANNEL, async (event, ...args: unknown[]) => {
    const context = getDeviceLinkInvokeContext();
    if (context?.sharedTask) throwIpcError('PERMISSION_DENIED', 'Not available to shared tasks');
    if (!context) assertTrustedAppRendererEvent(event);
    return receivedCatalogs(args);
  });
  ipcMain.handle(PROVIDER_SHARE_IPC.COMMAND, async (event, raw: unknown) => {
    // 账号级操作：只接受本机应用窗口，不经设备互联代理。
    if (getDeviceLinkInvokeContext()) throwIpcError('PERMISSION_DENIED', 'Provider sharing is local only');
    assertTrustedAppRendererEvent(event);
    return execute(parseProviderShareCommand(raw));
  });
}

/** 深链 `cindy://provider-share/join?...` → 让 Renderer 打开申请弹窗。 */
export function openProviderShareJoin(link: string): void {
  focusMainWindow();
  emit(PROVIDER_SHARE_IPC.OPEN_JOIN, { link });
}
