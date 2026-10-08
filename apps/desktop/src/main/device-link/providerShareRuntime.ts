/**
 * 供应商分享的本机接线：分享者与受邀者两侧运行时的起停、推送给 Renderer、系统通知，以及
 * Renderer 的命令通道。账号操作只接受本机应用窗口，不能经设备互联从别的电脑调用。
 */
import { app, BrowserWindow, ipcMain, Notification } from 'electron';

import {
  PROVIDER_SHARE_LINK_TTL_MS,
  PROVIDER_SHARE_RECEIVED_CATALOGS_CHANNEL,
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
} from '../../shared/providerShare.js';
import { getDeviceId } from '../authManager.js';
import { t } from '../i18n.js';
import { createLogger } from '../logger.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { isRemoteProviderInvocationAllowed } from '../maker-host/remote-provider-access-store.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { currentLedgerCurrency } from '../usage/ledgerCurrency.js';
import { getGatewayModelPricing, getModelPriceQuote } from '../usage/modelPricing.js';
import { computePriceQuoteTurnMoney, normalizeModelIdForPricing } from '../usage/turnCostCalculator.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { deviceName } from './deviceName.js';
import { providerShareActiveControllers, revokeProviderShareControllers, setProviderShareAccess } from './dispatch.js';
import { getDeviceLinkInvokeContext } from './invoke-context.js';
import { fetchIdentityCard, providerShareApi, providerShareLinkFor, sha256Hex } from './providerShareApi.js';
import {
  getReceivedShares,
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
  applyLocalMemberChange,
  applyLocalRequestDecision,
  ensureProviderSharePeerKnown,
  getProviderShareHostSnapshot,
  markProviderShareHostActive,
  providerShareGuestAccess,
  providerShareMemberMatcher,
  refreshProviderShareHost,
  startProviderShareHost,
  stopProviderShareHost,
} from './providerShareHost.js';
import { getProviderShareUsageStore } from './providerShareUsageStore.js';
import { readDeviceLinkSettings } from './settings-store.js';

const log = createLogger('provider-share');

type Broadcast = (channel: string, payload: unknown) => void;
/** 经设备互联读分享者电脑的目录(index.ts 注入 remoteBackgroundInvoke，避免循环依赖)。 */
type ShareInvoke = (agentDeviceId: string, channel: string, args: unknown[]) => Promise<InvokeResultPayload>;

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

/** 设备互联连上(本实例持有连接)时启动；断开、登出或失去持有权时停止。 */
export function startProviderShareRuntime(broadcast: Broadcast, options: { invoke?: ShareInvoke } = {}): void {
  broadcastFn = broadcast;
  shareInvoke = options.invoke ?? null;
  running = true;
  startProviderShareHost({
    changed() {
      emit(PROVIDER_SHARE_IPC.OWNED_CHANGED, null);
    },
    requested(request, share) {
      emit(PROVIDER_SHARE_IPC.REQUESTED, {
        request,
        share: { shareId: share.shareId, providerId: share.providerId, providerLabel: share.providerLabel },
      });
      void notify(
        t('providerShare.notification.requestTitle'),
        format(t('providerShare.notification.requestBody'), { name: request.displayName, provider: share.providerLabel }),
        () => emit(PROVIDER_SHARE_IPC.OPEN_MANAGE, { providerId: share.providerId }),
      );
    },
    revoked(member, purge) {
      revoke(providerShareMemberMatcher(member), purge);
    },
    reconcile(owned) {
      // 分享者电脑离线期间被删除或退出的成员：清理他们留在本机的会话数据。
      revoke((controller) => {
        const peer = parseProviderSharePeer(controller);
        if (peer?.role !== 'guest') return false;
        const members = owned.get(peer.shareId);
        return !!members && !members.has(peer.memberId);
      }, true);
    },
  });
  startProviderShareGuest({
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
  running = false;
  shareInvoke = null;
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

function parseCommand(raw: unknown): ProviderShareCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throwIpcError('INVALID_PARAMS', 'Invalid command');
  const value = raw as Record<string, unknown>;
  switch (value.action) {
    case 'owned': {
      const range = value.range;
      if (range !== '7d' && range !== 'month' && range !== 'all') throwIpcError('INVALID_PARAMS', 'Invalid range');
      return { action: 'owned', range };
    }
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
    case 'received':
      return { action: 'received' };
    case 'preview':
    case 'send-request':
      return { action: value.action, link: text(value.link, 'link', 4096) };
    case 'get-request':
    case 'withdraw':
      return { action: value.action, requestId: text(value.requestId, 'requestId', 128) };
    case 'leave':
      return { action: 'leave', memberId: text(value.memberId, 'memberId', 128) };
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
          lastUsedAt: record?.lastUsedAt ?? null,
          runningTasks: runningTasks.get(`${share.shareId}\u0000${member.memberId}`) ?? 0,
          models: await Promise.all((record?.models ?? []).map(async (model) => ({
            kind: model.kind,
            providerId: model.providerId,
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
  };
}

async function createLink(providerId: string): Promise<ProviderShareLinkCreated> {
  requireRunning();
  // 逐级开启：允许远程控制 → 允许被远程调用 → 分享。
  if (!readDeviceLinkSettings().remoteControlEnabled) throwIpcError('PRECONDITION_FAILED', 'Remote control is off');
  if (!isRemoteProviderInvocationAllowed(providerId)) throwIpcError('PRECONDITION_FAILED', 'Remote invocation is off for this provider');
  const providers = await getDesktopProviderService().listProviders({ allowSideEffects: false });
  const provider = providers.find((item) => item.id === providerId);
  if (!provider || !provider.connected || provider.agents.length === 0) throwIpcError('PRECONDITION_FAILED', 'Provider is not available');
  const hostDeviceId = getDeviceId();
  if (!hostDeviceId) throwIpcError('DEVICE_LINK_NOT_CONNECTED', 'Device is not registered');
  const identityCard = await fetchIdentityCard('share-link', sha256Hex(`${hostDeviceId}:${providerId}`));
  const created = await providerShareApi.createLink({
    providerId,
    // 名称可能自动带上登录身份(如「OpenAI · 邮箱」)，分享出去前去掉。
    providerLabel: scrubProviderShareLabel(provider.name, [provider.subscriptionAccount?.identity, provider.openAiAccount?.identity], provider.id),
    deviceName: deviceName(),
    identityCard,
  });
  markProviderShareHostActive();
  void refreshProviderShareHost('link');
  // 倒计时按本机收到响应的时刻计算：链接刚签发，服务端从签发起算 5 分钟。不拿服务端的绝对时间
  // 和本机时钟相减(两边时钟可能有偏差，偏快会一生成就显示已过期)，并留出请求往返的余量。
  const expiresAt = new Date(Date.now() + PROVIDER_SHARE_LINK_TTL_MS - LINK_TTL_SAFETY_MS).toISOString();
  return { link: providerShareLinkFor(created.invitation), expiresAt };
}

async function execute(command: ProviderShareCommand): Promise<unknown> {
  switch (command.action) {
    case 'owned':
      if (running) markProviderShareHostActive(60_000);
      return ownerState(command.range);
    case 'create-link':
      return createLink(command.providerId);
    case 'approve':
    case 'reject':
      requireRunning();
      if (command.action === 'approve') await providerShareApi.approve(command.requestId);
      else await providerShareApi.reject(command.requestId);
      applyLocalRequestDecision(command.requestId);
      void refreshProviderShareHost(command.action);
      return { ok: true };
    case 'set-member': {
      requireRunning();
      const result = await providerShareApi.setMember(command.memberId, command.status);
      applyLocalMemberChange(command.memberId, result.status);
      void refreshProviderShareHost('member');
      return { ok: true };
    }
    case 'received':
      if (running) void refreshReceivedShares('ui');
      return getReceivedShares();
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
  }
}

const CATALOG_READ_TIMEOUT_MS = 10_000;
const LINK_TTL_SAFETY_MS = 5_000;

/**
 * 手机(同账号)经被控电脑读取这台电脑收到的分享与各自的模型目录。目录由分享者电脑过滤为
 * 分享的那个供应商；读不到(离线、已暂停)时 catalog 为 null，不影响其他分享。
 */
async function receivedCatalogs(args: unknown[]): Promise<{ shares: ProviderShareReceivedCatalog[] }> {
  if (!running) return { shares: [] };
  const invoke = shareInvoke;
  const listArgs = Array.isArray(args) ? args.slice(0, 1) : [];
  const shares = getReceivedShares();
  return {
    shares: await Promise.all(shares.map(async (share): Promise<ProviderShareReceivedCatalog> => {
      const agentDeviceId = `share:${share.shareId}`;
      let catalog: unknown = null;
      if (invoke && share.status === 'active') {
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
        deviceName: share.deviceName,
        owner: { displayName: share.owner.displayName, avatarUrl: share.owner.avatarUrl },
        status: share.status,
        hostOnline: share.hostOnline,
        catalog,
      };
    })),
  };
}

export function registerProviderShareIpc(): void {
  setProviderShareAccess({
    guestAccess: providerShareGuestAccess,
    ensureKnown: ensureProviderSharePeerKnown,
    hasShares: () => getProviderShareHostSnapshot().length > 0,
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
    return execute(parseCommand(raw));
  });
}

/** 深链 `cindy://provider-share/join?...` → 让 Renderer 打开申请弹窗。 */
export function openProviderShareJoin(link: string): void {
  focusMainWindow();
  emit(PROVIDER_SHARE_IPC.OPEN_JOIN, { link });
}
