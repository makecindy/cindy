/**
 * 测试价值
 * - 生产入口与可观察结果：LocalNetworkAccessService.read/request、parseLocalNetworkRequestOptions、
 *   readMacLanGateway 与 LocalNetworkReminderState；设置页和侧边栏提醒看到的 granted / denied / unknown、
 *   默认 request 只触发系统弹窗而不抢焦点跳系统设置、显式打开系统设置及其新窗口回退，以及侧边栏何时提醒。
 * - Bug／规则依据：2026-11-22 两台同局域网 Mac 的个人版都没有本地网络许可，直连长期退回中转；
 *   2026-11-26 macOS 27.3 实测确认 1.2 秒后强跳系统设置会顶掉原生授权弹窗，改为显式两步打开并支持新窗口重试。
 *   见 docs/dev-rules/remote-and-mobile-adaptation.md「macOS「本地网络」权限」。
 * - 现有覆盖缺口：此前单测假定 request() 1.2 秒后自动打开系统设置，未覆盖不抢焦点、显式打开、新窗口回退与参数校验。
 * - 最小失败输入：网关探测返回 EHOSTUNREACH；默认路由落在 utun（VPN）上；显式 openSettings 首次普通打开、二次新窗口及新窗口报错回退；非法 IPC 参数。
 * - tier：unit，全部依赖注入，无真实网络与等待。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  LocalNetworkAccessService,
  classifyLocalNetworkProbe,
  parseLocalNetworkRequestOptions,
  readMacLanGateway,
  type LocalNetworkAccessDeps,
  type LocalNetworkConnectOutcome,
} from '../access';
import { LocalNetworkReminderState } from '../reminder';

function service(outcomes: LocalNetworkConnectOutcome[], overrides: Partial<LocalNetworkAccessDeps> = {}) {
  let clock = 0;
  const openSettings = vi.fn<(separateWindow: boolean) => Promise<void>>(async () => {});
  const connect = vi.fn(async () => outcomes.shift() ?? 'other');
  const deps: LocalNetworkAccessDeps = {
    platform: 'darwin',
    lanGateway: async () => '192.168.68.1',
    connect,
    openSettings,
    wait: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    ...overrides,
  };
  return { access: new LocalNetworkAccessService(deps), openSettings, connect, advance: (ms: number) => (clock += ms) };
}

describe('local network access', () => {
  it.each([
    ['hostUnreachable', 'denied'],
    ['refused', 'granted'],
    ['connected', 'granted'],
    ['timeout', 'granted'],
    ['other', 'unknown'],
    [null, 'unknown'],
  ] as const)('classifies a %s gateway probe as %s', (outcome, expected) => {
    expect(classifyLocalNetworkProbe(outcome)).toBe(expected);
  });

  it('validates local-network request IPC options strictly', () => {
    expect(parseLocalNetworkRequestOptions(undefined)).toEqual({});
    expect(parseLocalNetworkRequestOptions({ openSettings: true })).toEqual({ openSettings: true });
    expect(parseLocalNetworkRequestOptions({ openSettings: true, separateWindow: true })).toEqual({
      openSettings: true,
      separateWindow: true,
    });
    expect(parseLocalNetworkRequestOptions(null)).toBeNull();
    expect(parseLocalNetworkRequestOptions([])).toBeNull();
    expect(parseLocalNetworkRequestOptions({ openSettings: 'yes' })).toBeNull();
    expect(parseLocalNetworkRequestOptions({ extra: true })).toBeNull();
  });

  it('reports unknown without a LAN gateway and notRequired off macOS', async () => {
    expect(await service([], { lanGateway: async () => null }).access.read()).toBe('unknown');
    const windows = service(['hostUnreachable'], { platform: 'win32' });
    expect(await windows.access.read()).toBe('notRequired');
    expect(await windows.access.request()).toBe('notRequired');
    expect(windows.connect).not.toHaveBeenCalled();
  });

  it('triggers the OS prompt without yanking focus to System Settings until explicitly requested', async () => {
    const answered = service(['hostUnreachable', 'refused']);
    expect(await answered.access.request()).toBe('granted');
    expect(answered.openSettings).not.toHaveBeenCalled();
    expect(answered.access.settingsOpenStage).toBe('none');

    const decided = service(['hostUnreachable', 'hostUnreachable']);
    expect(await decided.access.request()).toBe('denied');
    expect(decided.openSettings).not.toHaveBeenCalled();
    expect(decided.access.settingsOpenStage).toBe('none');

    const alreadyAllowed = service(['refused']);
    expect(await alreadyAllowed.access.request()).toBe('granted');
    expect(alreadyAllowed.connect).toHaveBeenCalledTimes(1);
    expect(alreadyAllowed.openSettings).not.toHaveBeenCalled();
  });

  it('opens System Settings on explicit request, retries in a separate window, and resets on grant', async () => {
    const { access, openSettings } = service(['hostUnreachable', 'hostUnreachable', 'refused']);
    expect(await access.request({ openSettings: true })).toBe('denied');
    expect(openSettings).toHaveBeenNthCalledWith(1, false);
    expect(access.settingsOpenStage).toBe('standard');

    // Second explicit open uses a separate System Settings window to bypass stuck panes.
    expect(await access.request({ openSettings: true })).toBe('denied');
    expect(openSettings).toHaveBeenNthCalledWith(2, true);
    expect(access.settingsOpenStage).toBe('separate');

    // Grant clears settingsOpenStage without opening System Settings again.
    expect(await access.request({ openSettings: true })).toBe('granted');
    expect(openSettings).toHaveBeenCalledTimes(2);
    expect(access.settingsOpenStage).toBe('none');
  });

  it('falls back to the standard System Settings window if launching a separate window fails', async () => {
    const calls: boolean[] = [];
    const { access } = service(['hostUnreachable', 'hostUnreachable'], {
      openSettings: async (separate) => {
        calls.push(separate);
        if (separate) throw new Error('open -n refused');
      },
    });
    expect(await access.request({ openSettings: true })).toBe('denied');
    expect(await access.request({ openSettings: true, separateWindow: true })).toBe('denied');
    expect(calls).toEqual([false, true, false]);
  });

  it('notifies listeners once per change so a grant can restart direct connections', async () => {
    const { access, advance } = service(['hostUnreachable', 'hostUnreachable', 'refused']);
    const changes: Array<[string, string | null]> = [];
    access.onChange((next, previous) => changes.push([next, previous]));
    await access.read();
    advance(2000);
    await access.read();
    advance(2000);
    await access.read();
    expect(changes).toEqual([
      ['denied', null],
      ['granted', 'denied'],
    ]);
  });

  it('finds the LAN gateway when the default route belongs to a VPN', async () => {
    const route = vi.fn(async (args: string[]) =>
      args[0] === '-ifscope' && args[1] === 'en0'
        ? '   gateway: 192.168.68.1\n interface: en0\n'
        : args.length === 0
          ? '   gateway: 100.64.0.1\n interface: utun4\n'
          : '',
    );
    const interfaces = () => ({
      lo0: [{ family: 'IPv4', internal: true }],
      utun4: [{ family: 'IPv4', internal: false }],
      en0: [{ family: 'IPv4', internal: false }],
    }) as never;
    expect(await readMacLanGateway(route, interfaces)).toBe('192.168.68.1');
    expect(await readMacLanGateway(async () => '   gateway: 10.0.0.1\n interface: en1\n', interfaces)).toBe('10.0.0.1');
    expect(await readMacLanGateway(async () => '', () => ({}))).toBeNull();
  });

  it('reminds only while denied, and only when control was just enabled or peers are stuck on the relay', () => {
    let clock = 0;
    const state = new LocalNetworkReminderState({ now: () => clock });
    expect(state.current('denied')).toBeNull();

    expect(state.relayOnly(['phone', 'studio', 'phone'])).toBe(true);
    expect(state.current('denied')).toEqual({ reason: 'relayOnly', deviceIds: ['phone', 'studio'] });
    expect(state.current('granted')).toBeNull();
    expect(state.relayOnly(['studio', 'phone'])).toBe(false);
    clock += 30_000;
    expect(state.relayOnly(['studio'])).toBe(true);
    expect(state.relayOnly(['studio', 'mini'])).toBe(true);
    expect(state.relayOnly([])).toBe(false);
    expect(state.current('denied')).toBeNull();

    state.controlEnabled();
    expect(state.current('denied')).toEqual({ reason: 'controlEnabled', at: clock, deviceIds: [] });
    // The owner re-publishes at this moment; without it the card would never leave (review r4655121852).
    expect(state.controlExpiresAt()).toBe(clock + 10 * 60_000);
    clock += 10 * 60_000;
    expect(state.current('denied')).toBeNull();
    expect(state.controlExpiresAt()).toBeNull();
  });

  it('carries the relay-only devices on the control reminder so one dismissal covers both', () => {
    let clock = 0;
    const state = new LocalNetworkReminderState({ now: () => clock });
    state.relayOnly(['studio']);
    state.controlEnabled();
    expect(state.current('denied')).toEqual({ reason: 'controlEnabled', at: 0, deviceIds: ['studio'] });
    clock += 10 * 60_000;
    expect(state.current('denied')).toEqual({ reason: 'relayOnly', deviceIds: ['studio'] });
  });
});
