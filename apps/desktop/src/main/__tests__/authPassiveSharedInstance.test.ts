import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 共享 userData 的 passive dev 实例对 auth 凭证保持只读的回归守卫(authManager 依赖
 * Electron,node 测试环境无法直接 import,沿用 authSessionExpiredDetection.test.ts 的
 * 源码守卫模式)。
 *
 * 守护的契约:passive 共享实例可以**用**登录态,但不得**删除 / 作废 / 消费**整机共享
 * 的 auth 持久状态——refresh token 文件、服务端 device token(登出会连坐作废)、
 * relogin marker(一次性,被消费掉 primary 就看不到)、canary flag、账号删除 receipt。
 *
 * 约束的是破坏性动作,不是已知 realm 会话的轮换写回:passive 照常续期并写回
 * 有效的新 token,primary 侧由 replacement-retry 消化。但旧版裸 token 格式没有 realm,
 * passive 无权猜测并把它迁移成本区会话。
 *
 * 2026-07-27 事故:两个 MIGRATE_FAILED 的 passive 实例(05:30 与 07:51)在 LocalDbGate
 * fatal 界面点「返回登录」,logout 删掉整机 refresh token;正在使用的 primary 分别在
 * 19 / 46 分钟后的 refresh 周期被判 credential-lost 强制重登,当场还中断了在跑的
 * scheduler run、IM 连接与 device-link 持有权。同源事故 2026-07-23 已发生过一次,当时
 * 只把静默半死改成明确弹重登(正确的报警),没有堵住 passive 的写入权。
 */
describe('passive shared-userData instance auth isolation', () => {
  const authSource = readFileSync(
    resolve(process.cwd(), 'src/main/authManager.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const bootstrapSource = readFileSync(
    resolve(process.cwd(), 'src/main/bootstrap-electron.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  const sliceBody = (startAnchor: string, endAnchor: string): string => {
    const start = authSource.indexOf(startAnchor);
    expect(start, `anchor not found: ${startAnchor}`).toBeGreaterThan(-1);
    const end = authSource.indexOf(endAnchor, start);
    expect(end, `end anchor not found: ${endAnchor}`).toBeGreaterThan(start);
    return authSource.slice(start, end);
  };

  it('判定复用启动期已落地的 XDT_PASSIVE_SHARED_USER_DATA,且 packaged 无条件排除', () => {
    const body = sliceBody('function isPassiveSharedUserDataInstance(): boolean {', '\n}\n');

    // packaged 恒不设置该 env,但仍保留 isPackaged 双保险,防 ambient env 污染线上语义。
    expect(body).toContain('!app.isPackaged');
    expect(body).toContain("process.env.XDT_PASSIVE_SHARED_USER_DATA === '1'");
    // 不新增判定通道:是否共库由启动期 profileKind 落地成这个 env,本函数只读结果。
    expect(body).not.toContain('XDT_ISOLATED');
  });

  it('DEVICE_MISMATCH 只登出本进程,不删磁盘 refresh token', () => {
    expect(authSource).toContain("action.kind === 'foreign-device'");
    expect(authSource).toContain(
      'cold-start refresh: DEVICE_MISMATCH — this process starts logged out and keeps the persisted refresh token',
    );
    expect(authSource).toContain(
      'runtime refresh: DEVICE_MISMATCH — expiring this process and keeping the persisted refresh token',
    );
    const runtimeIdx = authSource.indexOf(
      'runtime refresh: DEVICE_MISMATCH — expiring this process and keeping the persisted refresh token',
    );
    const preserveIdx = authSource.indexOf('preservePersistedRefreshToken: true', runtimeIdx);
    expect(preserveIdx).toBeGreaterThan(runtimeIdx);
    expect(authSource).toContain('let foreignDeviceLocalSignOut = false');
    expect(authSource).toContain('foreignDeviceLocalSignOut = true');
    expect(authSource).toContain('if (foreignDeviceLocalSignOut) {');
  });

  it('clearAuth:passive 共享实例不删磁盘 refresh token', () => {
    const body = sliceBody('function clearAuth(', 'commitActiveAppSession');

    const guardIdx = body.indexOf('if (!opts.preservePersistedRefreshToken) {');
    const passiveIdx = body.indexOf('if (isPassiveSharedUserDataInstance()) {');
    expect(guardIdx).toBeGreaterThan(-1);
    // passive 判定必须落在 opts 守卫之内、四个 removeSafe 之前——即显式 preserve 与
    // passive 身份是两道独立的闸,任一命中都不得删盘。
    expect(passiveIdx).toBeGreaterThan(guardIdx);
    expect(body.indexOf('removeSafe(AUTH_SESSION_KEY);')).toBeGreaterThan(passiveIdx);
    expect(body.indexOf('removeSafe(LEGACY_RESOURCE_REFRESH_TOKEN_KEY);')).toBeGreaterThan(
      passiveIdx,
    );
    expect(body.indexOf('removeSafe(LEGACY_ACCOUNT_REFRESH_TOKEN_KEY);')).toBeGreaterThan(
      passiveIdx,
    );
    expect(body.indexOf('removeSafe(LEGACY_REFRESH_TOKEN_KEY);')).toBeGreaterThan(passiveIdx);
  });

  it('logout:passive 共享实例不切号或调服务端登出(会连坐作废 primary 的 device token)', () => {
    const body = sliceBody('export async function logout(): Promise<void> {', '\n}\n');

    // refresh token 服务端按 (user, device) 一对一存,passive 与 primary 共用 deviceId:
    // guard 必须在任何账号切换、凭证写入和服务端撤销之前直接拒绝。
    const guardIdx = body.indexOf('if (isPassiveSharedUserDataInstance()) {');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(body.indexOf('await switchSavedAccount(')).toBeGreaterThan(guardIdx);
    expect(body.indexOf('await mutateAuthAccountVault(')).toBeGreaterThan(guardIdx);
    expect(body.indexOf('revokeLoggedOutAccountBestEffort({')).toBeGreaterThan(guardIdx);

    const revokeBody = sliceBody('function revokeLoggedOutAccountBestEffort(', '\n}\n');
    expect(revokeBody).toContain("apiFetch('/api/auth/logout'");
  });

  it('续期节奏不设闸门:passive 照常排 timer,否则 access token 过期后无自愈路径', () => {
    // 本 PR 的契约是「不写/不删共享的 auth 持久状态」;「谁负责续期」是正交问题。
    // 曾经让 passive 停止续期，被两个 reviewer 从相反方向指出问题：停掉之后
    // access token 过期就再无替换途径（primary 的续期只更新磁盘 token，不更新本
    // 进程内存态），而 updateServerProfile 等直接走 apiFetch 的路径没有 401
    // refresh/retry，会一直失败到进程重启——resume 也救不了，系统不休眠就不触发。
    // 轮换本身不会踢人（primary 侧 replacement-retry 兜底），踢人的是删除凭证。
    const scheduleBody = sliceBody('function scheduleRefresh(token: string): void {', '\n}\n');
    expect(scheduleBody).not.toContain('if (isPassiveSharedUserDataInstance()) {');
    expect(scheduleBody).toContain('refreshTimer = setTimeout(');

    const retryBody = sliceBody(
      'function scheduleRefreshRetryAfterTransientFailure(): void {',
      '\n}\n',
    );
    expect(retryBody).not.toContain('isPassiveSharedUserDataInstance');
    expect(retryBody).toContain('refreshTimer = setTimeout(');
  });

  it('refresh 本身不被 passive 拦:冷启动仍能换 access token,凭证缺席仍走过期出口', () => {
    const body = sliceBody(
      'export async function refresh(): Promise<boolean> {',
      'const diskTokenChangedBeforeRefresh',
    );

    // passive 需要冷启动那一次 refresh 才有可用会话;拦掉 refresh() 本身会让它拿不到
    // access token。闸门只加在「写/删共享持久状态」上,不加在 refresh 入口。
    expect(body).not.toContain('isPassiveSharedUserDataInstance');
    // 且 passive 被 primary 换掉 token 时仍明确过期(只影响本进程、不删盘),
    // 不得退回 2026-07-23 那种静默半死。
    expect(body).toContain("await expireRuntimeAuth(previousUserId, 'credential-lost', {");
    expect(body).toContain('preservePersistedRefreshToken: true');
  });

  it('唤醒续期同样不设闸门', () => {
    const body = sliceBody('export function handleResume(): void {', '\n}\n');
    expect(body).not.toContain('isPassiveSharedUserDataInstance');
    expect(body).toContain('refresh();');
  });

  it('登出墓碑:passive 本地登出后 initialize 不得用 primary 的 token 登回来', () => {
    const clearBody = sliceBody('function clearAuth(', 'commitActiveAppSession');
    const passiveIdx = clearBody.indexOf('if (isPassiveSharedUserDataInstance()) {');
    // 墓碑必须和「保留磁盘 token」在同一分支里立起来。
    expect(clearBody.indexOf('passiveLocalSignOut = true;')).toBeGreaterThan(passiveIdx);

    const initBody = sliceBody(
      'export async function initialize(options: AuthInitializeOptions = {}): Promise<AuthState> {',
      'const reloginFlag = readReloginFlag();',
    );
    expect(initBody).toContain('if (passiveLocalSignOut) {');
    // 早退必须发生在读持久化 token 之前。
    expect(initBody).toContain('return snapshotLoggedOutAuthState();');

    // 显式登录解除墓碑，否则 passive 上登出后就再也登不回来。
    expect(authSource).toContain('passiveLocalSignOut = false;');
  });

  it('稳定登录的 passive initialize 不修复或消费本机 owner 预留', () => {
    const start = authSource.indexOf('// This owner is already durably authenticated.');
    const end = authSource.indexOf(
      'migrateLocalProviderBindingsAfterCloudCommit(currentUser.id);',
      start,
    );
    const body = authSource.slice(start, end);

    const passiveGuard = body.indexOf('if (!isPassiveSharedUserDataInstance()) {');
    const repair = body.indexOf('repairStableCloudOwnerDataReservations(currentUser.id);');
    expect(passiveGuard).toBeGreaterThan(-1);
    expect(repair).toBeGreaterThan(passiveGuard);
    expect(body.indexOf('commitCloudAppSession(currentUser.id);')).toBeGreaterThan(repair);

    const migrationHelper = sliceBody(
      'async function migrateLocalProviderBindingsAfterCloudCommit(ownerId: string): Promise<void> {',
      '\n}\n',
    );
    expect(migrationHelper).toContain('if (isPassiveSharedUserDataInstance()) return;');

    const beforeEnsureReadyStart = bootstrapSource.indexOf(
      'beforeEnsureReady: async (userId) => {',
    );
    const beforeEnsureReadyEnd = bootstrapSource.indexOf(
      '\n    },\n    onReady:',
      beforeEnsureReadyStart,
    );
    const beforeEnsureReady = bootstrapSource.slice(beforeEnsureReadyStart, beforeEnsureReadyEnd);
    const dbPassiveGuard = beforeEnsureReady.indexOf(
      'if (authManager.isPassiveSharedUserDataInstance()) {',
    );
    expect(dbPassiveGuard).toBeGreaterThan(-1);
    const passivePreflight = beforeEnsureReady.indexOf(
      'inspectPassiveLocalProfileAdoption(',
      dbPassiveGuard,
    );
    expect(passivePreflight).toBeGreaterThan(dbPassiveGuard);
    const passiveDepsEnd = beforeEnsureReady.indexOf('\n          ),', passivePreflight);
    const passiveDeps = beforeEnsureReady.slice(passivePreflight, passiveDepsEnd);
    expect(passiveDeps).toContain('() => hasExclusiveSharedLegacyUserDataAccess()');
    expect(
      beforeEnsureReady.indexOf("if (passivePreflight.status === 'required')", passivePreflight),
    ).toBeGreaterThan(passivePreflight);
    expect(beforeEnsureReady.indexOf('throw new Error(', passivePreflight)).toBeGreaterThan(
      passivePreflight,
    );
    const exclusiveAdoptionGate = beforeEnsureReady.lastIndexOf(
      '() => hasExclusiveSharedLegacyUserDataAccess()',
    );
    expect(exclusiveAdoptionGate).toBeGreaterThan(dbPassiveGuard);
    expect(beforeEnsureReady.indexOf('runLegacyUserDataMigrationForUser(user.id)')).toBeGreaterThan(
      dbPassiveGuard,
    );
    expect(beforeEnsureReady.indexOf('adoptLocalProfileDatabase(')).toBeGreaterThan(dbPassiveGuard);
    expect(exclusiveAdoptionGate).toBeGreaterThan(
      beforeEnsureReady.indexOf('adoptLocalProfileDatabase('),
    );
    const adoptionFailure = beforeEnsureReady.indexOf(
      "if (localProfileMigration.status === 'failed') {",
    );
    expect(adoptionFailure).toBeGreaterThan(dbPassiveGuard);
    expect(beforeEnsureReady.indexOf('throw new Error(', adoptionFailure)).toBeGreaterThan(
      adoptionFailure,
    );
    expect(beforeEnsureReady).not.toContain('continuing with cloud database');
  });

  it('relogin marker:passive 不消费整机一份的 marker,也不删 primary 的 token', () => {
    const start = authSource.indexOf('const reloginFlag = readReloginFlag();');
    const end = authSource.indexOf('// Old Feishu-auth refresh tokens', start);
    const body = authSource.slice(start, end);

    // marker 一次性且整机一份：passive 消费掉，primary 就永远看不到这次
    // requireRelogin；顺带删掉的又正是 primary 的 token。清理与消费必须整体落在
    // 非 passive 分支里。
    const passiveIdx = body.indexOf('if (isPassiveSharedUserDataInstance()) {');
    expect(passiveIdx).toBeGreaterThan(-1);
    expect(body.indexOf('removeSafe(AUTH_SESSION_KEY);')).toBeGreaterThan(passiveIdx);
    expect(body.indexOf('removeSafe(LEGACY_RESOURCE_REFRESH_TOKEN_KEY);')).toBeGreaterThan(
      passiveIdx,
    );
    expect(body.indexOf('clearReloginFlag();')).toBeGreaterThan(passiveIdx);
  });

  it('legacy 凭证清理:passive 启动不得删掉老构建 primary 可能还在用的文件', () => {
    const start = authSource.indexOf('// Old Feishu-auth refresh tokens');
    const end = authSource.indexOf('const storedToken = persistedSession.refreshToken;', start);
    const body = authSource.slice(start, end);

    // dev + packaged 共库双开是受支持的场景（--preserve-running）：老构建的 primary
    // 可能仍在消费三个 legacy 文件，passive 不能删除它们，也不能给没有
    // realm 的裸 token 擅自分区。
    expect(body).toContain('if (!isPassiveSharedUserDataInstance()) {');
    const guardIdx = body.indexOf('if (!isPassiveSharedUserDataInstance()) {');
    expect(body.indexOf('removeSafe(LEGACY_REFRESH_TOKEN_KEY);')).toBeGreaterThan(guardIdx);
    expect(body.indexOf('removeSafe(LEGACY_ACCOUNT_REFRESH_TOKEN_KEY);')).toBeGreaterThan(guardIdx);
    const legacyTokenIdx = body.indexOf(
      'const legacyToken = readSafe(LEGACY_RESOURCE_REFRESH_TOKEN_KEY);',
    );
    const ambiguousRealmGuardIdx = body.indexOf(
      'if (legacyToken && isPassiveSharedUserDataInstance()) {',
      legacyTokenIdx,
    );
    expect(ambiguousRealmGuardIdx).toBeGreaterThan(legacyTokenIdx);
    const migrationWriteIdx = body.indexOf(
      'writePersistedAuthSession(legacyToken, AUTH_REGION)',
      legacyTokenIdx,
    );
    expect(migrationWriteIdx).toBeGreaterThan(ambiguousRealmGuardIdx);
    const passiveBranch = body.slice(ambiguousRealmGuardIdx, migrationWriteIdx);
    expect(passiveBranch).toContain('passiveLocalSignOut = true;');
    expect(passiveBranch).toContain("commitActiveAppSession('signed-out');");
    expect(passiveBranch).toContain('return snapshotLoggedOutAuthState();');
    expect(passiveBranch).not.toContain('writePersistedAuthSession');
    expect(passiveBranch).not.toContain('removeSafe(');
    expect(body.indexOf('removeSafe(LEGACY_RESOURCE_REFRESH_TOKEN_KEY);')).toBeGreaterThan(
      migrationWriteIdx,
    );
  });

  it('其余整机一份的账号派生状态:canary flag 与账号删除 receipt 都不被 passive 清掉', () => {
    const clearBody = sliceBody('function clearAuth(', 'clearPerAccountIntegrationsInBackground');
    // canary-flag.json 被清 → packaged primary 下次更新轮询按 stable 拉 manifest。
    expect(clearBody).toContain('if (!isPassiveSharedUserDataInstance()) {');
    const canaryGuardIdx = clearBody.indexOf('if (!isPassiveSharedUserDataInstance()) {');
    expect(clearBody.indexOf('canaryFlagStore.clear();')).toBeGreaterThan(canaryGuardIdx);

    // receipt 被清 → primary 的 confirmAccountDeletion() 拿 RECEIPT_MISSING。
    // 闸门必须加在 logout 这条隐式路径上，而不是函数体里。
    const logoutBody = sliceBody('export async function logout(): Promise<void> {', '\n}\n');
    const receiptGuardIdx = logoutBody.indexOf('if (isPassiveSharedUserDataInstance()) {');
    expect(receiptGuardIdx).toBeGreaterThan(-1);
    expect(logoutBody.indexOf('clearAccountDeletionReceipt();')).toBeGreaterThan(receiptGuardIdx);
  });

  it('receipt 的显式清理不被闸门波及:renderer 主动 dismiss 在 passive 上必须照常生效', () => {
    // clearAccountDeletionReceipt() 经 auth:account-deletion:clear-receipt 暴露给
    // renderer（登录页处理无效/已取消挑战、dismiss 已完成状态）。把整个函数禁掉会让
    // receipt 永远留在盘上，snapshotAuthState() 每次启动又报出来，dismiss 不掉。
    const body = sliceBody('export function clearAccountDeletionReceipt(): void {', '\n}\n');
    expect(body).not.toContain('isPassiveSharedUserDataInstance');
    expect(body).toContain('removeSafe(ACCOUNT_DELETION_RECEIPT_KEY);');
  });

  it('passive 登录不得在 owner gate 前消费共享 receipt 或 relogin marker', () => {
    const acceptStart = authSource.indexOf('async function acceptLoginOutcome(');
    const acceptEnd = authSource.indexOf('\n}\n\nasync function runLoginAction', acceptStart);
    const acceptBody = authSource.slice(acceptStart, acceptEnd);
    expect(acceptBody).not.toContain('removeSafe(ACCOUNT_DELETION_RECEIPT_KEY);');
    expect(acceptBody).not.toContain('commitWithClearedAccountDeletionReceipt(');

    const completeStart = authSource.indexOf('async function completeLogin(');
    const completeEnd = authSource.indexOf(
      '\n}\n\nasync function acceptLoginOutcome',
      completeStart,
    );
    const completeBody = authSource.slice(completeStart, completeEnd);
    const completeGuard = completeBody.indexOf('if (!isPassiveSharedUserDataInstance()) {');
    expect(completeGuard).toBeGreaterThan(-1);
    expect(completeBody.indexOf('removeSafe(LEGACY_REFRESH_TOKEN_KEY);')).toBeGreaterThan(
      completeGuard,
    );
    expect(completeBody).toContain('commitWithClearedAccountDeletionReceipt(() => {');
    expect(completeBody.indexOf('clearReloginFlag();')).toBeGreaterThan(completeGuard);

    const receiptCommit = sliceBody(
      'function commitWithClearedAccountDeletionReceipt(commit: () => void): void {',
      '\n}\n',
    );
    expect(receiptCommit).toContain('if (isPassiveSharedUserDataInstance()) return commit();');
  });

  it('冷启动确定性失效:passive 不删盘,非 passive 也只做 compare-and-delete', () => {
    const start = authSource.indexOf("if (action.kind === 'definitive-failure') {");
    const end = authSource.indexOf("} else if (action.kind === 'replacement-retry') {", start);
    const body = authSource.slice(start, end);

    // passive 冷启动拿到 INVALID_REFRESH_TOKEN，最常见的原因就是 primary 刚轮换过它。
    expect(body).toContain('if (isPassiveSharedUserDataInstance()) {');
    // 删除本身抽到了 clearConfirmedDeadRefreshTokens（它同时清 v1 与 legacy 从属副本，
    // 并逐一比对本轮被拒过的每一枚 token）。这里只守住「非 passive 分支才调它、且分支内
    // 不出现任何无条件删除」。
    expect(body).toContain('clearConfirmedDeadRefreshTokens(storedRealm,');
    expect(body).not.toContain('removeSafe(AUTH_SESSION_KEY);');
    const cleanup = sliceBody('function clearConfirmedDeadRefreshTokens(', '\n}\n');
    // 非 passive 也不能无条件删：判定与删除之间另一个实例可能写入了替换凭证。
    // 断言分段写：prettier 会按行宽把这个调用拆成多行。
    expect(cleanup).toContain('removeSafeIfUnchanged(');
    expect(cleanup).toContain('serializeAuthSessionRecord(realm, token)');
    expect(cleanup).not.toContain('removeSafe(AUTH_SESSION_KEY);');
    // 三种结果各自如实记日志，尤其 'failed' 不得报成已清理。
    expect(cleanup).toContain("case 'deleted':");
    expect(cleanup).toContain("case 'changed':");
    expect(cleanup).toContain("case 'failed':");

    // compare-and-delete 读不出磁盘内容时不得删（宁留失效 token 也不误删有效凭证），
    // 并且要在内容比对前后各校验一次文件身份，收紧 read→unlink 之间的 TOCTOU。
    const helper = sliceBody(
      'function removeSafeIfUnchanged(key: string, expected: string): RemoveIfUnchangedResult {',
      '\n}\n',
    );
    expect(helper).toContain("if (readSafe(key) !== expected) return 'changed';");
    expect(helper).toContain('const before = identity();');
    // stat 失败要分开归类：ENOENT = 目标状态已达成（deleted），其它错误 = 不敢动（failed）。
    // 都折叠成 'changed' 会让调用点打出「token changed meanwhile」这种不实日志。
    expect(helper).toContain("if (before.kind === 'absent') return 'deleted';");
    expect(helper).toContain("if (before.kind === 'error') return 'failed';");
    expect(helper).toContain("if (after.kind === 'absent') return 'deleted';");
    expect(helper).toContain("if (after.kind === 'error') return 'failed';");
    expect(helper).toContain("if (after.id !== before.id) return 'changed';");
    expect(helper.indexOf("if (after.id !== before.id) return 'changed';")).toBeLessThan(
      helper.indexOf('fs.unlinkSync(filepath);'),
    );

    // 删除失败必须如实回报：removeSafe() 吞掉所有 unlink 错误，用它会让调用方把
    // 「没删成」当成「已清理」并据此打日志。ENOENT 例外——目标状态已达成。
    expect(helper).not.toContain('removeSafe(key);');
    expect(helper).toContain(
      "if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 'deleted';",
    );
    expect(helper).toContain("return 'failed';");
  });

  it('relogin marker:passive 不消费 marker,但同样保持登出(不得拿旧 token 登进去)', () => {
    const start = authSource.indexOf('const reloginFlag = readReloginFlag();');
    const end = authSource.indexOf('// Old Feishu-auth refresh tokens', start);
    const body = authSource.slice(start, end);

    // marker 命中 = 这个版本要求重新登录。passive 跑的是同一个版本，不消费 marker
    // 不等于可以拿旧 token 冷启动登进去——那正是 marker 想避免的。
    const passiveIdx = body.indexOf('if (isPassiveSharedUserDataInstance()) {');
    expect(passiveIdx).toBeGreaterThan(-1);
    const passiveBranch = body.slice(passiveIdx, body.indexOf('lastAcceptedRefreshToken = null;'));
    expect(passiveBranch).toContain('passiveLocalSignOut = true;');
    expect(passiveBranch).toContain('return snapshotLoggedOutAuthState();');
    // 但这条分支里不得出现任何删除或 marker 消费。
    expect(passiveBranch).not.toContain('removeSafe(');
    expect(passiveBranch).not.toContain('clearReloginFlag();');
  });
});
