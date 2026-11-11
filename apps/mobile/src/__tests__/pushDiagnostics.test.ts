import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ permission: vi.fn(), token: vi.fn(), environment: vi.fn() }));
vi.mock('expo-notifications', () => ({ getPermissionsAsync: mocks.permission, getDevicePushTokenAsync: mocks.token, IosAuthorizationStatus: { PROVISIONAL: 3 } }));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => ({ applicationId: 'com.example.app', nativeBuildVersion: '42' }) }));
vi.mock('@/notifications/nativePushEnvironment', () => ({ readIosPushEnvironment: mocks.environment }));
import { readIosPushDiagnostic } from '@/notifications/pushDiagnostics';
const permission = { status: 'granted', ios: { status: 2, allowsAlert: true, allowsDisplayOnLockScreen: false, allowsDisplayInNotificationCenter: true } };
beforeEach(() => { vi.resetAllMocks(); mocks.permission.mockResolvedValue(permission); mocks.environment.mockResolvedValue('development'); mocks.token.mockResolvedValue({ type: 'ios', data: 'a'.repeat(64) }); });
describe('explicit push diagnostics', () => {
  it('reads signed environment, actual identity and notification permissions', async () => {
    expect(await readIosPushDiagnostic(() => true)).toEqual({ bundleId: 'com.example.app', build: '42', environment: 'development', permission: 'granted', alerts: true, lockScreen: false, notificationCenter: true, token: 'a'.repeat(64) });
    expect(mocks.token).toHaveBeenCalledTimes(1);
  });
  it('does not read a token when notifications are denied', async () => {
    mocks.permission.mockResolvedValue({ status: 'denied' });
    expect(await readIosPushDiagnostic(() => true)).toMatchObject({ permission: 'denied', token: null, alerts: null });
    expect(mocks.token).not.toHaveBeenCalled();
  });
  it('preserves provisional authorization and production signing', async () => {
    mocks.permission.mockResolvedValue({ ...permission, ios: { ...permission.ios, status: 3 } });
    mocks.environment.mockResolvedValue('production');
    expect(await readIosPushDiagnostic(() => true)).toMatchObject({ permission: 'provisional', environment: 'production' });
  });
  it('does nothing after the screen has already left', async () => {
    expect(await readIosPushDiagnostic(() => false)).toBeNull(); expect(mocks.permission).not.toHaveBeenCalled();
  });
  it('stops between permission and token reads when backgrounded', async () => {
    let current = true; mocks.permission.mockImplementation(async () => { current = false; return permission; });
    expect(await readIosPushDiagnostic(() => current)).toBeNull(); expect(mocks.token).not.toHaveBeenCalled();
  });
  it('discards a late native token after leaving the screen', async () => {
    let current = true; mocks.token.mockImplementation(async () => { current = false; return { type: 'ios', data: 'a'.repeat(64) }; });
    expect(await readIosPushDiagnostic(() => current)).toBeNull();
  });
  it('refuses unknown signing environment before requesting a token', async () => {
    mocks.environment.mockResolvedValue(null);
    await expect(readIosPushDiagnostic(() => true)).rejects.toThrow('PUSH_DIAGNOSTIC_ENVIRONMENT_UNKNOWN'); expect(mocks.token).not.toHaveBeenCalled();
  });
  it('rejects malformed native tokens without putting the token in the error', async () => {
    mocks.token.mockResolvedValue({ type: 'ios', data: 'private-invalid-token' });
    await expect(readIosPushDiagnostic(() => true)).rejects.toThrow(/^PUSH_DIAGNOSTIC_TOKEN_INVALID$/);
  });
});
