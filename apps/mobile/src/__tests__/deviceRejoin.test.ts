/**
 * 测试价值
 * - 生产入口与可观察结果：deviceRejoin.ts 的 rejoinRemovedMobileDevice（DeviceLinkProvider 注册的处理函数原样调用它）与
 *   runMobileDeviceRejoin（横幅按钮的 onPress）：请求顺序、是否重建本机连接、Agent-Net 是否重新尝试，以及给用户的提示。
 * - 依据：2026-11-23 用户定「被移除的设备点『重新加入』就回来」；旧服务端／旧中转要如实提示，不静默失败。
 * - 现有覆盖缺口：新功能，之前没有任何恢复路径。
 * - 最小失败输入：旧 Device Link 服务回 404；旧中转对 rejoin 仍回 403 DEVICE_REENROLLMENT_REQUIRES_APPROVAL；连点两次。
 * - tier：unit（端口是内存 fake，Alert 只记录调用；无网络、无真实等待）。
 */
import { afterEach, expect, it, vi } from 'vitest';

const alert = vi.hoisted(() => vi.fn());
vi.mock('react-native', () => ({ Alert: { alert } }));

import { ApiError } from '@/api/client';
import { setActiveSelfHostedRelay } from '@/device-link/selfHostedRelayRouting';
import {
  MobileDeviceRejoinError,
  canRejoinRemovedMobileDevice,
  registerMobileDeviceRejoin,
  rejoinRemovedMobileDevice,
  runMobileDeviceRejoin,
  type MobileDeviceRejoinPorts,
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
