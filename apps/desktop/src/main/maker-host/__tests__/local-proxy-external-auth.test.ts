import { beforeEach, describe, expect, it, vi } from 'vitest';

// 用内存变量替身掉 safeStorage 落盘与非密钥设置存储,隔离出鉴权/生成/掩码逻辑,
// 不触碰 electron。两族各一份 token box + enabled box,验证互不串扰。
const tokenBox = vi.hoisted(() => ({ value: null as string | null }));
const enabledBox = vi.hoisted(() => ({ value: false }));
const codexTokenBox = vi.hoisted(() => ({ value: null as string | null }));
const codexEnabledBox = vi.hoisted(() => ({ value: false }));

vi.mock('../../secrets/providerSecretStore', () => ({
  readLocalProxyExternalToken: () => tokenBox.value,
  writeLocalProxyExternalToken: (v: string) => {
    tokenBox.value = v;
    return true;
  },
  readLocalProxyCodexExternalToken: () => codexTokenBox.value,
  writeLocalProxyCodexExternalToken: (v: string) => {
    codexTokenBox.value = v;
    return true;
  },
}));

vi.mock('../local-proxy-settings-store', () => ({
  isExternalAccessEnabled: () => enabledBox.value,
  isCodexExternalAccessEnabled: () => codexEnabledBox.value,
}));

import {
  getCodexExternalTokenMasked,
  getExternalTokenMasked,
  getOrCreateCodexExternalToken,
  getOrCreateExternalToken,
  hasCodexExternalToken,
  hasExternalToken,
  isCodexExternalAccessEnabled,
  isExternalAccessEnabled,
  matchesCodexExternalToken,
  matchesExternalToken,
  regenerateCodexExternalToken,
  regenerateExternalToken,
} from '../local-proxy-external-auth';

beforeEach(() => {
  tokenBox.value = null;
  enabledBox.value = false;
  codexTokenBox.value = null;
  codexEnabledBox.value = false;
});

describe('local proxy external token auth (A 族 = Anthropic)', () => {
  it('creates a prefixed token once and reuses it', () => {
    expect(hasExternalToken()).toBe(false);
    const first = getOrCreateExternalToken();
    expect(first).toMatch(/^cindy-local-/);
    expect(hasExternalToken()).toBe(true);
    // 已存在则复用,不重新生成。
    expect(getOrCreateExternalToken()).toBe(first);
  });

  it('regenerate replaces the token so the old one no longer matches', () => {
    const first = getOrCreateExternalToken();
    const next = regenerateExternalToken();
    expect(next).not.toBe(first);
    expect(matchesExternalToken(next)).toBe(true);
    expect(matchesExternalToken(first)).toBe(false);
  });

  it('matchesExternalToken is independent of enabled flag', () => {
    const token = getOrCreateExternalToken();
    enabledBox.value = false;
    // 命中判定与 enabled 无关:携带正确 token 的请求任何时候都算外部客户端。
    expect(matchesExternalToken(token)).toBe(true);
    enabledBox.value = true;
    expect(matchesExternalToken(token)).toBe(true);
  });

  it('rejects empty / wrong / length-mismatched candidates', () => {
    getOrCreateExternalToken();
    expect(matchesExternalToken(null)).toBe(false);
    expect(matchesExternalToken(undefined)).toBe(false);
    expect(matchesExternalToken('')).toBe(false);
    expect(matchesExternalToken('cindy-local-wrong')).toBe(false);
  });

  it('returns false when no token has been stored yet', () => {
    expect(matchesExternalToken('cindy-local-anything')).toBe(false);
  });

  it('masks the token without leaking the middle or true length', () => {
    expect(getExternalTokenMasked()).toBeNull();
    const token = getOrCreateExternalToken();
    const masked = getExternalTokenMasked();
    expect(masked).not.toBeNull();
    expect(masked).toMatch(/^cindy-local-•+/);
    expect(masked!.endsWith(token.slice(-4))).toBe(true);
    // 掩码不应包含 token 中段。
    expect(masked).not.toContain(token.slice(12, 20));
  });

  it('reflects the settings-store enabled flag', () => {
    enabledBox.value = false;
    expect(isExternalAccessEnabled()).toBe(false);
    enabledBox.value = true;
    expect(isExternalAccessEnabled()).toBe(true);
  });
});

describe('local proxy external token auth (B 族 = Codex / OpenAI)', () => {
  it('creates a prefixed token once and reuses it', () => {
    expect(hasCodexExternalToken()).toBe(false);
    const first = getOrCreateCodexExternalToken();
    expect(first).toMatch(/^cindy-local-/);
    expect(hasCodexExternalToken()).toBe(true);
    expect(getOrCreateCodexExternalToken()).toBe(first);
  });

  it('regenerate replaces the token so the old one no longer matches', () => {
    const first = getOrCreateCodexExternalToken();
    const next = regenerateCodexExternalToken();
    expect(next).not.toBe(first);
    expect(matchesCodexExternalToken(next)).toBe(true);
    expect(matchesCodexExternalToken(first)).toBe(false);
  });

  it('matchesCodexExternalToken is independent of codexEnabled flag', () => {
    const token = getOrCreateCodexExternalToken();
    codexEnabledBox.value = false;
    expect(matchesCodexExternalToken(token)).toBe(true);
    codexEnabledBox.value = true;
    expect(matchesCodexExternalToken(token)).toBe(true);
  });

  it('masks the token without leaking the middle or true length', () => {
    expect(getCodexExternalTokenMasked()).toBeNull();
    const token = getOrCreateCodexExternalToken();
    const masked = getCodexExternalTokenMasked();
    expect(masked).not.toBeNull();
    expect(masked).toMatch(/^cindy-local-•+/);
    expect(masked!.endsWith(token.slice(-4))).toBe(true);
    expect(masked).not.toContain(token.slice(12, 20));
  });

  it('reflects the settings-store codexEnabled flag', () => {
    codexEnabledBox.value = false;
    expect(isCodexExternalAccessEnabled()).toBe(false);
    codexEnabledBox.value = true;
    expect(isCodexExternalAccessEnabled()).toBe(true);
  });
});

describe('cross-family isolation (跨族 token 不互通)', () => {
  it('each family owns an independent token', () => {
    const a = getOrCreateExternalToken();
    const b = getOrCreateCodexExternalToken();
    expect(a).not.toBe(b);
    expect(hasExternalToken()).toBe(true);
    expect(hasCodexExternalToken()).toBe(true);
  });

  it("A-family token does not match the codex host, and vice versa", () => {
    const a = getOrCreateExternalToken();
    const b = getOrCreateCodexExternalToken();
    // 拿 A 族 token 打 codex loopback → 不命中(收紧隔离,不放行为外部客户端)。
    expect(matchesCodexExternalToken(a)).toBe(false);
    // 拿 B 族 token 打 anthropic loopback → 同样不命中。
    expect(matchesExternalToken(b)).toBe(false);
    // 各自 token 只命中本族。
    expect(matchesExternalToken(a)).toBe(true);
    expect(matchesCodexExternalToken(b)).toBe(true);
  });

  it('regenerating one family leaves the other untouched', () => {
    const a = getOrCreateExternalToken();
    const b = getOrCreateCodexExternalToken();
    regenerateExternalToken();
    // A 族换新后旧值失效,但 B 族原封不动。
    expect(matchesExternalToken(a)).toBe(false);
    expect(matchesCodexExternalToken(b)).toBe(true);
    const b2 = regenerateCodexExternalToken();
    expect(matchesCodexExternalToken(b)).toBe(false);
    expect(matchesCodexExternalToken(b2)).toBe(true);
    // B 族换新不影响 A 族当前 token。
    expect(matchesExternalToken(getOrCreateExternalToken())).toBe(true);
  });

  it('one family having a token does not imply the other does', () => {
    getOrCreateExternalToken();
    expect(hasExternalToken()).toBe(true);
    expect(hasCodexExternalToken()).toBe(false);
    // B 族无 token 时,任何候选都不命中。
    expect(matchesCodexExternalToken('cindy-local-anything')).toBe(false);
  });

  it('the two enabled flags are independent', () => {
    enabledBox.value = true;
    codexEnabledBox.value = false;
    expect(isExternalAccessEnabled()).toBe(true);
    expect(isCodexExternalAccessEnabled()).toBe(false);
    enabledBox.value = false;
    codexEnabledBox.value = true;
    expect(isExternalAccessEnabled()).toBe(false);
    expect(isCodexExternalAccessEnabled()).toBe(true);
  });
});
