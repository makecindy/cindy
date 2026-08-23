import { describe, expect, it } from 'vitest';

import { parseDesktopAccountDeletionConfirmInput, parseDesktopLoginAction } from '../authIpc';

describe('desktop auth IPC validation', () => {
  it('projects recognized actions onto their typed fields', () => {
    expect(
      parseDesktopLoginAction({
        type: 'start-browser',
        kind: 'sso',
        providerOrConnectionId: 'connection-id',
        label: 'Company SSO',
        ignored: 'renderer-controlled extra field',
      }),
    ).toEqual({
      type: 'start-browser',
      kind: 'sso',
      providerOrConnectionId: 'connection-id',
      label: 'Company SSO',
    });
  });

  it('accepts request-code with and without a bounded captchaToken', () => {
    expect(
      parseDesktopLoginAction({ type: 'request-code', kind: 'email', identifier: 'a@b.co' }),
    ).toEqual({ type: 'request-code', kind: 'email', identifier: 'a@b.co' });
    expect(
      parseDesktopLoginAction({
        type: 'request-code',
        kind: 'email',
        identifier: 'a@b.co',
        captchaToken: 'tok',
      }),
    ).toEqual({
      type: 'request-code',
      kind: 'email',
      identifier: 'a@b.co',
      captchaToken: 'tok',
    });
    // 携带即校验:超界/空/非字符串一律整条拒绝,不做静默剥离
    expect(
      parseDesktopLoginAction({
        type: 'request-code',
        kind: 'email',
        identifier: 'a@b.co',
        captchaToken: 'a'.repeat(2049),
      }),
    ).toBeNull();
    expect(
      parseDesktopLoginAction({
        type: 'request-code',
        kind: 'email',
        identifier: 'a@b.co',
        captchaToken: '',
      }),
    ).toBeNull();
    expect(
      parseDesktopLoginAction({
        type: 'request-code',
        kind: 'email',
        identifier: 'a@b.co',
        captchaToken: 42,
      }),
    ).toBeNull();
  });

  it('rejects unknown, incomplete, and oversized actions', () => {
    expect(parseDesktopLoginAction(null)).toBeNull();
    expect(parseDesktopLoginAction({ type: 'unknown' })).toBeNull();
    expect(parseDesktopLoginAction({ type: 'verify-code', kind: 'email' })).toBeNull();
    expect(
      parseDesktopLoginAction({
        type: 'discover',
        email: 'a'.repeat(321),
      }),
    ).toBeNull();
    expect(
      parseDesktopLoginAction({
        type: 'discover-sso-org',
        org: 'a'.repeat(254),
      }),
    ).toBeNull();
    expect(parseDesktopLoginAction({ type: 'discover-sso-org', org: '' })).toBeNull();
  });

  it('accepts each non-browser action shape', () => {
    expect(parseDesktopLoginAction({ type: 'reset' })).toEqual({ type: 'reset' });
    expect(parseDesktopLoginAction({ type: 'cancel-browser' })).toEqual({
      type: 'cancel-browser',
    });
    expect(parseDesktopLoginAction({ type: 'discover', email: 'user@example.com' })).not.toBeNull();
    expect(
      parseDesktopLoginAction({
        type: 'discover-sso-org',
        org: `${'a'.repeat(64)}.example.com`,
        extra: 'x',
      }),
    ).toEqual({
      type: 'discover-sso-org',
      org: `${'a'.repeat(64)}.example.com`,
    });
    expect(parseDesktopLoginAction({ type: 'discover-sso-org', org: 'corp' })).toEqual({
      type: 'discover-sso-org',
      org: 'corp',
    });
    expect(parseDesktopLoginAction({ type: 'confirm-sso-realm' })).toEqual({
      type: 'confirm-sso-realm',
    });
    expect(parseDesktopLoginAction({ type: 'cancel-sso-realm' })).toEqual({
      type: 'cancel-sso-realm',
    });
    expect(
      parseDesktopLoginAction({
        type: 'request-code',
        kind: 'phone',
        identifier: '+8613800000000',
      }),
    ).not.toBeNull();
    expect(
      parseDesktopLoginAction({
        type: 'verify-code',
        kind: 'email',
        identifier: 'user@example.com',
        code: '123456',
      }),
    ).not.toBeNull();
    expect(
      parseDesktopLoginAction({ type: 'select-account', accountId: 'account-id' }),
    ).not.toBeNull();
    expect(parseDesktopLoginAction({ type: 'request-sso-verification-code' })).toEqual({
      type: 'request-sso-verification-code',
    });
    expect(
      parseDesktopLoginAction({ type: 'verify-sso-verification', code: '123456' }),
    ).not.toBeNull();
    expect(
      parseDesktopLoginAction({
        type: 'request-binding-code',
        contact: 'user@example.com',
      }),
    ).not.toBeNull();
    expect(
      parseDesktopLoginAction({
        type: 'verify-binding',
        contact: 'user@example.com',
        code: '123456',
      }),
    ).not.toBeNull();
  });
});

describe('parseDesktopAccountDeletionConfirmInput', () => {
  it('keeps only a bounded challenge id and verification code', () => {
    expect(
      parseDesktopAccountDeletionConfirmInput({
        challengeId: 'challenge-id',
        code: '123456',
        acknowledged: false,
        receiptToken: 'must-not-cross-renderer-boundary',
      }),
    ).toEqual({ challengeId: 'challenge-id', code: '123456' });
  });

  it('rejects missing, empty, and oversized confirmation fields', () => {
    expect(parseDesktopAccountDeletionConfirmInput(null)).toBeNull();
    expect(parseDesktopAccountDeletionConfirmInput({ challengeId: '', code: '123456' })).toBeNull();
    expect(parseDesktopAccountDeletionConfirmInput({ challengeId: 'id', code: '' })).toBeNull();
    expect(
      parseDesktopAccountDeletionConfirmInput({ challengeId: 'id', code: '12345a' }),
    ).toBeNull();
    expect(
      parseDesktopAccountDeletionConfirmInput({
        challengeId: 'x'.repeat(257),
        code: '123456',
      }),
    ).toBeNull();
  });
});
