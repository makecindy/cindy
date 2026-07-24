import { beforeEach, describe, expect, it, vi } from 'vitest';

const secureStorage = vi.hoisted(() => ({
  getSecureItem: vi.fn(async () => null as string | null),
  setSecureItem: vi.fn(async () => undefined),
}));
const reactNative = vi.hoisted(() => ({ Alert: { alert: vi.fn() } }));

vi.mock('@/auth/secureStorage', () => secureStorage);
vi.mock('react-native', () => reactNative);

describe('mobile voice privacy consent persistence', () => {
  beforeEach(() => {
    secureStorage.getSecureItem.mockClear();
    secureStorage.setSecureItem.mockClear();
    secureStorage.setSecureItem.mockResolvedValue(undefined);
    reactNative.Alert.alert.mockClear();
  });

  it('treats a successful secure-store write as consent accepted', async () => {
    const { persistMobileVoicePrivacyConsent } =
      await import('@/session/mobileVoicePrivacyConsent');

    await expect(persistMobileVoicePrivacyConsent()).resolves.toBe(true);
    expect(secureStorage.setSecureItem).toHaveBeenCalledTimes(1);
    expect(secureStorage.getSecureItem).not.toHaveBeenCalled();
  });

  it('reports a secure-store write failure', async () => {
    secureStorage.setSecureItem.mockRejectedValueOnce(
      new Error('secure store unavailable'),
    );
    const { persistMobileVoicePrivacyConsent } =
      await import('@/session/mobileVoicePrivacyConsent');

    await expect(persistMobileVoicePrivacyConsent()).resolves.toBe(false);
  });

  it('shows an error when consent cannot be persisted', async () => {
    secureStorage.setSecureItem.mockRejectedValueOnce(new Error('secure store unavailable'));
    const { ensureMobileVoicePrivacyConsent } =
      await import('@/session/mobileVoicePrivacyConsent');

    const result = ensureMobileVoicePrivacyConsent();
    await vi.waitFor(() => expect(reactNative.Alert.alert).toHaveBeenCalledTimes(1));
    const buttons = reactNative.Alert.alert.mock.calls[0]?.[2] as
      | Array<{ onPress?: () => void }>
      | undefined;
    buttons?.[1]?.onPress?.();

    await expect(result).resolves.toBe(false);
    expect(reactNative.Alert.alert).toHaveBeenCalledTimes(2);
    expect(reactNative.Alert.alert.mock.calls[1]?.[1]).toBeTruthy();
  });
});
