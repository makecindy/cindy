import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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

  it('keeps account tokens inside membership selection and private tickets off screen', () => {
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
    expect(authSource).not.toContain('.logoutAccount(');
    expect(authSource).not.toContain('.refreshAccount(');
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
      /if \(authGenerationRef\.current !== generation\)\s+throw authCodeError\('AUTH_FLOW_SUPERSEDED'\)/,
    );
    expect(authSource).toMatch(
      /if \(authGenerationRef\.current !== generation\) return null;\s+setToken\(pair\.accessToken\)/,
    );
    // 2026-07 产品 /api/user/me 退役:身份只经 auth-server getMe,防复活。
    expect(authSource).not.toContain("'/api/user/me'");
    expect(authSource).toContain("throw authCodeError('AUTH_FLOW_SUPERSEDED')");
    expect(authSource).toMatch(
      /code === 'INVALID_LOGIN_TICKET'\s*\|\|\s*code === 'INVALID_BIND_TICKET'/,
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
