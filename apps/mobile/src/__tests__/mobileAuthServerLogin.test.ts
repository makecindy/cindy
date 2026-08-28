import { readFileSync as readFileSyncRaw } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readFileSync = (
  path: Parameters<typeof readFileSyncRaw>[0],
  encoding: BufferEncoding,
): string => readFileSyncRaw(path, encoding).toString().replace(/\r\n/g, '\n');

describe('mobile auth-server login', () => {
  it('uses native social credentials where available and browser PKCE for Global Android Apple', () => {
    const loginSource = readFileSync(
      resolve(process.cwd(), 'app/(auth)/login.tsx'),
      'utf8',
    );
    const authSource = readFileSync(
      resolve(process.cwd(), 'src/auth/AuthContext.tsx'),
      'utf8',
    );
    const nativeSource = readFileSync(
      resolve(process.cwd(), 'src/auth/nativeSocial.ts'),
      'utf8',
    );
    const modeSource = readFileSync(
      resolve(process.cwd(), 'src/auth/mobileSocialLoginMode.ts'),
      'utf8',
    );

    expect(loginSource).toMatch(/type:\s*'native-social',\s*provider/);
    expect(loginSource).toContain('testID: `login.${provider}Button`');
    // App Store Guideline 4:Apple 入口为圆钮行第一颗(variant='apple',ADR 官方配色圆钮),
    // 不再用全宽官方 AppleAuthenticationButton;testID login.appleButton 锚点保留。
    expect(loginSource).not.toContain('<AppleAuthenticationButton');
    expect(loginSource).not.toContain('expo-apple-authentication');
    expect(loginSource).toContain('variant="apple"');
    expect(loginSource).toContain('testID="login.appleButton"');
    expect(loginSource).toContain('<AppleLogoGlyph');
    expect(loginSource).toMatch(
      /type:\s*'native-social',\s*provider:\s*'apple',?\s*\n/,
    );
    expect(loginSource).toContain("type: 'start-social-browser'");
    expect(loginSource).toContain("mode === 'browser'");
    // 行 count 计入当前平台可用的 Apple + nonAppleProviders + SSO。
    expect(loginSource).toContain("socialProviders.includes('apple') ? 1 : 0");
    expect(loginSource).toContain('nonAppleProviders.length');
    expect(loginSource).not.toContain('react-native-webview');
    expect(authSource).toContain(
      'authClientFor(did, BUILD_AUTH_REGION).exchangeNativeSocial(',
    );
    expect(authSource).toContain("clientType: 'mobile'");
    expect(nativeSource).toContain("import('expo-apple-authentication')");
    expect(nativeSource).toContain('Crypto.CryptoDigestAlgorithm.SHA256');
    expect(nativeSource).toContain(
      "import('@react-native-google-signin/google-signin')",
    );
    expect(nativeSource).toContain('GoogleSignin.configure({');
    expect(nativeSource).toContain("import('xdt-wechat-login')");
    expect(nativeSource).toContain('requestWechatAuthCode({');
    expect(nativeSource).toContain('createNativeWechatLoginTimeout()');
    expect(nativeSource).toContain('cancelWechatAuthRequest().catch');
    expect(nativeSource).toContain("AppState.addEventListener('change'");
    // 社交入口可见性必须镜像 acquire* 的配置前置条件：缺 client ID / app ID 的构建不渲染必然失败的按钮
    expect(nativeSource).toContain(
      "if (provider === 'apple') return Platform.OS === 'ios';",
    );
    expect(nativeSource).toContain('if (!GOOGLE_WEB_CLIENT_ID) return false;');
    expect(nativeSource).toContain(
      '(!!GOOGLE_IOS_CLIENT_ID && !!GOOGLE_IOS_URL_SCHEME)',
    );
    expect(nativeSource).toContain(
      'return !!WECHAT_APP_ID && !!WECHAT_UNIVERSAL_LINK;',
    );
    expect(nativeSource).toContain('!GOOGLE_IOS_URL_SCHEME');
    expect(nativeSource).toMatch(/\|\|\s*!WECHAT_UNIVERSAL_LINK/);
    expect(modeSource).toContain("input.region === 'global'");
    expect(modeSource).toContain("input.platform === 'android'");
    expect(modeSource).toContain("return 'browser'");
  });

  it('AppleLogoGlyph path d 与桌面 ADR 官方资产逐字节一致(防手抄/跨端漂移)', () => {
    const controlsSource = readFileSync(
      resolve(process.cwd(), 'src/components/LoginSkinControls.tsx'),
      'utf8',
    );
    // AppleLogoGlyph 的 path d 以官方起点 M28.2226562,20.3846154 标识(唯一,区别于其它 icon)
    const glyphD = (controlsSource.match(/d="([^"]+)"/g) ?? [])
      .map((s) => s.slice(3, -1))
      .find((d) => d.startsWith('M28.2226562,20.3846154'));
    expect(glyphD).toBeDefined();
    expect(glyphD?.length).toBe(1228);
    // 桌面 apple.svg 从 ADR「Logo-only」源逐字节导入(见其文件头注释);双端共用同一
    // 官方 path,以仓库内桌面资产为对比锚,防止任一端被手抄改动后静默漂移。
    const desktopAdrSvg = readFileSync(
      resolve(
        process.cwd(),
        '../desktop/src/renderer/assets/login/icons/apple.svg',
      ),
      'utf8',
    );
    const adrD = (desktopAdrSvg.match(/ d="([^"]+)"/) ?? [])[1];
    expect(adrD).toBeTruthy();
    expect(glyphD).toBe(adrD);
  });

  it('releases timed-out WeChat requests in both native coordinators', () => {
    const moduleSource = readFileSync(
      resolve(process.cwd(), 'modules/xdt-wechat-login/src/index.ts'),
      'utf8',
    );
    const iosSource = readFileSync(
      resolve(
        process.cwd(),
        'modules/xdt-wechat-login/ios/XdtWechatAuthCoordinator.swift',
      ),
      'utf8',
    );
    const androidSource = readFileSync(
      resolve(
        process.cwd(),
        'modules/xdt-wechat-login/android/src/main/java/com/xdtmaker/wechatlogin/XdtWechatLoginModule.kt',
      ),
      'utf8',
    );

    expect(moduleSource).toContain('cancelWechatAuthRequest(): Promise<void>');
    expect(iosSource).toContain('func cancel()');
    expect(androidSource).toContain('fun cancel()');
  });

  it('keeps social and SSO browser auth on one PKCE path through the regional deep link', () => {
    const authSource = readFileSync(
      resolve(process.cwd(), 'src/auth/AuthContext.tsx'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const envSource = readFileSync(
      resolve(process.cwd(), 'src/config/env.ts'),
      'utf8',
    ).replace(/\r\n/g, '\n');

    expect(authSource).toContain("kind: 'sso'");
    expect(authSource).toContain("kind: 'social'");
    expect(authSource).toContain("action.type === 'start-social-browser'");
    expect(authSource).toContain('const startBrowserAuthorization = async');
    expect(authSource).toMatch(
      /WebBrowser\.openAuthSessionAsync\(\s*authUrl,\s*MOBILE_REDIRECT_URL,?\s*\)/,
    );
    expect(authSource).toMatch(/setSecureItem\(\s*PENDING_OAUTH_KEY/);
    expect(authSource).toContain('Linking.addEventListener');
    expect(authSource).toContain('Linking.getInitialURL()');
    expect(authSource).toContain(
      'matchesOAuthCallbackUrl(url, MOBILE_REDIRECT_URL)',
    );
    expect(authSource).toContain(
      'matchesOAuthCallbackUrl(callbackUrl, MOBILE_REDIRECT_URL)',
    );
    expect(authSource).toContain('exchangeAuthorizationCode(');
    // scheme 派生 2026-07-20 起为三区域查表(cn/global/dev),断言仍锚定
    // 「按区域取回调 scheme」这一形状。
    expect(envSource).toContain(
      "{ cn: 'cindycn', global: 'cindy', dev: 'cindydev' }",
    );
    expect(envSource).toContain('AUTH_REGION\n];');
  });

  it('clears a stale organization realm before personal login or a new organization lookup', () => {
    const authSource = readFileSync(
      resolve(process.cwd(), 'src/auth/AuthContext.tsx'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    expect(authSource).toContain("action.type === 'discover' ||");
    expect(authSource).toContain("action.type === 'request-code' ||");
    expect(authSource).toContain("action.type === 'verify-code' ||");
    expect(authSource).toContain("action.type === 'start-social-browser' ||");
    expect(authSource).toContain("action.type === 'native-social'");
    expect(authSource).toContain(
      'if (startsBuildRealmFlow) {\n            pendingAuthRealmRef.current = null;',
    );

    const discoveryStart = authSource.indexOf(
      "if (action.type === 'discover-sso-org') {",
    );
    const discoveryBody = authSource.slice(
      discoveryStart,
      authSource.indexOf(
        'const realmConfig = getMobileEndpointRealmConfig();',
        discoveryStart,
      ),
    );
    expect(discoveryBody).toContain('pendingAuthRealmRef.current = null;');
  });

  it('asks for confirmation only when enterprise discovery crosses the build region', () => {
    const authSource = readFileSync(
      resolve(process.cwd(), 'src/auth/AuthContext.tsx'),
      'utf8',
    );

    expect(authSource).toContain(
      'if (discovery.region !== BUILD_AUTH_REGION) {',
    );
    expect(authSource).toContain("type: 'realm-switch-required'");
    expect(authSource).toContain(
      "if (action.type === 'confirm-sso-realm') {",
    );
    expect(authSource).toContain(
      "if (action.type === 'cancel-sso-realm') {",
    );
    expect(authSource).toContain('methods: confirmation.methods');
    expect(authSource).toContain(
      "previousState?.step !== 'method-choice' ||",
    );
    expect(authSource).toContain('soleLoginMethod(methods)');
    expect(authSource).toContain('soleAutoStartSsoMethod(confirmation.methods)');
    expect(authSource).toContain("kind: 'sso'");
    expect(authSource).toContain('startBrowserAuthorization({');
    expect(authSource).toContain("sole?.type === 'email_code'");
  });

  it('remembers successful organization discovery before sole-SSO browser auth starts', () => {
    const authSource = readFileSync(
      resolve(process.cwd(), 'src/auth/AuthContext.tsx'),
      'utf8',
    );
    const discoveryStart = authSource.indexOf(
      "if (action.type === 'discover-sso-org') {",
    );
    const discoveryEnd = authSource.indexOf(
      "if (action.type === 'request-code') {",
      discoveryStart,
    );
    const discoveryBody = authSource.slice(discoveryStart, discoveryEnd);
    const methodsAt = discoveryBody.indexOf(
      'const methods = ssoOrgDiscoveryToMethods(discovery);',
    );
    const rememberAt = discoveryBody.indexOf(
      'await rememberSsoOrgIdentifier(action.org);',
    );
    const autoStartAt = discoveryBody.indexOf(
      'return startBrowserAuthorization({',
    );

    expect(methodsAt).toBeGreaterThanOrEqual(0);
    expect(rememberAt).toBeGreaterThan(methodsAt);
    expect(autoStartAt).toBeGreaterThan(rememberAt);
  });

  it('keeps short-lived account tokens and private tickets out of the screen and business API', () => {
    const authSource = readFileSync(
      resolve(process.cwd(), 'src/auth/AuthContext.tsx'),
      'utf8',
    );
    const loginSource = readFileSync(
      resolve(process.cwd(), 'app/(auth)/login.tsx'),
      'utf8',
    );

    expect(authSource).toContain('pendingLoginTicketRef');
    expect(authSource).toContain('pendingBindTicketRef');
    expect(authSource).toContain('pendingSsoVerificationTicketRef');
    expect(authSource).toContain('pendingAccountTokenRef');
    expect(authSource).toContain('client.exchangeAccountMembership(');
    expect(authSource).toContain(
      'client.selectAccount(ticket, action.accountId)',
    );
    expect(authSource).toContain('client.verifyBinding(');
    expect(loginSource).not.toContain('loginTicket');
    expect(loginSource).not.toContain('bindTicket');
    expect(loginSource).not.toContain('verificationTicket');
    expect(authSource).toContain('client.requestSsoVerificationCode(ticket)');
    expect(authSource).toContain(
      'client.verifySsoVerification(ticket, action.code)',
    );
    expect(authSource).toContain('pendingAccountRefreshTokenRef');
    expect(authSource).toContain('commitMobileLoginSessions(');
    expect(authSource).toContain('.refreshAccount(');
    expect(authSource).toContain('.logoutAccount(');
    expect(authSource).not.toContain(
      'setSecureItem(LEGACY_ACCOUNT_REFRESH_TOKEN_KEY',
    );

    const apiFetchStart = authSource.indexOf('const apiFetch = useCallback(');
    const apiFetchEnd = authSource.indexOf(
      '\n\n  const value = useMemo',
      apiFetchStart,
    );
    const apiFetchBody = authSource.slice(apiFetchStart, apiFetchEnd);
    expect(apiFetchBody).toContain('const token = await getAccessToken();');
    expect(apiFetchBody).not.toContain('pendingAccountTokenRef');
    expect(apiFetchBody).not.toContain('pendingAccountRefreshTokenRef');
    expect(apiFetchBody).not.toContain('accountRefreshToken');
  });

  it('serializes rotated-token writes and keeps identity on auth-server only', () => {
    const authSource = readFileSync(
      resolve(process.cwd(), 'src/auth/AuthContext.tsx'),
      'utf8',
    );

    expect(authSource).toContain('serializeRefreshTokenMutation');
    expect(authSource).toMatch(
      /const LEGACY_ACCOUNT_REFRESH_TOKEN_KEY\s*=\s*'cindy\.mobile\.auth\.accountRefreshToken';/,
    );
    expect(authSource).not.toContain('serializeAccountTokenMutation');
    expect(authSource).not.toContain('accountRefreshInFlightRef');
    expect(authSource).toMatch(
      /authGenerationRef\.current !== generation \|\|\s+loginFlowEpochRef\.current !== expectedLoginFlowEpoch/,
    );
    const refreshStart = authSource.indexOf('const refresh = useCallback');
    const refreshEnd = authSource.indexOf('\n  useEffect(() => {', refreshStart);
    const refreshBody = authSource.slice(refreshStart, refreshEnd);
    const crashReconcile = refreshBody.indexOf(
      'reconcileMobileActiveAuthSession({',
    );
    const networkRefresh = refreshBody.indexOf('.refresh(', crashReconcile);
    expect(crashReconcile).toBeGreaterThan(-1);
    expect(networkRefresh).toBeGreaterThan(crashReconcile);
    expect(refreshBody).toContain(
      'readPersistedSession: readPersistedAuthSessionStrict',
    );
    expect(refreshBody).toContain(
      'clearPersistedSession: () => deleteSecureItem(AUTH_SESSION_KEY)',
    );
    const resourceVaultWrite = refreshBody.indexOf(
      'commitMobileRuntimeResourceSession({',
    );
    const publishAccessToken = refreshBody.indexOf(
      'setToken(pair.accessToken);',
      resourceVaultWrite,
    );
    const inactiveCommit = refreshBody.indexOf(
      "if (resourceCommit === 'inactive') {",
      resourceVaultWrite,
    );
    const selectActivePair = refreshBody.indexOf(
      'selectedSession = candidate;',
      inactiveCommit,
    );
    expect(resourceVaultWrite).toBeGreaterThan(-1);
    expect(inactiveCommit).toBeGreaterThan(resourceVaultWrite);
    expect(selectActivePair).toBeGreaterThan(inactiveCommit);
    expect(publishAccessToken).toBeGreaterThan(resourceVaultWrite);
    expect(refreshBody.slice(resourceVaultWrite, publishAccessToken)).not.toContain(
      '.catch(',
    );
    expect(refreshBody).toContain(
      'expectedRefreshToken: candidate.refreshToken',
    );
    expect(refreshBody.slice(inactiveCommit, selectActivePair)).toContain(
      'continue;',
    );
    expect(refreshBody).toContain('removeMobileResourceSessionIfCurrent({');
    expect(refreshBody).toContain(
      'expectedRefreshToken:\n                    activeResourceAtStart!.resource!.refreshToken',
    );
    expect(refreshBody).toContain("error.code === 'DEVICE_MISMATCH'");
    expect(refreshBody).not.toContain('removeMobileSavedAccount(');
    // 2026-07 产品 /api/user/me 退役:身份只经 auth-server getMe,防复活。
    expect(authSource).not.toContain("'/api/user/me'");
    expect(authSource).toContain("throw authCodeError('AUTH_FLOW_SUPERSEDED')");
    expect(authSource).toMatch(
      /code === 'INVALID_LOGIN_TICKET'\s*\|\|\s*code === 'INVALID_BIND_TICKET'/,
    );
  });

  it('single-flights Passport rotations before membership reads', () => {
    const authSource = readFileSync(
      resolve(process.cwd(), 'src/auth/AuthContext.tsx'),
      'utf8',
    );
    const helperStart = authSource.indexOf(
      'async function refreshMobilePassportSingleFlight(',
    );
    const helperEnd = authSource.indexOf(
      '\n}\n\n// 2026-07 产品',
      helperStart,
    );
    const helperBody = authSource.slice(helperStart, helperEnd);
    expect(helperBody).toContain('mobilePassportRefreshFlights.get(key)');
    expect(helperBody).toContain('replaceMobilePassportSessionIfCurrent({');
    expect(helperBody).toContain('removeMobilePassportSessionIfCurrent(');
    expect(helperBody.indexOf("error.code === 'DEVICE_MISMATCH'")).toBeLessThan(
      helperBody.indexOf('removeMobilePassportSessionIfCurrent('),
    );

    const syncStart = authSource.indexOf(
      'const syncSavedAccounts = useCallback',
    );
    const syncEnd = authSource.indexOf(
      '\n\n  const switchAccount = useCallback',
      syncStart,
    );
    const syncBody = authSource.slice(syncStart, syncEnd);
    const refreshAccount = syncBody.indexOf('refreshMobilePassportSingleFlight(');
    const readMemberships = syncBody.indexOf(
      'client.getAccountMemberships(',
      refreshAccount,
    );
    expect(refreshAccount).toBeGreaterThan(-1);
    expect(readMemberships).toBeGreaterThan(refreshAccount);

    const switchStart = syncEnd;
    const switchEnd = authSource.indexOf(
      '\n\n  const beginAddAccount',
      switchStart,
    );
    const switchBody = authSource.slice(switchStart, switchEnd);
    const switchRefreshAccount = switchBody.indexOf(
      'refreshMobilePassportSingleFlight(',
    );
    const switchReadMemberships = switchBody.indexOf(
      'client.getAccountMemberships(',
      switchRefreshAccount,
    );
    expect(switchRefreshAccount).toBeGreaterThan(-1);
    expect(switchReadMemberships).toBeGreaterThan(switchRefreshAccount);
    expect(switchBody).toContain('replaceMobileResourceSessionIfCurrent({');
    expect(switchBody).toContain('removeMobileResourceSessionIfCurrent({');
    expect(switchBody).toContain(
      'expectedRefreshToken: resource.refreshToken',
    );
    expect(switchBody).toContain('validateBeforeWrite: () => {');
    expect(switchBody).toContain("if (removal === 'stale')");
    expect(switchBody).toContain("error.code === 'DEVICE_MISMATCH'");
    const resourceStored = switchBody.indexOf(
      'await rememberMobileResourceSession(',
    );
    const regionGuard = switchBody.indexOf(
      'realm !== BUILD_AUTH_REGION',
      resourceStored,
    );
    expect(resourceStored).toBeGreaterThan(-1);
    expect(regionGuard).toBeGreaterThan(resourceStored);
    expect(switchBody).toContain("throw authCodeError('REGION_MISMATCH')");
    expect(switchBody).toContain('const runtimeActiveAccountKey = userRef.current');
    expect(switchBody).toContain('if (runtimeActiveAccountKey === accountKey) return;');
  });

  it('tries both compatibility and vault Resource generations before expiring auth', () => {
    const authSource = readFileSync(
      resolve(process.cwd(), 'src/auth/AuthContext.tsx'),
      'utf8',
    );
    const refreshStart = authSource.indexOf('const refresh = useCallback');
    const refreshEnd = authSource.indexOf('\n  useEffect(() => {', refreshStart);
    const refreshBody = authSource.slice(refreshStart, refreshEnd);

    expect(refreshBody).toContain('const refreshCandidates = reconciledAuth.refreshCandidates;');
    expect(refreshBody).toContain('for (const [index, candidate] of refreshCandidates.entries())');
    expect(refreshBody).toContain('rejectedRefreshTokens.push(candidate.refreshToken);');
    expect(refreshBody).toContain('compatibilityRefreshTokens: refreshCandidates');
    expect(refreshBody).toContain("if (resourceCommit === 'inactive') {");
    expect(refreshBody).toContain('selectedSession = candidate;');
    expect(refreshBody).toContain(
      'rejectedRefreshTokens.includes(\n                activeResourceAtStart.resource.refreshToken,',
    );

    const snapshotStart = authSource.indexOf(
      'const refreshSavedAccountsSnapshot = useCallback',
    );
    const snapshotEnd = authSource.indexOf(
      '\n\n  const refreshSavedAccountsSnapshotBestEffort',
      snapshotStart,
    );
    const snapshotBody = authSource.slice(snapshotStart, snapshotEnd);
    expect(snapshotBody).toContain('const runtimeActiveAccountKey = userRef.current');
    expect(snapshotBody).toContain(
      'listMobileSavedAccounts(vault, runtimeActiveAccountKey)',
    );
  });

  it('rolls a failed account switch back to the latest serialized session', () => {
    const authSource = readFileSync(
      resolve(process.cwd(), 'src/auth/AuthContext.tsx'),
      'utf8',
    );
    const switchStart = authSource.indexOf('const switchAccount = useCallback');
    const switchBody = authSource.slice(
      switchStart,
      authSource.indexOf('\n\n  const beginAddAccount', switchStart),
    );
    const serialized = switchBody.indexOf(
      'await serializeRefreshTokenMutation(async () => {',
    );
    const latestRead = switchBody.indexOf(
      'const previousSessionRaw = await getSecureItem(AUTH_SESSION_KEY);',
      serialized,
    );
    const targetWrite = switchBody.indexOf(
      'await writePersistedAuthSession(pair!.refreshToken, realm!);',
      latestRead,
    );
    const activeVaultCommit = switchBody.indexOf(
      'await commitMobileSavedAccountActivation(',
      latestRead,
    );
    const runtimeClear = switchBody.indexOf(
      'await clearAccountScopedRuntimeForSwitch();',
      targetWrite,
    );
    const rollbackWrite = switchBody.indexOf(
      'await restorePersistedAuthSessionRaw(previousSessionRaw);',
      runtimeClear,
    );

    expect(serialized).toBeGreaterThan(-1);
    expect(latestRead).toBeGreaterThan(serialized);
    expect(activeVaultCommit).toBeGreaterThan(latestRead);
    expect(targetWrite).toBeGreaterThan(activeVaultCommit);
    expect(runtimeClear).toBeGreaterThan(targetWrite);
    expect(rollbackWrite).toBeGreaterThan(runtimeClear);
    expect(switchBody.slice(runtimeClear, rollbackWrite)).toContain(
      'activateMobileSessionRealm(realm!);',
    );
    expect(switchBody.slice(rollbackWrite)).toContain(
      'activateMobileSessionRealm(previousRealm);',
    );
    expect(switchBody).not.toContain('const oldSession = initialVault');
  });

  it('clears the previous identity deletion receipt inside saved-account activation', () => {
    const authSource = readFileSync(
      resolve(process.cwd(), 'src/auth/AuthContext.tsx'),
      'utf8',
    );
    const switchStart = authSource.indexOf('const switchAccount = useCallback');
    const switchBody = authSource.slice(
      switchStart,
      authSource.indexOf('\n\n  const beginAddAccount', switchStart),
    );
    const runtimeClear = switchBody.indexOf(
      'await clearAccountScopedRuntimeForSwitch();',
    );
    const receiptClear = switchBody.indexOf(
      'await commitWithClearedAccountDeletionReceipt(() => {',
      runtimeClear,
    );
    const ownerCommit = switchBody.indexOf(
      'activateMobileSessionRealm(realm!);',
      receiptClear,
    );

    expect(runtimeClear).toBeGreaterThan(-1);
    expect(receiptClear).toBeGreaterThan(runtimeClear);
    expect(ownerCommit).toBeGreaterThan(receiptClear);
    expect(switchBody.slice(receiptClear, ownerCommit)).toContain(
      'pendingAccountDeletionRestoredRef.current = false;',
    );
    expect(switchBody.slice(receiptClear, ownerCommit)).toContain(
      'setAccountDeletionRestored(false);',
    );
  });

  it('normalizes outer saved-account sync failures into sheet state', () => {
    const authSource = readFileSync(
      resolve(process.cwd(), 'src/auth/AuthContext.tsx'),
      'utf8',
    );
    const syncStart = authSource.indexOf('const syncSavedAccounts = useCallback');
    const syncBody = authSource.slice(
      syncStart,
      authSource.indexOf('\n\n  const switchAccount = useCallback', syncStart),
    );

    expect(syncBody).toContain('const generation = authGenerationRef.current;');
    expect(syncBody).toContain('} catch (error) {');
    expect(syncBody).toContain('setAccountsError(authErrorCode(error));');
    expect(syncBody).toContain(
      'if (authGenerationRef.current === generation) setAccountsLoading(false);',
    );
  });

  it('routes every background saved-account snapshot through rejection handling', () => {
    const authSource = readFileSync(
      resolve(process.cwd(), 'src/auth/AuthContext.tsx'),
      'utf8',
    );
    const helperStart = authSource.indexOf(
      'const refreshSavedAccountsSnapshotBestEffort = useCallback',
    );
    const helperBody = authSource.slice(
      helperStart,
      authSource.indexOf(
        '\n\n  const clearAccountScopedRuntimeForSwitch',
        helperStart,
      ),
    );

    expect(helperBody).toContain(
      'void refreshSavedAccountsSnapshot().catch(() => undefined);',
    );
    expect(authSource).not.toContain('void refreshSavedAccountsSnapshot();');
    expect(
      authSource.match(/refreshSavedAccountsSnapshotBestEffort\(\);/g)?.length,
    ).toBeGreaterThanOrEqual(4);
  });

  it('keeps the added-account vault transaction through runtime cleanup and owner commit', () => {
    const authSource = readFileSync(
      resolve(process.cwd(), 'src/auth/AuthContext.tsx'),
      'utf8',
    );
    const acceptStart = authSource.indexOf('const acceptOutcome = useCallback');
    const acceptBody = authSource.slice(
      acceptStart,
      authSource.indexOf('const refresh = useCallback', acceptStart),
    );
    const serialized = acceptBody.indexOf(
      'const persisted = await serializeRefreshTokenMutation(async () => {',
    );
    const previousSessionSnapshot = acceptBody.indexOf(
      'const previousPersistedSessionRaw = await getSecureItem(AUTH_SESSION_KEY);',
      serialized,
    );
    const vaultTransaction = acceptBody.indexOf(
      'await commitMobileLoginSessions(',
      serialized,
    );
    const targetWrite = acceptBody.indexOf(
      'await writePersistedAuthSession(',
      vaultTransaction,
    );
    const runtimeClear = acceptBody.indexOf(
      'await clearAccountScopedRuntimeForSwitch();',
      targetWrite,
    );
    const ownerCommit = acceptBody.indexOf(
      'activateMobileSessionRealm(committedRealm);',
      runtimeClear,
    );
    const rollback = acceptBody.indexOf(
      'await restorePersistedAuthSessionRaw(previousPersistedSessionRaw);',
      ownerCommit,
    );

    expect(serialized).toBeGreaterThan(-1);
    expect(previousSessionSnapshot).toBeGreaterThan(serialized);
    expect(vaultTransaction).toBeGreaterThan(previousSessionSnapshot);
    expect(targetWrite).toBeGreaterThan(vaultTransaction);
    expect(runtimeClear).toBeGreaterThan(targetWrite);
    expect(ownerCommit).toBeGreaterThan(runtimeClear);
    expect(rollback).toBeGreaterThan(ownerCommit);
    expect(acceptBody.slice(rollback)).toContain(
      'activateMobileSessionRealm(previousRealm);',
    );
  });

  it('durably clears saved credentials before publishing mobile logout', () => {
    const authSource = readFileSync(
      resolve(process.cwd(), 'src/auth/AuthContext.tsx'),
      'utf8',
    );
    const logoutStart = authSource.indexOf('const logout = useCallback');
    const logoutBody = authSource.slice(
      logoutStart,
      authSource.indexOf('const getAccessToken = useCallback', logoutStart),
    );
    const durableClear = logoutBody.indexOf(
      'clearMobileLoginCredentialsForLogout({',
    );
    const receiptClear = logoutBody.indexOf(
      'clearReceipt: () => persistAccountDeletionReceipt(null),',
      durableClear,
    );
    const runtimeClear = logoutBody.indexOf(
      'await clearLocalSession({ persistedAuthAlreadyCleared: true });',
    );
    expect(durableClear).toBeGreaterThan(-1);
    expect(receiptClear).toBeGreaterThan(durableClear);
    expect(runtimeClear).toBeGreaterThan(receiptClear);
    expect(logoutBody).not.toContain('clearMobileAccountVault().catch');
    expect(authSource).toContain(
      "typeof persistedAccountVault?.signedOutAt === 'number'",
    );
  });

  it('clears the previous owner canary flag before best-effort sync', () => {
    const authSource = readFileSync(
      resolve(process.cwd(), 'src/auth/AuthContext.tsx'),
      'utf8',
    );
    const acceptStart = authSource.indexOf('const acceptOutcome = useCallback');
    const acceptBody = authSource.slice(
      acceptStart,
      authSource.indexOf('const refresh = useCallback', acceptStart),
    );
    const switchStart = authSource.indexOf('const switchAccount = useCallback');
    const switchBody = authSource.slice(
      switchStart,
      authSource.indexOf('\n\n  const beginAddAccount', switchStart),
    );

    for (const body of [acceptBody, switchBody]) {
      const clearAt = body.indexOf('void clearCanaryChannel()');
      const syncAt = body.indexOf('scheduleCanaryChannelSync(', clearAt);
      expect(clearAt).toBeGreaterThan(-1);
      expect(syncAt).toBeGreaterThan(clearAt);
    }
  });

  it('invalidates an add-account login when Android removes the route', () => {
    const screenSource = readFileSync(
      resolve(process.cwd(), 'app/add-account.tsx'),
      'utf8',
    );
    const authSource = readFileSync(
      resolve(process.cwd(), 'src/auth/AuthContext.tsx'),
      'utf8',
    );
    expect(screenSource).toContain('() => () => {');
    expect(screenSource).toContain('void auth.cancelAddAccount();');
    expect(screenSource).toContain('flowFinishedRef.current');

    const beginStart = authSource.indexOf('const beginAddAccount = useCallback');
    const cancelStart = authSource.indexOf(
      'const cancelAddAccount = useCallback',
      beginStart,
    );
    const cancelEnd = authSource.indexOf(
      '\n\n  const clearLocalSession',
      cancelStart,
    );
    expect(authSource.slice(beginStart, cancelStart)).toContain(
      'loginFlowEpochRef.current += 1;',
    );
    expect(authSource.slice(cancelStart, cancelEnd)).toContain(
      'loginFlowEpochRef.current += 1;',
    );
    expect(authSource).toContain(
      'assertLoginFlowCurrent(expectedLoginFlowEpoch);',
    );
    expect(authSource).toContain(
      'loginFlowEpochRef.current !== expectedLoginFlowEpoch',
    );
  });

  it('does not block add-account while saved accounts sync in the background', () => {
    const sheetSource = readFileSync(
      resolve(process.cwd(), 'src/session/AccountSwitcherSheet.tsx'),
      'utf8',
    );
    expect(sheetSource).toContain('disabled={switchingKey !== null}');
    expect(sheetSource).not.toContain(
      'disabled={auth.accountsLoading || switchingKey !== null}',
    );
    expect(sheetSource).toContain("t('devices.list.alert.actionFailed')");
    expect(sheetSource).toContain('formatRemoteError(error)');
    expect(sheetSource).not.toContain('.catch(() => undefined)\n        .finally');
  });

  it('clears every Device Link account projection when accountGeneration changes', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/device-link/DeviceLinkContext.tsx'),
      'utf8',
    );
    const clearStart = source.indexOf(
      'const clearPerAccountDeviceLinkState = useCallback',
    );
    const clearEnd = source.indexOf('\n  }, []);', clearStart);
    const clearBody = source.slice(clearStart, clearEnd);
    expect(clearBody).toContain('remoteSessionStore.clear();');
    expect(clearBody).toContain('remoteScheduleEventStore.clearAll();');
    expect(clearBody).toContain('revokedDevicesStore.clearAll();');
    expect(clearBody).toContain('clearAllDeviceProviders();');
    expect(clearBody).toContain('setLastPresenceSnapshot(null);');

    const effectStart = source.indexOf(
      'const accountGenerationChanged =',
      clearEnd,
    );
    const authenticatedStart = source.indexOf(
      'const client = new DeviceLinkClient',
      effectStart,
    );
    const boundaryBody = source.slice(effectStart, authenticatedStart);
    expect(boundaryBody).toContain(
      'accountGenerationRef.current !== auth.accountGeneration',
    );
    expect(boundaryBody).toContain(
      'if (accountGenerationChanged) clearPerAccountDeviceLinkState();',
    );
  });

  it('accepts enterprise ID, organization slug, and verified domains up to the API limit', () => {
    const loginSource = readFileSync(
      resolve(process.cwd(), 'app/(auth)/login.tsx'),
      'utf8',
    );
    expect(loginSource).toContain('maxLength={253}');
    expect(loginSource).toContain("type: 'discover-sso-org'");
  });
});
