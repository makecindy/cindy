import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { shouldTeardownColdStartRuntime } from '../authColdStartBoundary';

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
    expect(completeBody).toContain(
      'if (authStateEpoch !== loginEpoch || loginFlowEpoch !== expectedLoginFlowEpoch)',
    );
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
    // 唯一 SSO 不在 main 里套 start-browser：否则 renderer 要等整段浏览器
    // 授权结束才拿得到下一步，确认框会卡住。waiting 投影归 renderer。
    expect(body).not.toContain('soleAutoStartSsoMethod');
    expect(body).not.toContain("type: 'start-browser'");

    // 跨区连接只有 confirm action 才写入 start-browser 白名单；弹窗阶段不能
    // 通过伪造 connectionId 直接跳过确认。
    const confirmStart = source.indexOf("if (action.type === 'confirm-sso-realm') {");
    const confirmBody = source.slice(
      confirmStart,
      source.indexOf("\n    if (action.type === 'cancel-sso-realm')", confirmStart),
    );
    expect(confirmBody).toContain('discoveredMethods = confirmation.methods;');
    expect(confirmBody).toContain("type: 'discovery-loaded'");
    expect(confirmBody).not.toContain('soleAutoStartSsoMethod');
    expect(confirmBody).not.toContain("type: 'start-browser'");
  });

  it('pins personal login to the build realm and clears stale realm before organization discovery', () => {
    const discoveryStart = source.indexOf('async function discoverOrganizationRealm(');
    const discoveryBody = source.slice(discoveryStart, source.indexOf('\n}', discoveryStart));
    expect(discoveryBody).toContain('pendingAuthRealm = null;');

    const actionStart = source.indexOf('async function runLoginAction(action: DesktopLoginAction)');
    const actionPreamble = source.slice(
      actionStart,
      source.indexOf('const stateBeforeAction', actionStart),
    );
    expect(actionPreamble).toContain("action.type === 'discover'");
    expect(actionPreamble).toContain("action.type === 'request-code'");
    expect(actionPreamble).toContain("action.type === 'verify-code'");
    expect(actionPreamble).toContain("action.type === 'start-browser' && action.kind === 'social'");
    expect(actionPreamble).toContain('? AUTH_REGION');
    expect(actionPreamble).toContain('const client = createAuthClient(loginRealm);');

    const personalActionSetup = source.slice(
      source.indexOf('if (!providerConfig) await loadLoginProviders', actionStart),
      source.indexOf("if (action.type === 'discover')", actionStart),
    );
    expect(personalActionSetup).toContain(
      'if (startsBuildRealmFlow) pendingAuthRealm = loginRealm;',
    );
  });

  it('does not leave expired private tickets on a screen that can only reuse them', () => {
    expect(source).toContain("'INVALID_LOGIN_TICKET',");
    expect(source).toContain("'INVALID_BIND_TICKET',");
    expect(source).toContain("'INVALID_SSO_VERIFICATION_TICKET',");
    expect(source).toContain("? { step: 'error', code, recoverTo: 'identifier' }");
  });

  it('keeps account access tokens in memory while persisting only encrypted refresh sessions', () => {
    expect(source).toContain(
      "const LEGACY_ACCOUNT_REFRESH_TOKEN_KEY = 'cindy_auth_account_refresh_token';",
    );
    expect(source).toContain('let pendingAccountToken: string | null = null;');
    expect(source).toContain('client.exchangeAccountMembership(accountToken, action.accountId)');
    expect(source).toContain("const AUTH_ACCOUNT_VAULT_KEY = 'cindy_auth_accounts_v1';");
    expect(source).toContain('client.refreshAccount(current.accountRefreshToken)');
    expect(source).toContain('client.logoutAccount(pair.accountToken)');
    expect(source).toContain('writeAtomicSafe(AUTH_ACCOUNT_VAULT_KEY');
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

  it('keeps saved account metadata fresh after profile edits and Passport sync', () => {
    const writePassportStart = source.indexOf('function writePassportSessionToVault(');
    const writePassportEnd = source.indexOf(
      '\n}\n\n/** Persist a rotated Passport',
      writePassportStart,
    );
    const writePassportBody = source.slice(writePassportStart, writePassportEnd);
    expect(writePassportBody).toContain('reconcileSavedAccountMetadata(vault');
    expect(writePassportBody).toContain("passportMode: 'replace-passport'");

    const profileStart = source.indexOf('export async function updateServerProfile(');
    const profileEnd = source.indexOf('\n}\n\nexport async function initialize(', profileStart);
    const profileBody = source.slice(profileStart, profileEnd);
    expect(profileBody).toContain('rememberUpdatedMembershipMetadata(');
    expect(profileBody).toContain('membership.passportId ?? currentUser.passportId');
  });

  it('serializes saved-account vault mutations across shared-userData processes', () => {
    const mutationStart = source.indexOf('async function transactAuthAccountVault');
    const mutationEnd = source.indexOf(
      '\n}\n\nasync function mutateAuthAccountVault',
      mutationStart,
    );
    const mutationBody = source.slice(mutationStart, mutationEnd);
    expect(mutationBody).toContain('withCrossProcessLock(');
    expect(mutationBody).toContain(
      "status.reason === 'busy' && options.waitWhileBusyAfterRotation",
    );
    expect(mutationBody).toContain('throw accountVaultLockError(status.reason);');
    expect(mutationBody).toContain("if (attempt.kind === 'committed') return attempt.result;");
    expect(mutationBody.indexOf('const vault = readAuthAccountVault({')).toBeGreaterThan(
      mutationBody.indexOf('if (!status.held)'),
    );
    expect(mutationBody.indexOf('writeAuthAccountVaultOrThrow(vault);')).toBeGreaterThan(
      mutationBody.indexOf('await operation(vault);'),
    );
    expect(mutationBody.indexOf('await afterPersist(result);')).toBeGreaterThan(
      mutationBody.indexOf('writeAuthAccountVaultOrThrow(vault);'),
    );
    expect(mutationBody).toContain('removeAtomicSafeOrThrow(AUTH_ACCOUNT_VAULT_KEY);');
    expect(mutationBody).toContain('writeAtomicSafe(AUTH_ACCOUNT_VAULT_KEY, previousRaw)');

    for (const helper of [
      'async function rememberResourceSession(',
      'async function replaceResourceSessionIfCurrent(',
      'async function removeRejectedResourceSession(',
      'async function rememberPassportSession(',
      'async function replacePassportSessionIfCurrent(',
      'async function removePassportSessionIfCurrent(',
      'async function rememberUpdatedMembershipMetadata(',
      'async function removeVaultAccount(',
    ]) {
      const start = source.indexOf(helper);
      const end = source.indexOf('\n}\n', start);
      expect(start).toBeGreaterThan(-1);
      expect(source.slice(start, end)).toContain('mutateAuthAccountVault(');
    }
  });

  it('filters invalid vault children only for read-only projection', () => {
    const readStart = source.indexOf('function readAuthAccountVault(');
    const readEnd = source.indexOf('\n}\n\nfunction writeAuthAccountVault', readStart);
    const readBody = source.slice(readStart, readEnd);

    expect(readBody).toContain('if (options.allowUnreadable || options.recoverInvalid) continue;');
    expect(readBody).toContain("throw new Error('invalid saved resource credential')");
    expect(readBody).toContain("throw new Error('invalid saved Passport credential')");
    expect(readBody).toContain("throw new Error('invalid saved Passport membership')");
    expect(readBody).toContain('memberships.length !== item.memberships.length');
    expect(readBody).toContain('active && resources[active] ? active : null');
  });

  it('recovers invalid Desktop vault content only for a completed explicit login', () => {
    const readStart = source.indexOf('function readAuthAccountVault(');
    const readEnd = source.indexOf('\n}\n\nfunction writeAuthAccountVault', readStart);
    const readBody = source.slice(readStart, readEnd);
    const unreadableBranch = readBody.slice(
      readBody.indexOf('if (raw === null)'),
      readBody.indexOf('try {'),
    );
    expect(unreadableBranch).not.toContain('recoverInvalid');
    expect(readBody).toContain('options.allowUnreadable || options.recoverInvalid');

    const transactionStart = source.indexOf('async function transactAuthAccountVault');
    const transactionEnd = source.indexOf(
      '\n}\n\nasync function mutateAuthAccountVault',
      transactionStart,
    );
    const transactionBody = source.slice(transactionStart, transactionEnd);
    expect(transactionBody).toContain('recoverInvalidForExplicitLogin?: boolean');
    expect(transactionBody).toContain('recoverInvalid: options.recoverInvalidForExplicitLogin');

    const loginStart = source.indexOf('async function commitDesktopLoginSessions(');
    const loginEnd = source.indexOf('\n}\n\n/** Persist a rotated Passport', loginStart);
    const loginBody = source.slice(loginStart, loginEnd);
    expect(loginBody).toContain('recoverInvalidForExplicitLogin: true');
    expect(loginBody).toContain('waitWhileBusyAfterRotation: true');
    const transitionCommit = loginBody.indexOf('await transition.commit();');
    const transitionRollback = loginBody.indexOf('await transition.rollback();');
    expect(transitionCommit).toBeGreaterThan(loginBody.indexOf('await transactAuthAccountVault('));
    expect(transitionRollback).toBeGreaterThan(transitionCommit);
    expect(transitionRollback).toBeLessThan(
      loginBody.indexOf('recoverInvalidForExplicitLogin: true'),
    );
  });

  it('atomically replaces the aggregate saved-account vault', () => {
    const writeStart = source.indexOf('function writeAtomicSafe(');
    const writeEnd = source.indexOf('\n}\n\nfunction removeAtomicSafeOrThrow', writeStart);
    const writeBody = source.slice(writeStart, writeEnd);
    expect(writeBody).toContain('atomicWriteFileSync(');
    expect(writeBody).toContain("safeStorage.encryptString(value).toString('base64')");

    const readStart = source.indexOf('function readAtomicSafe(');
    const readEnd = source.indexOf('\n}\n\nfunction isAtomicPersistedSecretAbsent', readStart);
    expect(source.slice(readStart, readEnd)).toContain('fs.readFileSync(`${filepath}.bak`');

    const clearStart = source.indexOf('function removeAtomicSafeOrThrow(');
    const clearEnd = source.indexOf('\n}\n\nfunction removeSafe(', clearStart);
    const clearBody = source.slice(clearStart, clearEnd);
    expect(clearBody.indexOf('`${filepath}.bak`')).toBeLessThan(clearBody.indexOf('filepath])'));
  });

  it('waits through a busy vault lock after the server has rotated a credential', () => {
    const rotatedCredentialHelpers = [
      ['async function rememberResourceSession(', '\n}\n\ntype ResourceSessionReplacementResult'],
      [
        'async function replaceResourceSessionIfCurrent(',
        '\n}\n\ntype RejectedResourceSessionRemovalResult',
      ],
      ['async function replacePassportSessionIfCurrent(', '\n}\n\n/** Delete a rejected Passport'],
      ['async function commitDesktopRefreshCredentials(', '\n}\n\n/**\n * Account refresh tokens'],
    ] as const;

    for (const [startMarker, endMarker] of rotatedCredentialHelpers) {
      const start = source.indexOf(startMarker);
      const end = source.indexOf(endMarker, start);
      expect(start).toBeGreaterThan(-1);
      expect(source.slice(start, end)).toContain('waitWhileBusyAfterRotation: true');
    }
  });

  it('fails a Desktop account switch before owner teardown and rolls back under the vault lock', () => {
    const completeStart = source.indexOf('async function completeLogin(');
    const completeEnd = source.indexOf('\n}\n\nasync function acceptLoginOutcome', completeStart);
    const completeBody = source.slice(completeStart, completeEnd);
    const vaultTransaction = completeBody.indexOf('await commitDesktopLoginSessions(');
    const durableSession = completeBody.indexOf('writePersistedAuthSessionOrThrow(');
    const ownerCommit = completeBody.indexOf('await withCloudOwnerCommit({');
    expect(vaultTransaction).toBeGreaterThan(-1);
    expect(durableSession).toBeGreaterThan(vaultTransaction);
    expect(durableSession).toBeGreaterThan(-1);
    expect(ownerCommit).toBeGreaterThan(durableSession);
    expect(completeBody.indexOf('restorePersistedAuthSessionIfCurrent(')).toBeGreaterThan(
      ownerCommit,
    );
    expect(completeBody.indexOf('rollback: () => {')).toBeGreaterThan(ownerCommit);
    expect(completeBody.slice(ownerCommit)).not.toContain(
      'writePersistedAuthSession(outcome.refreshToken',
    );
  });

  it('invalidates pending add-account actions without cancelling an accepted login commit', () => {
    const runStart = source.indexOf('async function runLoginAction(action: DesktopLoginAction)');
    const runEnd = source.indexOf('\n}\n\nexport async function dispatchLoginAction', runStart);
    const runBody = source.slice(runStart, runEnd);
    expect(runBody).toContain('const actionLoginFlowEpoch = loginFlowEpoch;');
    expect(runBody).toContain('assertLoginFlowCurrent(actionLoginFlowEpoch);');
    expect(runBody).toContain("code: 'AUTH_FLOW_SUPERSEDED'");

    const completeStart = source.indexOf('async function completeLogin(');
    const completeEnd = source.indexOf('\n}\n\nasync function acceptLoginOutcome', completeStart);
    const completeBody = source.slice(completeStart, completeEnd);
    expect(completeBody).toContain('expectedLoginFlowEpoch = loginFlowEpoch');
    expect(completeBody).toContain('loginFlowEpoch !== expectedLoginFlowEpoch');
    expect(completeBody).toContain(
      'const releaseLoginFlowCommit = sealLoginFlowCommit(expectedLoginFlowEpoch);',
    );
    expect(completeBody).toContain('releaseLoginFlowCommit();');
    const vaultTransaction = completeBody.indexOf('await commitDesktopLoginSessions(');
    const durableSession = completeBody.indexOf('writePersistedAuthSessionOrThrow(');
    const teardown = completeBody.indexOf('await accountSwitchTeardown(');
    expect(vaultTransaction).toBeGreaterThan(-1);
    expect(durableSession).toBeGreaterThan(vaultTransaction);
    expect(completeBody.lastIndexOf('assertTransitionCurrent();', teardown)).toBeLessThan(teardown);
    expect(completeBody).toContain('restorePersistedAuthSessionIfCurrent(');

    const cancelStart = source.indexOf('export function cancelAddAccountLogin(): void {');
    const cancelEnd = source.indexOf('\n}\n\nexport function getCurrentDataOwnerId', cancelStart);
    const cancelBody = source.slice(cancelStart, cancelEnd);
    expect(cancelBody).toContain('if (isLoginFlowCommitSealed(loginFlowEpoch))');
    expect(cancelBody).toContain('loginFlowEpoch += 1;');
    expect(cancelBody.indexOf('isLoginFlowCommitSealed')).toBeLessThan(
      cancelBody.indexOf('loginFlowEpoch += 1;'),
    );
  });

  it('single-flights Passport refresh and rejects cross-realm personal account switching', () => {
    const helperStart = source.indexOf('async function refreshPassportSessionSingleFlight(');
    const helperEnd = source.indexOf(
      '\n}\n\nasync function rememberUpdatedMembershipMetadata',
      helperStart,
    );
    const helperBody = source.slice(helperStart, helperEnd);
    expect(helperBody).toContain('passportAccountRefreshFlights.get(key)');
    expect(helperBody).toContain('replacePassportSessionIfCurrent({');
    expect(helperBody).toContain('removePassportSessionIfCurrent(');
    expect(helperBody.indexOf("error.code === 'DEVICE_MISMATCH'")).toBeLessThan(
      helperBody.indexOf('removePassportSessionIfCurrent('),
    );
    expect(source).toContain("'write-failed'");
    expect(source).toContain("'CREDENTIAL_STORE_UNAVAILABLE'");
    expect(source).toContain('isPersistedSecretAbsent(AUTH_ACCOUNT_VAULT_KEY)');
    expect(source).toContain('readAuthAccountVault({ allowUnreadable: true })');
    expect(source).toContain('writeAuthAccountVaultOrThrow(vault);');

    const syncStart = source.indexOf('export async function syncSavedAccounts()');
    const syncEnd = source.indexOf('\n}\n\nexport async function switchSavedAccount', syncStart);
    const syncBody = source.slice(syncStart, syncEnd);
    expect(syncBody).toContain('refreshPassportSessionSingleFlight(');

    const switchStart = syncEnd;
    const switchEnd = source.indexOf(
      '\n}\n\nexport async function beginAddAccountLogin',
      switchStart,
    );
    const switchBody = source.slice(switchStart, switchEnd);
    const policyGuard = switchBody.indexOf('!canRestoreAuthSessionForMembership(');
    const commitRealm = switchBody.indexOf('pendingAuthRealm = realm;');
    expect(policyGuard).toBeGreaterThan(-1);
    expect(commitRealm).toBeGreaterThan(policyGuard);
    expect(switchBody).toContain('refreshPassportSessionSingleFlight(');
    expect(switchBody).toContain('refreshSavedResourceSession({');
    expect(switchBody).not.toContain('client.refresh(resource.refreshToken)');
    expect(switchBody).not.toContain('removeVaultAccount(parsedKey)');
    expect(switchBody).toContain("'REGION_MISMATCH'");
    expect(switchBody).toContain('const switchLoginFlowEpoch = loginFlowEpoch;');
    expect(switchBody).toContain(
      "await completeLogin({ status: 'ok', ...pair }, switchLoginFlowEpoch);",
    );

    const resourceRefreshStart = source.indexOf('async function refreshSavedResourceSession(');
    const resourceRefreshEnd = source.indexOf(
      '\n}\n\nfunction readPersistedAuthSession()',
      resourceRefreshStart,
    );
    const resourceRefreshBody = source.slice(resourceRefreshStart, resourceRefreshEnd);
    expect(resourceRefreshBody).toContain('runRefreshWithReplacementRetry<RefreshAttemptData>(');
    expect(resourceRefreshBody).toContain(
      'readAuthAccountVault().resources[input.accountKey]?.refreshToken',
    );
    expect(resourceRefreshBody).toContain('replaceResourceSessionIfCurrent({');
    expect(resourceRefreshBody).toContain('removeRejectedResourceSession({');
    expect(resourceRefreshBody).toContain("if (removal === 'stale')");
    expect(resourceRefreshBody).toContain("'AUTH_FLOW_SUPERSEDED'");
    expect(resourceRefreshBody).toContain("lastRefreshError.code === 'DEVICE_MISMATCH'");
  });

  it('keeps account refresh out of resource-token cold-start initialization', () => {
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
    const refreshTokenRead = initializeBody.indexOf('await reconcileDesktopActiveAuthSession()');

    expect(localGuard).toBeGreaterThan(-1);
    expect(refreshTokenRead).toBeGreaterThan(localGuard);
    expect(initializeBody.slice(localGuard, refreshTokenRead)).toContain(
      'return snapshotAuthState();',
    );
  });

  it('preserves compatibility and vault generations before cold-start refresh', () => {
    const helperStart = source.indexOf('async function reconcileDesktopActiveAuthSession()');
    const helperEnd = source.indexOf('\n}\n\nfunction readPersistedRefreshToken', helperStart);
    const helperBody = source.slice(helperStart, helperEnd);
    expect(helperBody).toContain('authAccountVaultLockPath()');
    expect(helperBody).toContain("label: 'auth-account-vault-reconcile'");
    expect(helperBody).toContain('vault.resources[vault.activeAccountKey]');
    expect(helperBody).toContain('if (!session)');
    expect(helperBody).toContain('writePersistedAuthSessionOrThrow(');
    expect(helperBody).toContain('return session;');

    const candidatesStart = source.indexOf('function readStoredRefreshTokenCandidates');
    const candidatesEnd = source.indexOf(
      '\n}\n\nfunction readPersistedAccountDeletionReceipt',
      candidatesStart,
    );
    const candidatesBody = source.slice(candidatesStart, candidatesEnd);
    expect(candidatesBody).toContain('readPersistedRefreshToken(realm)');
    expect(candidatesBody).toContain('vault.resources[vault.activeAccountKey]');
    expect(candidatesBody).toContain('activeResource.refreshToken');

    const commitStart = source.indexOf('async function commitDesktopRefreshCredentials');
    const commitEnd = source.indexOf(
      '\n}\n\n/**\n * Account refresh tokens have no replay grace.',
      commitStart,
    );
    const commitBody = source.slice(commitStart, commitEnd);
    expect(commitBody).toContain('vault.resources[key]?.refreshToken === requestedRefreshToken');

    const deadStart = source.indexOf('async function clearConfirmedDeadRefreshTokens');
    const deadEnd = source.indexOf('\n}\n\n/**\n * replacement-retry', deadStart);
    const deadBody = source.slice(deadStart, deadEnd);
    expect(deadBody).toContain('await mutateAuthAccountVault((vault) => {');
    expect(deadBody).toContain('deadTokens.includes(activeResource.refreshToken)');
    expect(deadBody).toContain('delete vault.resources[activeKey];');
    expect(deadBody).toContain('vault.activeAccountKey = null;');

    const listStart = source.indexOf('export function listSavedAccounts()');
    const listEnd = source.indexOf('\n}\n\nexport async function syncSavedAccounts', listStart);
    const listBody = source.slice(listStart, listEnd);
    expect(listBody).toContain(
      'const activeKey = currentUser ? accountVaultKey(activeAuthRealm, currentUser.id) : null;',
    );

    const initializeStart = source.indexOf('export async function initialize(');
    const initializeEnd = source.indexOf('\n}\n\n/**\n * 冷启动 refresh 流程本体', initializeStart);
    const initializeBody = source.slice(initializeStart, initializeEnd);
    const reconcileAt = initializeBody.indexOf('await reconcileDesktopActiveAuthSession()');
    const refreshAt = initializeBody.indexOf(
      'runColdStartRefreshFlow(storedToken, persistedSession.realm)',
    );
    expect(reconcileAt).toBeGreaterThan(-1);
    expect(refreshAt).toBeGreaterThan(reconcileAt);
  });

  it('keeps logout-all durable across a crash between vault and session cleanup', () => {
    expect(source).toContain('signedOutAt?: number;');

    const clearStart = source.indexOf('async function clearAuthAccountVault(');
    const clearEnd = source.indexOf('\n}\n\nfunction metadataFromMembership', clearStart);
    const clearBody = source.slice(clearStart, clearEnd);
    expect(clearBody).toContain('withCrossProcessLock(');
    expect(clearBody).toContain("label: 'auth-account-vault-clear'");
    expect(clearBody).toContain('const vault = emptyAuthAccountVault();');
    expect(clearBody).toContain('vault.activeAccountKey = null;');
    expect(clearBody).toContain('vault.resources = {};');
    expect(clearBody).toContain('vault.passports = {};');
    expect(clearBody).toContain('vault.signedOutAt = Date.now();');
    expect(clearBody.indexOf('writeAuthAccountVaultOrThrow(vault);')).toBeLessThan(
      clearBody.indexOf('await afterPersist();'),
    );

    const reconcileStart = source.indexOf('async function reconcileDesktopActiveAuthSession()');
    const reconcileEnd = source.indexOf(
      '\n}\n\nfunction readPersistedRefreshToken',
      reconcileStart,
    );
    const reconcileBody = source.slice(reconcileStart, reconcileEnd);
    const tombstoneGuard = reconcileBody.indexOf("typeof vault.signedOutAt === 'number'");
    expect(tombstoneGuard).toBeGreaterThan(-1);
    expect(reconcileBody.indexOf('removeSafe(AUTH_SESSION_KEY);')).toBeGreaterThan(tombstoneGuard);
    expect(reconcileBody.indexOf('return null;')).toBeGreaterThan(tombstoneGuard);
    expect(reconcileBody.indexOf('writePersistedAuthSessionOrThrow(')).toBeGreaterThan(
      tombstoneGuard,
    );

    const refreshCommitStart = source.indexOf('async function commitDesktopRefreshCredentials(');
    const refreshCommitEnd = source.indexOf(
      '\n}\n\n/**\n * Account refresh tokens',
      refreshCommitStart,
    );
    expect(source.slice(refreshCommitStart, refreshCommitEnd)).toContain(
      "typeof vault.signedOutAt !== 'number'",
    );

    const resourceWriteStart = source.indexOf('function writeResourceSessionToVault(');
    const resourceWriteEnd = source.indexOf(
      '\n}\n\nasync function rememberPassportSession',
      resourceWriteStart,
    );
    const resourceWriteBody = source.slice(resourceWriteStart, resourceWriteEnd);
    expect(resourceWriteBody).toContain('if (options.markActive !== false) {');
    expect(resourceWriteBody).toContain('delete vault.signedOutAt;');

    const loginCommitStart = source.indexOf('async function commitDesktopLoginSessions(');
    const loginCommitEnd = source.indexOf(
      '\n}\n\n/** Persist a rotated Passport',
      loginCommitStart,
    );
    const loginCommitBody = source.slice(loginCommitStart, loginCommitEnd);
    expect(loginCommitBody).toContain('if (!input.passportId) {');
    expect(loginCommitBody).toContain('delete vault.signedOutAt;');

    const logoutStart = source.indexOf('export async function logout(): Promise<void> {');
    const logoutEnd = source.indexOf('\n}\n\n/**\n * Called on system resume', logoutStart);
    const logoutBody = source.slice(logoutStart, logoutEnd);
    const tombstoneCommit = logoutBody.indexOf('await clearAuthAccountVault(() => {');
    const ownerTeardown = logoutBody.indexOf('await withAccountFreeOwnerCommit({');
    expect(tombstoneCommit).toBeGreaterThan(-1);
    expect(logoutBody.indexOf('removeSafe(AUTH_SESSION_KEY);')).toBeGreaterThan(tombstoneCommit);
    expect(ownerTeardown).toBeGreaterThan(tombstoneCommit);
    expect(logoutBody).toContain('preservePersistedRefreshToken: true');
  });

  it('activates a restored realm only after the refreshed membership passes build policy', () => {
    const initializeStart = source.indexOf('export async function initialize(');
    const initializeEnd = source.indexOf('\n}\n\n/**\n * 冷启动 refresh 流程本体', initializeStart);
    const initializeBody = source.slice(initializeStart, initializeEnd);
    expect(initializeBody).toContain('await loadClientEndpointsForRealm(persistedSession.realm);');
    expect(initializeBody).not.toContain('activateClientEndpointRealm(persistedSession.realm);');

    const coldStart = source.indexOf('async function runColdStartRefreshFlow(');
    const coldEnd = source.indexOf('\n}\n\nasync function loadLoginProviders()', coldStart);
    const coldBody = source.slice(coldStart, coldEnd);
    const coldCredentialCommit = coldBody.indexOf('await commitDesktopRefreshCredentials(');
    const coldPolicyGuard = coldBody.indexOf('!canRestoreAuthSessionForMembership(');
    const coldRealmActivation = coldBody.indexOf('activateClientEndpointRealm(storedRealm);');
    expect(coldCredentialCommit).toBeGreaterThan(-1);
    expect(coldPolicyGuard).toBeGreaterThan(-1);
    expect(coldCredentialCommit).toBeLessThan(coldPolicyGuard);
    expect(coldRealmActivation).toBeGreaterThan(coldPolicyGuard);
    expect(coldBody).toContain('requestedToken,');
    expect(coldBody).toContain('allowUnclaimedVault: true');
    expect(coldBody).toContain("epochChanged('before-cold-start-credential-commit')");
    expect(coldBody).toContain("credentialCommit !== 'active'");
    const inactiveCommit = coldBody.indexOf("credentialCommit !== 'active'");
    const activeCandidateRead = coldBody.indexOf(
      'readActiveVaultRefreshCandidate()',
      inactiveCommit,
    );
    const ownershipRetry = coldBody.indexOf('return runColdStartRefreshFlow(', activeCandidateRead);
    expect(activeCandidateRead).toBeGreaterThan(inactiveCommit);
    expect(ownershipRetry).toBeGreaterThan(activeCandidateRead);
    expect(coldBody.slice(inactiveCommit, ownershipRetry)).toContain(
      '!attemptedOwnershipTokens.has(nextActiveCandidate.refreshToken)',
    );
    expect(coldBody).not.toContain(
      'writePersistedAuthSession(refreshData.refreshToken, storedRealm)',
    );
    expect(coldBody).not.toContain('rememberResourceSession(refreshData');

    const refreshStart = source.indexOf('export async function refresh(): Promise<boolean> {');
    const refreshEnd = source.indexOf('\n}\n\nexport async function logout()', refreshStart);
    const refreshBody = source.slice(refreshStart, refreshEnd);
    const runtimePolicyGuard = refreshBody.indexOf('!canRestoreAuthSessionForMembership(');
    const runtimeRealmActivation = refreshBody.indexOf(
      'activateClientEndpointRealm(refreshRealm);',
    );
    expect(runtimePolicyGuard).toBeGreaterThan(-1);
    expect(runtimeRealmActivation).toBeGreaterThan(runtimePolicyGuard);
    expect(refreshBody).toContain('await commitDesktopRefreshCredentials(');
    expect(refreshBody).toContain(
      "await expireRuntimeAuth(currentUser.id, 'replaced-elsewhere', {",
    );
    expect(refreshBody).toContain('preservePersistedRefreshToken: true');
  });

  it('does not call teardown for a fresh signed-out/null cold-start session', () => {
    const teardown = vi.fn();
    const previousAppSession = {
      mode: 'signed-out' as const,
      dataOwnerId: null,
      generation: 0,
    };

    if (shouldTeardownColdStartRuntime(previousAppSession, 'account-1')) {
      teardown();
    }

    expect(teardown).not.toHaveBeenCalled();
  });

  it('tears down only an already-committed runtime that crosses an owner boundary', () => {
    expect(
      shouldTeardownColdStartRuntime(
        { mode: 'cloud', dataOwnerId: 'account-1', generation: 1 },
        'account-1',
      ),
    ).toBe(false);
    expect(
      shouldTeardownColdStartRuntime(
        { mode: 'cloud', dataOwnerId: 'account-1', generation: 1 },
        'account-2',
      ),
    ).toBe(true);
    expect(
      shouldTeardownColdStartRuntime(
        { mode: 'local', dataOwnerId: 'local-v1', generation: 1 },
        'account-1',
      ),
    ).toBe(true);
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
    expect(refreshBody).toContain('latestSession.refreshToken === requestedToken');
    expect(refreshBody).toContain("credentialCommit !== 'active'");

    const helperStart = source.indexOf('async function commitDesktopRefreshCredentials(');
    const helperEnd = source.indexOf('\n}\n\n/** Persist a rotated Passport', helperStart);
    const helperBody = source.slice(helperStart, helperEnd);
    expect(helperBody).toContain('vault.activeAccountKey === key');
    expect(helperBody).toContain('options.validateBeforeWrite?.()');
    expect(helperBody).toContain('canClaimUninitializedVault');
    expect(helperBody).toContain('Object.keys(vault.resources).length === 0');
    expect(helperBody).toContain('readSafe(LEGACY_RESOURCE_REFRESH_TOKEN_KEY)');
    expect(helperBody).toContain('markActive: stillOwnsActiveSession');
    expect(helperBody).toContain("if (commit === 'active') {");
    expect(helperBody).toContain('writePersistedAuthSessionOrThrow(pair.refreshToken, realm);');
  });

  it('reconnects realm-bound main clients after a runtime realm change commits its new token', () => {
    const refreshStart = source.indexOf('export async function refresh(): Promise<boolean> {');
    const refreshEnd = source.indexOf('\n}\n\nexport async function logout()', refreshStart);
    const refreshBody = source.slice(refreshStart, refreshEnd);

    expect(refreshBody).toContain('const authRealmChanged = refreshRealm !== activeAuthRealm;');
    expect(refreshBody).toContain('await commitDesktopRefreshCredentials(');
    expect(refreshBody).toContain('activeAuthRealm = refreshRealm;');
    expect(refreshBody).toContain(
      'const membershipKindChanged = previousMembershipKind !== nextUser.membershipKind;',
    );
    expect(refreshBody).toContain(
      'previousUserId !== nextUser.id || authRealmChanged || membershipKindChanged',
    );
    expect(refreshBody).toContain(
      'if (authRealmChanged || membershipKindChanged) {\n        notifyAuthListeners();',
    );

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
    expect(helperBody).toContain('clearAuth({ notify: false,');
    expect(helperBody).toContain('await withAccountFreeOwnerCommit({');
    expect(helperBody).toContain('authAlreadyCleared: true');
    expect(helperBody).toContain('notifySessionExpired(reason);');

    const ownerCommitStart = source.indexOf('async function withAccountFreeOwnerCommit(');
    const ownerCommitEnd = source.indexOf(
      '\n}\n\nasync function withCloudOwnerCommit(',
      ownerCommitStart,
    );
    const ownerCommitBody = source.slice(ownerCommitStart, ownerCommitEnd);
    expect(ownerCommitBody).toContain('beginAppSessionBoundary()');
    expect(ownerCommitBody).toContain('notifyRendererAuthBoundaryPending();');
    expect(ownerCommitBody).toContain('await accountSwitchTeardown');
    expect(ownerCommitBody).toContain('await authSessionTeardown(opts.reason);');
    expect(ownerCommitBody).toContain('notifyAuthListeners();');

    const refreshStart = source.indexOf('export async function refresh(): Promise<boolean> {');
    const refreshEnd = source.indexOf('\n}\n\nexport async function logout()', refreshStart);
    const refreshBody = source.slice(refreshStart, refreshEnd);
    expect(refreshBody).toContain(
      'await expireRuntimeAuth(previousUserId, resolveSessionExpiredReason(code));',
    );
    expect(refreshBody).not.toContain('clearAuth({ notify: false });');
  });

  it('reserves local namespaces before publishing a cloud owner', () => {
    const cloudStart = source.indexOf('async function withCloudOwnerCommit(');
    const prepareStart = source.indexOf('prepareCommit: async () => {', cloudStart);
    const prepareEnd = source.indexOf('\n      },\n      commit: async () => {', prepareStart);
    const prepareBody = source.slice(prepareStart, prepareEnd);

    expect(prepareBody).toContain(
      'rollbackReservation = reserveCloudOwnerData(opts.nextOwnerId, opts.previousOwnerId);',
    );
    expect(prepareBody.indexOf('reserveCloudOwnerData')).toBeLessThan(
      prepareBody.indexOf('await opts.prepareCommit?.();'),
    );
    expect(source).toContain('await repairStableCloudOwnerDataReservations(currentUser.id);');
    expect(source).toContain('if (reservation && !reservation.finalize())');
    expect(source).toContain('if (!reservation.rollback())');
    expect(source).toContain('if (boundaryCommitApplied || commitApplied) return;');

    const failureStart = source.indexOf(
      'onCommitFailure: ({ commitApplied: boundaryCommitApplied }) => {',
      cloudStart,
    );
    const failureEnd = source.indexOf('\n      },\n    });', failureStart);
    const failureBody = source.slice(failureStart, failureEnd);
    expect(failureBody).toContain('if (boundaryCommitApplied || commitApplied) return;');
    expect(failureBody.indexOf('if (!reservation.rollback())')).toBeLessThan(
      failureBody.indexOf('rollbackReservation = null;'),
    );
    const finallyStart = source.indexOf('  } finally {', failureEnd);
    const finallyBody = source.slice(finallyStart, source.indexOf('\n  }\n', finallyStart));
    expect(finallyBody).toContain('if (!committed && !commitApplied)');

    const repairStart = source.indexOf(
      'function repairStableCloudOwnerDataReservationsWhileLocked(',
    );
    const repairEnd = source.indexOf(
      '\n}\n\nasync function repairStableCloudOwnerDataReservations(',
      repairStart,
    );
    const repairBody = source.slice(repairStart, repairEnd);
    expect(repairBody).toContain('reserveCommittedLocalProfileDataOwnerDetailed(');
    expect(repairBody).toContain(
      'const profileReservationOwnerId = resolveProfileReservationOwnerId(ownerId);',
    );
    expect(repairBody).toContain(
      'reserveCommittedLocalProfileDataOwnerDetailed(\n      profileReservationOwnerId,',
    );
    expect(repairBody).toContain(
      'reserveCommittedLegacyNativeProviderAuthOwner(authoritativeOwnerId)',
    );
    expect(repairBody).not.toContain('reserveLocalProfileDataOwnerDetailed(');
    expect(repairBody).not.toContain('reserveLegacyNativeProviderAuthOwnerDetailed(ownerId)');
    expect(repairBody).toContain('remains authenticated with local adoption fail-closed');
    expect(repairBody).not.toContain('throw new Error');
    const serializedRepairStart = source.indexOf(
      'async function repairStableCloudOwnerDataReservations(',
    );
    const serializedRepairEnd = source.indexOf(
      '\n}\n\nfunction commitCloudAppSession(',
      serializedRepairStart,
    );
    const serializedRepairBody = source.slice(serializedRepairStart, serializedRepairEnd);
    expect(serializedRepairBody).toContain('withStableOwnerBoundaryMutation(ownerId');
    expect(serializedRepairBody).toContain(
      'repairStableCloudOwnerDataReservationsWhileLocked(ownerId)',
    );

    const reserveStart = source.indexOf('function reserveCloudOwnerData(');
    const reserveEnd = source.indexOf(
      '\n}\n\nfunction repairStableCloudOwnerDataReservationsWhileLocked(',
      reserveStart,
    );
    const reserveBody = source.slice(reserveStart, reserveEnd);
    expect(reserveBody).toContain(
      'const profileReservationOwnerId = resolveProfileReservationOwnerId(ownerId);',
    );
    expect(reserveBody).toContain(
      'reserveLocalProfileDataOwnerDetailed(\n      profileReservationOwnerId,',
    );
    expect(reserveBody).toContain(
      'releaseLocalProfileDataOwner(\n          profileReservationOwnerId,',
    );
    expect(reserveBody).toContain(
      "if (nativeReservation.status === 'claimed' && nativeReservation.claimToken)",
    );
    expect(reserveBody).not.toContain(
      "profileReservation.status === 'claimed' &&\n      nativeReservation.status === 'claimed'",
    );
    expect(reserveBody).toContain('const authoritativeOwnerId = profileReservation.ownerId;');
    expect(reserveBody).toContain(
      'reserveLegacyNativeProviderAuthOwnerDetailed(authoritativeOwnerId)',
    );
    expect(reserveBody).toContain(
      "throw new Error('local profile and native provider ownership reservations disagree')",
    );
    expect(reserveBody).toContain(
      'finalize: () => recoverCloudOwnerDataReservations(authoritativeOwnerId)',
    );

    const migrationStart = source.indexOf(
      'async function migrateLocalProviderBindingsAfterCloudCommit(ownerId: string): Promise<void> {',
    );
    const migrationEnd = source.indexOf(
      '\n}\n\nasync function finishColdStartSignedOut(',
      migrationStart,
    );
    const migrationBody = source.slice(migrationStart, migrationEnd);
    expect(migrationBody).toContain(
      'if (!(await repairStableCloudOwnerDataReservations(ownerId))) return;',
    );
    expect(migrationBody.indexOf('repairStableCloudOwnerDataReservations')).toBeLessThan(
      migrationBody.indexOf('migrateLocalNativeProviderAuthBindings'),
    );
  });

  it('synchronizes canary flags on every path that establishes a new auth identity', () => {
    expect(source).not.toContain('canaryFlagStore.sync(false)');
    expect(source.match(/scheduleCanaryFlagSync\(\{/g)).toHaveLength(3);
    expect(source.match(/scheduleXdOrgBetaDefault\(\{/g)).toHaveLength(3);
    expect(source.match(/scheduleNonXdOrgBetaDefault\(\{/g)).toHaveLength(1);
    expect(source).toContain("getClientEndpoint('oauthBrokerApiBaseUrl')");
    expect(source).toContain("apiFetch('/api/user/feature-flags'");

    const syncStart = source.indexOf('function scheduleCanaryFlagSync(');
    const syncEnd = source.indexOf(
      '\n}\n\n/**\n * 登录态落地后为 xd 组织补一次设备级 beta 默认值',
      syncStart,
    );
    expect(syncEnd).toBeGreaterThan(syncStart);
    const syncBody = source.slice(syncStart, syncEnd);
    expect(syncBody).toContain("if (outcome.kind === 'synced')");
    expect(syncBody).toContain('notifyRenderer();');

    const completeStart = source.indexOf('async function completeLogin(');
    const completeEnd = source.indexOf('\n}\n\nasync function acceptLoginOutcome', completeStart);
    const completeBody = source.slice(completeStart, completeEnd);
    const ownerCommit = completeBody.indexOf('commitCloudAppSession(currentUser.id);');
    const clearPreviousFlag = completeBody.indexOf('canaryFlagStore.clear();', ownerCommit);
    expect(ownerCommit).toBeGreaterThan(-1);
    expect(clearPreviousFlag).toBeGreaterThan(ownerCommit);
    expect(completeBody.slice(ownerCommit, clearPreviousFlag)).toContain(
      'if (!isPassiveSharedUserDataInstance()) {',
    );

    const betaStart = source.indexOf('function scheduleXdOrgBetaDefault(');
    const betaEnd = source.indexOf('function scheduleNonXdOrgBetaDefault(', betaStart);
    expect(betaEnd).toBeGreaterThan(betaStart);
    const betaBody = source.slice(betaStart, betaEnd);
    expect(betaBody).toContain('if (isPassiveSharedUserDataInstance()) return;');
    expect(betaBody).toContain('decodeAccessTokenOrgSlug(accessToken)');
    expect(betaBody).not.toContain('shouldAttemptOrgBetaDefault');
    const nonXdStart = source.indexOf('function scheduleNonXdOrgBetaDefault(');
    const nonXdEnd = source.indexOf('\n}\n\n/**\n * 冷启动流程的进程内去重', nonXdStart);
    const nonXdBody = source.slice(nonXdStart, nonXdEnd);
    expect(nonXdBody).toContain('shouldAttemptOrgBetaDefault');
    expect(betaBody).toContain('enableUncustomizedBetaChannel');
    expect(betaBody).toContain('authStateEpoch === input.expectedAuthEpoch');
    expect(source).not.toContain('relaunchForChannelChange');

    const clearIntegrationsStart = source.indexOf('async function clearPerAccountIntegrations(');
    const clearIntegrationsEnd = source.indexOf('\n}', clearIntegrationsStart);
    expect(source.slice(clearIntegrationsStart, clearIntegrationsEnd)).not.toContain(
      'canaryFlagStore.clear()',
    );
  });
});
