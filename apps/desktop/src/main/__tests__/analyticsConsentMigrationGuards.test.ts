import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 存量同意迁移「关窗」链路的回归守卫。
 *
 * 为什么用源码守卫:`authManager.ts` 依赖 Electron(safeStorage / app),无法在 node
 * 测试环境直接 import 执行(沿用 authSessionExpiredDetection.test.ts 的既有模式);
 * 而 analyticsSettingsService.test.ts 里 authManager 是被 mock 掉的 —— 那边只能验证
 * 「假设探测结果是 X 时下游怎么走」,验证不到真实实现本身。这个文件补上后半截。
 *
 * 守护的契约(2026-07-28 review,两个方向都是隐私红线):
 *  1. 关窗判据必须区分「凭证确定不存在」与「暂时探不出来」。探不出来时保留窗口,
 *     否则 realm 清单不可用 / refresh 瞬态失败(两处都刻意保留 token)的真存量用户
 *     会被永久误判、永远拿不到同意迁移。
 *  2. 用户主动进入本地模式(跳过登录)是**无歧义**的确定性事件,必须绕过探测直接封窗。
 *     否则密钥链恰好不可用的那一刻,跳过登录用户探不出「凭证已删」→ 不关窗 → 之后
 *     走免协议 SSO 时会被静默迁移成「已同意」,等于未经同意打开采集。
 */
describe('legacy consent migration window guards', () => {
  const authSource = readFileSync(resolve(process.cwd(), 'src/main/authManager.ts'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
  const serviceSource = readFileSync(
    resolve(process.cwd(), 'src/main/analyticsSettingsService.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('hasNoPersistedAuthCredentials 覆盖 initialize 会消费的两个凭证 key', () => {
    const start = authSource.indexOf('export function hasNoPersistedAuthCredentials(): boolean {');
    expect(start).toBeGreaterThan(-1);
    const body = authSource.slice(start, authSource.indexOf('\n}\n', start));

    // initialize() 恢复登录时读的就是这两个:原子记录 + 旧格式 token(见
    // readPersistedAuthSession 与 initialize 里的 legacyToken 分支)。其余 LEGACY_*
    // key 只被 removeSafe 清理、从不读回,不影响「还能不能恢复登录」的判定。
    expect(body).toContain('isPersistedSecretAbsent(AUTH_SESSION_KEY)');
    expect(body).toContain('isPersistedSecretAbsent(LEGACY_RESOURCE_REFRESH_TOKEN_KEY)');
    // 必须两者同时缺席才算「没有凭证」。
    expect(body).toContain('&&');
  });

  it('hasNoPersistedAuthCredentials 复用 isPersistedSecretAbsent,不自造 existsSync 判定', () => {
    const start = authSource.indexOf('export function hasNoPersistedAuthCredentials(): boolean {');
    const body = authSource.slice(start, authSource.indexOf('\n}\n', start));

    // existsSync 对 EPERM/EACCES 同样返回 false,会把「没权限读」误判成「已删除」;
    // 也不得直接 readSafe(它把加密不可用/解密失败都折叠成 null = 看着像没凭证)。
    expect(body).not.toContain('existsSync');
    expect(body).not.toContain('readSafe');
    expect(body).not.toContain('readPersistedAuthSession');
  });

  it('冷启动关窗必须先过凭证闸,探测失败时保留窗口', () => {
    const start = serviceSource.indexOf('function closeMigrationWindowOrLog(): void {');
    expect(start).toBeGreaterThan(-1);
    const body = serviceSource.slice(start, serviceSource.indexOf('\n}\n', start));

    expect(body).toContain('if (!authManager.hasNoPersistedAuthCredentials())');
    // 闸不通过 = 直接 return,不得落盘。
    expect(body.indexOf('hasNoPersistedAuthCredentials')).toBeLessThan(
      body.indexOf('sealMigrationWindowOrLog()'),
    );
    // 探测自身抛错(密钥链异常)也按「结论不明确」处理,同样保留窗口。
    expect(body).toContain('keeping migration window open');
  });

  it('进入本地模式时直接封窗,不经过凭证探测闸', () => {
    const start = serviceSource.indexOf('export function initAnalyticsSettingsService(): void {');
    const body = serviceSource.slice(start, serviceSource.indexOf('ipcMain.handle(', start));

    // 用户主动跳过登录无歧义:调 seal(无条件),不是 close(带探测闸)。
    expect(body).toContain('if (authManager.isLocalMode()) sealMigrationWindowOrLog();');
    expect(body).not.toContain('closeMigrationWindowOrLog');
    // 封窗要发生在广播之前:广播出去的 allowed 必须已经反映本地模式。
    expect(body.indexOf('sealMigrationWindowOrLog()')).toBeLessThan(
      body.indexOf('broadcastSettingsChange()'),
    );
  });

  it('上报结论叠加本地模式运行时闸,且不写盘', () => {
    const start = serviceSource.indexOf('function isReportingAllowedNow(): boolean {');
    expect(start).toBeGreaterThan(-1);
    const body = serviceSource.slice(start, serviceSource.indexOf('\n}\n', start));

    expect(body).toContain('isAnalyticsAllowed()');
    expect(body).toContain('!authManager.isLocalMode()');
    // 闸是运行时的:不得在这里写 store(那会篡改用户的同意与开关这两个持久真相)。
    expect(body).not.toContain('setAnalyticsEnabled');
    expect(body).not.toContain('writePatch');

    // payload 必须消费这道闸,而不是裸的 isAnalyticsAllowed()。
    const payloadStart = serviceSource.indexOf(
      'export function analyticsSettingsPayload(): AnalyticsSettingsPayload {',
    );
    const payloadBody = serviceSource.slice(
      payloadStart,
      serviceSource.indexOf('\n}\n', payloadStart),
    );
    expect(payloadBody).toContain('allowed: isReportingAllowedNow()');
  });

  it('auth 订阅在 quit 与测试重置时都会退订', () => {
    expect(serviceSource).toContain('unsubscribeAuthState = authManager.onAuthStateChange(');

    const quitStart = serviceSource.indexOf("onQuit('analytics-settings', () => {");
    const quitBody = serviceSource.slice(quitStart, serviceSource.indexOf('});', quitStart));
    expect(quitBody).toContain('unsubscribeAuthState?.();');
    expect(quitBody).toContain('unsubscribeAuthState = null;');

    const resetStart = serviceSource.indexOf('resetForTests(): void {');
    const resetBody = serviceSource.slice(resetStart, serviceSource.indexOf('},', resetStart));
    expect(resetBody).toContain('unsubscribeAuthState?.();');

    // 订阅必须在 ipcRegistered 早返回之后 —— 否则二次 init 会重复订阅、重复广播。
    expect(serviceSource.indexOf('ipcRegistered = true;')).toBeLessThan(
      serviceSource.indexOf('unsubscribeAuthState = authManager.onAuthStateChange('),
    );
  });
});
