import { beforeEach, describe, expect, it, vi } from 'vitest';

// 用内存变量替身掉 safeStorage 落盘与非密钥设置存储,隔离出鉴权/生成/掩码逻辑,
// 不触碰 electron。两族各一份 token box + enabled box,验证互不串扰。
const tokenBox = vi.hoisted(() => ({ value: null as string | null }));
const enabledBox = vi.hoisted(() => ({ value: false }));
const codexTokenBox = vi.hoisted(() => ({ value: null as string | null }));
const codexEnabledBox = vi.hoisted(() => ({ value: false }));
// safeStorage 是否可落盘;置 false 模拟 safeStorage 不可用(write 返回 false),
// 用来验证进程内兜底缓存路径。
const writableBox = vi.hoisted(() => ({ value: true }));
// remove 是否生效;置 false 模拟 safeStorage 不可用时旧物理值删不掉(轮换失败路径)。
const removableBox = vi.hoisted(() => ({ value: true }));

vi.mock('../../secrets/providerSecretStore', () => ({
  readLocalProxyExternalToken: () => tokenBox.value,
  writeLocalProxyExternalToken: (v: string) => {
    if (!writableBox.value) return false;
    tokenBox.value = v;
    return true;
  },
  removeLocalProxyExternalToken: () => {
    if (!removableBox.value) return { success: false, error: 'unavailable' };
    tokenBox.value = null;
    return { success: true };
  },
  readLocalProxyCodexExternalToken: () => codexTokenBox.value,
  writeLocalProxyCodexExternalToken: (v: string) => {
    if (!writableBox.value) return false;
    codexTokenBox.value = v;
    return true;
  },
  removeLocalProxyCodexExternalToken: () => {
    if (!removableBox.value) return { success: false, error: 'unavailable' };
    codexTokenBox.value = null;
    return { success: true };
  },
}));

vi.mock('../local-proxy-settings-store', () => ({
  isExternalAccessEnabled: () => enabledBox.value,
  isCodexExternalAccessEnabled: () => codexEnabledBox.value,
}));

import {
  clearExternalTokenMemoryFallback,
  getCodexExternalTokenMasked,
  getExternalTokenMasked,
  getOrCreateCodexExternalToken,
  getOrCreateExternalToken,
  hasCodexExternalToken,
  hasExternalToken,
  isCindyLocalToken,
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
  writableBox.value = true;
  removableBox.value = true;
  clearExternalTokenMemoryFallback();
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

describe('isCindyLocalToken(前缀判别器,用于拒绝陈旧/跨族 token)', () => {
  it('只按前缀判定,不比对具体值', () => {
    expect(isCindyLocalToken('cindy-local-anything')).toBe(true);
    // 生成的真 token 也带前缀。
    expect(isCindyLocalToken(getOrCreateExternalToken())).toBe(true);
  });

  it('非前缀值(真凭证 / 网关 key / 占位 key / 空)一律否', () => {
    expect(isCindyLocalToken('sk-ant-realkey')).toBe(false);
    expect(isCindyLocalToken('xdt-provider-auth-placeholder-key')).toBe(false);
    expect(isCindyLocalToken('')).toBe(false);
    expect(isCindyLocalToken(null)).toBe(false);
    expect(isCindyLocalToken(undefined)).toBe(false);
  });

  it('陈旧/跨族的 cindy-local- token 命不中但仍被识别为本地代理 token', () => {
    const a = getOrCreateExternalToken();
    const b = getOrCreateCodexExternalToken();
    // 跨族:A 族 token 打 B 族命不中,但前缀判别器认得它是 Cindy 本地 token(host 据此 401,不透传)。
    expect(matchesCodexExternalToken(a)).toBe(false);
    expect(isCindyLocalToken(a)).toBe(true);
    // 重置后旧值命不中,但仍带前缀。
    regenerateExternalToken();
    expect(matchesExternalToken(a)).toBe(false);
    expect(isCindyLocalToken(a)).toBe(true);
    expect(isCindyLocalToken(b)).toBe(true);
  });
});

describe('clearExternalTokenMemoryFallback(账号切换清理)', () => {
  it('清掉进程内兜底 token,清理后旧 token 不再命中', () => {
    writableBox.value = false;
    const a = regenerateExternalToken();
    const b = regenerateCodexExternalToken();
    // 落盘失败,兜底缓存让两族 token 本次运行仍命中。
    expect(matchesExternalToken(a)).toBe(true);
    expect(matchesCodexExternalToken(b)).toBe(true);
    // 切换账号:物理 token 由 providerSecretStore 清除(此处物理本就为空),兜底须一并清。
    clearExternalTokenMemoryFallback();
    expect(hasExternalToken()).toBe(false);
    expect(hasCodexExternalToken()).toBe(false);
    expect(matchesExternalToken(a)).toBe(false);
    expect(matchesCodexExternalToken(b)).toBe(false);
  });
});

describe('in-process fallback when safeStorage write fails', () => {
  // 用 regenerate(总是覆盖兜底)取确定值,避免依赖模块级兜底 Map 的跨用例残留。
  it('keeps the token stable in memory so it still matches this run', () => {
    writableBox.value = false;
    const token = regenerateExternalToken();
    // 落盘失败:物理存储仍为空。
    expect(tokenBox.value).toBeNull();
    // 但兜底缓存让本次运行期读取/掩码/命中都拿到同一个稳定值。
    expect(hasExternalToken()).toBe(true);
    expect(getExternalTokenMasked()).not.toBeNull();
    expect(matchesExternalToken(token)).toBe(true);
    // getOrCreate 不再重新生成,复用兜底值(否则鉴权永远命不中)。
    expect(getOrCreateExternalToken()).toBe(token);
  });

  it('a later successful write supersedes the memory fallback', () => {
    writableBox.value = false;
    const stale = regenerateExternalToken();
    writableBox.value = true;
    const fresh = regenerateExternalToken();
    // 落盘成功后以持久值为准,旧兜底值失效。
    expect(tokenBox.value).toBe(fresh);
    expect(matchesExternalToken(fresh)).toBe(true);
    expect(matchesExternalToken(stale)).toBe(false);
  });

  it('memory fallback is keyed per family (A vs B do not collide)', () => {
    writableBox.value = false;
    const a = regenerateExternalToken();
    const b = regenerateCodexExternalToken();
    expect(a).not.toBe(b);
    // 各族兜底各认各的,跨族仍不互通。
    expect(matchesExternalToken(a)).toBe(true);
    expect(matchesCodexExternalToken(b)).toBe(true);
    expect(matchesCodexExternalToken(a)).toBe(false);
    expect(matchesExternalToken(b)).toBe(false);
  });
});

describe('regenerate rotation integrity (旧物理 token 删不掉时必须报失败,不谎报成功)', () => {
  it('throws when the previous physical token can neither be removed nor overwritten', () => {
    // 先在可落盘时存一个旧物理 token。
    const stale = getOrCreateExternalToken();
    expect(tokenBox.value).toBe(stale);
    // 模拟 safeStorage 变得不可用:remove 删不掉旧值、write 也写不进新值。
    removableBox.value = false;
    writableBox.value = false;
    // 轮换无法让新值生效(effectiveRead 仍读到旧物理值)→ 抛错,绝不谎报成功。
    expect(() => regenerateExternalToken()).toThrow(/rotation failed/i);
    // 旧物理 token 仍在,但轮换抛错让 IPC 层如实回失败(旧 token 仍有效必须让调用方知道)。
    expect(tokenBox.value).toBe(stale);
    // 内存兜底已回滚,不残留一个既写不进物理、又被旧物理值遮挡的新值。
    expect(matchesExternalToken(stale)).toBe(true);
  });

  it('codex family throws on the same rotation failure independently', () => {
    const stale = getOrCreateCodexExternalToken();
    removableBox.value = false;
    writableBox.value = false;
    expect(() => regenerateCodexExternalToken()).toThrow(/rotation failed/i);
    expect(codexTokenBox.value).toBe(stale);
  });

  it('rotation succeeds via remove even when write fails (safeStorage clears but cannot persist)', () => {
    const stale = getOrCreateExternalToken();
    // remove 能删掉旧物理值,但 write 写不进 —— effectiveRead 落到内存新值,旧值已失效。
    writableBox.value = false;
    const next = regenerateExternalToken();
    expect(next).not.toBe(stale);
    expect(tokenBox.value).toBeNull(); // 旧物理值被 remove 清掉
    expect(matchesExternalToken(stale)).toBe(false); // 旧 token 失效
    expect(matchesExternalToken(next)).toBe(true); // 新 token 经内存兜底命中
  });
});
