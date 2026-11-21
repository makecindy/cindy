/**
 * 测试价值
 * - 生产入口与可观察结果：LocalNetworkAccessService.read/request、readMacLanGateway 与 LocalNetworkReminderState；设置页和侧边栏提醒看到的
 *   granted / denied / unknown，只有系统已拒绝时才打开系统设置，以及侧边栏何时提醒。
 * - Bug／规则依据：2026-11-22 两台同局域网 Mac 的个人版都没有本地网络许可，直连长期退回中转；
 *   docs/dev-rules/remote-and-mobile-adaptation.md「macOS「本地网络」权限」。
 * - 现有覆盖缺口：此前没有任何本地网络许可检测。
 * - 最小失败输入：网关探测返回 EHOSTUNREACH；默认路由落在 utun（VPN）上；首次探测拒绝但系统询问后放行。
 * - tier：unit，全部依赖注入，无真实网络与等待。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  LocalNetworkAccessService,
  classifyLocalNetworkProbe,
  readMacLanGateway,
  type LocalNetworkAccessDeps,
  type LocalNetworkConnectOutcome,
} from '../access';
import { LocalNetworkReminderState } from '../reminder';

function service(outcomes: LocalNetworkConnectOutcome[], overrides: Partial<LocalNetworkAccessDeps> = {}) {
  let clock = 0;
  const openSettings = vi.fn(async () => {});
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

  it('reports unknown without a LAN gateway and notRequired off macOS', async () => {
    expect(await service([], { lanGateway: async () => null }).access.read()).toBe('unknown');
    const windows = service(['hostUnreachable'], { platform: 'win32' });
    expect(await windows.access.read()).toBe('notRequired');
    expect(await windows.access.request()).toBe('notRequired');
    expect(windows.connect).not.toHaveBeenCalled();
  });

  it('opens System Settings only when access is still denied after the prompt window', async () => {
    const answered = service(['hostUnreachable', 'refused']);
    expect(await answered.access.request()).toBe('granted');
    expect(answered.openSettings).not.toHaveBeenCalled();

    const decided = service(['hostUnreachable', 'hostUnreachable']);
    expect(await decided.access.request()).toBe('denied');
    expect(decided.openSettings).toHaveBeenCalledTimes(1);

    const alreadyAllowed = service(['refused']);
    expect(await alreadyAllowed.access.request()).toBe('granted');
    expect(alreadyAllowed.connect).toHaveBeenCalledTimes(1);
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
