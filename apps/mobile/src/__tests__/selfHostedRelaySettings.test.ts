/**
 * 测试价值
 * - 生产入口与结果：saveSelfHostedRelay / clearSelfHostedRelay 切换后保留成员配置和安全凭证，
 *   重新加载账号后可继续使用；forgetSelfHostedRelay 才撤销成员资格。
 * - Bug：手机切回官方中转会删除加入信息，电脑端切换则保留。
 * - 覆盖缺口：selfHostedRelaySignatures 只测签名与路由，不覆盖持久化及退出请求。
 * - 最小失败输入：加入一次后切回官方；旧实现删除配置并发送 DELETE。
 * - tier：unit，内存存储替身；不读取真实凭证、不访问网络。
 * - 实测耗时：单独运行 2.29 秒，用例执行 21ms（Windows，pnpm --filter mobile exec vitest run 此文件）。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  config: new Map<string, string>(),
  secrets: new Map<string, string>(),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.config.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.config.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      storage.config.delete(key);
    }),
  },
}));
vi.mock('@/auth/secureStorage', () => ({
  getSecureItem: vi.fn(async (key: string) => storage.secrets.get(key) ?? null),
  setSecureItem: vi.fn(async (key: string, value: string) => {
    storage.secrets.set(key, value);
  }),
  deleteSecureItem: vi.fn(async (key: string) => {
    storage.secrets.delete(key);
  }),
}));
vi.mock('@/debug/mobileDebugLog', () => ({ mobileDebugLog: vi.fn() }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getMobileAuthOwner, setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import * as settings from '@/device-link/selfHostedRelay';
import {
  __testing as routingTesting,
  getActiveSelfHostedRelay,
  selfHostedRelayAuthorizationFor,
  waitForSelfHostedRelayRoute,
} from '@/device-link/selfHostedRelayRouting';

async function join(relayId = 'test-relay') {
  await settings.saveSelfHostedRelay({
    owner: getMobileAuthOwner(),
    relayId,
    name: 'Test relay',
    baseUrl: 'https://relay.example.invalid',
    deviceId: 'test-phone',
    ownerPublicKey: 'A'.repeat(43),
    credential: 'fake-test-credential',
    seed: 'A'.repeat(43),
  });
}

beforeEach(async () => {
  setMobileAuthOwner(null);
  storage.config.clear();
  storage.secrets.clear();
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
  setMobileAuthOwner('test-account');
  await waitForSelfHostedRelayRoute();
});
afterEach(() => {
  setMobileAuthOwner(null);
  vi.unstubAllGlobals();
});

it('keeps membership and credentials when switching to official, including after account rehydration', async () => {
  await join();
  const credentials = [...storage.secrets.values()];
  await settings.clearSelfHostedRelay();
  expect(getActiveSelfHostedRelay()).toBeNull();
  expect([...storage.config.values()]).toHaveLength(1);
  expect([...storage.secrets.values()]).toEqual(credentials);
  expect(fetch).not.toHaveBeenCalled();
  setMobileAuthOwner(null);
  routingTesting.reset();
  setMobileAuthOwner('test-account');
  await waitForSelfHostedRelayRoute();
  expect(getActiveSelfHostedRelay()).toBeNull();
  expect(selfHostedRelayAuthorizationFor('https://relay.example.invalid')).toEqual({
    kind: 'blocked',
  });
  await settings.resumeSelfHostedRelay();
  expect(getActiveSelfHostedRelay()?.credential).toBe('fake-test-credential');
});

it.each([false, true])('only explicit removal leaves the relay (official=%s)', async (official) => {
  await join();
  if (official) await settings.clearSelfHostedRelay();
  await settings.forgetSelfHostedRelay();
  expect(storage.config.size).toBe(0);
  expect(storage.secrets.size).toBe(0);
  expect(getActiveSelfHostedRelay()).toBeNull();
  expect(fetch).toHaveBeenCalledWith(
    'https://relay.example.invalid/api/device-link/devices/test-phone',
    expect.objectContaining({ method: 'DELETE' }),
  );
});

it('keeps the selected route if persisting the switch fails', async () => {
  await join();
  vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk full'));
  await expect(settings.clearSelfHostedRelay()).rejects.toThrow('disk full');
  expect(getActiveSelfHostedRelay()?.relayId).toBe('test-relay');
  expect(storage.secrets.size).toBe(1);
});

it('cannot resume another account’s relay or switch to one with missing credentials', async () => {
  await join();
  await settings.clearSelfHostedRelay();
  setMobileAuthOwner('other-account');
  await waitForSelfHostedRelayRoute();
  await expect(settings.resumeSelfHostedRelay()).rejects.toThrow();
  expect(getActiveSelfHostedRelay()).toBeNull();
  setMobileAuthOwner('test-account');
  await waitForSelfHostedRelayRoute();
  storage.secrets.clear();
  await expect(settings.resumeSelfHostedRelay()).rejects.toThrow('RELAY_CREDENTIAL_MISSING');
  expect(getActiveSelfHostedRelay()).toBeNull();
  expect(storage.config.size).toBe(1);
});

it('restores the saved credentials if joining a different relay cannot save its config', async () => {
  await join();
  await settings.clearSelfHostedRelay();
  const previousSecrets = [...storage.secrets.values()];
  vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk full'));
  await expect(
    settings.saveSelfHostedRelay({
      owner: getMobileAuthOwner(),
      relayId: 'replacement',
      name: 'Other relay',
      baseUrl: 'https://other.example.invalid',
      deviceId: 'test-phone',
      ownerPublicKey: 'A'.repeat(43),
      credential: 'different-fake-credential',
      seed: 'B'.repeat(43),
    }),
  ).rejects.toThrow('disk full');
  expect([...storage.secrets.values()]).toEqual(previousSecrets);
  await settings.resumeSelfHostedRelay();
  expect(getActiveSelfHostedRelay()?.relayId).toBe('test-relay');
  expect(fetch).not.toHaveBeenCalled();
});

it('does not apply a late switch from a previous account to the current account', async () => {
  await join();
  let finishWrite!: () => void;
  vi.mocked(AsyncStorage.setItem).mockImplementationOnce(
    (key, value) =>
      new Promise<void>((resolve) => {
        finishWrite = () => {
          storage.config.set(key, value);
          resolve();
        };
      }),
  );
  const switching = settings.clearSelfHostedRelay();
  setMobileAuthOwner('other-account');
  await waitForSelfHostedRelayRoute();
  await join('other-relay');
  finishWrite();
  await switching;
  expect(getActiveSelfHostedRelay()?.relayId).toBe('other-relay');
});
