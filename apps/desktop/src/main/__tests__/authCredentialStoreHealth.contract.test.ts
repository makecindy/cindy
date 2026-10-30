// Guard tier: engineering-conventions section 3.2. Existing cross-file
// credential, permission, protocol, race, and design contracts are isolated
// from runtime unit tests. No new input or assertion is introduced here.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe("authManager credential-store escalation wiring", () => {

  const authSource = readFileSync(
    resolve(process.cwd(), 'src/main/authManager.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');


  it('retains startup failure across all owner cleanup paths and exposes it before loading providers', () => {
    const recovery = authSource.slice(
      authSource.indexOf('async function withAccountFreeOwnerCommit'),
      authSource.indexOf('interface CloudOwnerDataReservation'),
    );
    // Passive, normal commit and failed cleanup must all retain the same cause.
    expect(
      recovery.match(/credentialStoreUnavailable: opts\.credentialStoreUnavailable/g),
    ).toHaveLength(3);
    expect(recovery).toContain(
      'if (credentialStoreUnavailable) credentialStoreHealth.noteStartupFailure();',
    );
    const clear = authSource.slice(
      authSource.indexOf('function clearAuth('),
      authSource.indexOf('// ── Public API'),
    );
    expect(clear.indexOf('credentialStoreHealth.noteStartupFailure()')).toBeGreaterThan(
      clear.indexOf('credentialStoreHealth.reset()'),
    );
    const login = authSource.slice(
      authSource.indexOf('export async function getLoginState()'),
      authSource.indexOf('async function completeLogin('),
    );
    expect(login.indexOf('credentialStoreHealth.unavailable')).toBeLessThan(
      login.indexOf('await loadLoginProviders'),
    );
    expect(login).toContain(
      "state: { step: 'error', code: 'CREDENTIAL_STORE_UNAVAILABLE', recoverTo: 'identifier' }",
    );
  });


  it('transient-unreadable 分支喂失败计数并在翻转时广播,但仍保持瞬时语义', () => {
    const start = authSource.indexOf('export async function refresh(');
    const end = authSource.indexOf('const diskTokenChangedBeforeRefresh', start);
    const body = authSource.slice(start, end);

    // 升级钩子必须在 transient 分支内、且仍然 return false + 重排重试
    // (升级不改变「不强踢用户」的语义,只是多了状态广播)。
    expect(body).toContain('credentialStoreHealth.noteReadFailure()');
    const noteIdx = body.indexOf('credentialStoreHealth.noteReadFailure()');
    expect(noteIdx).toBeGreaterThan(body.indexOf('treating as transient'));
    // 注意 refresh body 更早处(realm manifest 分支)也调用了同名重排函数,
    // 必须取 noteReadFailure 之后的那一次。
    const retryAfterNote = body.indexOf('scheduleRefreshRetryAfterTransientFailure(refreshEpoch);', noteIdx);
    expect(retryAfterNote).toBeGreaterThan(noteIdx);
    // 升级不改变瞬时语义:transient 分支内不得出现实际的过期 / 清态调用
    // (匹配调用形态,避免误中提及函数名的注释)。
    const transientBranch = body.slice(body.indexOf('treating as transient'), retryAfterNote);
    expect(transientBranch).not.toContain('await expireRuntimeAuth(');
    expect(transientBranch).not.toContain('clearAuth(');
  });


  it('成功读到持久会话时喂恢复并在翻转时广播', () => {
    const start = authSource.indexOf('export async function refresh(');
    const end = authSource.indexOf('const diskTokenChangedBeforeRefresh', start);
    const body = authSource.slice(start, end);
    expect(body).toContain(
      'if (persistedSession !== null && credentialStoreHealth.noteRecovered())',
    );
  });


  it('clearAuth 整体清态时复位状态机', () => {
    const start = authSource.indexOf('function clearAuth(');
    const end = authSource.indexOf('commitActiveAppSession', start);
    const body = authSource.slice(start, end);
    expect(body).toContain('credentialStoreHealth.reset();');
  });


  it('AuthState 快照携带 credentialStoreUnavailable,登出投影恒为 false', () => {
    const snapStart = authSource.indexOf('function snapshotAuthState(): AuthState {');
    const snapEnd = authSource.indexOf('function snapshotLoggedOutAuthState', snapStart);
    expect(authSource.slice(snapStart, snapEnd)).toContain(
      'credentialStoreUnavailable: credentialStoreHealth.unavailable',
    );
    const loggedOutStart = snapEnd;
    const loggedOutEnd = authSource.indexOf('function notifyRenderer', loggedOutStart);
    expect(authSource.slice(loggedOutStart, loggedOutEnd)).toContain(
      'credentialStoreUnavailable: false',
    );
  });
});
