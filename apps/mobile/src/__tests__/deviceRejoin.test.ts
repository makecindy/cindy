/**
 * 测试价值
 * - 生产入口与可观察结果：deviceRejoin.ts 的 rejoinRemovedMobileDevice（DeviceLinkProvider 注册的处理函数原样调用它）与
 *   runMobileDeviceRejoin（横幅按钮的 onPress）：请求顺序、是否重建本机连接、Agent-Net 是否重新尝试，以及给用户的提示。
 * - 依据：2026-11-23 用户定「被移除的设备点『重新加入』就回来」；旧服务端／旧中转要如实提示，不静默失败。
 * - 现有覆盖缺口：新功能，之前没有任何恢复路径。
 * - 最小失败输入：旧 Device Link 服务回 404；旧中转对 rejoin 仍回 403 DEVICE_REENROLLMENT_REQUIRES_APPROVAL；连点两次。
 * - tier：unit（端口是内存 fake，Alert 只记录调用；无网络、无真实等待）。
 *
 * 打开 Agent-Net 开关时的重新加入（prepareMobileAgentNetEnable，AgentNetSettingsGroup 原样调用它；rejoinMobileDeviceForAgentNet）：
 * - 可观察结果：开关是否打开（resolve／reject）、是否发起一次「重新加入」、失败时给的提示。
 * - 依据：2026-11-26 用户定「被删后要能重新加入」；现场是被移除后重新登录的手机，打开开关时 `/directory` 回
 *   401 DEVICE_REVOKED，被本地旧名单吞掉，开关打开却拿作废证书连，电脑一台都连不上。
 * - 现有覆盖缺口：开关的准备步骤此前没有测试；离线兜底与「服务端说已移除」没有区分。
 * - 最小失败输入：`/directory` 抛 `{ status: 401, code: 'DEVICE_REVOKED' }`，本机有未过期名单——修复前直接打开、不重新加入；
 *   账号设备列表里没有这台手机——修复前照样打开，同账号的电脑在 Agent-Net 上都拦它，手机干等。
 */
import { afterEach, expect, it, vi } from 'vitest';

const alert = vi.hoisted(() => vi.fn());
vi.mock('react-native', () => ({ Alert: { alert } }));

import { ApiError } from '@/api/client';
import { setActiveSelfHostedRelay } from '@/device-link/selfHostedRelayRouting';
import {
  MobileDeviceRejoinError,
  canRejoinRemovedMobileDevice,
  mobileAgentNetEnableFailureKey,
  prepareMobileAgentNetEnable,
  registerMobileDeviceRejoin,
  rejoinMobileDeviceForAgentNet,
  rejoinRemovedMobileDevice,
  runMobileDeviceRejoin,
  type MobileDeviceRejoinPorts,
  type MobileDeviceRejoinResult,
} from '@/device-link/deviceRejoin';
import { i18n } from '@/i18n';

afterEach(() => { alert.mockReset(); setActiveSelfHostedRelay(null); });

const revocationKept = () => Object.assign(new Error('DEVICE_REENROLLMENT_REQUIRES_APPROVAL'),
  { status: 403, code: 'DEVICE_REENROLLMENT_REQUIRES_APPROVAL' });

function ports(overrides: Partial<MobileDeviceRejoinPorts> & { involved?: boolean; required?: boolean } = {}) {
  const calls: string[] = [];
  const value: MobileDeviceRejoinPorts = {
    rejoinDeviceLink: async () => { calls.push('device-link'); },
    agentNetInvolved: async () => overrides.involved ?? true,
    agentNetRequired: () => overrides.required ?? false,
    rejoinAgentNet: async () => { calls.push('agent-net'); },
    clearAgentNetRefusal: () => { calls.push('clear-refusal'); },
    restartConnection: () => { calls.push('restart'); },
    ...overrides,
  };
  return { calls, value };
}

it.each([
  { name: 'Agent-Net in use', involved: true, result: 'rejoined',
    calls: ['device-link', 'agent-net', 'clear-refusal', 'restart'] },
  { name: 'Agent-Net never used on this phone', involved: false, result: 'not-used', calls: ['device-link', 'restart'] },
  // Old relay: Device Link is back, the refusal stays so the rebuilt connection goes straight to Device Link.
  { name: 'relay that predates rejoin', involved: true, refuse: true, result: 'unavailable',
    calls: ['device-link', 'restart'] },
])('rejoins Device Link first, then Agent-Net, and rebuilds once: $name', async ({ involved, refuse, result, calls }) => {
  const fake = ports({ involved, ...(refuse ? { rejoinAgentNet: async () => { throw revocationKept(); } } : {}) });
  await expect(rejoinRemovedMobileDevice(fake.value)).resolves.toEqual({ agentNet: result });
  expect(fake.calls).toEqual(calls);
});

it('reports an old Device Link service and an Agent-Net-only phone on an old relay instead of failing silently', async () => {
  const oldService = ports({ rejoinDeviceLink: async () => { throw new ApiError('NOT_FOUND', 404, 'Not found'); } });
  await expect(rejoinRemovedMobileDevice(oldService.value)).rejects.toMatchObject({ code: 'DEVICE_REJOIN_UNSUPPORTED' });
  expect(oldService.calls).toEqual([]); // Nothing changed on the service: no Agent-Net attempt, no rebuild.

  const onlyEncrypted = ports({ required: true, rejoinAgentNet: async () => { throw revocationKept(); } });
  await expect(rejoinRemovedMobileDevice(onlyEncrypted.value)).rejects.toBeInstanceOf(MobileDeviceRejoinError);
  expect(onlyEncrypted.calls).toEqual(['device-link', 'restart']);
});

it('runs one attempt per tap and tells the person why it failed', async () => {
  await i18n.changeLanguage('zh-CN');
  let finish!: () => void;
  const handler = vi.fn(() => new Promise<{ agentNet: 'rejoined' }>((resolve) => { finish = () => resolve({ agentNet: 'rejoined' }); }));
  const dispose = registerMobileDeviceRejoin(handler);
  try {
    const first = runMobileDeviceRejoin();
    await runMobileDeviceRejoin(); // A second tap while the first runs does nothing.
    finish(); await first;
    expect(handler).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();

    handler.mockImplementationOnce(() => Promise.reject(new MobileDeviceRejoinError('DEVICE_REJOIN_UNSUPPORTED')));
    await runMobileDeviceRejoin();
    expect(alert).toHaveBeenCalledWith(i18n.t('deviceLink.rejoin.failedTitle'), i18n.t('deviceLink.rejoin.unsupported'));
  } finally { dispose(); }
});

it('offers rejoin only for this phone’s removal on the official network', () => {
  const removed = { kind: 'device-removed' as const, at: 0 };
  expect(canRejoinRemovedMobileDevice(removed)).toBe(true);
  expect(canRejoinRemovedMobileDevice({ kind: 'auth-failed', at: 0 })).toBe(false);
  // A self-hosted relay's 4410 means its owner removed the phone or retired the relay: re-pairing, not rejoin.
  setActiveSelfHostedRelay({ relayId: 'relay-1', name: 'Home', baseUrl: 'https://relay.example.test', credential: 'relay-credential', signing: null });
  expect(canRejoinRemovedMobileDevice(removed)).toBe(false);
});

const revoked = () => Object.assign(new Error('DEVICE_REVOKED'), { status: 401, code: 'DEVICE_REVOKED' });
const offline = () => Object.assign(new Error('AGENT_NET_NETWORK_ERROR'), { status: 0, code: 'AGENT_NET_NETWORK_ERROR' });

function enablePorts(input: { identity?: unknown[]; directory?: unknown[]; official?: boolean; listed?: boolean | null;
  rejoin?: MobileDeviceRejoinResult['agentNet'] }) {
  const calls: string[] = [];
  const identityFailures = [...(input.identity ?? [])], directoryFailures = [...(input.directory ?? [])];
  const step = (name: string, failures: unknown[]) => { calls.push(name); const failure = failures.shift(); if (failure) throw failure; };
  return {
    calls,
    value: {
      identity: async () => { step('identity', identityFailures); return 'identity'; },
      refreshDirectory: async () => { step('directory', directoryFailures); },
      hasLocalDirectory: async () => { calls.push('local-roster'); return true; },
      official: () => input.official ?? true,
      listed: async () => { calls.push('listed'); return input.listed === undefined ? true : input.listed; },
      rejoin: async () => { calls.push('rejoin'); return { agentNet: input.rejoin ?? 'rejoined' }; },
    },
  };
}

it.each([
  // The field case: removed, signed in again, switch turned on. Device Link is back, but the account's device list does not
  // have the phone (every computer refuses it on Agent-Net) and its certificate may be revoked: either way it rejoins first.
  { name: 'the account device list does not have this phone', listed: false as const, calls: ['listed', 'rejoin', 'identity', 'directory'] },
  // The stored roster used to swallow this answer.
  { name: 'the roster says this phone was removed', directory: [revoked()],
    calls: ['listed', 'identity', 'directory', 'rejoin', 'identity', 'directory'] },
  { name: 'renewing the certificate says it was removed', identity: [revoked()],
    calls: ['listed', 'identity', 'rejoin', 'identity', 'directory'] },
  // Offline is not a removal: an unread list, or the stored roster, still lets the switch go on without asking to rejoin.
  { name: 'the device list cannot be read', listed: null, calls: ['listed', 'identity', 'directory'] },
  { name: 'offline with a stored roster', directory: [offline()], calls: ['listed', 'identity', 'directory', 'local-roster'] },
])('turning Agent-Net on: $name', async ({ identity, directory, listed, calls }) => {
  const fake = enablePorts({ identity, directory, listed });
  await expect(prepareMobileAgentNetEnable(fake.value)).resolves.toBeUndefined();
  expect(fake.calls).toEqual(calls);
});

it('keeps the switch off with the reason when a removed phone cannot come back on Agent-Net', async () => {
  await i18n.changeLanguage('zh-CN');
  const oldRelay = enablePorts({ directory: [revoked()], rejoin: 'unavailable' });
  const failure = await prepareMobileAgentNetEnable(oldRelay.value).catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: 'AGENT_NET_REJOIN_UNAVAILABLE' });
  expect(i18n.t(mobileAgentNetEnableFailureKey(failure))).toBe(i18n.t('deviceLink.rejoin.agentNetUnavailable'));

  // A self-hosted relay re-pairs instead: no official list or rejoin, the switch stays off.
  const relay = enablePorts({ directory: [revoked()], official: false, listed: false });
  await expect(prepareMobileAgentNetEnable(relay.value)).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
  expect(relay.calls).toEqual(['identity', 'directory']);
});

it('rejoins Agent-Net from the switch through the banner’s handler, one attempt at a time', async () => {
  let finish!: () => void;
  const handler = vi.fn((_options?: { agentNet?: boolean }) =>
    new Promise<MobileDeviceRejoinResult>((resolve) => { finish = () => resolve({ agentNet: 'rejoined' }); }));
  const dispose = registerMobileDeviceRejoin(handler);
  try {
    const first = rejoinMobileDeviceForAgentNet();
    // The switch still reads off, so the handler is told Agent-Net is involved.
    expect(handler).toHaveBeenCalledWith({ agentNet: true });
    await expect(rejoinMobileDeviceForAgentNet()).rejects.toThrow('DEVICE_REJOIN_BUSY');
    finish();
    await expect(first).resolves.toEqual({ agentNet: 'rejoined' });
  } finally { dispose(); }
  await expect(rejoinMobileDeviceForAgentNet()).rejects.toThrow('DEVICE_REJOIN_UNAVAILABLE');
});
