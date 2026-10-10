// @vitest-environment jsdom
import React, { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  platform: 'android',
  replaceRoute: vi.fn(),
  closeAccount: undefined as (() => void) | undefined,
  storage: new Map<string, string>(),
  readSecure: vi.fn(),
  deleteSecure: vi.fn(),
  writeSecure: vi.fn(),
  logoutCleanup: vi.fn(),
  unregisterPush: vi.fn(),
  links: new Set<(event: { url: string }) => void>(),
  open: vi.fn(),
  exchange: vi.fn(),
  selectAccount: vi.fn(),
  requestBinding: vi.fn(),
  requestVerification: vi.fn(),
  providers: vi.fn(),
  initialUrl: vi.fn(),
  requestCode: vi.fn(),
  discoverOrganization: vi.fn(),
  crossRealm: false,
  state: 0,
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ replace: native.replaceRoute }) }));
vi.mock('../../../app/(auth)/login', () => ({
  LoginScreen: ({ onClose }: { onClose?: () => void }) => { native.closeAccount = onClose; return null; },
}));
vi.mock('react-native', () => ({
  Platform: { get OS() { return native.platform; } },
  AppState: { addEventListener: () => ({ remove() {} }) },
  Linking: {
    getInitialURL: native.initialUrl,
    addEventListener: (_: string, listener: (event: { url: string }) => void) => {
      native.links.add(listener);
      return { remove: () => native.links.delete(listener) };
    },
  },
  Keyboard: { dismiss() {} },
}));
vi.mock('expo-web-browser', () => ({
  maybeCompleteAuthSession() {}, openAuthSessionAsync: native.open,
}));
vi.mock('expo-modules-core', () => ({ requireNativeModule: () => ({ addCustomField() {} }) }));
vi.mock('@/config/env', () => ({
  BUILD_AUTH_REGION: 'cn', MOBILE_REDIRECT_URL: 'cindycn://auth',
  WECHAT_APP_ID: '', WECHAT_UNIVERSAL_LINK: '',
  IS_OTA_SELFHOST: false, MOBILE_VISUAL_MOCK_ENABLED: false,
  OAUTH_BROKER_API_BASE_URL: 'https://auth.example.invalid',
  getMobileEndpointForRealm: () => 'https://auth.example.invalid',
  getMobileEndpointRealmConfig: () => ({ crossRealmOrgLoginEnabled: native.crossRealm }),
  loadMobileEndpointsForRealm: async () => {},
  activateMobileSessionRealm() {}, resetMobileSessionRealm() {},
}));
vi.mock('@cindy/auth-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cindy/auth-client')>();
  return {
    ...actual,
    CindyAuthClient: class {
      getProviders = native.providers;
      requestCode = native.requestCode;
      discoverSsoOrg = native.discoverOrganization;
      buildAuthorizeUrl = ({ state }: { state: string }) => `https://auth.example.invalid/authorize?state=${state}`;
      exchangeAuthorizationCode = native.exchange;
      selectAccount = native.selectAccount;
      requestBindingCode = native.requestBinding;
      requestSsoVerificationCode = native.requestVerification;
    },
  };
});
vi.mock('@cindy/auth-client/fixtures', () => ({ resolveLoginScenarioFetch: () => undefined }));
vi.mock('@/auth/secureStorage', () => ({
  getSecureItem: native.readSecure,
  setSecureItem: native.writeSecure,
  deleteSecureItem: native.deleteSecure,
}));
vi.mock('@/auth/pkce', () => ({
  createPkcePair: async () => ({ codeVerifier: 'fixture-verifier', codeChallenge: 'fixture-challenge' }),
  createState: () => `fixture-state-${++native.state}`,
}));
vi.mock('@/auth/deviceId', () => ({ ensureDeviceId: async () => 'fixture-device', hasStoredDeviceId: async () => true }));
vi.mock('@/auth/mobileAccountVault', () => ({
  readMobileAccountVault: async () => null,
  clearMobileLoginCredentialsForLogout: native.logoutCleanup,
  listMobileSavedAccounts: () => [],
  reconcileMobileActiveAuthSession: async () => null,
}));
vi.mock('@/api/client', () => ({ registerAccountUnavailableHandler: () => () => {} }));
vi.mock('@/auth/nativeSocial', () => ({}));
vi.mock('@/auth/ssoOrgHistory', () => ({ rememberSsoOrgIdentifier: async () => {} }));
vi.mock('@/auth/canaryChannelSync', () => ({}));
vi.mock('@/auth/xdOrgBetaDefault', () => ({}));
vi.mock('@/analytics/mobileTapdb', () => ({ clearTapdbUser: async () => {}, stopMobileTapdbReporting: async () => {} }));
vi.mock('@/analytics/analyticsConsentStore', () => ({ clearAnalyticsConsent: async () => {} }));
vi.mock('@/notifications/pushNotifications', () => ({ unregisterPushTokenBestEffort: native.unregisterPush }));
vi.mock('@/session/agentCapabilitiesCache', () => ({ resetAgentCapabilitiesCache: async () => {} }));
vi.mock('@/session/composerPaletteCache', () => ({ resetComposerPaletteCache: async () => {} }));
vi.mock('@/device-link/remoteResourceCache', () => ({ clearRemoteResourceCache: async () => {} }));
vi.mock('@/session/mobileHomeListCache', () => ({ clearCachedHomeListSnapshot: async () => {} }));
vi.mock('@/device-link/clipboardInvitationHistory', () => ({ clearClipboardInvitationHistory: async () => {} }));
vi.mock('@/remote-desktop/credentialIdentity', () => ({ updateCredentialAccessToken() {} }));
vi.mock('@/session/mobileSessionMessageCache', () => ({ clearCachedSessionMessages: async () => {} }));
vi.mock('@/session/remoteHistoryDiskCache', () => ({ clearHistoryDisk: async () => {} }));
vi.mock('@/session/mobileVoiceCredentialStore', () => ({ clearAllMobileVoiceCredentials: async () => {} }));
vi.mock('@/session/mobileVoiceDictionaryCache', () => ({ setMobileVoiceDictionaryAccountScope() {}, clearAllMobileVoiceDictionaryCaches: async () => {} }));
vi.mock('@/session/mobileVoiceHistoryStore', () => ({ clearAllMobileVoiceInputHistories: async () => {} }));
vi.mock('@/debug/visualMock', () => ({}));
vi.mock('@/update/canaryChannelStore', () => ({ clearCanaryChannel: async () => {} }));
vi.mock('@/update/betaChannelStore', () => ({ prepareBetaChannelForDevice: async () => {} }));
vi.mock('@/update/fetchLatestRelease', () => ({}));

import { AuthProvider, useAuth } from '../AuthContext';
import AddAccountScreen from '../../../app/add-account';
import { redirectSystemPath } from '../../../app/+native-intent';

const pendingKey = 'cindy.mobile.auth.pendingOAuth';
const verifiedOutcome = {
  status: 'sso_verification_required', verificationTicket: 'fixture-ticket',
  channel: 'email', targetMasked: 'u***@example.invalid',
};
let auth: ReturnType<typeof useAuth>;
let root: Root;

function Probe() {
  auth = useAuth();
  return null;
}

function LoginScreenLifecycle() {
  const value = useAuth();
  const initialized = useRef(false);
  useEffect(() => {
    if (!value.initialized || value.isAuthenticated || initialized.current) return;
    initialized.current = true;
    void value.dispatchLoginAction({ type: 'initialize' });
  }, [value]);
  return null;
}

async function restartProvider() {
  await act(async () => root.unmount());
  root = createRoot(document.createElement('div'));
  await act(async () => { root.render(<AuthProvider><Probe /></AuthProvider>); });
}

async function mountLoginScreen(key: string) {
  await act(async () => {
    root.render(<AuthProvider><Probe /><LoginScreenLifecycle key={key} /></AuthProvider>);
  });
}

function callbackUrl(state = JSON.parse(native.storage.get(pendingKey)!).state as string) {
  return `cindycn://auth?code=fixture-code&state=${state}`;
}

async function start(kind: 'sso' | 'social' = 'sso') {
  await act(async () => {
    await auth.dispatchLoginAction(kind === 'sso'
      ? { type: 'discover-sso-org', org: 'example.invalid' }
      : { type: 'start-social-browser', provider: 'wechat', label: 'WeChat' });
  });
}

async function emitLink(url: string) {
  await act(async () => {
    for (const listener of native.links) listener({ url });
  });
}

describe('browser auth session lifecycle (real AuthProvider, mocked native/network boundaries)', () => {
  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    native.platform = 'android';
    native.replaceRoute.mockReset();
    native.closeAccount = undefined;
    native.crossRealm = false;
    native.discoverOrganization.mockReset().mockResolvedValue({
      region: 'cn', orgName: 'Fixture Organization',
      connections: [{ connectionId: 'fixture-connection', connectionName: 'Fixture SSO', protocol: 'wecom' }],
    });
    native.providers.mockReset().mockResolvedValue({ social: ['wechat'], emailCode: true, smsCode: false });
    native.initialUrl.mockReset().mockResolvedValue(null);
    native.requestCode.mockReset().mockResolvedValue(undefined);
    native.storage.clear();
    native.writeSecure.mockReset().mockImplementation(async (key: string, value: string) => { native.storage.set(key, value); });
    native.logoutCleanup.mockReset();
    native.unregisterPush.mockReset();
    native.deleteSecure.mockReset().mockImplementation(async (key: string) => { native.storage.delete(key); });
    native.readSecure.mockReset().mockImplementation(async (key: string) => native.storage.get(key) ?? null);
    native.state = 0;
    native.open.mockReset().mockResolvedValue({ type: 'dismiss' });
    native.exchange.mockReset().mockResolvedValue(verifiedOutcome);
    native.selectAccount.mockReset().mockResolvedValue(verifiedOutcome);
    native.requestBinding.mockReset().mockResolvedValue(undefined);
    native.requestVerification.mockReset().mockResolvedValue(undefined);
    root = createRoot(document.createElement('div'));
    await act(async () => { root.render(<AuthProvider><Probe /></AuthProvider>); });
    expect(auth.initialized).toBe(true);
    await act(async () => { await auth.dispatchLoginAction({ type: 'reset' }); });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    expect(native.links.size).toBe(0);
    vi.restoreAllMocks();
  });

  it.each(['sso', 'social'] as const)('retains %s login on Android dismiss and accepts a delayed deep link', async (kind) => {
    await start(kind);
    expect(auth.loginState?.step).toBe('browser-redirect');
    expect(auth.isBusy).toBe(false); // The existing Cancel button must be usable.
    expect(auth.authError).toBeNull();
    expect(native.storage.has(pendingKey)).toBe(true);
    expect(native.exchange).not.toHaveBeenCalled();

    await emitLink(callbackUrl());
    expect(native.exchange).toHaveBeenCalledExactlyOnceWith('fixture-code', 'fixture-verifier');
    expect(auth.loginState?.step).toBe('sso-verification');
    expect(native.storage.has(pendingKey)).toBe(false);
  });

  it.each(['access_denied', 'missing-code'])('surfaces a current terminal callback after dismiss (%s)', async error => {
    await start();
    const state = JSON.parse(native.storage.get(pendingKey)!).state;
    await emitLink(`cindycn://auth?state=${state}${error === 'access_denied' ? '&error=access_denied' : ''}`);
    expect(native.exchange).not.toHaveBeenCalled();
    expect(auth.loginState?.step).toBe('error');
    expect(auth.authError).toBe(error === 'access_denied' ? error : 'INVALID_AUTH_CODE');
    expect(native.storage.has(pendingKey)).toBe(false);
    await emitLink(callbackUrl(state));
    expect(native.exchange).not.toHaveBeenCalled();
    await act(async () => { await auth.dispatchLoginAction({ type: 'reset' }); });
    await start();
    await emitLink(callbackUrl());
    expect(auth.loginState?.step).toBe('sso-verification');
  });

  it.each(['wrong-state', 'missing-state'])('ignores an unowned error callback (%s)', async state => {
    await start();
    const pending = native.storage.get(pendingKey);
    await emitLink(`cindycn://auth?error=access_denied${state === 'wrong-state' ? '&state=old-state' : ''}`);
    expect(auth.loginState?.step).toBe('browser-redirect');
    expect(auth.authError).toBeNull();
    expect(native.storage.get(pendingKey)).toBe(pending);
    await emitLink(callbackUrl());
    expect(auth.loginState?.step).toBe('sso-verification');
  });

  it.each(['native-cancel', 'close-account', 'error-link'])('reports complete storage failure and permits cancellation retry (%s)', async entry => {
    if (entry === 'close-account') await act(async () => { await auth.beginAddAccount(); });
    let finish!: (v: {type: 'cancel'}) => void;
    let opening!: Promise<unknown>;
    if (entry === 'native-cancel') {
      native.open.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      await act(async () => { opening = auth.dispatchLoginAction({ type: 'start-social-browser', provider: 'wechat', label: 'WeChat' }).catch(e => e); });
    } else await start();
    const pending = native.storage.get(pendingKey);
    const url = callbackUrl();
    native.writeSecure.mockRejectedValueOnce(new Error('fixture storage unavailable'));
    native.deleteSecure.mockRejectedValueOnce(new Error('fixture storage unavailable'));
    await act(async () => {
      if (entry === 'native-cancel') { finish({type: 'cancel'}); await opening; }
      else if (entry === 'close-account') await auth.cancelAddAccount().catch(() => undefined);
      else for (const listener of native.links) listener({url: url.replace('code=fixture-code', 'error=access_denied')});
    });
    expect(auth.loginState?.step).toBe('error');
    expect(auth.authError).toBeTruthy();
    expect(native.storage.get(pendingKey)).toBe(pending);
    await emitLink(url);
    expect(native.exchange).not.toHaveBeenCalled();
    await act(async () => {
      if (entry === 'close-account') await auth.cancelAddAccount();
      else expect(await auth.dispatchLoginAction({type: 'reset'})).toBe(true);
    });
    expect(native.storage.has(pendingKey)).toBe(false);
  });

  it('keeps the add-account route open when cancellation fails and closes on retry', async () => {
    await act(async () => { await auth.beginAddAccount(); });
    await start();
    await act(async () => { root.render(<AuthProvider><Probe /><AddAccountScreen /></AuthProvider>); });
    native.writeSecure.mockRejectedValueOnce(new Error('fixture storage unavailable'));
    native.deleteSecure.mockRejectedValueOnce(new Error('fixture storage unavailable'));
    await act(async () => { native.closeAccount!(); });
    expect(auth.loginState?.step).toBe('error');
    expect(native.replaceRoute).not.toHaveBeenCalled();
    await act(async () => { native.closeAccount!(); });
    expect(native.replaceRoute).toHaveBeenCalledExactlyOnceWith('/devices');
    expect(native.storage.has(pendingKey)).toBe(false);
  });

  it('ignores repeated close taps while cancellation is pending, including storage failure', async () => {
    await act(async () => { await auth.beginAddAccount(); });
    await start();
    const pending = native.storage.get(pendingKey);
    const url = callbackUrl();
    await act(async () => { root.render(<AuthProvider><Probe /><AddAccountScreen /></AuthProvider>); });
    native.writeSecure.mockRejectedValue(new Error('fixture storage unavailable'));
    native.deleteSecure.mockRejectedValue(new Error('fixture storage unavailable'));
    const writes = native.writeSecure.mock.calls.length;
    await act(async () => { native.closeAccount!(); native.closeAccount!(); });
    expect(native.replaceRoute).not.toHaveBeenCalled();
    expect(native.writeSecure.mock.calls.length - writes).toBe(1);
    expect(auth.loginState?.step).toBe('error');
    expect(native.storage.get(pendingKey)).toBe(pending);
    await emitLink(url);
    expect(native.exchange).not.toHaveBeenCalled();
    native.writeSecure.mockImplementation(async (key: string, value: string) => { native.storage.set(key, value); });
    native.deleteSecure.mockImplementation(async (key: string) => { native.storage.delete(key); });
    await act(async () => { native.closeAccount!(); });
    expect(native.replaceRoute).toHaveBeenCalledExactlyOnceWith('/devices');
    expect(native.storage.has(pendingKey)).toBe(false);
  });

  it('surfaces a failed unmount cancellation without an unhandled rejection', async () => {
    await act(async () => { await auth.beginAddAccount(); });
    await start();
    const url = callbackUrl();
    await act(async () => { root.render(<AuthProvider><Probe /><AddAccountScreen /></AuthProvider>); });
    native.writeSecure.mockRejectedValueOnce(new Error('fixture storage unavailable'));
    native.deleteSecure.mockRejectedValueOnce(new Error('fixture storage unavailable'));
    await act(async () => { root.render(<AuthProvider><Probe /></AuthProvider>); });
    expect(auth.loginState?.step).toBe('error');
    await emitLink(url);
    expect(native.exchange).not.toHaveBeenCalled();
    await act(async () => { await auth.beginAddAccount(); });
    expect(native.storage.has(pendingKey)).toBe(false);
    expect(auth.loginState?.step).toBe('identifier');
  });

  it('handles a terminal native success redirect on iOS through the same error path', async () => {
    native.platform = 'ios';
    native.open.mockImplementationOnce(async (url: string) => ({
      type: 'success', url: `cindycn://auth?state=${new URL(url).searchParams.get('state')}&error=access_denied`,
    }));
    await act(async () => {
      await auth.dispatchLoginAction({type: 'start-social-browser', provider: 'wechat', label: 'WeChat'}).catch(() => undefined);
    });
    expect(auth.loginState?.step).toBe('error');
    expect(auth.authError).toBe('access_denied');
    expect(native.storage.has(pendingKey)).toBe(false);
    expect(native.exchange).not.toHaveBeenCalled();
  });

  it.each([
    { outcome: verifiedOutcome, action: {type: 'request-sso-verification-code'}, request: native.requestVerification, step: 'sso-verification', args: ['fixture-ticket'] },
    { outcome: {status: 'select_account', loginTicket: 'fixture-ticket', accounts: []}, action: {type: 'select-account', accountId: 'fixture-account'}, request: native.selectAccount, step: 'account-selection', args: ['fixture-ticket', 'fixture-account'] },
    { outcome: {status: 'binding_required', bindType: 'email', bindTicket: 'fixture-ticket'}, action: {type: 'request-binding-code', contact: 'user@example.invalid'}, request: native.requestBinding, step: 'binding', args: ['fixture-ticket', 'email', 'user@example.invalid'] },
  ] as const)('allows $step actions before the browser settles without late cancel clearing new work', async fixture => {
    native.exchange.mockResolvedValueOnce(fixture.outcome);
    let finishBrowser!: (value: {type: 'cancel'}) => void;
    native.open.mockImplementationOnce(() => new Promise(resolve => { finishBrowser = resolve; }));
    let opening!: Promise<unknown>;
    await act(async () => { opening = auth.dispatchLoginAction({type: 'start-social-browser', provider: 'wechat', label: 'WeChat'}).catch(e => e); });
    await emitLink(callbackUrl());
    expect(auth.loginState?.step).toBe(fixture.step);
    let finishRequest!: () => void;
    fixture.request.mockImplementationOnce(() => new Promise(resolve => { finishRequest = () => resolve(verifiedOutcome); }));
    let requesting!: Promise<boolean>;
    await act(async () => { requesting = auth.dispatchLoginAction(fixture.action); });
    expect(fixture.request).toHaveBeenCalledExactlyOnceWith(...fixture.args);
    expect(auth.isBusy).toBe(true);
    await act(async () => { finishBrowser({type: 'cancel'}); await opening; });
    expect(auth.loginState?.step).toBe(fixture.step);
    expect(auth.isBusy).toBe(true);
    await act(async () => { finishRequest(); expect(await requesting).toBe(true); });
    expect(auth.isBusy).toBe(false);
  });

  it('retires expired credentials during cold initialization', async () => {
    native.storage.set(pendingKey, JSON.stringify({state: 'expired', codeVerifier: 'fixture-verifier', deviceId: 'fixture-device', realm: 'cn', label: 'SSO', createdAt: Date.now() - 11 * 60 * 1000}));
    await restartProvider();
    await mountLoginScreen('expired-cold');
    expect(auth.loginState?.step).toBe('identifier');
    expect(native.storage.has(pendingKey)).toBe(false);
  });

  it('queues expired cleanup before a newer browser credential write', async () => {
    native.storage.set(pendingKey, JSON.stringify({state: 'expired', codeVerifier: 'fixture-verifier', deviceId: 'fixture-device', realm: 'cn', label: 'SSO', createdAt: Date.now() - 11 * 60 * 1000}));
    await restartProvider();
    let finishDelete!: () => void;
    native.deleteSecure.mockImplementationOnce(() => new Promise<void>(resolve => {
      finishDelete = () => { native.storage.delete(pendingKey); resolve(); };
    }));
    await mountLoginScreen('expired-cleanup');
    let opening!: Promise<boolean>;
    await act(async () => { opening = auth.dispatchLoginAction({type: 'reset'}).then(() => auth.dispatchLoginAction({type: 'start-social-browser', provider: 'wechat', label: 'WeChat'})); });
    await act(async () => { finishDelete(); await opening; });
    expect(auth.loginState?.step).toBe('browser-redirect');
    expect(JSON.parse(native.storage.get(pendingKey)!).state).not.toBe('expired');
    await emitLink(callbackUrl());
    expect(auth.loginState?.step).toBe('sso-verification');
  });

  it.each(['initial-url', 'initialize'] as const)('does not restore an add-account attempt after restart (%s)', async entry => {
    await act(async () => { await auth.beginAddAccount(); });
    await start();
    const oldUrl = callbackUrl();
    if (entry === 'initial-url') native.initialUrl.mockResolvedValueOnce(oldUrl);
    await restartProvider();
    await mountLoginScreen('cold-add-account');
    expect(native.exchange).not.toHaveBeenCalled();
    expect(native.storage.has(pendingKey)).toBe(false);
    expect(auth.loginState?.step).toBe('identifier');
    await emitLink(oldUrl);
    expect(native.exchange).not.toHaveBeenCalled();
    await act(async () => { await auth.beginAddAccount(); });
    await start();
    await emitLink(callbackUrl());
    expect(native.exchange).toHaveBeenCalledTimes(1);
    expect(auth.loginState?.step).toBe('sso-verification');
  });

  it('retires add-account credentials on provider startup without a login screen or initial URL', async () => {
    await act(async () => { await auth.beginAddAccount(); });
    await start();
    await restartProvider();
    expect(native.initialUrl).toHaveReturned();
    expect(auth.initialized).toBe(true);
    expect(auth.loginState).toBeNull();
    expect(native.exchange).not.toHaveBeenCalled();
    expect(native.storage.has(pendingKey)).toBe(false);
  });

  it('does not let delayed startup cleanup retire a newly started login', async () => {
    await act(async () => { await auth.beginAddAccount(); });
    await start();
    const oldRecord = native.storage.get(pendingKey)!;
    let finishRead!: () => void;
    let delayed = false;
    native.readSecure.mockImplementation(async (key: string) => {
      if (key === pendingKey && !delayed) {
        delayed = true;
        return new Promise<string>(resolve => { finishRead = () => resolve(oldRecord); });
      }
      return native.storage.get(key) ?? null;
    });
    await restartProvider();
    await act(async () => { await auth.beginAddAccount(); });
    await start();
    const newRecord = native.storage.get(pendingKey);
    await act(async () => { finishRead(); });
    expect(native.storage.get(pendingKey)).toBe(newRecord);
    await emitLink(callbackUrl());
    expect(auth.loginState?.step).toBe('sso-verification');
  });

  it('does not fail provider startup when stale add-account retirement cannot be persisted', async () => {
    await act(async () => { await auth.beginAddAccount(); });
    await start();
    const url = callbackUrl();
    native.writeSecure.mockRejectedValueOnce(new Error('fixture storage failure'));
    native.deleteSecure.mockImplementation(async (key: string) => {
      if (key === pendingKey) throw new Error('fixture storage failure');
      native.storage.delete(key);
    });
    await restartProvider();
    expect(auth.initialized).toBe(true);
    expect(auth.isBusy).toBe(false);
    await emitLink(url);
    expect(native.exchange).not.toHaveBeenCalled();
    native.deleteSecure.mockImplementation(async (key: string) => { native.storage.delete(key); });
    await restartProvider();
    expect(native.storage.has(pendingKey)).toBe(false);
  });

  it('keeps the add-account route mounted for a delayed warm auth link', async () => {
    await act(async () => { await auth.beginAddAccount(); });
    await start();
    await act(async () => { root.render(<AuthProvider><Probe /><AddAccountScreen /></AuthProvider>); });
    const url = callbackUrl();
    const target = redirectSystemPath({path: url, initial: false});
    // Expo Router only navigates for a truthy redirectSystemPath result.
    if (target) await act(async () => { root.render(<AuthProvider><Probe /></AuthProvider>); });
    await emitLink(url);
    expect(target).toBeNull();
    expect(native.exchange).toHaveBeenCalledExactlyOnceWith('fixture-code', 'fixture-verifier');
    expect(auth.loginState?.step).toBe('sso-verification');
    expect(native.replaceRoute).not.toHaveBeenCalled();
  });

  it.each([
    {outcome: verifiedOutcome, action: {type: 'request-sso-verification-code'}, request: native.requestVerification},
    {outcome: {status: 'select_account', loginTicket: 'fixture-ticket', accounts: []}, action: {type: 'select-account', accountId: 'fixture-account'}, request: native.selectAccount},
    {outcome: {status: 'binding_required', bindType: 'email', bindTicket: 'fixture-ticket'}, action: {type: 'request-binding-code', contact: 'user@example.invalid'}, request: native.requestBinding},
  ] as const)('blocks $action.type while add-account cancellation is persisting', async fixture => {
    native.exchange.mockResolvedValueOnce(fixture.outcome);
    await act(async () => { await auth.beginAddAccount(); });
    await start();
    await emitLink(callbackUrl());
    let finishDelete!: () => void;
    native.deleteSecure.mockImplementationOnce(() => new Promise<void>(resolve => {
      finishDelete = () => { native.storage.delete(pendingKey); resolve(); };
    }));
    let closing!: Promise<void>;
    await act(async () => { closing = auth.cancelAddAccount(); });
    expect(auth.isBusy).toBe(true);
    await act(async () => {
      expect(await auth.dispatchLoginAction(fixture.action)).toBe(false);
    });
    expect(fixture.request).not.toHaveBeenCalled();
    await act(async () => { finishDelete(); await closing; });
    expect(auth.loginState).toBeNull();
    expect(auth.isBusy).toBe(false);
  });

  it('does not retire a new ordinary login after a delayed startup read of an old add-account record', async () => {
    await act(async () => { await auth.beginAddAccount(); });
    await start();
    const oldRecord = native.storage.get(pendingKey)!;
    let finishRead!: () => void;
    let delayed = false;
    native.readSecure.mockImplementation(async (key: string) => {
      if (key === pendingKey && !delayed) {
        delayed = true;
        return new Promise<string>(resolve => { finishRead = () => resolve(oldRecord); });
      }
      return native.storage.get(key) ?? null;
    });
    await restartProvider();
    await mountLoginScreen('ordinary-cold-login');
    expect(auth.loginState?.step).toBe('identifier');
    await start('social');
    const newRecord = native.storage.get(pendingKey);
    expect(JSON.parse(newRecord!).additionalAccount).toBe(false);
    await act(async () => { finishRead(); });
    expect(native.storage.get(pendingKey)).toBe(newRecord);
    await emitLink(callbackUrl());
    expect(auth.loginState?.step).toBe('sso-verification');
  });

  it.each(['cancel', 'dismiss', 'success'] as const)('preserves a terminal Linking error when the browser later returns %s', async type => {
    native.platform = 'ios';
    let finishBrowser!: (value: {type: string; url?: string}) => void;
    native.open.mockImplementationOnce(() => new Promise(resolve => { finishBrowser = resolve; }));
    let opening!: Promise<unknown>;
    await act(async () => { opening = auth.dispatchLoginAction({type: 'start-social-browser', provider: 'wechat', label: 'WeChat'}).catch(e => e); });
    const errorUrl = callbackUrl().replace('code=fixture-code', 'error=access_denied');
    await emitLink(errorUrl);
    const errorState = auth.loginState;
    expect(errorState?.step).toBe('error');
    await act(async () => { finishBrowser({type, url: errorUrl}); await opening; });
    expect(auth.loginState).toBe(errorState);
    expect(auth.authError).toBe('access_denied');
    expect(native.exchange).not.toHaveBeenCalled();
    await act(async () => { await auth.dispatchLoginAction({type: 'reset'}); });
    native.platform = 'android';
    await start();
    await emitLink(callbackUrl());
    expect(auth.loginState?.step).toBe('sso-verification');
  });

  it('explicit reset cancels the pending login; its late callback cannot authenticate', async () => {
    await start();
    const oldCallback = callbackUrl();
    await act(async () => { await auth.dispatchLoginAction({ type: 'reset' }); });
    expect(native.storage.has(pendingKey)).toBe(false);
    expect(auth.loginState?.step).toBe('identifier');
    await emitLink(oldCallback);
    expect(native.exchange).not.toHaveBeenCalled();
    expect(auth.authError).toBeNull();
    await act(async () => { await auth.dispatchLoginAction({ type: 'reset' }); });
    await start();
    await emitLink(callbackUrl());
    expect(native.exchange).toHaveBeenCalledTimes(1);
  });

  it.each(['late-link', 'in-flight'] as const)('keeps failed cancellation fenced until storage deletion can be retried (%s)', async timing => {
    await start();
    const oldCallback = callbackUrl();
    const pending = native.storage.get(pendingKey);
    let complete!: (value: typeof verifiedOutcome) => void;
    if (timing === 'in-flight') {
      native.exchange.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
      await emitLink(oldCallback);
    }
    native.writeSecure.mockRejectedValueOnce(new Error('fixture storage unavailable'));
    native.deleteSecure.mockRejectedValueOnce(new Error('fixture storage unavailable'));
    await act(async () => { expect(await auth.dispatchLoginAction({ type: 'reset' })).toBe(false); });
    expect(native.storage.get(pendingKey)).toBe(pending);
    expect(auth.loginState?.step).toBe('error');
    const error = auth.authError;
    await mountLoginScreen('remount-after-failed-cancel');
    await emitLink(oldCallback);
    if (timing === 'in-flight') await act(async () => { complete(verifiedOutcome); });
    expect(native.exchange).toHaveBeenCalledTimes(timing === 'in-flight' ? 1 : 0);
    expect(auth.loginState?.step).toBe('error');
    expect(auth.authError).toBe(error);
    await act(async () => { expect(await auth.dispatchLoginAction({ type: 'reset' })).toBe(true); });
    expect(native.storage.has(pendingKey)).toBe(false);
    expect(auth.loginState?.step).toBe('identifier');
    await start();
    await emitLink(callbackUrl());
    expect(native.exchange).toHaveBeenCalledTimes(timing === 'in-flight' ? 2 : 1);
    expect(auth.loginState?.step).toBe('sso-verification');
  });

  it('ignores a callback that starts while cancellation is still deleting credentials', async () => {
    await start();
    const url = callbackUrl();
    let deleted!: () => void;
    native.deleteSecure.mockImplementationOnce(() => new Promise<void>(resolve => {
      deleted = () => { native.storage.delete(pendingKey); resolve(); };
    }));
    let reset!: Promise<boolean>;
    await act(async () => { reset = auth.dispatchLoginAction({ type: 'reset' }); });
    await emitLink(url);
    expect(native.exchange).not.toHaveBeenCalled();
    expect(auth.isBusy).toBe(true);
    await act(async () => { deleted(); expect(await reset).toBe(true); });
    expect(auth.loginState?.step).toBe('identifier');
    expect(auth.authError).toBeNull();
  });

  it.each(['reset', 'close'] as const)('persists cancellation across restart when deletion fails (%s)', async action => {
    await start();
    const url = callbackUrl();
    native.deleteSecure.mockRejectedValueOnce(new Error('fixture deletion failure'));
    await act(async () => {
      if (action === 'reset') await auth.dispatchLoginAction({ type: 'reset' });
      else await auth.cancelAddAccount();
    });
    native.initialUrl.mockResolvedValue(url);
    await restartProvider();
    await mountLoginScreen('after-restart');
    expect(native.exchange).not.toHaveBeenCalled();
    expect(auth.loginState?.step).toBe('identifier');
  });

  it.each(['old-first', 'current-first'] as const)('does not deduplicate different callback states (%s)', async order => {
    await start();
    const oldUrl = callbackUrl();
    await act(async () => { await auth.dispatchLoginAction({ type: 'reset' }); });
    await start();
    const currentUrl = callbackUrl();
    const pending = native.storage.get(pendingKey)!;
    let finishRead!: (value: string) => void;
    native.readSecure.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    await emitLink(order === 'old-first' ? oldUrl : currentUrl);
    await emitLink(order === 'old-first' ? currentUrl : oldUrl);
    await act(async () => { finishRead(pending); });
    expect(native.exchange).toHaveBeenCalledTimes(1);
    expect(auth.loginState?.step).toBe('sso-verification');
    expect(auth.authError).toBeNull();
  });

  it('invalidates cold callback validation before a browser state has been restored', async () => {
    await start();
    const oldUrl = callbackUrl();
    const pending = native.storage.get(pendingKey)!;
    await restartProvider();
    let finishRead!: (value: string) => void;
    native.readSecure.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    await emitLink(oldUrl);
    expect(auth.loginState).toBeNull();
    await act(async () => { await auth.dispatchLoginAction({ type: 'reset' }); });
    await start();
    await emitLink(callbackUrl());
    await act(async () => { finishRead(pending); });
    expect(native.exchange).toHaveBeenCalledTimes(1);
    expect(auth.loginState?.step).toBe('sso-verification');
    expect(auth.authError).toBeNull();
  });

  it('ignores a duplicate success callback after its continuation is already displayed', async () => {
    await start();
    const url = callbackUrl();
    await emitLink(url);
    const state = auth.loginState;
    await emitLink(url);
    expect(native.exchange).toHaveBeenCalledTimes(1);
    expect(auth.loginState).toBe(state);
    expect(auth.authError).toBeNull();
  });

  it('an earlier attempt cannot consume the new attempt after cancel and retry', async () => {
    await start();
    const oldCallback = callbackUrl();
    await act(async () => { await auth.dispatchLoginAction({ type: 'reset' }); });
    await start();
    const pending = native.storage.get(pendingKey);
    await emitLink(oldCallback);
    expect(native.exchange).not.toHaveBeenCalled();
    expect(auth.authError).toBeNull();
    expect(native.storage.get(pendingKey)).toBe(pending);
    await emitLink(callbackUrl());
    expect(native.exchange).toHaveBeenCalledTimes(1);
    expect(auth.authError).toBeNull();
  });

  it('retaining the attempt does not extend its existing ten-minute PKCE lifetime', async () => {
    await start();
    const url = callbackUrl();
    const pending = JSON.parse(native.storage.get(pendingKey)!);
    vi.spyOn(Date, 'now').mockReturnValue(pending.createdAt + 10 * 60_000 + 1);
    await emitLink(url);
    expect(native.exchange).not.toHaveBeenCalled();
    expect(auth.authError).toBe('INVALID_AUTH_CODE');
    expect(native.storage.has(pendingKey)).toBe(false);
  });

  it.each(['android', 'ios'])('preserves normal successful browser callbacks on %s', async (platform) => {
    native.platform = platform;
    native.open.mockImplementation(async () => ({ type: 'success', url: callbackUrl() }));
    await start();
    expect(native.exchange).toHaveBeenCalledExactlyOnceWith('fixture-code', 'fixture-verifier');
    expect(auth.loginState?.step).toBe('sso-verification');
    expect(native.storage.has(pendingKey)).toBe(false);
  });

  it.each([['ios', 'cancel'], ['ios', 'dismiss'], ['android', 'cancel']])('preserves cleanup for %s %s', async (platform, type) => {
    native.platform = platform;
    native.open.mockResolvedValue({ type });
    // Existing non-dismiss cancellation rejects at the browser boundary.
    await act(async () => {
      await expect(auth.dispatchLoginAction({ type: 'discover-sso-org', org: 'example.invalid' }))
        .rejects.toMatchObject({ code: 'USER_CANCELLED' });
    });
    expect(native.storage.has(pendingKey)).toBe(false);
    expect(auth.loginState).toBeNull();
    expect(native.exchange).not.toHaveBeenCalled();
  });

  it.each([
    ['android', 'cancel', 'delayed'], ['android', 'cancel', 'failed'],
    ['ios', 'cancel', 'delayed'], ['ios', 'cancel', 'failed'],
    ['ios', 'dismiss', 'delayed'], ['ios', 'dismiss', 'failed'],
  ])('fences %s browser %s during %s credential deletion', async (platform, type, deletion) => {
    native.platform = platform;
    native.open.mockResolvedValueOnce({ type });
    let finishDelete!: () => void;
    if (deletion === 'failed') native.deleteSecure.mockRejectedValueOnce(new Error('fixture storage failure'));
    else native.deleteSecure.mockImplementationOnce(() => new Promise<void>(resolve => {
      finishDelete = () => { native.storage.delete(pendingKey); resolve(); };
    }));
    let result!: Promise<unknown>;
    await act(async () => {
      result = auth.dispatchLoginAction({ type: 'start-social-browser', provider: 'wechat', label: 'WeChat' })
        .catch(error => error);
    });
    await emitLink(callbackUrl(new URL(native.open.mock.calls[0][0]).searchParams.get('state')!));
    expect(native.exchange).not.toHaveBeenCalled();
    await act(async () => {
      if (deletion === 'delayed') finishDelete();
      expect(await result).toMatchObject({ code: 'USER_CANCELLED' });
    });
    expect(auth.loginState).toBeNull();
  });

  it('invalidates an exchange already running when the browser reports cancel', async () => {
    let finishBrowser!: (value: { type: string }) => void;
    let finishExchange!: (value: typeof verifiedOutcome) => void;
    native.open.mockImplementationOnce(() => new Promise(resolve => { finishBrowser = resolve; }));
    native.exchange.mockImplementationOnce(() => new Promise(resolve => { finishExchange = resolve; }));
    let result!: Promise<unknown>;
    await act(async () => {
      result = auth.dispatchLoginAction({ type: 'start-social-browser', provider: 'wechat', label: 'WeChat' })
        .catch(error => error);
    });
    await emitLink(callbackUrl());
    await act(async () => { finishBrowser({ type: 'cancel' }); await result; });
    expect(auth.loginState).toBeNull();
    await act(async () => { finishExchange(verifiedOutcome); });
    expect(auth.loginState).toBeNull();
    expect(auth.authError).toBeNull();
    expect(auth.isBusy).toBe(false);
  });

  it.each(['missing', 'valid'] as const)('ignores an old %s callback snapshot after a new OAuth write', async snapshot => {
    await restartProvider();
    await act(async () => { await auth.dispatchLoginAction({ type: 'initialize' }); });
    const old = JSON.stringify({ codeVerifier: 'old-verifier', deviceId: 'fixture-device', state: 'old-state', createdAt: Date.now(), label: 'Old', realm: 'cn' });
    let finishRead!: (value: string | null) => void;
    native.readSecure.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    await emitLink(callbackUrl('old-state'));
    await start('social');
    const pending = native.storage.get(pendingKey);
    const state = auth.loginState;
    await act(async () => { finishRead(snapshot === 'missing' ? null : old); });
    expect(native.storage.get(pendingKey)).toBe(pending);
    expect(auth.loginState).toBe(state);
    expect(native.exchange).not.toHaveBeenCalled();
    await emitLink(callbackUrl());
    expect(auth.loginState?.step).toBe('sso-verification');
  });

  it.each([
    { outcome: verifiedOutcome, action: {type: 'request-sso-verification-code'}, request: native.requestVerification },
    { outcome: {status: 'select_account', loginTicket: 'fixture-ticket', accounts: []}, action: {type: 'select-account', accountId: 'fixture-account'}, request: native.selectAccount },
    { outcome: {status: 'binding_required', bindType: 'email', bindTicket: 'fixture-ticket'}, action: {type: 'request-binding-code', contact: 'user@example.invalid'}, request: native.requestBinding },
  ] as const)('blocks $action.type while session termination awaits cleanup', async fixture => {
    native.exchange.mockResolvedValueOnce(fixture.outcome);
    await act(async () => { await auth.beginAddAccount(); });
    await start();
    await emitLink(callbackUrl());
    let failCleanup!: (error: Error) => void;
    native.unregisterPush.mockImplementationOnce(() => new Promise((_, reject) => { failCleanup = reject; }));
    let closing!: Promise<unknown>;
    await act(async () => { closing = auth.terminateSession('ACCOUNT_UNAVAILABLE').catch(error => error); });
    expect(auth.isBusy).toBe(true);
    await act(async () => { expect(await auth.dispatchLoginAction(fixture.action)).toBe(false); });
    expect(fixture.request).not.toHaveBeenCalled();
    await act(async () => { failCleanup(new Error('fixture cleanup failure')); await closing; });
    expect(auth.isBusy).toBe(false);
  });

  it('initializes a login page mounted during termination only after full cleanup', async () => {
    await start();
    let finishCleanup!: () => void;
    native.unregisterPush.mockImplementationOnce(() => new Promise<void>(resolve => { finishCleanup = resolve; }));
    let closing!: Promise<void>;
    let initializing!: Promise<boolean>;
    await act(async () => { closing = auth.terminateSession(); });
    native.providers.mockClear();
    await act(async () => { initializing = auth.dispatchLoginAction({ type: 'initialize' }); });
    expect(native.providers).not.toHaveBeenCalled();
    expect(auth.isBusy).toBe(true);
    await act(async () => { finishCleanup(); await closing; expect(await initializing).toBe(true); });
    expect(auth.loginState?.step).toBe('identifier');
    expect(auth.isBusy).toBe(false);
    await start();
    await emitLink(callbackUrl());
    expect(auth.loginState?.step).toBe('sso-verification');
  });

  it.each(['logout', 'terminateSession'] as const)('fences OAuth before %s awaits cleanup', async action => {
    await start();
    const url = callbackUrl();
    let failCleanup!: (error: Error) => void;
    const boundary = action === 'logout' ? native.logoutCleanup : native.unregisterPush;
    boundary.mockImplementationOnce(() => new Promise((_, reject) => { failCleanup = reject; }));
    let closing!: Promise<unknown>;
    await act(async () => { closing = auth[action]().catch(error => error); });
    expect(boundary).toHaveBeenCalledTimes(1);
    await emitLink(url);
    expect(native.exchange).not.toHaveBeenCalled();
    const cleanupError = new Error('fixture cleanup failure');
    await act(async () => { failCleanup(cleanupError); expect(await closing).toBe(cleanupError); });
    await emitLink(url);
    expect(native.exchange).not.toHaveBeenCalled();
  });

  it('does not let a delayed add-account close erase a newer login', async () => {
    await act(async () => { await auth.beginAddAccount(); });
    await start();
    let finishDelete!: () => void;
    native.deleteSecure.mockImplementationOnce(() => {
      native.storage.delete(pendingKey);
      return new Promise<void>(resolve => { finishDelete = resolve; });
    });
    let closing!: Promise<void>;
    await act(async () => { closing = auth.cancelAddAccount(); });
    let reopening!: Promise<void>;
    await act(async () => { reopening = auth.beginAddAccount(); });
    await act(async () => { finishDelete(); await closing; await reopening; });
    await start();
    const pending = native.storage.get(pendingKey);
    const state = auth.loginState;
    expect(auth.loginState).toBe(state);
    expect(native.storage.get(pendingKey)).toBe(pending);
    await emitLink(callbackUrl());
    expect(auth.loginState?.step).toBe('sso-verification');
  });

  it('does not erase PKCE when Linking begins exchanging before Android dismiss resolves', async () => {
    let resolveExchange!: (value: typeof verifiedOutcome) => void;
    native.exchange.mockImplementation(() => new Promise((resolve) => { resolveExchange = resolve; }));
    native.open.mockImplementation(async () => {
      for (const listener of native.links) listener({ url: callbackUrl() });
      return { type: 'dismiss' };
    });
    await start();
    expect(native.exchange).toHaveBeenCalledTimes(1);
    expect(native.storage.has(pendingKey)).toBe(true);
    expect(auth.isBusy).toBe(true);
    await act(async () => { resolveExchange(verifiedOutcome); });
    expect(auth.loginState?.step).toBe('sso-verification');
    expect(auth.authError).toBeNull();
    expect(native.storage.has(pendingKey)).toBe(false);
  });

  it('lets the latest reset win without publishing an older reset result', async () => {
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    await act(async () => {
      first = auth.dispatchLoginAction({ type: 'reset' });
      second = auth.dispatchLoginAction({ type: 'reset' });
      expect(second).not.toBe(first);
      expect(await first).toBe(false);
      expect(await second).toBe(true);
    });
    expect(auth.loginState?.step).toBe('identifier');
    expect(auth.isBusy).toBe(false);
    expect(native.exchange).not.toHaveBeenCalled();
  });

  it('invalidates an iOS browser callback on explicit reset without changing successful return handling', async () => {
    native.platform = 'ios';
    let complete!: (value: typeof verifiedOutcome) => void;
    native.exchange.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    native.open.mockImplementation(async () => ({ type: 'success', url: callbackUrl() }));
    let cancelled!: Promise<unknown>;
    await act(async () => {
      cancelled = auth.dispatchLoginAction({ type: 'discover-sso-org', org: 'example.invalid' })
        .catch(error => error);
    });
    expect(native.exchange).toHaveBeenCalledTimes(1);
    await act(async () => { await auth.dispatchLoginAction({ type: 'reset' }); });
    await act(async () => { complete(verifiedOutcome); await cancelled; });
    expect(auth.loginState?.step).toBe('identifier');
    expect(auth.authError).toBeNull();
    expect(auth.isBusy).toBe(false);
    expect(native.storage.has(pendingKey)).toBe(false);
  });

  it('keeps callback busy when Android dismiss arrives after the exchange has started', async () => {
    let dismiss!: (value: { type: string }) => void;
    let complete!: (value: typeof verifiedOutcome) => void;
    native.open.mockImplementation(() => new Promise(resolve => { dismiss = resolve; }));
    native.exchange.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    let action!: Promise<boolean>;
    await act(async () => {
      action = auth.dispatchLoginAction({ type: 'discover-sso-org', org: 'example.invalid' });
    });
    await emitLink(callbackUrl());
    expect(native.exchange).toHaveBeenCalledTimes(1);
    expect(auth.isBusy).toBe(true);
    await act(async () => { dismiss({ type: 'dismiss' }); await action; });
    expect(auth.isBusy).toBe(true);
    expect(native.storage.has(pendingKey)).toBe(true);
    await act(async () => { complete(verifiedOutcome); });
    expect(auth.isBusy).toBe(false);
    expect(auth.loginState?.step).toBe('sso-verification');
  });

  it.each(['success', 'failure'] as const)('reset and retry ignore the old exchange %s while the new exchange is running', async result => {
    let completeOld!: (value: typeof verifiedOutcome) => void;
    let rejectOld!: (error: Error) => void;
    let completeNew!: (value: typeof verifiedOutcome) => void;
    native.exchange
      .mockImplementationOnce(() => new Promise((resolve, reject) => { completeOld = resolve; rejectOld = reject; }))
      .mockImplementationOnce(() => new Promise(resolve => { completeNew = resolve; }));
    await start();
    await emitLink(callbackUrl());
    expect(native.exchange).toHaveBeenCalledTimes(1);
    // Exercise the cancellation boundary directly, including an already queued
    // reset event; disabling the rendered button is not an invalidation fence.
    await act(async () => { await auth.dispatchLoginAction({ type: 'reset' }); });
    expect(auth.loginState?.step).toBe('identifier');
    await start();
    const pending = native.storage.get(pendingKey);
    await emitLink(callbackUrl());
    expect(native.exchange).toHaveBeenCalledTimes(2);
    expect(auth.isBusy).toBe(true);
    await act(async () => {
      if (result === 'success') completeOld(verifiedOutcome);
      else rejectOld(new Error('fixture exchange failure'));
    });
    expect(auth.loginState?.step).toBe('browser-redirect');
    expect(auth.authError).toBeNull();
    expect(auth.isBusy).toBe(true);
    expect(native.storage.get(pendingKey)).toBe(pending);
    await act(async () => { completeNew(verifiedOutcome); });
    expect(auth.loginState?.step).toBe('sso-verification');
    expect(auth.isBusy).toBe(false);
    expect(native.storage.has(pendingKey)).toBe(false);
  });

  it.each(['before-callback', 'during-exchange'] as const)(
    'preserves browser login when the login screen remounts %s', async timing => {
      await mountLoginScreen('initial');
      await start();
      const url = callbackUrl();
      const pending = native.storage.get(pendingKey);
      let complete!: (value: typeof verifiedOutcome) => void;
      native.exchange.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
      if (timing === 'during-exchange') await emitLink(url);
      await mountLoginScreen('remounted-after-deep-link');
      expect(auth.loginState?.step).toBe('browser-redirect');
      expect(native.storage.get(pendingKey)).toBe(pending);
      if (timing === 'before-callback') await emitLink(url);
      expect(native.exchange).toHaveBeenCalledExactlyOnceWith('fixture-code', 'fixture-verifier');
      await act(async () => { complete(verifiedOutcome); });
      expect(auth.loginState?.step).toBe('sso-verification');
      expect(auth.authError).toBeNull();
      expect(native.storage.has(pendingKey)).toBe(false);
    },
  );

  it('still cancels and retries explicitly after the login screen has remounted', async () => {
    await mountLoginScreen('initial');
    await start();
    const oldUrl = callbackUrl();
    await mountLoginScreen('remounted-after-deep-link');
    await act(async () => { await auth.dispatchLoginAction({ type: 'reset' }); });
    expect(auth.loginState?.step).toBe('identifier');
    expect(native.storage.has(pendingKey)).toBe(false);
    await start();
    await emitLink(oldUrl);
    expect(native.exchange).not.toHaveBeenCalled();
    await emitLink(callbackUrl());
    expect(native.exchange).toHaveBeenCalledTimes(1);
    expect(auth.loginState?.step).toBe('sso-verification');
    expect(auth.authError).toBeNull();
  });

  describe.each(['android', 'ios'])('completed browser exchange on %s', platform => {
    it.each([
      { outcome: { status: 'select_account', loginTicket: 'fixture-login-ticket', accounts: [] }, step: 'account-selection',
        action: { type: 'select-account', accountId: 'fixture-account' }, request: native.selectAccount,
        args: ['fixture-login-ticket', 'fixture-account'] },
      { outcome: { status: 'binding_required', bindType: 'email', bindTicket: 'fixture-bind-ticket' }, step: 'binding',
        action: { type: 'request-binding-code', contact: 'user@example.invalid' }, request: native.requestBinding,
        args: ['fixture-bind-ticket', 'email', 'user@example.invalid'] },
      { outcome: verifiedOutcome, step: 'sso-verification',
        action: { type: 'request-sso-verification-code' }, request: native.requestVerification,
        args: ['fixture-ticket'] },
    ] as const)('preserves $step and its ticket when navigation remounts the screen', async fixture => {
      native.platform = platform;
      native.exchange.mockResolvedValue(fixture.outcome);
      native.open.mockImplementation(async () => ({ type: 'success', url: callbackUrl() }));
      await mountLoginScreen('initial');
      await start();
      expect(auth.loginState?.step).toBe(fixture.step);
      expect(native.storage.has(pendingKey)).toBe(false);
      await mountLoginScreen('remounted-after-exchange');
      expect(auth.loginState?.step).toBe(fixture.step);
      await act(async () => { expect(await auth.dispatchLoginAction(fixture.action)).toBe(true); });
      expect(fixture.request).toHaveBeenCalledExactlyOnceWith(...fixture.args);
      expect(auth.authError).toBeNull();
      // An explicit cancellation must still clear the retained continuation ticket.
      await act(async () => { await auth.dispatchLoginAction({ type: 'reset' }); });
      fixture.request.mockClear();
      await act(async () => { expect(await auth.dispatchLoginAction(fixture.action)).toBe(false); });
      expect(fixture.request).not.toHaveBeenCalled();
    });
  });

  it.each(['android', 'ios'])('retains the personal OAuth organization confirmation on %s', async platform => {
    native.platform = platform;
    native.exchange.mockResolvedValueOnce({
      status: 'ok', accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresIn: 3600,
      membership: { id: 'fixture-personal', kind: 'personal', role: 'owner', displayName: 'Fixture',
        email: 'user@example.invalid', orgId: null, orgName: null },
    });
    native.open.mockImplementation(async () => ({ type: 'success', url: callbackUrl() }));
    await mountLoginScreen('initial');
    await start('social');
    expect(auth.loginState).toMatchObject({ step: 'realm-confirmation', personalLoginAvailable: true });
    await mountLoginScreen('remounted-after-personal-exchange');
    expect(auth.loginState).toMatchObject({ step: 'realm-confirmation', personalLoginAvailable: true });
    await act(async () => { expect(await auth.dispatchLoginAction({ type: 'confirm-sso-realm' })).toBe(true); });
    expect(native.open).toHaveBeenCalledTimes(2);
    expect(auth.loginState?.step).toBe('sso-verification');
  });

  it('restores the browser wait after a cold launch without an initial URL', async () => {
    await act(async () => { await auth.cancelAddAccount(); });
    const pending = JSON.stringify({ state: 'fixture-cold-state', codeVerifier: 'fixture-verifier',
      deviceId: 'fixture-device', realm: 'cn', label: 'Fixture SSO', createdAt: Date.now() });
    native.storage.set(pendingKey, pending);
    await act(async () => root.unmount());
    root = createRoot(document.createElement('div'));
    native.providers.mockClear();
    await mountLoginScreen('initial');
    expect(auth.loginState).toEqual({ step: 'browser-redirect', label: 'Fixture SSO' });
    expect(auth.isBusy).toBe(false);
    expect(native.storage.get(pendingKey)).toBe(pending);
    await mountLoginScreen('remounted');
    expect(native.providers).not.toHaveBeenCalled();
    await emitLink(callbackUrl());
    expect(auth.loginState?.step).toBe('sso-verification');
  });

  it.each(['email', 'phone'] as const)('cancels a restored OAuth attempt before starting %s login', async kind => {
    await start();
    const url = callbackUrl();
    await act(async () => root.unmount());
    root = createRoot(document.createElement('div'));
    await mountLoginScreen('cold-start');
    expect(auth.loginState?.step).toBe('browser-redirect');
    let complete!: (value: typeof verifiedOutcome) => void;
    native.exchange.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    await emitLink(url);
    expect(native.exchange).toHaveBeenCalledTimes(1);
    await act(async () => { await auth.dispatchLoginAction({ type: 'reset' }); });
    expect(native.storage.has(pendingKey)).toBe(false);
    await act(async () => { await auth.dispatchLoginAction({
      type: 'request-code', kind, identifier: kind === 'email' ? 'user@example.invalid' : '+15555550123',
    }); });
    const current = auth.loginState;
    expect(current?.step).toBe('verification-code');
    await act(async () => { complete(verifiedOutcome); });
    expect(auth.loginState).toBe(current);
    expect(auth.authError).toBeNull();
    expect(auth.isAuthenticated).toBe(false);
  });

  it('does not restore a canceled browser wait on remount when deletion failed', async () => {
    await start();
    const url = callbackUrl();
    native.deleteSecure.mockRejectedValueOnce(new Error('fixture storage failure'));
    await act(async () => { await auth.cancelAddAccount(); });
    await mountLoginScreen('remount-after-cancel');
    expect(auth.loginState?.step).toBe('identifier');
    await emitLink(url);
    expect(native.exchange).not.toHaveBeenCalled();
    expect(auth.loginState?.step).toBe('identifier');
  });

  it.each(['expired', 'malformed', 'null', 'absent'])('starts the normal identifier flow for %s persisted OAuth', async kind => {
    await act(async () => { await auth.cancelAddAccount(); });
    if (kind !== 'absent') native.storage.set(pendingKey, kind === 'malformed' ? '{invalid' : kind === 'null' ? 'null' : JSON.stringify({
      state: 'fixture-state', codeVerifier: 'fixture-verifier', deviceId: 'fixture-device',
      realm: 'cn', label: 'Fixture SSO', createdAt: Date.now() - 10 * 60_000 - 1,
    }));
    await mountLoginScreen('initial');
    expect(auth.loginState?.step).toBe('identifier');
    expect(auth.isBusy).toBe(false);
    expect(auth.authError).toBeNull();
    expect(native.exchange).not.toHaveBeenCalled();
  });

  it.each(['callback', 'cancel'] as const)('does not restore a stale browser wait after %s takes ownership during storage read', async owner => {
    await restartProvider();
    const pending = JSON.stringify({ state: 'fixture-cold-state', codeVerifier: 'fixture-verifier',
      deviceId: 'fixture-device', realm: 'cn', label: 'Fixture SSO', createdAt: Date.now() });
    native.storage.set(pendingKey, pending);
    let finishRead!: (value: string) => void;
    native.readSecure.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    await mountLoginScreen('initial');
    if (owner === 'callback') await emitLink(callbackUrl());
    else await act(async () => { await auth.dispatchLoginAction({ type: 'reset' }); });
    const state = auth.loginState;
    expect(state?.step).toBe(owner === 'callback' ? 'sso-verification' : 'identifier');
    await act(async () => { finishRead(pending); });
    expect(auth.loginState).toBe(state);
    expect(auth.isBusy).toBe(false);
    expect(native.storage.has(pendingKey)).toBe(false);
  });

  it.each(['pending', 'finished', 'failed-provider'] as const)(
    'does not let slow initialization overwrite a cold callback (%s)', async timing => {
      await restartProvider();
      let finishProviders!: (value: unknown) => void;
      let failProviders!: (error: Error) => void;
      native.providers.mockImplementationOnce(() => new Promise((resolve, reject) => {
        finishProviders = resolve; failProviders = reject;
      }));
      let complete!: (value: typeof verifiedOutcome) => void;
      native.exchange.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
      await mountLoginScreen('initial');
      native.storage.set(pendingKey, JSON.stringify({ state: 'fixture-cold-state', codeVerifier: 'fixture-verifier',
        deviceId: 'fixture-device', realm: 'cn', label: 'Fixture SSO', createdAt: Date.now() }));
      await emitLink(callbackUrl());
      expect(native.exchange).toHaveBeenCalledTimes(1);
      if (timing !== 'pending') await act(async () => { complete(verifiedOutcome); });
      await act(async () => {
        if (timing === 'failed-provider') failProviders(new Error('fixture network failure'));
        else finishProviders({ social: ['wechat'], emailCode: true, smsCode: false });
      });
      if (timing === 'pending') {
        expect(auth.isBusy).toBe(true);
        expect(auth.loginState).toBeNull();
        await act(async () => { complete(verifiedOutcome); });
      }
      expect(auth.loginState?.step).toBe('sso-verification');
      expect(auth.authError).toBeNull();
      expect(auth.isBusy).toBe(false);
    },
  );

  it('keeps a cold getInitialURL callback alive when the login screen mounts during exchange', async () => {
    await act(async () => root.unmount());
    native.storage.set(pendingKey, JSON.stringify({ state: 'fixture-cold-state', codeVerifier: 'fixture-verifier',
      deviceId: 'fixture-device', realm: 'cn', label: 'Fixture SSO', createdAt: Date.now() }));
    native.initialUrl.mockResolvedValue(callbackUrl());
    let complete!: (value: typeof verifiedOutcome) => void;
    native.exchange.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    root = createRoot(document.createElement('div'));
    await mountLoginScreen('cold-start');
    expect(native.exchange).toHaveBeenCalledTimes(1);
    expect(native.storage.has(pendingKey)).toBe(true);
    await act(async () => { complete(verifiedOutcome); });
    expect(auth.loginState?.step).toBe('sso-verification');
    expect(auth.authError).toBeNull();
  });

  it('preserves personal verification-code state and explicitly resets it', async () => {
    await act(async () => { expect(await auth.dispatchLoginAction({
      type: 'request-code', kind: 'email', identifier: 'user@example.invalid',
    })).toBe(true); });
    const before = auth.loginState;
    expect(before?.step).toBe('verification-code');
    await mountLoginScreen('remounted-code-entry');
    expect(auth.loginState).toBe(before);
    await act(async () => { await auth.dispatchLoginAction({ type: 'reset' }); });
    expect(auth.loginState?.step).toBe('identifier');
  });

  it('keeps add-account initialization and cancellation as explicit lifecycle boundaries', async () => {
    await start();
    const oldUrl = callbackUrl();
    await act(async () => { await auth.beginAddAccount(); });
    expect(auth.loginState?.step).toBe('identifier');
    expect(native.storage.has(pendingKey)).toBe(false);
    await start();
    await mountLoginScreen('add-account-remount');
    await emitLink(oldUrl);
    expect(native.exchange).not.toHaveBeenCalled();
    await emitLink(callbackUrl());
    expect(auth.loginState?.step).toBe('sso-verification');
    await act(async () => { await auth.cancelAddAccount(); });
    expect(auth.loginState).toBeNull();
    await act(async () => { expect(await auth.dispatchLoginAction({ type: 'request-sso-verification-code' })).toBe(false); });
    expect(native.requestVerification).not.toHaveBeenCalled();
  });

  it.each([
    ['delayed', 'late-link'], ['failed', 'late-link'],
    ['delayed', 'in-flight'], ['failed', 'in-flight'],
  ] as const)('fences add-account close with %s deletion and %s callback', async (deletion, timing) => {
    await act(async () => { await auth.beginAddAccount(); });
    await start();
    const url = callbackUrl();
    const user = auth.user;
    let complete!: (value: typeof verifiedOutcome) => void;
    if (timing === 'in-flight') {
      native.exchange.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
      await emitLink(url);
    }
    let finishDelete!: () => void;
    if (deletion === 'failed') native.deleteSecure.mockRejectedValueOnce(new Error('fixture storage unavailable'));
    else native.deleteSecure.mockImplementationOnce(() => new Promise<void>(resolve => {
      finishDelete = () => { native.storage.delete(pendingKey); resolve(); };
    }));
    let closing!: Promise<void>;
    await act(async () => { closing = auth.cancelAddAccount(); });
    await emitLink(url);
    expect(native.exchange).toHaveBeenCalledTimes(timing === 'in-flight' ? 1 : 0);
    if (timing === 'in-flight') await act(async () => { complete(verifiedOutcome); });
    await act(async () => {
      if (deletion === 'delayed') finishDelete();
      await closing;
    });
    await emitLink(url);
    expect(native.exchange).toHaveBeenCalledTimes(timing === 'in-flight' ? 1 : 0);
    expect(auth.loginState).toBeNull();
    expect(auth.user).toBe(user);
    expect(auth.authError).toBeNull();
    expect(auth.isBusy).toBe(false);
    // Failed deletion may leave storage behind, but it must not reopen the attempt.
    expect(native.storage.has(pendingKey)).toBe(deletion === 'failed');
    await act(async () => { await auth.beginAddAccount(); });
    await start();
    await emitLink(callbackUrl());
    expect(native.exchange).toHaveBeenCalledTimes(timing === 'in-flight' ? 2 : 1);
    expect(auth.loginState?.step).toBe('sso-verification');
  });

  it.each(['method-choice', 'realm-confirmation'] as const)('preserves %s before starting browser authorization', async step => {
    native.crossRealm = true;
    native.discoverOrganization.mockResolvedValue({
      region: step === 'realm-confirmation' ? 'global' : 'cn', orgName: 'Fixture Organization',
      connections: [
        { connectionId: 'fixture-one', connectionName: 'Fixture One', protocol: 'wecom' },
        { connectionId: 'fixture-two', connectionName: 'Fixture Two', protocol: 'oidc' },
      ],
    });
    await start();
    const state = auth.loginState;
    expect(state?.step).toBe(step);
    await mountLoginScreen('remounted-discovery');
    expect(auth.loginState).toBe(state);
    expect(native.open).not.toHaveBeenCalled();
    if (step === 'realm-confirmation') {
      await act(async () => { expect(await auth.dispatchLoginAction({ type: 'cancel-sso-realm' })).toBe(true); });
    } else {
      await act(async () => { await auth.dispatchLoginAction({ type: 'reset' }); });
    }
    expect(auth.loginState?.step).toBe('identifier');
  });

  it('reports initial provider failures without deleting pending OAuth and allows retry', async () => {
    await act(async () => { await auth.cancelAddAccount(); });
    native.storage.set(pendingKey, 'fixture-pending-record');
    native.providers.mockRejectedValueOnce(new Error('fixture provider unavailable'));
    await mountLoginScreen('failed-initialization');
    expect(auth.loginState).toBeNull();
    expect(auth.authError).not.toBeNull();
    expect(auth.isBusy).toBe(false);
    expect(native.storage.get(pendingKey)).toBe('fixture-pending-record');
    await mountLoginScreen('retried-initialization');
    expect(auth.loginState?.step).toBe('identifier');
    expect(auth.authError).toBeNull();
  });

  it.each([
    { name: 'select-account', outcome: { status: 'select_account', loginTicket: 'fixture-select', accounts: [] },
      action: { type: 'select-account', accountId: 'fixture-account' }, request: native.selectAccount },
    { name: 'binding', outcome: { status: 'binding_required', bindType: 'email', bindTicket: 'fixture-bind' },
      action: { type: 'request-binding-code', contact: 'user@example.invalid' }, request: native.requestBinding },
    { name: 'verification', outcome: verifiedOutcome,
      action: { type: 'request-sso-verification-code' }, request: native.requestVerification },
    { name: 'back', outcome: verifiedOutcome, action: { type: 'reset' }, request: native.providers },
  ] as const)('executes $name immediately while initialization is still awaiting providers', async fixture => {
    await restartProvider();
    let finishProviders!: (value: unknown) => void;
    native.providers.mockImplementationOnce(() => new Promise(resolve => { finishProviders = resolve; }));
    native.exchange.mockResolvedValueOnce(fixture.outcome);
    await mountLoginScreen('initial');
    native.storage.set(pendingKey, JSON.stringify({ state: 'fixture-cold-state', codeVerifier: 'fixture-verifier',
      deviceId: 'fixture-device', realm: 'cn', label: 'Fixture SSO', createdAt: Date.now() }));
    await emitLink(callbackUrl());
    expect(auth.isBusy).toBe(false);
    fixture.request.mockClear();
    let actionFinished = false;
    await act(async () => {
      void auth.dispatchLoginAction(fixture.action).then(result => { actionFinished = result; });
    });
    expect(fixture.request).toHaveBeenCalledTimes(1);
    expect(actionFinished).toBe(true);
    const state = auth.loginState;
    await act(async () => { finishProviders({ social: ['wechat'], emailCode: true, smsCode: false }); });
    expect(auth.loginState).toBe(state);
    expect(auth.authError).toBeNull();
  });

  it.each(['success', 'failure'] as const)('ignores late initialization %s while the next user request is running', async result => {
    await restartProvider();
    let finish!: (value: unknown) => void;
    let fail!: (error: Error) => void;
    native.providers.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    await mountLoginScreen('initial');
    native.storage.set(pendingKey, JSON.stringify({ state: 'fixture-cold-state', codeVerifier: 'fixture-verifier',
      deviceId: 'fixture-device', realm: 'cn', label: 'Fixture SSO', createdAt: Date.now() }));
    await emitLink(callbackUrl());
    let finishCode!: () => void;
    native.requestVerification.mockImplementationOnce(() => new Promise<void>(resolve => { finishCode = resolve; }));
    let codeRequest!: Promise<boolean>;
    await act(async () => { codeRequest = auth.dispatchLoginAction({ type: 'request-sso-verification-code' }); });
    expect(native.requestVerification).toHaveBeenCalledTimes(1);
    expect(auth.isBusy).toBe(true);
    const state = auth.loginState;
    await act(async () => {
      if (result === 'success') finish({ social: ['wechat'], emailCode: true, smsCode: false });
      else fail(new Error('fixture obsolete initialization failure'));
    });
    expect(auth.loginState).toBe(state);
    expect(auth.isBusy).toBe(true);
    expect(auth.authError).toBeNull();
    await act(async () => { finishCode(); expect(await codeRequest).toBe(true); });
    expect(auth.loginState).toMatchObject({ step: 'sso-verification', codeRequested: true });
    expect(auth.isBusy).toBe(false);
  });

  it('deduplicates initialization independently and abandons it on explicit reset', async () => {
    await act(async () => { await auth.cancelAddAccount(); });
    let finish!: (value: unknown) => void;
    native.providers.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    let first!: Promise<boolean>;
    await act(async () => {
      first = auth.dispatchLoginAction({ type: 'initialize' });
      expect(auth.dispatchLoginAction({ type: 'initialize' })).toBe(first);
    });
    await act(async () => { expect(await auth.dispatchLoginAction({ type: 'reset' })).toBe(true); });
    expect(auth.loginState?.step).toBe('identifier');
    const state = auth.loginState;
    await act(async () => { finish({ social: [], emailCode: false, smsCode: true }); expect(await first).toBe(false); });
    expect(auth.loginState).toBe(state);
    expect(auth.isBusy).toBe(false);
  });

  it('does not reuse or clear a new initialization after add-account cancellation changes the epoch', async () => {
    await act(async () => { await auth.cancelAddAccount(); });
    let finishOld!: (value: unknown) => void;
    let finishNew!: (value: unknown) => void;
    native.providers
      .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }));
    let old!: Promise<boolean>;
    let current!: Promise<boolean>;
    await act(async () => { old = auth.dispatchLoginAction({ type: 'initialize' }); });
    await act(async () => { await auth.cancelAddAccount(); });
    await act(async () => { current = auth.dispatchLoginAction({ type: 'initialize' }); });
    expect(current).not.toBe(old);
    await act(async () => { finishOld({ social: [], emailCode: true, smsCode: false }); expect(await old).toBe(false); });
    expect(auth.loginState).toBeNull();
    expect(auth.isBusy).toBe(true);
    await act(async () => { finishNew({ social: ['wechat'], emailCode: true, smsCode: false }); expect(await current).toBe(true); });
    expect(auth.loginState?.step).toBe('identifier');
    expect(auth.isBusy).toBe(false);
  });

  it('still exchanges only once when Linking and the browser both report success', async () => {
    native.open.mockImplementation(async () => {
      const url = callbackUrl();
      for (const listener of native.links) listener({ url });
      return { type: 'success', url };
    });
    await start();
    expect(native.exchange).toHaveBeenCalledExactlyOnceWith('fixture-code', 'fixture-verifier');
    expect(auth.loginState?.step).toBe('sso-verification');
    expect(auth.authError).toBeNull();
  });
});
