import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Regression guard for login progress that is intentionally owned by Electron main. */
describe('auth login-flow reset', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/main/authManager.ts'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
  const deviceLinkSource = readFileSync(
    resolve(process.cwd(), 'src/main/device-link/index.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const hookControlSource = readFileSync(
    resolve(process.cwd(), 'src/main/hook-control/ipc.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('clears renderer state, provider cache, and private tickets whenever auth is cleared', () => {
    const resetStart = source.indexOf('function resetLoginFlowState(): void {');
    const resetEnd = source.indexOf('\n}', resetStart);
    const resetBody = source.slice(resetStart, resetEnd);
    expect(resetBody).toContain('loginFlowState = null;');
    expect(resetBody).toContain('providerConfig = null;');
    expect(resetBody).toContain('discoveredMethods = [];');
    expect(resetBody).toContain('pendingAccountToken = null;');
    expect(resetBody).toContain('pendingLoginTicket = null;');
    expect(resetBody).toContain('pendingBindTicket = null;');
    expect(resetBody).toContain('pendingSsoVerificationTicket = null;');

    const clearStart = source.indexOf('function clearAuth(');
    const clearEnd = source.indexOf('\n}\n\n// ── Public API', clearStart);
    const clearBody = source.slice(clearStart, clearEnd);
    expect(clearBody).toContain('resetLoginFlowState();');
    expect(clearBody).toContain('canaryFlagStore.clear();');
  });

  it('keeps the login-epoch guard and does not resurrect the legacy feishu token chain', () => {
    const completeStart = source.indexOf('async function completeLogin(');
    const completeEnd = source.indexOf('\n}\n\nasync function acceptLoginOutcome', completeStart);
    const completeBody = source.slice(completeStart, completeEnd);
    expect(completeBody).toContain('if (authStateEpoch !== loginEpoch)');
    expect(completeBody).toContain('notifyRenderer();');
    // 防复活:主机飞书 token 链已随 refresh-feishu 退役(2026-07-17),
    // authManager 不得再接 FeishuTokenManager(飞书授权归 xd-feishu 意识
    // 的 OAuth broker 通道)。
    expect(source).not.toContain('getFeishuService');
    expect(source).not.toContain('setJwt(');
  });

  it('requires confirmation only when enterprise discovery crosses the build region', () => {
    const start = source.indexOf("if (action.type === 'discover-sso-org') {");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(
      start,
      source.indexOf("\n    if (action.type === 'request-code')", start),
    );
    expect(body).toContain('const methods = ssoOrgDiscoveryToMethods(discovery)');
    expect(body).toContain('if (discovery.region !== AUTH_REGION)');
    expect(body).toContain("type: 'realm-switch-required'");
    expect(body).toContain("type: 'discovery-loaded'");
    expect(body).toContain("email: ''");

    // 跨区连接只有 confirm action 才写入 start-browser 白名单；弹窗阶段不能
    // 通过伪造 connectionId 直接跳过确认。
    const confirmStart = source.indexOf("if (action.type === 'confirm-sso-realm') {");
    const confirmBody = source.slice(
      confirmStart,
      source.indexOf("\n    if (action.type === 'cancel-sso-realm')", confirmStart),
    );
    expect(confirmBody).toContain('discoveredMethods = confirmation.methods;');
    expect(confirmBody).toContain("type: 'discovery-loaded'");
  });

  it('clears stale organization realm state before personal login and a new discovery', () => {
    const discoveryStart = source.indexOf(
      'async function discoverOrganizationRealm(org: string)',
    );
    const discoveryBody = source.slice(
      discoveryStart,
      source.indexOf('\n}', discoveryStart),
    );
    expect(discoveryBody).toContain('pendingAuthRealm = null;');

    const actionStart = source.indexOf(
      'async function runLoginAction(action: DesktopLoginAction)',
    );
    const actionPreamble = source.slice(
      actionStart,
      source.indexOf('const stateBeforeAction', actionStart),
    );
    expect(actionPreamble).toContain("action.type === 'discover'");
    expect(actionPreamble).toContain("action.type === 'request-code'");
    expect(actionPreamble).toContain("action.type === 'verify-code'");
    expect(actionPreamble).toContain(
      "action.type === 'start-browser' && action.kind === 'social'",
    );
    expect(actionPreamble).toContain(
      'if (startsBuildRealmFlow) pendingAuthRealm = null;',
    );
  });

  it('does not leave expired private tickets on a screen that can only reuse them', () => {
    expect(source).toContain("'INVALID_LOGIN_TICKET',");
    expect(source).toContain("'INVALID_BIND_TICKET',");
    expect(source).toContain("'INVALID_SSO_VERIFICATION_TICKET',");
    expect(source).toContain("? { step: 'error', code, recoverTo: 'identifier' }");
  });

  it('keeps the account token in the login flow only and exchanges a resource token', () => {
    expect(source).toContain(
      "const LEGACY_ACCOUNT_REFRESH_TOKEN_KEY = 'cindy_auth_account_refresh_token';",
    );
    expect(source).toContain('let pendingAccountToken: string | null = null;');
    expect(source).toContain('client.exchangeAccountMembership(accountToken, action.accountId)');
    expect(source).not.toContain('.logoutAccount(');
    expect(source).not.toContain('accountSession');
    expect(source).not.toContain('writeSafe(LEGACY_ACCOUNT_REFRESH_TOKEN_KEY');
    expect(source).not.toContain('accountToken: accountAccessToken');

    const completeStart = source.indexOf('async function completeLogin(');
    const completeEnd = source.indexOf('\n}\n\nasync function acceptLoginOutcome', completeStart);
    expect(source.slice(completeStart, completeEnd)).toContain('pendingAccountToken = null;');

    const logoutStart = source.indexOf('export async function logout()');
    const logoutEnd = source.indexOf('\n}\n\n/**\n * Called on system resume', logoutStart);
    const logoutBody = source.slice(logoutStart, logoutEnd);
    expect(logoutBody).toContain('token: currentAccessToken');
    expect(logoutBody).not.toContain('pendingAccountToken');

    const getterStart = source.indexOf('export function getAccessToken(): string | null {');
    const getterEnd = source.indexOf('\n}', getterStart);
    const getterBody = source.slice(getterStart, getterEnd);
    expect(getterBody).toContain('return accessToken;');
    expect(getterBody).not.toContain('accountAccessToken');
  });

  it('never restores an account session during resource-token initialization', () => {
    const initializeStart = source.indexOf('export async function initialize(');
    const initializeEnd = source.indexOf('\n}\n\n/**\n * 冷启动 refresh 流程本体', initializeStart);
    const initializeBody = source.slice(initializeStart, initializeEnd);
    const authenticatedFastPath = initializeBody.indexOf('if (accessToken && currentUser)');

    expect(authenticatedFastPath).toBeGreaterThan(-1);
    expect(initializeBody).toContain('removeSafe(LEGACY_ACCOUNT_REFRESH_TOKEN_KEY);');
    expect(initializeBody).not.toContain('refreshAccount');
    expect(initializeBody).not.toContain('restoreAccountSelection');
  });

  it('returns a committed local session before reading or refreshing cloud credentials', () => {
    const initializeStart = source.indexOf('export async function initialize(');
    const initializeEnd = source.indexOf('\n}\n\n/**\n * 冷启动 refresh 流程本体', initializeStart);
    const initializeBody = source.slice(initializeStart, initializeEnd);
    const localGuard = initializeBody.indexOf("getActiveAppSession().mode === 'local'");
    const refreshTokenRead = initializeBody.indexOf('readPersistedAuthSession()');

    expect(localGuard).toBeGreaterThan(-1);
    expect(refreshTokenRead).toBeGreaterThan(localGuard);
    expect(initializeBody.slice(localGuard, refreshTokenRead)).toContain('return snapshotAuthState();');
  });

  it('drops a runtime refresh result after logout or a newer login changes auth generation', () => {
    const refreshStart = source.indexOf('export async function refresh(): Promise<boolean> {');
    const refreshEnd = source.indexOf('\n}\n\nexport async function logout()', refreshStart);
    const refreshBody = source.slice(refreshStart, refreshEnd);
    expect(refreshBody).toContain('const refreshEpoch = authStateEpoch;');
    expect(refreshBody).toContain("refreshWasSuperseded('after-refresh')");
    // 'after-product-me' 守卫点已随产品 /api/user/me 退役(2026-07):refresh
    // 与提交之间不再有产品资料网络往返,该迟到窗口不存在了。
    expect(refreshBody).not.toContain('/api/user/me');
    expect(refreshBody).toContain("refreshWasSuperseded('after-account-switch-teardown')");
    expect(refreshBody).toContain("refreshWasSuperseded('after-integration-reload')");
    expect(refreshBody).toContain("refreshWasSuperseded('catch')");
  });

  it('reconnects realm-bound main clients after a runtime realm change commits its new token', () => {
    const refreshStart = source.indexOf('export async function refresh(): Promise<boolean> {');
    const refreshEnd = source.indexOf('\n}\n\nexport async function logout()', refreshStart);
    const refreshBody = source.slice(refreshStart, refreshEnd);

    expect(refreshBody).toContain('const authRealmChanged = refreshRealm !== activeAuthRealm;');
    expect(refreshBody).toContain('writePersistedAuthSession(data.refreshToken, refreshRealm);');
    expect(refreshBody).toContain('activeAuthRealm = refreshRealm;');
    expect(refreshBody).toContain('previousUserId !== currentUser.id || authRealmChanged');
    expect(refreshBody).toContain('if (authRealmChanged) {\n        notifyAuthListeners();');

    expect(deviceLinkSource).toContain('restartDeviceLinkForAuthRealmChange();');
    expect(deviceLinkSource).toContain('void stopArbitrationAndTeardown()');
    expect(deviceLinkSource).toContain('authManager.getActiveAuthRealm() !== targetRealm');
    expect(hookControlSource).toContain('} else if (realmChanged) {');
    expect(hookControlSource).toContain('manager?.sync();');
  });

  it('tears down the owner boundary before notifying runtime auth expiry', () => {
    const helperStart = source.indexOf('async function expireRuntimeAuth(');
    const helperEnd = source.indexOf('\n}\n\n// ── Public API', helperStart);
    const helperBody = source.slice(helperStart, helperEnd);
    expect(helperBody).toContain('beginAppSessionBoundary()');
    expect(helperBody).toContain('notifyRendererAuthBoundaryPending();');
    expect(helperBody).toContain('clearAuth({ notify: false,');
    expect(helperBody).toContain('await accountSwitchTeardown');
    expect(helperBody).toContain('closeLocalDb();');
    expect(helperBody).toContain('notifyAuthListeners();');
    expect(helperBody).toContain('notifySessionExpired(reason);');

    const refreshStart = source.indexOf('export async function refresh(): Promise<boolean> {');
    const refreshEnd = source.indexOf('\n}\n\nexport async function logout()', refreshStart);
    const refreshBody = source.slice(refreshStart, refreshEnd);
    expect(refreshBody).toContain(
      'await expireRuntimeAuth(previousUserId, resolveSessionExpiredReason(code));',
    );
    expect(refreshBody).not.toContain('clearAuth({ notify: false });');
  });

  it('synchronizes canary flags on every path that establishes a new auth identity', () => {
    expect(source).not.toContain('canaryFlagStore.sync(false)');
    expect(source.match(/scheduleCanaryFlagSync\(\{/g)).toHaveLength(3);
    expect(source).toContain("getClientEndpoint('oauthBrokerApiBaseUrl')");
    expect(source).toContain("apiFetch('/api/user/feature-flags'");

    const syncStart = source.indexOf('function scheduleCanaryFlagSync(');
    const syncEnd = source.indexOf('\n}\n\n/**\n * 冷启动流程的进程内去重', syncStart);
    expect(syncEnd).toBeGreaterThan(syncStart);
    const syncBody = source.slice(syncStart, syncEnd);
    expect(syncBody).toContain("if (outcome.kind === 'synced')");
    expect(syncBody).toContain('notifyRenderer();');

    const clearIntegrationsStart = source.indexOf('async function clearPerAccountIntegrations(');
    const clearIntegrationsEnd = source.indexOf('\n}', clearIntegrationsStart);
    expect(source.slice(clearIntegrationsStart, clearIntegrationsEnd)).not.toContain(
      'canaryFlagStore.clear()',
    );
  });
});
