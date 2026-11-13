import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ os: 'web' }));
const secureStore = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: { get OS() { return platform.os; } } }));
vi.mock('expo-secure-store', () => secureStore);

describe('secureStorage', () => {
  const webItems = new Map<string, string>();

  beforeEach(() => {
    platform.os = 'web';
    secureStore.getItemAsync.mockReset();
    secureStore.setItemAsync.mockReset();
    secureStore.deleteItemAsync.mockReset();
    webItems.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => webItems.get(key) ?? null,
      setItem: (key: string, value: string) => webItems.set(key, value),
      removeItem: (key: string) => webItems.delete(key),
    });
  });

  it('uses web storage on web previews', async () => {
    const { deleteSecureItem, getSecureItem, setSecureItem } = await import('@/auth/secureStorage');

    await setSecureItem('k', 'v');
    await expect(getSecureItem('k')).resolves.toBe('v');
    await deleteSecureItem('k');
    await expect(getSecureItem('k')).resolves.toBeNull();
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('uses SecureStore on native platforms', async () => {
    platform.os = 'ios';
    secureStore.getItemAsync.mockResolvedValue('native-value');
    const { deleteSecureItem, getSecureItem, setSecureItem } = await import('@/auth/secureStorage');

    await expect(getSecureItem('k')).resolves.toBe('native-value');
    await setSecureItem('k', 'v');
    await deleteSecureItem('k');

    expect(secureStore.setItemAsync).toHaveBeenCalledWith('k', 'v');
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith('k');
  });

  // 登录凭证要在锁屏时可续期(通知按钮从后台把结果送到电脑)，其余条目保持「解锁时可读」。
  // 写错档位的后果:要么锁屏时续期失败、按钮点了送不出去，要么把不该放宽的条目放宽。
  it('stores only login credentials readable after first unlock', async () => {
    platform.os = 'ios';
    const store = secureStore as typeof secureStore & Record<string, unknown>;
    store.AFTER_FIRST_UNLOCK = 'after-first-unlock';
    store.WHEN_UNLOCKED_THIS_DEVICE_ONLY = 'this-device';
    const { setSecureItem } = await import('@/auth/secureStorage');

    await setSecureItem('login', 'v', { whileLocked: true });
    await setSecureItem('key', 'v', { thisDeviceOnly: true });

    expect(secureStore.setItemAsync).toHaveBeenNthCalledWith(1, 'login', 'v', { keychainAccessible: 'after-first-unlock' });
    expect(secureStore.setItemAsync).toHaveBeenNthCalledWith(2, 'key', 'v', { keychainAccessible: 'this-device' });
  });
});
