import { describe, expect, it } from 'vitest';

import { isCodexOAuthReconnectRequired } from '../codexAuthRecovery';

describe('isCodexOAuthReconnectRequired', () => {
  it('matches invalidation reason tokens from auth adapters', () => {
    for (const reason of [
      'app_session_terminated',
      'token_invalidated',
      'token_revoked',
      'refresh_token_reused',
    ]) {
      expect(isCodexOAuthReconnectRequired(reason)).toBe(true);
    }
  });

  it('matches every codex-rs permanent refresh failure sentence variant', () => {
    // codex-rs login/src/auth/manager.rs 的 REFRESH_TOKEN_*_MESSAGE 家族:
    // 共享前缀 "access token could not be refreshed",全部为永久失败、需重登。
    const variants = [
      'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.',
      'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.',
      'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
      'Your access token could not be refreshed. Please log out and sign in again.',
      'Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.',
    ];
    for (const variant of variants) {
      expect(isCodexOAuthReconnectRequired(variant)).toBe(true);
    }
  });

  it('matches the full wrapped thread/resume config-load failure end to end', () => {
    expect(
      isCodexOAuthReconnectRequired(
        'LAZY_CREATE_FAILED: Failed to resume Codex thread: Error: codex app-server thread/resume error -32600: failed to load configuration: Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.',
      ),
    ).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isCodexOAuthReconnectRequired(undefined)).toBe(false);
    expect(isCodexOAuthReconnectRequired('')).toBe(false);
    expect(isCodexOAuthReconnectRequired('fetch failed: ECONNREFUSED')).toBe(false);
    expect(isCodexOAuthReconnectRequired('failed to load configuration: invalid TOML')).toBe(
      false,
    );
    expect(isCodexOAuthReconnectRequired('401 Missing bearer token')).toBe(false);
  });
});
