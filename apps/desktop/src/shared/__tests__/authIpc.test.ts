import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LOGIN_PREPARING_UNLOCK_TIMEOUT_MS,
  awaitDesktopLoginStateLoad,
  parseDesktopAccountDeletionConfirmInput,
  parseDesktopAccountKey,
  parseDesktopLoginAction,
  settleDesktopLoginResult,
} from '../authIpc';

describe('desktop auth IPC validation', () => {
  it('accepts bounded opaque account keys and rejects malformed values', () => {
    expect(parseDesktopAccountKey('["global","membership-1"]')).toBe('["global","membership-1"]');
    expect(parseDesktopAccountKey('')).toBeNull();
    expect(parseDesktopAccountKey('x'.repeat(513))).toBeNull();
    expect(parseDesktopAccountKey({ accountKey: 'membership-1' })).toBeNull();
  });

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

describe('settleDesktopLoginResult', () => {
  it('keeps a successful identifier state', () => {
    const state = {
      step: 'identifier' as const,
      providers: {
        region: 'global' as const,
        attribution: 'email' as const,
        email: true,
        phone: false,
        social: [],
      },
    };
    expect(settleDesktopLoginResult({ success: true, state })).toEqual({
      success: true,
      state,
    });
  });

  it('maps a failed null state onto the retryable error step', () => {
    expect(
      settleDesktopLoginResult({
        success: false,
        code: 'AUTH_FLOW_SUPERSEDED',
        state: null,
      }),
    ).toEqual({
      success: false,
      code: 'AUTH_FLOW_SUPERSEDED',
      state: { step: 'error', code: 'AUTH_FLOW_SUPERSEDED', recoverTo: 'identifier' },
    });
  });
});

describe('awaitDesktopLoginStateLoad', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a settled identifier before the preparing timeout', async () => {
    const state = {
      step: 'identifier' as const,
      providers: {
        region: 'global' as const,
        attribution: 'email' as const,
        email: true,
        phone: false,
        social: [],
      },
    };
    await expect(
      awaitDesktopLoginStateLoad(async () => ({ success: true, state })),
    ).resolves.toEqual({ success: true, state });
  });

  it('unlocks preparing after 30s when getLoginState never settles', async () => {
    const hung = () => new Promise<never>(() => undefined);
    const p = awaitDesktopLoginStateLoad(hung);
    const rejected = expect(p).resolves.toEqual({
      success: false,
      code: 'AUTH_SERVICE_UNAVAILABLE',
      state: { step: 'error', code: 'AUTH_SERVICE_UNAVAILABLE', recoverTo: 'identifier' },
    });
    await vi.advanceTimersByTimeAsync(LOGIN_PREPARING_UNLOCK_TIMEOUT_MS - 1);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
  });

  it('maps a thrown getLoginState onto the retryable error step', async () => {
    await expect(
      awaitDesktopLoginStateLoad(async () => {
        throw new Error('ipc exploded');
      }),
    ).resolves.toEqual({
      success: false,
      code: 'AUTH_SERVICE_UNAVAILABLE',
      state: { step: 'error', code: 'AUTH_SERVICE_UNAVAILABLE', recoverTo: 'identifier' },
    });
  });
});
