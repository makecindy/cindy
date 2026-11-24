// @vitest-environment jsdom
/**
 * 手机「我分享的供应商」两个页面的行为(provider-sharing.md §7.6)。只替换设备互联的 `invoke`、那台电脑的
 * 供应商目录与界面基础组件；页面、读取节奏与协议解析都是生产代码。
 *
 * 测试价值
 * - 生产入口与可观察结果：`ProviderShareDetailScreen` / `ProviderSharesScreen`；断言用户看到的配对码、告知、
 *   链接与提示，以及发给供应商所在电脑的命令。
 * - 规则依据：provider-sharing.md §4.1 第 4 步(同意前核对供应商、Claude 邮箱告知、链接由生成它的设备显示申请)、
 *   §3(未打开「允许被远程调用」不能生成链接)；engineering-conventions.md §8.7(申请 5 秒、状态 15 秒)、
 *   §8.3(切到后台后不再发新的读取)。
 * - 现有覆盖缺口：手机此前没有分享者一侧的界面；Desktop 的同类流程在 renderer 测试里，不覆盖这两页。
 * - 最小失败输入：见各用例(目录未就绪时点同意、链接生成后 5 秒内到达的申请、生成链接途中点同意、读不到的电脑、
 *   链接在后台期间过期、六台电脑的额度读到一半切到后台、下拉刷新在途时退出页面等)。
 * - tier：unit(jsdom 渲染；设备互联与应用前后台状态为内存替身，生成链接后的轮询与有效期用假计时器)。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import ProviderShareDetailScreen from '@/provider-share/ProviderShareDetailScreen';
import ProviderSharesScreen from '@/provider-share/ProviderSharesScreen';

type Command = { action: string; providerId?: string; requestId?: string };

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  readDeviceList: vi.fn(),
  push: vi.fn(),
  share: vi.fn(async () => undefined),
  clipboard: vi.fn(async () => undefined),
  params: {} as Record<string, string>,
  catalog: { providers: [] as unknown[], ready: false, error: null as string | null },
  appState: { current: 'active', listeners: new Set<(state: string) => void>() },
}));

vi.mock('react-native', () => {
  const View = ({ children, testID }: { children?: ReactNode; testID?: string }) => <div data-testid={testID}>{children}</div>;
  return {
    View,
    ScrollView: ({ children, refreshControl, testID }: { children?: ReactNode; refreshControl?: ReactNode; testID?: string }) => (
      <div data-testid={testID}>{refreshControl}{children}</div>
    ),
    ActivityIndicator: () => null,
    // 下拉刷新没有可点的元素：用一个按钮代替手势，触发的是页面自己的 onRefresh。
    RefreshControl: ({ onRefresh }: { onRefresh?: () => void }) => <button data-testid="pullToRefresh" onClick={onRefresh} />,
    Share: { share: mocks.share },
    StyleSheet: { create: (value: unknown) => value },
    AppState: {
      get currentState() { return mocks.appState.current; },
      addEventListener: (_type: string, listener: (state: string) => void) => {
        mocks.appState.listeners.add(listener);
        return { remove: () => { mocks.appState.listeners.delete(listener); } };
      },
    },
  };
});
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({}),
  useIsFocused: () => true,
  useLocalSearchParams: () => mocks.params,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}), monoFont: 'monospace' }));
vi.mock('@/components/AppText', () => ({
  Text: ({ children, testID }: { children?: ReactNode; testID?: string }) => <span data-testid={testID}>{children}</span>,
}));
vi.mock('@/components/MobilePrimitives', () => ({
  MainWindowActionButton: ({ action }: { action: { label: string; onPress?: () => void; busy?: boolean; disabled?: boolean; testID?: string } }) => (
    <button data-testid={action.testID} disabled={action.busy || action.disabled} onClick={action.onPress}>{action.label}</button>
  ),
  MainWindowEmptyState: ({ title, testID }: { title: string; testID?: string }) => <div data-testid={testID}>{title}</div>,
  StatusDot: () => null,
}));
vi.mock('@/components/MobileUserAvatar', () => ({ MobileUserAvatar: () => null }));
vi.mock('@/components/ErrorNotice', () => ({
  ErrorNotice: ({ message, children }: { message: string; children?: ReactNode }) => <div role="alert">{message}{children}</div>,
}));
vi.mock('@/platform/chrome/SimpleStackHeader', () => ({
  SimpleStackHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
  simpleScrollInsetProps: {},
  simpleScrollScreenSafeAreaEdges: () => [],
}));
vi.mock('@/session/SettingsGroupRows', () => ({
  SettingsGroup: ({ children, footer, messages, testID, title }: {
    children?: ReactNode; footer?: string; messages?: ReadonlyArray<{ text: string; testID?: string } | null>; testID?: string; title?: string;
  }) => (
    <section data-testid={testID}>
      <h2>{title}</h2>
      {children}
      <p>{footer}</p>
      {messages?.map((message) => message ? <p data-testid={message.testID} key={message.text}>{message.text}</p> : null)}
    </section>
  ),
  ActionInfoRow: ({ disabled, label, onPress, testID, value }: {
    disabled?: boolean; label: string; onPress?: () => void; testID?: string; value?: string;
  }) => <button data-testid={testID} disabled={disabled} onClick={onPress}>{label}{value ? ` | ${value}` : ''}</button>,
  useSettingsRowStyles: () => ({}),
}));
vi.mock('@/session/ModelQuotaBar', () => ({
  ModelQuotaBar: ({ remaining }: { remaining: number }) => <div aria-valuenow={remaining} role="progressbar" />,
}));
vi.mock('@/session/messageActions', () => ({ writeClipboardText: mocks.clipboard }));
vi.mock('@/session/sessionUsagePresentation', () => ({
  formatQuotaResetCountdown: () => '3h',
  formatSessionUsageMoney: () => '$1.00',
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: 1 }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({
  useDeviceLink: () => ({ invoke: mocks.invoke, readDeviceList: mocks.readDeviceList }),
}));
vi.mock('@/device-link/useDeviceProviders', () => ({ useDeviceProviders: () => mocks.catalog }));
vi.mock('@/device-link/devices', () => ({
  // 可达性判定是既有共享逻辑(maker-shared device-list)，这里只保留「在线且允许远程控制」。
  toDeviceListItems: (devices: Array<{ deviceId: string; name: string; online: boolean; remoteControlEnabled: boolean }>) =>
    devices.map((device) => ({ device, canOpen: device.online && device.remoteControlEnabled })),
}));
vi.mock('@/device-link/revokedDevicesStore', () => ({ useRevokedDevices: () => new Set<string>() }));
vi.mock('@/utils/backGuard', () => ({ goBackGuarded: vi.fn() }));
vi.mock('@/utils/useGuardedPush', () => ({ useGuardedPush: () => mocks.push }));

const LINK_ID = 'b'.repeat(64);
const LINK = 'https://cindy.example.invalid/provider-share#one-time-secret';
const anthropic = {
  id: 'anthropic', name: 'Anthropic', source: 'builtin', connected: true, remoteInvocationEnabled: true, auth: { method: 'oauth' },
};
const pending = (requestId: string, linkId?: string) => ({
  requestId, displayName: 'Mallory', avatarUrl: null, region: 'global', pairingCode: '4821',
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), ...(linkId ? { linkId } : {}),
});
const member = { memberId: 'm-1', displayName: 'Bob', avatarUrl: null, region: 'global', status: 'active', joinedAt: '2026-11-01T00:00:00.000Z' };
const ownedShare = (providerId: string, members: unknown[], requests: unknown[]) => ({
  shareId: `share-${providerId}`, providerId, providerLabel: providerId === 'anthropic' ? 'Anthropic' : providerId,
  createdAt: '2026-11-01T00:00:00.000Z', members, requests,
});

/** 供应商所在电脑的内存替身：按命令回包，记录收到的命令。 */
function host(handlers: Partial<Record<string, (command: Command, deviceId: string) => unknown>>) {
  const received: Array<{ deviceId: string; command: Command }> = [];
  mocks.invoke.mockImplementation(async (deviceId: string, _channel: string, args: unknown[]) => {
    const request = args[0] as { action: string; providerId?: string; command?: Command };
    const command = request.action === 'view' ? { action: 'view', providerId: request.providerId } : request.command!;
    received.push({ deviceId, command });
    const handler = handlers[command.action];
    if (!handler) throw new Error(`[INVALID_PARAMS] Unknown command ${command.action}`);
    const result = await handler(command, deviceId);
    return command.action === 'view' ? result : { result, respondedAt: Date.now() };
  });
  return { received, count: (action: string) => received.filter((entry) => entry.command.action === action).length };
}

const noGroup = () => ({ providerId: 'anthropic', config: null, members: [] });
/** 建了组的供应商：组里每台电脑各有自己的账号，额度要分别去问。 */
const groupOf = (deviceIds: string[]) => ({
  providerId: 'anthropic',
  config: {
    strategy: 'least',
    autoSwitch: true,
    members: deviceIds.map((deviceId) => ({
      key: `device:${deviceId}:anthropic`, kind: 'device', agentDeviceId: deviceId, providerId: 'anthropic', limit: 4, weight: 1, paused: false,
    })),
  },
  members: deviceIds.map((deviceId) => ({
    key: `device:${deviceId}:anthropic`, kind: 'device', label: `Mac ${deviceId}`, state: 'available', running: 0, limit: 4, weight: 1, paused: false,
  })),
});
const weekQuota = () => ({
  state: 'ready', updatedAt: Date.now(), balance: null,
  windows: [{ kind: 'week', label: null, remainingPercent: 40, resetsAt: Date.now() + 3_600_000, windowMinutes: 10_080 }],
});

/** 应用切到后台 / 回到前台(React Native 的 AppState 事件)。 */
function setAppState(state: 'active' | 'background') {
  mocks.appState.current = state;
  act(() => { for (const listener of [...mocks.appState.listeners]) listener(state); });
}

beforeEach(() => {
  vi.clearAllMocks();
  setMobileAuthOwner('test-account');
  mocks.params = { deviceId: 'studio', deviceName: 'Mac Studio', providerId: 'anthropic', label: 'Anthropic' };
  mocks.catalog = { providers: [anthropic], ready: true, error: null };
  mocks.appState.current = 'active';
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setMobileAuthOwner(null);
});

it('shows the applicant, pairing code and Claude email notice, then approves on the provider computer', async () => {
  let handled = false;
  const computer = host({
    owned: () => ({ ready: true, shares: [ownedShare('anthropic', [member], handled ? [] : [pending('req-1')])] }),
    view: noGroup,
    'quota-account': weekQuota,
    approve: () => { handled = true; return { ok: true }; },
  });
  render(<ProviderShareDetailScreen />);

  expect((await screen.findByTestId('providerShareDetail.pairingCode.req-1')).textContent).toBe('4821');
  // 分享的是 Claude 订阅登录：同意前必须告诉分享者受邀者的 Agent 看得到登录邮箱。
  expect(screen.getByTestId('providerShareDetail.claudeEmail.req-1')).toBeDefined();
  expect((await screen.findByRole('progressbar')).getAttribute('aria-valuenow')).toBe('40');

  fireEvent.click(screen.getByTestId('providerShareDetail.approve.req-1'));
  expect((await screen.findByTestId('providerShareDetail.notice')).textContent).toBe('providerShare.manage.pending.approved');
  expect(computer.received.filter((entry) => entry.command.action === 'approve')).toEqual([
    { deviceId: 'studio', command: { action: 'approve', requestId: 'req-1' } },
  ]);
  // 处理后重新读取现状；申请不再显示。
  await waitFor(() => expect(computer.count('owned')).toBeGreaterThan(1));
  expect(screen.queryByTestId('providerShareDetail.request.req-1')).toBeNull();
});

it('keeps approval closed until the provider is found on that computer, while declining stays possible', async () => {
  mocks.catalog = { providers: [], ready: false, error: null };
  const computer = host({
    owned: () => ({ ready: true, shares: [ownedShare('anthropic', [], [pending('req-1')])] }),
    view: noGroup,
    'quota-account': weekQuota,
    reject: () => ({ ok: true }),
  });
  render(<ProviderShareDetailScreen />);

  // 目录还没读到：不知道是不是 Claude 登录、有没有建组，不能同意，也不摆生成链接的入口。
  const approve = await screen.findByTestId('providerShareDetail.approve.req-1') as HTMLButtonElement;
  expect(approve.disabled).toBe(true);
  expect(screen.getByTestId('providerShareDetail.approvalBlocked').textContent).toBe('providerShare.manage.pending.checking');
  expect(screen.queryByTestId('providerShareDetail.createLink')).toBeNull();
  fireEvent.click(approve);
  expect(computer.count('approve')).toBe(0);

  fireEvent.click(screen.getByTestId('providerShareDetail.reject.req-1'));
  expect((await screen.findByTestId('providerShareDetail.notice')).textContent).toBe('providerShare.manage.pending.rejected');
  expect(computer.count('reject')).toBe(1);
});

it('drops a request that was already handled elsewhere instead of reporting a failure', async () => {
  host({
    owned: () => ({ ready: true, shares: [ownedShare('anthropic', [], [pending('req-1')])] }),
    view: noGroup,
    'quota-account': weekQuota,
    approve: () => { throw new Error('[NOT_FOUND] The share request or member is no longer on this computer'); },
  });
  render(<ProviderShareDetailScreen />);
  fireEvent.click(await screen.findByTestId('providerShareDetail.approve.req-1'));
  expect((await screen.findByTestId('providerShareDetail.notice')).textContent).toBe('providerShare.manage.pending.gone');
  // 迟到的读取仍带着这条申请时也不再显示。
  await waitFor(() => expect(screen.queryByTestId('providerShareDetail.request.req-1')).toBeNull());
});

it('creates a link, then checks for its request every five seconds until it arrives', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let requested = false;
  const computer = host({
    owned: () => ({ ready: true, shares: [ownedShare('anthropic', [member], requested ? [pending('req-9', LINK_ID)] : [])] }),
    view: noGroup,
    'quota-account': weekQuota,
    'create-link': () => ({ link: LINK, linkId: LINK_ID, expiresAt: new Date(Date.now() + 295_000).toISOString() }),
  });
  render(<ProviderShareDetailScreen />);
  const create = await screen.findByTestId('providerShareDetail.createLink');

  // 没有链接时按 15 秒读：5 秒内不再读申请。
  const idle = computer.count('owned');
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(computer.count('owned')).toBe(idle);

  fireEvent.click(create);
  expect((await screen.findByTestId('providerShareDetail.linkText')).textContent).toBe(LINK);
  expect(screen.getByTestId('providerShareDetail.countdown').textContent).toContain('providerShare.manage.link.expiresIn');
  expect(screen.getByText('providerShare.manage.link.waiting')).toBeDefined();
  expect(computer.received.filter((entry) => entry.command.action === 'create-link')).toEqual([
    { deviceId: 'studio', command: { action: 'create-link', providerId: 'anthropic' } },
  ]);
  fireEvent.click(screen.getByTestId('providerShareDetail.sendLink'));
  expect(mocks.share).toHaveBeenCalledWith({ message: LINK });

  // 那台电脑在这段时间不弹审批窗：手机 5 秒读一次，申请到了就在这一页显示。
  await waitFor(() => expect(computer.count('owned')).toBeGreaterThan(idle));
  const watching = computer.count('owned');
  requested = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(computer.count('owned')).toBe(watching + 1);
  expect((await screen.findByTestId('providerShareDetail.pairingCode.req-9')).textContent).toBe('4821');
  // 链接只能用一次：它带来的申请到了，就不再当作还能发出去的链接显示，可以直接为下一个人生成。
  expect(screen.queryByTestId('providerShareDetail.linkText')).toBeNull();
  expect(screen.queryByText('providerShare.manage.link.waiting')).toBeNull();
  expect(screen.queryByTestId('providerShareDetail.linkExpired')).toBeNull();
  expect(screen.getByTestId('providerShareDetail.createLink').textContent).toBe('providerShare.manage.link.create');
});

it('shows a link that expired while the app was in the background as expired, and lets the owner create a new one', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const computer = host({
    owned: () => ({ ready: true, shares: [ownedShare('anthropic', [member], [])] }),
    view: noGroup,
    'quota-account': weekQuota,
    'create-link': () => ({ link: LINK, linkId: LINK_ID, expiresAt: new Date(Date.now() + 295_000).toISOString() }),
  });
  render(<ProviderShareDetailScreen />);
  fireEvent.click(await screen.findByTestId('providerShareDetail.createLink'));
  expect((await screen.findByTestId('providerShareDetail.linkText')).textContent).toBe(LINK);

  // 切到后台后倒计时不走；有效期在后台期间过去。
  setAppState('background');
  await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
  setAppState('active');

  // 回来时按现在的时刻判断：不再摆着旧倒计时和「发送」「复制」，而是写明已过期并可以重新生成。
  await waitFor(() => expect(screen.queryByTestId('providerShareDetail.linkText')).toBeNull());
  expect(screen.queryByTestId('providerShareDetail.sendLink')).toBeNull();
  expect(screen.getByTestId('providerShareDetail.linkExpired').textContent).toBe('providerShare.manage.link.expired');
  const regenerate = screen.getByTestId('providerShareDetail.createLink') as HTMLButtonElement;
  expect(regenerate.textContent).toBe('providerShare.manage.link.regenerate');
  expect(regenerate.disabled).toBe(false);

  fireEvent.click(regenerate);
  expect((await screen.findByTestId('providerShareDetail.linkText')).textContent).toBe(LINK);
  expect(computer.count('create-link')).toBe(2);
});

it('stops asking the remaining computers for quota once the app is in the background, and asks them after it returns', async () => {
  const waiting: Array<(value: unknown) => void> = [];
  const release = () => act(async () => { for (const resolve of waiting.splice(0)) resolve(weekQuota()); });
  const computer = host({
    owned: () => ({ ready: true, shares: [ownedShare('anthropic', [member], [])] }),
    view: () => groupOf(['a', 'b', 'c', 'd', 'e', 'f']),
    'quota-account': () => new Promise((resolve) => { waiting.push(resolve); }),
  });
  const asked = () => computer.received.filter((entry) => entry.command.action === 'quota-account').map((entry) => entry.deviceId);
  render(<ProviderShareDetailScreen />);
  // 同时最多读 3 台，其余排队。
  await waitFor(() => expect(asked()).toEqual(['a', 'b', 'c']));

  setAppState('background');
  await release();
  // 已发出的三台照常收下；排着队的三台在后台不再发(§8.3)。
  await waitFor(() => expect(screen.getAllByRole('progressbar')).toHaveLength(3));
  expect(asked()).toEqual(['a', 'b', 'c']);

  // 回到前台：没读完的随即重读，不等满一分钟。
  setAppState('active');
  await waitFor(() => expect(waiting).toHaveLength(3));
  await release();
  await waitFor(() => expect(waiting).toHaveLength(3));
  await release();
  await waitFor(() => expect(screen.getAllByRole('progressbar')).toHaveLength(6));
  expect(asked().slice(3).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
});

it('does not start another quota round when the owner pulls to refresh and leaves before the answers come back', async () => {
  let held: Array<() => void> | null = null;
  const answer = <T,>(value: T) => held ? new Promise<T>((resolve) => { held!.push(() => resolve(value)); }) : value;
  const computer = host({
    owned: () => answer({ ready: true, shares: [ownedShare('anthropic', [member], [])] }),
    view: () => answer(groupOf(['a', 'b'])),
    'quota-account': weekQuota,
  });
  const page = render(<ProviderShareDetailScreen />);
  await waitFor(() => expect(screen.getAllByRole('progressbar')).toHaveLength(2));
  expect(computer.count('quota-account')).toBe(2);

  // 下拉刷新：名单与组状态在途时退出详情页。
  held = [];
  fireEvent.click(screen.getByTestId('pullToRefresh'));
  await waitFor(() => expect(held).toHaveLength(2));
  page.unmount();
  await act(async () => { for (const resolve of held!.splice(0)) resolve(); });
  await new Promise((resolve) => { setTimeout(resolve, 20); });

  // 页面已经不在：迟到的回包不再引出对组内每台电脑的额度读取。
  expect(computer.count('quota-account')).toBe(2);
});

it('sends one write at a time: approving and declining wait while a link is being created', async () => {
  let finish: (value: unknown) => void = () => undefined;
  host({
    owned: () => ({ ready: true, shares: [ownedShare('anthropic', [member], [pending('req-1')])] }),
    view: noGroup,
    'quota-account': weekQuota,
    'create-link': () => new Promise((resolve) => { finish = resolve; }),
  });
  render(<ProviderShareDetailScreen />);
  const button = (name: string) => screen.getByTestId(`providerShareDetail.${name}.req-1`) as HTMLButtonElement;
  await screen.findByTestId('providerShareDetail.approve.req-1');
  expect(button('approve').disabled).toBe(false);

  // 生成链接还没回来：这时点同意不会发出去，按钮就不该看起来能点。
  fireEvent.click(screen.getByTestId('providerShareDetail.createLink'));
  await waitFor(() => expect(button('approve').disabled).toBe(true));
  expect(button('reject').disabled).toBe(true);

  await act(async () => { finish({ link: LINK, linkId: LINK_ID, expiresAt: new Date(Date.now() + 295_000).toISOString() }); });
  await waitFor(() => expect(button('approve').disabled).toBe(false));
  expect(button('reject').disabled).toBe(false);
});

it('explains why a link cannot be created when remote use is off, without offering the action', async () => {
  mocks.catalog = { providers: [{ ...anthropic, remoteInvocationEnabled: false }], ready: true, error: null };
  host({
    owned: () => ({ ready: true, shares: [ownedShare('anthropic', [member], [])] }),
    view: noGroup,
    'quota-account': weekQuota,
  });
  render(<ProviderShareDetailScreen />);
  expect((await screen.findByTestId('providerShareDetail.linkGate')).textContent).toBe('providerShare.manage.link.gateInvocation');
  expect(screen.queryByTestId('providerShareDetail.createLink')).toBeNull();
  expect(await screen.findByTestId('providerShareDetail.member.m-1')).toBeDefined();
});

it('lists the shares it could read per computer and says why the other computers are missing', async () => {
  mocks.params = {};
  mocks.readDeviceList.mockResolvedValue({
    devices: [
      { deviceId: 'studio', name: 'Mac Studio', online: true, remoteControlEnabled: true },
      { deviceId: 'macbook', name: 'MacBook Pro', online: false, remoteControlEnabled: true },
      { deviceId: 'old', name: 'Old Mac', online: true, remoteControlEnabled: true },
    ],
  });
  host({
    owned: (_command, deviceId) => {
      // 旧电脑不认识管理动作。
      if (deviceId === 'old') throw Object.assign(new Error("channel 'provider-group:remote' not allowed"), { code: 'CHANNEL_NOT_ALLOWED' });
      return {
        ready: true,
        shares: [
          ownedShare('anthropic', [member], [pending('req-1')]),
          ownedShare('acp-plugin:demo:engine', [member], []),
          ownedShare('link-only', [], []),
        ],
      };
    },
  });
  render(<ProviderSharesScreen />);

  const row = await screen.findByTestId('providerShares.share.share-anthropic');
  expect(row.textContent).toBe('Anthropic | providerShare.manage.list.pendingCount');
  // 插件提供的供应商与只生成过链接的不列；每台读得到的电脑都能从这里分享其他供应商。
  expect(screen.queryByTestId('providerShares.share.share-acp-plugin:demo:engine')).toBeNull();
  expect(screen.queryByTestId('providerShares.share.share-link-only')).toBeNull();
  expect(screen.getByTestId('providerShares.shareOther.studio')).toBeDefined();
  // 没读到的电脑不摆点不了的行，原因写在下面。
  expect(screen.queryByTestId('providerShares.computer.macbook')).toBeNull();
  expect(screen.getByTestId('providerShares.unreachable').textContent).toBe('providerShare.manage.list.unreachable');
  expect((await screen.findByTestId('providerShares.outdated')).textContent).toBe('providerShare.manage.list.needsUpdate');
  expect(mocks.invoke.mock.calls.some(([deviceId]) => deviceId === 'macbook')).toBe(false);

  fireEvent.click(row);
  expect(mocks.push).toHaveBeenCalledWith({
    pathname: '/provider-shares/detail',
    params: { deviceId: 'studio', deviceName: 'Mac Studio', providerId: 'anthropic', label: 'Anthropic' },
  });
});
