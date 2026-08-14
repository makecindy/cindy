import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 会话失效感知链路的回归守卫(authManager / device-link 依赖 Electron,无法在 node
 * 测试环境直接 import,沿用 authAccountDeletionLifecycle.test.ts 的源码守卫模式)。
 *
 * 守护的契约:任何「权威拒绝 / 凭证确定性失效」都必须汇入会话过期出口
 * (expireRuntimeAuth / invalidateSession → auth:session-expired 弹窗),不允许再有
 * 静默半死路径——2026-07-23 事故:共享 userData 的 dev 实例登出删掉磁盘 refresh
 * token 后,正式版进程自以为登录,模型源静默消失、device-link 无限 401。
 */
describe('desktop auth session-expiry detection', () => {
  const authSource = readFileSync(resolve(process.cwd(), 'src/main/authManager.ts'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
  const deviceLinkSource = readFileSync(
    resolve(process.cwd(), 'src/main/device-link/index.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('runtime refresh 发现磁盘 token 消失但会话活着时,按确定性失效走会话过期出口', () => {
    const start = authSource.indexOf('export async function refresh(): Promise<boolean> {');
    const end = authSource.indexOf('const diskTokenChangedBeforeRefresh', start);
    const body = authSource.slice(start, end);

    // 活会话 + 磁盘 token 缺失 → 不是 debug 跳过,而是 expireRuntimeAuth('credential-lost')。
    expect(body).toContain('if (currentUser !== null) {');
    expect(body).toContain("await expireRuntimeAuth(previousUserId, 'credential-lost', {");
    // 共享 userData 下另一个实例可能在登出→重登间隙写入了新 token:过期时不得删磁盘
    // token 文件(磁盘上已没有属于本进程的 token 可清,删了就是把别人踢成半死)。
    expect(body).toContain('preservePersistedRefreshToken: true');
    // 竞态守卫:logout 与 refresh 并发时让位给 logout 路径,不重复过期。
    expect(body).toContain("refreshWasSuperseded('missing-persisted-token')");
    // 防误踢:文件还在但读/解密失败(或加密暂不可用)是瞬时故障,按 transient 处理,
    // 不得 expireRuntimeAuth——否则密钥链一次抖动就会把有效用户强制登出。
    expect(body).toContain('isPersistedSecretAbsent(AUTH_SESSION_KEY)');
    expect(body).toContain('treating as transient');
    // 瞬时分支必须重排 refresh 重试:正常 timer 已触发过,不重排则密钥链/IO 抖动
    // 后有效会话在 access token 到期前没有任何后续 refresh(半死)。
    expect(body).toContain('scheduleRefreshRetryAfterTransientFailure();');
    expect(body.indexOf('isPersistedSecretAbsent(AUTH_SESSION_KEY)')).toBeLessThan(
      body.indexOf("await expireRuntimeAuth(previousUserId, 'credential-lost', {"),
    );
    // 无活会话(冷启动 / 已登出)保持静默跳过。
    expect(body).toContain("log.debug('runtime refresh skipped: no persisted refresh token');");
    // 顺序:活会话分支必须先于 debug 分支判定。
    expect(body.indexOf('if (currentUser !== null) {')).toBeLessThan(
      body.indexOf("log.debug('runtime refresh skipped: no persisted refresh token');"),
    );
  });

  it('clearAuth 在 preservePersistedRefreshToken 时不删除磁盘 refresh token 文件', () => {
    const start = authSource.indexOf('function clearAuth(');
    const end = authSource.indexOf('commitActiveAppSession', start);
    const body = authSource.slice(start, end);

    // 三个 refresh token 相关文件的删除必须整体收在 preserve 守卫之内。
    expect(body).toContain('if (!opts.preservePersistedRefreshToken) {');
    const guardIdx = body.indexOf('if (!opts.preservePersistedRefreshToken) {');
    expect(body.indexOf('removeSafe(AUTH_SESSION_KEY);')).toBeGreaterThan(guardIdx);
    expect(body.indexOf('removeSafe(LEGACY_RESOURCE_REFRESH_TOKEN_KEY);')).toBeGreaterThan(
      guardIdx,
    );
    expect(body.indexOf('removeSafe(LEGACY_ACCOUNT_REFRESH_TOKEN_KEY);')).toBeGreaterThan(guardIdx);
    expect(body.indexOf('removeSafe(LEGACY_REFRESH_TOKEN_KEY);')).toBeGreaterThan(guardIdx);

    // expireRuntimeAuth 必须把 preserve 选项透传给 clearAuth。
    const expireStart = authSource.indexOf('async function expireRuntimeAuth(');
    const expireEnd = authSource.indexOf('if (accountSwitchTeardown)', expireStart);
    const expireBody = authSource.slice(expireStart, expireEnd);
    expect(expireBody).toContain('preservePersistedRefreshToken: opts.preservePersistedRefreshToken');
  });

  it('isPersistedSecretAbsent 只在文件确定不存在(ENOENT)时判缺席', () => {
    const start = authSource.indexOf('function isPersistedSecretAbsent(key: string): boolean {');
    const end = authSource.indexOf('\n}\n', start);
    const body = authSource.slice(start, end);

    // 加密不可用不判缺席;existsSync 对 EPERM/EACCES 也返回 false,必须用
    // accessSync 并只认 ENOENT 为真缺席,其它错误一律按瞬时故障。
    expect(body).toContain('if (!safeStorage.isEncryptionAvailable()) return false;');
    expect(body).toContain('fs.accessSync(');
    expect(body).toContain("=== 'ENOENT'");
    expect(body).not.toContain('existsSync');
  });

  it('服务器确定性拒绝把失效码归类为展示 reason 后走会话过期出口', () => {
    // 锚定 runtime refresh 分支(cold-start 也有同名 if,用日志文案区分)。
    const anchor = authSource.indexOf('runtime refresh: definitive credential failure');
    const start = authSource.lastIndexOf("if (action.kind === 'definitive-failure') {", anchor);
    const end = authSource.indexOf("} else if (action.kind === 'replacement-retry') {", anchor);
    const body = authSource.slice(start, end);

    expect(body).toContain('await expireRuntimeAuth(previousUserId, resolveSessionExpiredReason(code));');
  });

  it('session-expired 广播携带客户端内部分类 reason,不透传服务端原文', () => {
    const start = authSource.indexOf('function notifySessionExpired(');
    const end = authSource.indexOf('\n}\n', start);
    const body = authSource.slice(start, end);

    expect(body).toContain("reason: SessionExpiredReason = 'unknown'");
    expect(body).toContain("broadcastToRenderers('auth:session-expired', { message: '', reason });");
  });

  it('invalidateSession 只显式归类 account-unavailable,其余走通用文案', () => {
    const start = authSource.indexOf('export function invalidateSession(');
    const end = authSource.indexOf('\n}\n\n/** Ensure a terminal auth teardown', start);
    const body = authSource.slice(start, end);

    expect(body).toContain(
      "notifySessionExpired(reason === 'account-unavailable' ? 'account-unavailable' : 'unknown');",
    );
    expect(body).toContain('await withAccountFreeOwnerCommit({');
    expect(body).toContain('clearOnFailure: true');
  });

  it('device-link 收到 relay auth-failed 时主动 refresh,把被顶下线汇入会话过期出口', () => {
    // 接线:onConnectionIssue 的 auth-failed 分支调用自救函数(broadcast 行内含 '});',
    // 不能直接拿它当切片终点,锚到下一个订阅器)。
    const issueStart = deviceLinkSource.indexOf('client.onConnectionIssue((issue) => {');
    const issueEnd = deviceLinkSource.indexOf('client.onPresenceChanged', issueStart);
    const issueBody = deviceLinkSource.slice(issueStart, issueEnd);
    expect(issueBody).toContain("if (issue?.kind === 'auth-failed') recoverFromRelayAuthFailure();");

    // 自救函数:节流(token-rotating 端点不能每次重连都打)+ refresh 成功后立即重连。
    const recoverStart = deviceLinkSource.indexOf('function recoverFromRelayAuthFailure(): void {');
    const recoverEnd = deviceLinkSource.indexOf('\n}\n', recoverStart);
    const recoverBody = deviceLinkSource.slice(recoverStart, recoverEnd);
    expect(recoverBody).toContain('elapsed < RELAY_AUTH_RECOVERY_MIN_INTERVAL_MS');
    // 节流窗内必须补排延迟自救:client 对同类 issue 去重不重复通知,直接 return
    // 会让自救在首次尝试后永久停摆,退回无限 401。延迟触发前复查 issue 仍在,
    // 避免已自愈后多余轮换 token。
    expect(recoverBody).toContain('relayAuthRecoveryRetryTimer = setTimeout(');
    expect(recoverBody).toContain("client?.getConnectionIssue()?.kind !== 'auth-failed'");
    expect(recoverBody).toContain('authManager');
    expect(recoverBody).toContain('.refresh()');
    expect(recoverBody).toContain("client?.connectNow('relay-auth-recovered');");
    // refresh 在途期间持有权可能已被别的实例夺走(teardown 已停 client):connectNow
    // 会把已停的 client 拉活绕过仲裁,重连前必须重新确认 isOwner。
    expect(recoverBody).toContain('arbiter?.isOwner()');

    // teardown 必须清掉延迟自救 timer,避免登出/掉持有权后迟到触发。
    const teardownStart = deviceLinkSource.indexOf('function teardownActiveLink(): void {');
    const teardownEnd = deviceLinkSource.indexOf('\n}\n', teardownStart);
    const teardownBody = deviceLinkSource.slice(teardownStart, teardownEnd);
    expect(teardownBody).toContain('clearTimeout(relayAuthRecoveryRetryTimer);');
  });

  it('routes replacement refresh through the durable Ghost projection owner boundary', () => {
    const refreshStart = authSource.indexOf('export async function refresh(): Promise<boolean> {');
    const refreshEnd = authSource.indexOf('\n}\n\nexport async function logout()', refreshStart);
    const refreshBody = authSource.slice(refreshStart, refreshEnd);

    expect(authSource).toContain('withGhostSkillProjectionOwnerCommit,');
    expect(authSource).toContain("from './authBoundaryQuarantine.js';");
    expect(refreshBody).toContain('writePersistedAuthSession(data.refreshToken, refreshRealm);');
    expect(refreshBody).toContain('await withCloudOwnerCommit({');
    expect(refreshBody).toContain('nextOwnerId: nextUser.id');
    expect(refreshBody.indexOf('writePersistedAuthSession(data.refreshToken, refreshRealm);')).toBeLessThan(
      refreshBody.indexOf('await withCloudOwnerCommit({'),
    );
  });

  it('keeps the Ghost sweep inside the shared owner state machine', () => {
    const ghostSource = readFileSync(
      resolve(process.cwd(), 'src/main/cindy-brain/index.ts'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const start = ghostSource.indexOf('export async function suspendAllGhosts(): Promise<void> {');
    const end = ghostSource.indexOf('\n}\n', start);
    const body = ghostSource.slice(start, end);

    expect(body).toContain('await removeGhostSkillLinksForRoots(listGhostOwnerProjectionRoots())');
    expect(body).toContain('throw new Error(`ghost owner skill cleanup incomplete');
    expect(body).not.toContain('AuthBoundaryQuarantine');

    expect(ghostSource).toContain('await withGhostSkillProjectionReconcile(');
    expect(ghostSource).toContain('releaseLease = beginGhostMutation(owner);');
    expect(ghostSource.indexOf('await withGhostSkillProjectionReconcile(')).toBeLessThan(
      ghostSource.indexOf('releaseLease = beginGhostMutation(owner);'),
    );
  });

  it('requires every Ghost runtime lookup to match the durable projection owner', () => {
    const ghostSource = readFileSync(
      resolve(process.cwd(), 'src/main/cindy-brain/index.ts'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const start = ghostSource.indexOf('export function isGhostAvailableForActiveSession(');
    const end = ghostSource.indexOf('\n}\n', start);
    const body = ghostSource.slice(start, end);
    expect(body).toContain('isGhostSkillProjectionBoundaryStableForOwner(activeOwner)');

    const requireStart = ghostSource.indexOf('function requireGhostAvailableForActiveSession(');
    const requireEnd = ghostSource.indexOf('\n}\n', requireStart);
    const requireBody = ghostSource.slice(requireStart, requireEnd);
    expect(requireBody).toContain("throwIpcError(\n        'PRECONDITION_FAILED'");
    expect(requireBody).toContain('isAppSessionBoundaryPending()');
    // A durable Ghost owner mismatch must stay a retryable precondition error
    // (not a misleading PERMISSION_DENIED) even when the App session itself is
    // not switching. The owner-stable check has to sit inside the
    // PRECONDITION_FAILED branch, so require it to appear before the
    // PERMISSION_DENIED throw — otherwise a regression that moves it into the
    // permission branch would still pass a mere toContain.
    const ownerStableIndex = requireBody.indexOf('!isGhostSkillProjectionBoundaryStableForOwner(activeOwner)');
    const permissionDeniedIndex = requireBody.indexOf("'PERMISSION_DENIED'");
    expect(ownerStableIndex).toBeGreaterThan(-1);
    expect(permissionDeniedIndex).toBeGreaterThan(-1);
    expect(ownerStableIndex).toBeLessThan(permissionDeniedIndex);
  });
});
