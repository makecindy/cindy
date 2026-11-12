import { afterEach, expect, it, vi } from 'vitest';
vi.mock('expo-application', () => ({ nativeApplicationVersion: '0.1.99', nativeBuildVersion: '123' }));
vi.mock('expo-updates', () => ({ updateId: '12345678-1234-1234-1234-123456789abc', runtimeVersion: 'abc123', isEmbeddedLaunch: false }));
import { mobileRuntimeIdentity } from './mobileRuntimeIdentity';

afterEach(() => vi.unstubAllEnvs());
it('reads native binary metadata without relying on removed Constants fields', () => {
  vi.stubEnv('EXPO_PUBLIC_XDT_GIT_COMMIT', 'abcdef123456');
  expect(mobileRuntimeIdentity()).toEqual({ commit: 'abcdef123456', version: '0.1.99', build: '123',
    updateId: '12345678-1234-1234-1234-123456789abc', runtimeVersion: 'abc123', embedded: false });
  vi.stubEnv('EXPO_PUBLIC_XDT_GIT_COMMIT', 'not-a-commit');
  expect(mobileRuntimeIdentity().commit).toBe('unknown');
});
