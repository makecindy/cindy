import { describe, expect, it } from 'vitest';

import { decodeRemoteErrorMessage, remoteErrorMessageForBanner } from '@/lib/makerChatStore';
import { i18n } from '@/i18n';

describe('decodeRemoteErrorMessage', () => {
  it.each([
    ['MCP_APPROVAL_AUTO_BLOCKED', 'Automatic approval review blocked this tool call. No manual rejection was received.'],
    ['MCP_APPROVAL_CONFIRMATION_TIMEOUT', 'The permission request timed out without a confirmed decision. A timeout does not show whether you clicked a button.'],
    ['MCP_APPROVAL_CONFIRMATION_UNAVAILABLE', 'Permission confirmation could not be completed. No manual rejection was received.'],
  ])('explains %s without blaming the user', (code, text) => {
    expect(decodeRemoteErrorMessage(`[${code}] fallback`)).toBe(text);
  });

  it('maps user-facing device-link chat errors to i18n text', () => {
    expect(decodeRemoteErrorMessage('[DEVICE_LINK_CONTROL_DISABLED] device control is disabled locally')).toBe(
      'Control for this device is off; the message was not sent.',
    );
    expect(decodeRemoteErrorMessage('[DEVICE_LINK_MEDIA_TRANSFER_FAILED] upload failed')).toBe(
      'Attachment transfer failed; the message was not sent. Please try again.',
    );
  });

  it('maps Electron-wrapped device-link chat errors to i18n text', () => {
    expect(
      decodeRemoteErrorMessage(
        'Error invoking remote method device-link:invoke: Error: [DEVICE_LINK_CONTROL_DISABLED] device control is disabled locally',
      ),
    ).toBe('Control for this device is off; the message was not sent.');
  });

  it('keeps non-chat device-link IPC codes unchanged', () => {
    expect(decodeRemoteErrorMessage('[DEVICE_LINK_ACCESS_REVOKED] access revoked')).toBe(
      '[DEVICE_LINK_ACCESS_REVOKED] access revoked',
    );
  });

  it('summarizes unknown remote codes in the interface language instead of upstream fallback text', () => {
    const summary = i18n.t('ipcError.INTERNAL');
    expect(decodeRemoteErrorMessage('[REMOTE_UNKNOWN] fallback message')).toBe(summary);
    expect(remoteErrorMessageForBanner('[REMOTE_UNKNOWN] fallback message')).toBe(summary);
    expect(summary).not.toContain('fallback message');
  });

  it('keeps an explicit fallback for missing keys that are not error copy', () => {
    expect(i18n.t('not.a.real.key', { defaultValue: 'keep me' })).toBe('keep me');
    expect(i18n.t('models.options.effortLevels.not-a-real-effort', { defaultValue: '' })).toBe('');
  });

  it('keeps known codes available to live and tail banners while other callers still get translated text', () => {
    const raw = '[REMOTE_LOCAL_ONLY_PROVIDER] use a different provider';
    expect(remoteErrorMessageForBanner(raw)).toBe(raw);
    expect(decodeRemoteErrorMessage(raw)).not.toBe(raw);
  });

  it('maps a missing auto-review confirmation to i18n text, not a user rejection', () => {
    expect(
      decodeRemoteErrorMessage(
        '[AUTO_REVIEW_CONFIRM_UNDELIVERED] Automatic review was unavailable, and the confirmation request was not completed.',
      ),
    ).toBe(
      'Automatic review was unavailable, and the confirmation request was not completed. This is not a user rejection.',
    );
  });
});
