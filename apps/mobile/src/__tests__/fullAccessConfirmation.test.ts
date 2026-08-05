import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }));
vi.mock('expo-localization', () => ({ getLocales: vi.fn(() => [{ languageCode: 'en' }]) }));

import { confirmFullAccessChange, getFullAccessConfirmationCopy } from '@/session/fullAccessConfirmation';

describe('getFullAccessConfirmationCopy', () => {
  it('selects the supported system language and falls back to English', () => {
    expect(getFullAccessConfirmationCopy('ja').confirm).toBe('Full access を有効にする');
    expect(getFullAccessConfirmationCopy('ko-KR').cancel).toBe('현재 권한 유지');
    expect(getFullAccessConfirmationCopy('zh-Hans-CN').title).toBe('开启 Full access？');
    expect(getFullAccessConfirmationCopy('fr').title).toBe('Enable Full access?');
  });
});

describe('confirmFullAccessChange', () => {
  it('does not show an alert when the change does not enter Full access', async () => {
    const showAlert = vi.fn();

    await expect(confirmFullAccessChange('auto', 'ask', showAlert)).resolves.toBe(true);
    expect(showAlert).not.toHaveBeenCalled();
  });

  it('keeps the previous mode when the user cancels', async () => {
    const showAlert = vi.fn((_title, _message, buttons) => {
      buttons?.[0]?.onPress?.();
    });

    await expect(confirmFullAccessChange('auto', 'bypassPermissions', showAlert)).resolves.toBe(false);
    expect(showAlert).toHaveBeenCalledOnce();
    expect(showAlert.mock.calls[0]?.[2]?.[1]).toMatchObject({ style: 'destructive' });
  });

  it('allows the change only after explicit confirmation', async () => {
    const showAlert = vi.fn((_title, _message, buttons) => {
      buttons?.[1]?.onPress?.();
    });

    await expect(confirmFullAccessChange('ask', 'bypassPermissions', showAlert)).resolves.toBe(true);
  });

  it('treats dismiss as cancellation', async () => {
    const showAlert = vi.fn((_title, _message, _buttons, options) => {
      options?.onDismiss?.();
    });

    await expect(confirmFullAccessChange(undefined, 'bypassPermissions', showAlert)).resolves.toBe(false);
  });
});
