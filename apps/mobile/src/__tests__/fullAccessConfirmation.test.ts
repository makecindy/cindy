import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());

vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }));
vi.mock('expo-localization', () => ({ getLocales: vi.fn(() => [{ languageCode: 'en' }]) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    getAllKeys: vi.fn(async () => [...store.keys()]),
    multiRemove: vi.fn(async (keys: readonly string[]) => {
      for (const key of keys) store.delete(key);
    }),
  },
}));

import {
  __testing as confirmationTesting,
  confirmFullAccessChange,
  getFullAccessConfirmationCopy,
} from '@/session/fullAccessConfirmation';
import { __testing as storeTesting } from '@/session/fullAccessConfirmationStore';
import {
  __testing as authOwnerTesting,
  setMobileAuthOwner,
} from '@/auth/authOwnerGeneration';

const DEVICE_A = 'desktop-a';

function scope(deviceId = DEVICE_A) {
  return { controlledDeviceId: deviceId };
}

function confirmingAlert() {
  return vi.fn((_title, _message, buttons) => {
    buttons?.[1]?.onPress?.();
  });
}

describe('getFullAccessConfirmationCopy', () => {
  it('selects the supported system language and falls back to English', () => {
    expect(getFullAccessConfirmationCopy('ja').confirm).toBe('Full access を有効にする');
    expect(getFullAccessConfirmationCopy('ko-KR').cancel).toBe('현재 권한 유지');
    expect(getFullAccessConfirmationCopy('zh-Hans-CN').title).toBe('开启 Full access？');
    expect(getFullAccessConfirmationCopy('fr').title).toBe('Enable Full access?');
  });
});

describe('confirmFullAccessChange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    storeTesting.resetMemory();
    confirmationTesting.resetInFlight();
    authOwnerTesting.reset();
    setMobileAuthOwner('account-a');
  });

  it('does not show an alert when the change does not enter Full access', async () => {
    const showAlert = vi.fn();

    await expect(confirmFullAccessChange('auto', 'ask', { ...scope(), showAlert })).resolves.toBe(true);
    expect(showAlert).not.toHaveBeenCalled();
  });

  it('keeps the previous mode when the user cancels or dismisses', async () => {
    const cancelAlert = vi.fn((_title, _message, buttons) => {
      buttons?.[0]?.onPress?.();
    });
    await expect(
      confirmFullAccessChange('auto', 'bypassPermissions', { ...scope(), showAlert: cancelAlert }),
    ).resolves.toBe(false);
    expect(cancelAlert.mock.calls[0]?.[2]?.[1]).toMatchObject({ style: 'destructive' });

    const dismissAlert = vi.fn((_title, _message, _buttons, options) => {
      options?.onDismiss?.();
    });
    await expect(
      confirmFullAccessChange(undefined, 'bypassPermissions', { ...scope(), showAlert: dismissAlert }),
    ).resolves.toBe(false);
  });

  it('asks once for the same account and controlled desktop, including after memory reset', async () => {
    const showAlert = confirmingAlert();

    await expect(
      confirmFullAccessChange('ask', 'bypassPermissions', { ...scope(), showAlert }),
    ).resolves.toBe(true);
    await expect(
      confirmFullAccessChange('ask', 'bypassPermissions', { ...scope(), showAlert }),
    ).resolves.toBe(true);
    expect(showAlert).toHaveBeenCalledOnce();

    storeTesting.resetMemory();
    confirmationTesting.resetInFlight();
    await expect(
      confirmFullAccessChange('auto', 'bypassPermissions', { ...scope(), showAlert }),
    ).resolves.toBe(true);
    expect(showAlert).toHaveBeenCalledOnce();
  });

  it('asks again for a different desktop or account', async () => {
    const showAlert = confirmingAlert();

    await confirmFullAccessChange('ask', 'bypassPermissions', { ...scope(DEVICE_A), showAlert });
    await confirmFullAccessChange('ask', 'bypassPermissions', { ...scope('desktop-b'), showAlert });
    setMobileAuthOwner('account-b');
    await confirmFullAccessChange('ask', 'bypassPermissions', { ...scope(DEVICE_A), showAlert });

    expect(showAlert).toHaveBeenCalledTimes(3);
  });

  it('rejects a stale confirmation after the account or controlled desktop changes', async () => {
    let currentDevice = DEVICE_A;
    const accountSwitchAlert = vi.fn((_title, _message, buttons) => {
      setMobileAuthOwner('account-b');
      buttons?.[1]?.onPress?.();
    });
    await expect(confirmFullAccessChange('ask', 'bypassPermissions', {
      controlledDeviceId: DEVICE_A,
      isControlledDeviceCurrent: () => currentDevice === DEVICE_A,
      showAlert: accountSwitchAlert,
    })).resolves.toBe(false);

    setMobileAuthOwner('account-a');
    const deviceSwitchAlert = vi.fn((_title, _message, buttons) => {
      currentDevice = 'desktop-b';
      buttons?.[1]?.onPress?.();
    });
    await expect(confirmFullAccessChange('ask', 'bypassPermissions', {
      controlledDeviceId: DEVICE_A,
      isControlledDeviceCurrent: () => currentDevice === DEVICE_A,
      showAlert: deviceSwitchAlert,
    })).resolves.toBe(false);
  });

  it('coalesces concurrent confirmation requests for the same owner generation', async () => {
    let confirm: (() => void) | undefined;
    const showAlert = vi.fn((_title, _message, buttons) => {
      confirm = buttons?.[1]?.onPress;
    });

    const first = confirmFullAccessChange('ask', 'bypassPermissions', { ...scope(), showAlert });
    const second = confirmFullAccessChange('auto', 'bypassPermissions', { ...scope(), showAlert });
    await vi.waitFor(() => expect(showAlert).toHaveBeenCalledOnce());
    confirm?.();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });

  it('rechecks each caller device fence after a shared confirmation finishes', async () => {
    let confirm: (() => void) | undefined;
    let secondDevice = DEVICE_A;
    const showAlert = vi.fn((_title, _message, buttons) => {
      confirm = buttons?.[1]?.onPress;
    });

    const first = confirmFullAccessChange('ask', 'bypassPermissions', {
      ...scope(),
      isControlledDeviceCurrent: () => true,
      showAlert,
    });
    const second = confirmFullAccessChange('auto', 'bypassPermissions', {
      ...scope(),
      isControlledDeviceCurrent: () => secondDevice === DEVICE_A,
      showAlert,
    });
    await vi.waitFor(() => expect(showAlert).toHaveBeenCalledOnce());
    secondDevice = 'desktop-b';
    confirm?.();

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
  });

  it('fails closed when account or controlled desktop identity is unavailable', async () => {
    const showAlert = confirmingAlert();
    setMobileAuthOwner(null);
    await expect(
      confirmFullAccessChange('ask', 'bypassPermissions', { ...scope(), showAlert }),
    ).resolves.toBe(false);

    setMobileAuthOwner('account-a');
    await expect(
      confirmFullAccessChange('ask', 'bypassPermissions', { controlledDeviceId: '', showAlert }),
    ).resolves.toBe(false);
    expect(showAlert).not.toHaveBeenCalled();
  });
});
