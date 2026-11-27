import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ module: null as any, load: vi.fn() }));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: (name: string) => { mocks.load(name); return mocks.module; } }));
import { readIosPushEnvironment } from '@/notifications/nativePushEnvironment';

describe('native APNs signing environment', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.module = null; });
  it.each(['development', 'production'])('reads %s from the installed native profile', async environment => {
    mocks.module = { getPushNotificationServiceEnvironmentAsync: vi.fn().mockResolvedValue(environment) };
    expect(await readIosPushEnvironment()).toBe(environment);
    expect(mocks.load).toHaveBeenCalledWith('ExpoApplication');
  });
  it('preserves App Store production signing when re-signing removes the embedded profile', async () => {
    mocks.module = { getPushNotificationServiceEnvironmentAsync: async () => null, getApplicationReleaseTypeAsync: async () => 5 };
    expect(await readIosPushEnvironment()).toBe('production');
  });
  it.each([0, 1, 2, 3, 4])('does not guess production for a missing profile of release type %s', async release => {
    mocks.module = { getPushNotificationServiceEnvironmentAsync: async () => null, getApplicationReleaseTypeAsync: async () => release };
    expect(await readIosPushEnvironment()).toBeNull();
  });
  it('reports missing native support and read failures', async () => {
    await expect(readIosPushEnvironment()).rejects.toThrow('cannot read');
    mocks.module = { getPushNotificationServiceEnvironmentAsync: async () => { throw Error('profile read failed'); } };
    await expect(readIosPushEnvironment()).rejects.toThrow('profile read failed');
  });
});
