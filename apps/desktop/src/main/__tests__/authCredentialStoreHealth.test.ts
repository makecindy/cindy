import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CREDENTIAL_STORE_UNREADABLE_ESCALATION_THRESHOLD,
  createCredentialStoreHealth,
} from '../authCredentialStoreHealth';

/**
 * #1687:持久凭证库故障升级状态机。
 *
 * 守护的契约:refresh token 文件仍在但连续读不出时,不能无限 transient(此前
 * 该路径失败 14+ 小时零提示),也不能立即清空登录态(会重新引入「钥匙串抖动
 * 强制登出」的历史问题)。连续 N 次失败才升级、任何一次成功读取立即复位。
 */
describe('authCredentialStoreHealth', () => {
  it('阈值之前保持瞬时语义,不升级', () => {
    const health = createCredentialStoreHealth(5);
    for (let i = 0; i < 4; i++) {
      expect(health.noteReadFailure()).toBe(false);
      expect(health.unavailable).toBe(false);
    }
  });

  it('连续跨过阈值时恰好翻转一次(只广播一次)', () => {
    const health = createCredentialStoreHealth(3);
    expect(health.noteReadFailure()).toBe(false);
    expect(health.noteReadFailure()).toBe(false);
    expect(health.noteReadFailure()).toBe(true); // 第 3 次:翻转
    expect(health.unavailable).toBe(true);
    // 继续失败不再返回 true,避免每 60s 重复广播
    expect(health.noteReadFailure()).toBe(false);
    expect(health.unavailable).toBe(true);
  });

  it('失败与成功交替时永不升级(「连续」是全部语义)', () => {
    const health = createCredentialStoreHealth(3);
    for (let i = 0; i < 10; i++) {
      expect(health.noteReadFailure()).toBe(false);
      expect(health.noteReadFailure()).toBe(false);
      expect(health.noteRecovered()).toBe(false); // 未升级时恢复不返回翻转信号
      expect(health.unavailable).toBe(false);
    }
  });

  it('升级后一次成功读取立即恢复并返回翻转信号,再恢复不重复', () => {
    const health = createCredentialStoreHealth(2);
    health.noteReadFailure();
    expect(health.noteReadFailure()).toBe(true);
    expect(health.noteRecovered()).toBe(true); // 恢复:翻转,广播一次
    expect(health.unavailable).toBe(false);
    expect(health.noteRecovered()).toBe(false); // 已恢复,不重复广播
  });

  it('恢复后重新计数,再次连续失败可再次升级', () => {
    const health = createCredentialStoreHealth(2);
    health.noteReadFailure();
    health.noteReadFailure();
    health.noteRecovered();
    expect(health.noteReadFailure()).toBe(false); // 计数已清零
    expect(health.noteReadFailure()).toBe(true); // 再次连续跨过阈值
  });

  it('reset 无条件复位且不返回信号(登出整体清态用)', () => {
    const health = createCredentialStoreHealth(1);
    health.noteReadFailure();
    expect(health.unavailable).toBe(true);
    health.reset();
    expect(health.unavailable).toBe(false);
    // reset 后计数也清零
    expect(health.noteReadFailure()).toBe(true); // threshold=1,单次即翻转
  });

  it('默认阈值 × 60s 重试间隔 ≈ 5 分钟持续失败才升级', () => {
    expect(CREDENTIAL_STORE_UNREADABLE_ESCALATION_THRESHOLD).toBe(5);
  });
});

/**
 * authManager 接线守卫(authManager 依赖 Electron 无法直接 import,沿用
 * authSessionExpiredDetection.test.ts 的源码守卫模式)。
 */
describe('authManager credential-store escalation wiring', () => {
  const authSource = readFileSync(resolve(process.cwd(), 'src/main/authManager.ts'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );

  it('transient-unreadable 分支喂失败计数并在翻转时广播,但仍保持瞬时语义', () => {
    const start = authSource.indexOf('export async function refresh(): Promise<boolean> {');
    const end = authSource.indexOf('const diskTokenChangedBeforeRefresh', start);
    const body = authSource.slice(start, end);

    // 升级钩子必须在 transient 分支内、且仍然 return false + 重排重试
    // (升级不改变「不强踢用户」的语义,只是多了状态广播)。
    expect(body).toContain('credentialStoreHealth.noteReadFailure()');
    const noteIdx = body.indexOf('credentialStoreHealth.noteReadFailure()');
    expect(noteIdx).toBeGreaterThan(body.indexOf('treating as transient'));
    // 注意 refresh body 更早处(realm manifest 分支)也调用了同名重排函数,
    // 必须取 noteReadFailure 之后的那一次。
    const retryAfterNote = body.indexOf('scheduleRefreshRetryAfterTransientFailure();', noteIdx);
    expect(retryAfterNote).toBeGreaterThan(noteIdx);
    // 升级不改变瞬时语义:transient 分支内不得出现实际的过期 / 清态调用
    // (匹配调用形态,避免误中提及函数名的注释)。
    const transientBranch = body.slice(body.indexOf('treating as transient'), retryAfterNote);
    expect(transientBranch).not.toContain('await expireRuntimeAuth(');
    expect(transientBranch).not.toContain('clearAuth(');
  });

  it('成功读到持久会话时喂恢复并在翻转时广播', () => {
    const start = authSource.indexOf('export async function refresh(): Promise<boolean> {');
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
