import * as Crypto from 'expo-crypto';
import { AppState, Platform } from 'react-native';
import type { SocialProvider } from '@cindy/auth-client';

import {
  GOOGLE_IOS_CLIENT_ID,
  GOOGLE_IOS_URL_SCHEME,
  GOOGLE_WEB_CLIENT_ID,
  WECHAT_APP_ID,
  WECHAT_UNIVERSAL_LINK,
} from '@/config/env';
import { createState } from '@/auth/pkce';

const NATIVE_WECHAT_LOGIN_FOREGROUND_TIMEOUT_MS = 8 * 1000;

export type NativeSocialCredential =
  | { idToken: string }
  | {
      identityToken: string;
      authorizationCode?: string;
      rawNonce: string;
      user?: { name?: string };
      // Apple 首次授权返回的明文 email(后续登录为 null,服务端应从 identityToken
      // JWT payload 自行解 email)。补传以消除客户端侧丢 email 的缺陷,对齐 App Store
      // Guideline 4.2(不得在 Apple 登录后再向用户索要 email)。
      email?: string | null;
    }
  | { code: string };

/**
 * Mirrors the acquire* preconditions below so the login page never renders a
 * provider whose credential acquisition would deterministically fail
 * (unsupported platform, or build-time client IDs not injected).
 */
export function isNativeSocialProviderSupported(
  provider: SocialProvider,
): boolean {
  if (provider === 'apple') return Platform.OS === 'ios';
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return false;
  if (provider === 'google') {
    if (!GOOGLE_WEB_CLIENT_ID) return false;
    return (
      Platform.OS !== 'ios' ||
      (!!GOOGLE_IOS_CLIENT_ID && !!GOOGLE_IOS_URL_SCHEME)
    );
  }
  return !!WECHAT_APP_ID && !!WECHAT_UNIVERSAL_LINK;
}

/** Acquires a short-lived native SDK credential. Token exchange always happens in auth-server. */
export async function acquireNativeSocialCredential(
  provider: SocialProvider,
): Promise<NativeSocialCredential> {
  if (provider === 'apple') return acquireAppleCredential();
  if (provider === 'google') return acquireGoogleCredential();
  return acquireWechatCredential();
}

async function acquireAppleCredential(): Promise<NativeSocialCredential> {
  if (Platform.OS !== 'ios')
    throw authAdapterError('SOCIAL_PROVIDER_UNAVAILABLE');
  const AppleAuthentication = await import('expo-apple-authentication');
  if (!(await AppleAuthentication.isAvailableAsync())) {
    throw authAdapterError('SOCIAL_PROVIDER_UNAVAILABLE');
  }

  const rawNonce = createState();
  const hashedNonce = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    rawNonce,
  );
  const credential = await AppleAuthentication.signInAsync({
    nonce: hashedNonce,
    requestedScopes: [
      AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
      AppleAuthentication.AppleAuthenticationScope.EMAIL,
    ],
  });
  if (!credential.identityToken) {
    throw authAdapterError('AUTH_REQUEST_FAILED');
  }
  const name = credential.fullName
    ? AppleAuthentication.formatFullName(credential.fullName).trim()
    : '';
  return {
    identityToken: credential.identityToken,
    ...(credential.authorizationCode
      ? { authorizationCode: credential.authorizationCode }
      : {}),
    rawNonce,
    ...(name ? { user: { name } } : {}),
    // EMAIL scope 请求到的明文 email(仅首次授权有值,后续为 null);服务端据此
    // 或 identityToken JWT 解析建立账号 email,避免登录后再向用户索要(Apple 审核硬要求)。
    ...(credential.email ? { email: credential.email } : {}),
  };
}

async function acquireGoogleCredential(): Promise<NativeSocialCredential> {
  const iosConfigMissing =
    Platform.OS === 'ios' && (!GOOGLE_IOS_CLIENT_ID || !GOOGLE_IOS_URL_SCHEME);
  if (
    (Platform.OS !== 'ios' && Platform.OS !== 'android') ||
    !GOOGLE_WEB_CLIENT_ID ||
    iosConfigMissing
  ) {
    throw authAdapterError('SOCIAL_PROVIDER_NOT_CONFIGURED');
  }
  const { GoogleSignin } =
    await import('@react-native-google-signin/google-signin');
  GoogleSignin.configure({
    webClientId: GOOGLE_WEB_CLIENT_ID,
    ...(GOOGLE_IOS_CLIENT_ID ? { iosClientId: GOOGLE_IOS_CLIENT_ID } : {}),
    offlineAccess: false,
  });
  if (Platform.OS === 'android') {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  }
  const result = await GoogleSignin.signIn();
  if (result.type !== 'success') throw authAdapterError('USER_CANCELLED');
  if (!result.data.idToken) throw authAdapterError('AUTH_REQUEST_FAILED');
  return { idToken: result.data.idToken };
}

async function acquireWechatCredential(): Promise<NativeSocialCredential> {
  if (
    (Platform.OS !== 'ios' && Platform.OS !== 'android') ||
    !WECHAT_APP_ID ||
    !WECHAT_UNIVERSAL_LINK
  ) {
    throw authAdapterError('SOCIAL_PROVIDER_NOT_CONFIGURED');
  }
  const { cancelWechatAuthRequest, isWechatInstalled, requestWechatAuthCode } =
    await import('xdt-wechat-login');
  if (!(await isWechatInstalled()))
    throw authAdapterError('SOCIAL_PROVIDER_UNAVAILABLE');
  const timeout = createNativeWechatLoginTimeout();
  let result: { code: string };
  try {
    result = await Promise.race([
      requestWechatAuthCode({
        appId: WECHAT_APP_ID,
        universalLink: WECHAT_UNIVERSAL_LINK,
        scope: 'snsapi_userinfo',
        state: createState(),
      }),
      timeout.promise,
    ]);
  } catch (error) {
    if (readErrorCode(error) === 'REQUEST_TIMEOUT') {
      await cancelWechatAuthRequest().catch(() => undefined);
    }
    throw error;
  } finally {
    timeout.cleanup();
  }
  return { code: result.code };
}

function readErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

/**
 * Bounds an SDK request by foreground time only. Opening WeChat backgrounds Cindy,
 * so wall-clock timeouts would expire while the user is legitimately authorizing.
 */
function createNativeWechatLoginTimeout(): {
  promise: Promise<never>;
  cleanup: () => void;
} {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let activeStartedAt: number | null =
    AppState.currentState === 'active' ? Date.now() : null;
  let foregroundElapsedMs = 0;
  let cleanup = () => undefined;
  const promise = new Promise<never>((_, reject) => {
    const clearTimer = () => {
      if (timeoutId !== null) clearTimeout(timeoutId);
      timeoutId = null;
    };
    const rejectTimeout = () => {
      cleanup();
      reject(authAdapterError('REQUEST_TIMEOUT'));
    };
    const armTimer = () => {
      clearTimer();
      if (activeStartedAt === null) return;
      const remaining =
        NATIVE_WECHAT_LOGIN_FOREGROUND_TIMEOUT_MS - foregroundElapsedMs;
      if (remaining <= 0) {
        rejectTimeout();
        return;
      }
      timeoutId = setTimeout(rejectTimeout, remaining);
    };
    const pauseTimer = () => {
      if (activeStartedAt !== null) {
        foregroundElapsedMs += Date.now() - activeStartedAt;
        activeStartedAt = null;
      }
      clearTimer();
    };
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        if (activeStartedAt === null) activeStartedAt = Date.now();
        armTimer();
      } else {
        pauseTimer();
      }
    });
    cleanup = () => {
      clearTimer();
      subscription.remove();
    };
    armTimer();
  });
  return { promise, cleanup };
}

function authAdapterError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
