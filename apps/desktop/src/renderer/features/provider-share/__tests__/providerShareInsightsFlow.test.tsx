// @vitest-environment jsdom
/**
 * 跨模块集成：真实 renderer → IPC handler → guest runtime → host dispatch → insights
 * reader/文件权限 → wire DTO → renderer。现有单段测试没有覆盖这条接线。
 * 最小失败输入：一份获准的分享，默认折叠却查历史；展开→收起/隐藏/离页期间迟到的回包。
 * 既有测试仅验证显示折叠，未检查真实 host 读取与传输。unit runner；集成场景。
 * Electron、传输、账号关系快照、上游额度和账本为替身，不是真实跨账号/跨电脑 E2E。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import {
  providerShareGuestPeer,
  type DeviceLinkClient,
  type InvokeResultPayload,
  type ProviderShareReceived,
} from '@cindy/device-link';

const state = vi.hoisted(() => ({ root: '', active: true, historyReads: 0 }));
vi.mock('electron-store', () => ({ default: class {} }));
vi.mock('electron', () => ({
  app: { getAppPath: () => state.root, getPath: () => state.root, getVersion: () => '0.0.0-test' },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: { isSupported: () => false },
  powerSaveBlocker: { start: () => 0, stop: () => {}, isStarted: () => false },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
}));
vi.mock('../../../../main/appSessionState.js', () => ({
  activeOwnerScopeKey: () => 'isolated-owner',
  isAppSessionBoundaryPending: () => false,
  ownerScopedUserDataPath: (file: string) => `${state.root}/${file}`,
}));
vi.mock('../../../../main/maker-host/createDesktopProviderService.js', () => ({
  getDesktopProviderService: () => ({ listProviders: async () => [] }),
}));
vi.mock('../../../../main/maker-host/remote-provider-access-store.js', () => ({
  isRemoteProviderInvocationAllowed: () => true,
}));
vi.mock('../../../../main/i18n.js', () => ({ t: (key: string) => key }));
vi.mock('../../../../main/textClipboard.js', () => ({ rememberIssuedClipboardText: vi.fn() }));
// 额度查询不经过 Agent 启动面，隔离其与调度器的全局装配。
// 其它 IPC 服务不是本链路的依赖，不装配文件传输、桌面捕获、语音和插件宿主。
vi.mock('../../../../main/localDb/ipc/taskTags.js', () => ({
  TASK_TAG_CHANNEL: 'local-db:task-tags:execute',
}));
vi.mock('../../../../main/device-link/mediaFetch', () => ({}));
vi.mock('../../../../main/task-migration/service', () => ({}));
vi.mock('../../../../main/device-link/filePeer', () => ({}));
vi.mock('../../../../main/remote-desktop', () => ({}));
vi.mock('../../../../main/device-link/sharedTaskFileAccess.js', () => ({}));
vi.mock('../../../../main/voice-input/index.js', () => ({}));
vi.mock('../../../../main/cindy-brain/ghostSetupInteractionBridge.js', () => ({}));
vi.mock('../../../../main/maker-host/index.js', () => ({}));
vi.mock('../../../../main/maker-ipc/register.js', () => ({}));
vi.mock('../../../../main/device-link/index.js', () => ({ remoteBackgroundInvoke: vi.fn() }));
vi.mock('../../../../main/device-link/providerShareApi.js', () => ({
  providerShareApi: {},
  providerShareOwnerKey: () => 'isolated-owner',
  fetchIdentityCard: vi.fn(),
  sha256Hex: (v: string) => v,
}));
vi.mock('../../../../main/authManager.js', () => ({
  getDeviceId: () => 'isolated-host',
  getAuthState: () => ({ user: { name: 'Shared Owner', avatar: null } }),
}));
vi.mock('../../../../main/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../../main/security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
}));
vi.mock('../../../../main/device-link/settings-store.js', async (original) => ({
  ...(await original<typeof import('../../../../main/device-link/settings-store.js')>()),
  readDeviceLinkSettings: () => ({
    remoteControlEnabled: true,
    keepAwake: false,
    revokedControllers: [],
    disabledControlDeviceIds: [],
  }),
  readLastKnownDeviceNames: () => ({}),
}));
vi.mock('../../../../main/device-link/providerShareHost.js', () => ({
  startProviderShareHost: vi.fn(),
  stopProviderShareHost: vi.fn(),
  providerShareAccessRevision: () => 1,
  ownedProviderShareGuestAccess: () =>
    state.active ? { shareId: 'flow', memberId: 'guest', providerId: 'anthropic' } : null,
  providerShareGuestAccess: () =>
    state.active ? { shareId: 'flow', memberId: 'guest', providerId: 'anthropic' } : null,
  ensureProviderSharePeerKnown: async () => {},
  providerShareGuestDenial: () => null,
  getProviderShareHostSnapshot: () => [
    {
      shareId: 'flow',
      providerId: 'anthropic',
      members: [
        { memberId: 'guest', displayName: 'Guest Alice', avatarUrl: null, status: 'active' },
      ],
      requests: [],
    },
  ],
}));
vi.mock('../../../../main/device-link/providerShareGuest.js', () => ({
  startProviderShareGuest: vi.fn(),
  stopProviderShareGuest: vi.fn(),
  findReceivedShare: () => ({
    shareId: 'flow',
    memberId: 'guest',
    status: 'active',
    hostOnline: true,
  }),
  providerShareReceivedRevision: () => 1,
  refreshReceivedShares: async () => {},
  getReceivedShares: () => [],
}));
vi.mock('../../../../main/device-link/providerShareGuestPrefs.js', () => ({
  configureProviderShareGuestPrefs: vi.fn(),
  invalidateProviderShareGuestPrefsCache: vi.fn(),
}));
vi.mock('../../../../main/device-link/providerShareQuota.js', () => ({
  readProviderShareQuota: async () => ({
    group: false,
    partial: false,
    accounts: [
      {
        state: 'ready',
        updatedAt: null,
        windows: [],
        balance: { remaining: 25, total: 100, currency: 'USD', resetsAt: null, pools: [] },
      },
    ],
  }),
}));
vi.mock('../../../../main/usage/providerPartyUsageStore.js', () => ({
  currentProviderPartyUsageStore: () => ({
    history: () => (
      state.historyReads++,
      {
        self: {
          lastUsedAt: null,
          days: [
            {
              day: '2026-10-19',
              kind: 'codex',
              model: 'model-a',
              memberKey: 'private-device',
              turns: 1,
              inputTokens: 10,
              outputTokens: 2,
              cacheReadTokens: 0,
              cacheCreateTokens: 0,
            },
          ],
        },
        relays: [],
      }
    ),
  }),
}));
vi.mock('../../../../main/device-link/providerShareUsageStore.js', () => ({
  getProviderShareUsageStore: () => ({
    history: () => [
      {
        shareId: 'flow',
        memberId: 'guest',
        lastUsedAt: null,
        days: [
          {
            day: '2026-10-19',
            kind: 'codex',
            model: 'model-b',
            providerId: 'anthropic',
            memberKey: 'private-guest',
            turns: 1,
            inputTokens: 20,
            outputTokens: 3,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
          },
        ],
      },
    ],
  }),
  providerUsageLocalDay: () => '2026-10-19',
}));
vi.mock('../../../../main/usage/modelPricing.js', () => ({
  getGatewayModelPricing: async () => null,
  getModelPriceQuote: () => null,
}));
vi.mock('../../../../main/usage/ledgerCurrency.js', () => ({ currentLedgerCurrency: () => 'USD' }));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => [],
}));
vi.mock('@/features/provider-group/useLocalProviderGroups', () => ({
  useLocalProviderGroups: () => ({}),
}));
vi.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => true }));

import {
  registerProviderShareIpc,
  startProviderShareRuntime,
  stopProviderShareRuntime,
} from '../../../../main/device-link/providerShareRuntime';
import {
  __testing as dispatch,
  setProviderShareAccess,
  setRemoteAgentHandler,
} from '../../../../main/device-link/dispatch';
import { createProviderShareVisibilityStore } from '../../../../main/device-link/providerShareVisibility';
import { ProviderShareInsightsSection } from '../ProviderShareInsightsSection';

const share: ProviderShareReceived = {
  shareId: 'flow',
  memberId: 'guest',
  providerId: 'anthropic',
  providerLabel: 'Anthropic',
  hostDeviceId: 'host',
  deviceName: 'private-host',
  owner: { displayName: 'Shared Owner', avatarUrl: null, region: 'global' },
  status: 'active',
  hostOnline: true,
  hostCapable: true,
};
afterEach(() => {
  cleanup();
  stopProviderShareRuntime();
  dispatch.reset();
  setProviderShareAccess(null);
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (state.root) fs.rmSync(state.root, { recursive: true, force: true });
});
it('round-trips permissions, private projection and live revocation through the real query stack', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  state.historyReads = 0;
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-share-flow-'));
  const peer = providerShareGuestPeer('flow', 'guest', 'test-device');
  const received: InvokeResultPayload[] = [];
  const client = {
    getConnectionEpoch: () => 1,
    getStatus: () => 'online',
    sendInvokeResult: (_peer: string, _id: string, value: InvokeResultPayload) => {
      received.push(JSON.parse(JSON.stringify(value)) as InvokeResultPayload);
    },
  } as unknown as DeviceLinkClient;
  dispatch.reset();
  dispatch.setActiveClient(client);
  const agent = vi.fn();
  setRemoteAgentHandler({ handle: agent, abortAll: vi.fn() });
  let request = 0;
  let holdResponse: Promise<void> | null = null;
  startProviderShareRuntime(vi.fn(), {
    invoke: async (_target, channel, args, options) => {
      options?.preSend?.();
      await dispatch.handleInvoke(client, peer, `query-${request++}`, { channel, args });
      const response = received.at(-1)!;
      await holdResponse;
      return response;
    },
  });
  const registration = vi.spyOn(ipcMain, 'handle');
  registerProviderShareIpc();
  const handler = registration.mock.calls.find(
    ([channel]) => channel === 'provider-share:command',
  )![1];
  const command = (input: unknown) => handler({} as Electron.IpcMainInvokeEvent, input);
  const save = (quota: boolean, usage: boolean) =>
    command({ action: 'set-visibility', providerId: 'anthropic', visibility: { quota, usage } });
  Object.assign(window, {
    electronAPI: { providerShare: { command, onReceivedChanged: () => () => {} } },
  });
  await expect(
    command({ action: 'get-visibility', providerId: 'anthropic' }),
  ).resolves.toMatchObject({ quota: false, usage: false });
  await save(true, true);
  expect(request).toBe(0);
  expect(state.historyReads).toBe(0);
  let page!: ReturnType<typeof render>;
  await act(async () => {
    page = render(<ProviderShareInsightsSection share={share} />);
  });
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25');
  expect(screen.queryByText('Guest Alice')).toBeNull();
  expect(state.historyReads).toBe(0);
  expect(received.at(-1)).toMatchObject({
    ok: true,
    result: { capabilities: { usage: true }, status: { usage: 'not-requested' }, usage: null },
  });
  const toggle = () => screen.getByRole('button', { name: 'providerShare.insights.usageTitle' });
  await act(async () => {
    fireEvent.click(toggle());
  });
  expect(state.historyReads).toBe(1);
  expect(screen.getByText('Guest Alice')).toBeTruthy();
  expect(screen.getByText('Shared Owner')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'providerGroup.usage.stack.model' }));
  expect(screen.getAllByTestId('provider-usage-model')).toHaveLength(2);
  fireEvent.click(screen.getByRole('tab', { name: 'providerGroup.usage.stack.party' }));
  fireEvent.click(screen.getByRole('button', { name: 'Guest Alice' }));
  fireEvent.click(screen.getByRole('tab', { name: 'providerGroup.usage.stack.model' }));
  expect(screen.getAllByTestId('provider-usage-model')).toHaveLength(1);
  expect(screen.getByTestId('provider-usage-model').textContent).toContain('model-b');
  fireEvent.change(screen.getByLabelText('usageHistory.range.date'), {
    target: { value: '2026-10-18' },
  });
  expect(screen.queryAllByTestId('provider-usage-model')).toHaveLength(0);
  fireEvent.change(screen.getByLabelText('usageHistory.range.date'), {
    target: { value: '2026-10-19' },
  });
  expect(screen.getAllByTestId('provider-usage-model')).toHaveLength(1);
  expect(JSON.stringify(received)).not.toMatch(
    /private-device|private-guest|memberKey|hostDeviceId/,
  );
  // 折叠后即使越过缓存有效期仍不读历史，额度继续刷新且模型区域不被明细占据。
  await act(async () => {
    fireEvent.click(toggle());
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
  expect(state.historyReads).toBe(1);
  expect(received.at(-1)).toMatchObject({
    ok: true,
    result: { usage: null, status: { usage: 'not-requested' } },
  });
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25');
  let release!: () => void;
  holdResponse = new Promise<void>((resolve) => {
    release = resolve;
  });
  await act(async () => {
    fireEvent.click(toggle());
  });
  expect(state.historyReads).toBe(2);
  const lateUsage = release;
  holdResponse = null;
  await act(async () => {
    fireEvent.click(toggle());
    lateUsage();
  });
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByText('Guest Alice')).toBeNull();
  expect(screen.getByRole('progressbar')).toBeTruthy();
  await act(async () => {
    fireEvent.click(toggle());
  });
  expect(screen.getByText('Guest Alice')).toBeTruthy();
  holdResponse = new Promise<void>((resolve) => {
    release = resolve;
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  await act(async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const hiddenRequests = request;
  const hiddenReads = state.historyReads;
  await act(async () => {
    release();
  });
  holdResponse = null;
  expect(screen.queryByRole('progressbar')).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
  expect(request).toBe(hiddenRequests);
  expect(state.historyReads).toBe(hiddenReads);
  expect(screen.queryByText('Guest Alice')).toBeNull();
  await act(async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  expect(state.historyReads).toBe(hiddenReads);
  // 已发请求不声称跨端取消；离页后到达的真实 host 回包不能进入新页面。
  holdResponse = new Promise<void>((resolve) => {
    release = resolve;
  });
  await act(async () => {
    fireEvent.click(toggle());
  });
  const leftReads = state.historyReads;
  page.unmount();
  const leftRequests = request;
  await act(async () => {
    release();
    await vi.advanceTimersByTimeAsync(20_000);
  });
  expect(request).toBe(leftRequests);
  expect(state.historyReads).toBe(leftReads);
  holdResponse = null;
  await act(async () => {
    page = render(<ProviderShareInsightsSection share={share} />);
  });
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByText('Guest Alice')).toBeNull();
  expect(state.historyReads).toBe(leftReads);
  const reopened = createProviderShareVisibilityStore({
    filePath: () => path.join(state.root, 'provider-share-visibility.json'),
    scopeKey: () => 'isolated-owner',
  });
  expect(reopened.read('anthropic')).toMatchObject({ quota: true, usage: true });
  // 重新挂载触发同一真实查询；不依赖真实时间等待，也不以伪造响应替代撤权。
  cleanup();
  // 文件权限写入使用真实文件锁时钟；轮询与缓存过期已用虚拟时间验证完毕。
  vi.useRealTimers();
  await save(true, false);
  await act(async () => {
    render(<ProviderShareInsightsSection share={share} />);
  });
  expect(screen.getByRole('progressbar')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'providerShare.insights.usageTitle' })).toBeNull();
  expect(screen.queryByText('Guest Alice')).toBeNull();
  expect(agent).not.toHaveBeenCalled();
});
