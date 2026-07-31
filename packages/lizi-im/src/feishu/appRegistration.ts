import { makeScopedLogger } from './moduleScope.js';

export type LarkBrand = 'feishu' | 'lark';

export interface AppRegistrationBeginResult {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

export interface AppRegistrationSuccessResult {
  clientId: string;
  clientSecret: string;
  ownerOpenId: string | null;
  tenantBrand: LarkBrand | null;
}

interface AppRegistrationBrandDiscovery {
  /** Brand reported before credentials are complete (including pending responses). */
  tenantBrand?: LarkBrand;
}

export type AppRegistrationPollResult =
  | ({ status: 'pending' } & AppRegistrationBrandDiscovery)
  | ({ status: 'slow_down'; interval: number } & AppRegistrationBrandDiscovery)
  | { status: 'success'; result: AppRegistrationSuccessResult }
  | ({ status: 'expired'; message: string } & AppRegistrationBrandDiscovery)
  | ({ status: 'denied'; message: string } & AppRegistrationBrandDiscovery)
  | ({ status: 'error'; message: string } & AppRegistrationBrandDiscovery);

type HttpPostForm = (
  url: string,
  form: URLSearchParams,
) => Promise<{ status: number; body: unknown }>;

const log = makeScopedLogger('appRegistration');

// 飞书 / Lark 的协议固定域名 —— 包内端点单点定义(2026-07 端点收敛),按 brand 二选一。
export const FEISHU_ACCOUNTS_BASE_URL = 'https://accounts.feishu.cn';
export const LARK_ACCOUNTS_BASE_URL = 'https://accounts.larksuite.com';
export const FEISHU_OPEN_BASE_URL = 'https://open.feishu.cn';
export const LARK_OPEN_BASE_URL = 'https://open.larksuite.com';

function accountsBase(brand: LarkBrand): string {
  return brand === 'lark' ? LARK_ACCOUNTS_BASE_URL : FEISHU_ACCOUNTS_BASE_URL;
}

function openBase(brand: LarkBrand): string {
  return brand === 'lark' ? LARK_OPEN_BASE_URL : FEISHU_OPEN_BASE_URL;
}

function registrationEndpoint(brand: LarkBrand): string {
  return `${accountsBase(brand)}/oauth/v1/app/registration`;
}

export function buildVerificationUrl(
  brand: LarkBrand,
  userCode: string,
  appVersion?: string,
): string {
  const url = new URL('/page/cli', openBase(brand));
  url.searchParams.set('user_code', userCode);
  if (appVersion) {
    url.searchParams.set('lpv', appVersion);
    url.searchParams.set('ocv', appVersion);
  }
  url.searchParams.set('from', 'xdt-maker');
  return url.toString();
}

export async function requestAppRegistration(
  httpPostForm: HttpPostForm,
  brand: LarkBrand = 'feishu',
): Promise<AppRegistrationBeginResult> {
  const form = new URLSearchParams();
  form.set('action', 'begin');
  form.set('archetype', 'PersonalAgent');
  form.set('auth_method', 'client_secret');
  form.set('request_user_info', 'open_id tenant_brand');
  // 注: 飞书 OAuth device-code app/registration 没有公开的事件订阅参数。
  // PersonalAgent archetype 默认只订 im.message.receive_v1, card.action.trigger
  // 等其它事件需要用户登录飞书开放平台 console 手动添加 (UI 内部 API
  // /developers/v1/callback/update 走 user session cookie + csrf, 程序无法调用)。
  // 对照实现: lark-cli 同样不在此处订阅, 在 consume preflight 时报错让用户去 console
  // (https://github.com/larksuite/cli/blob/main/internal/auth/app_registration.go).

  // Device-code registration always bootstraps on Feishu. `brand` only picks
  // the user-facing verification host; polling discovers the issuing tenant
  // and switches to Lark when required.
  const res = await httpPostForm(registrationEndpoint('feishu'), form);
  const data = asRecord(res.body);
  const apiError = getString(data, 'error');
  if (res.status >= 400 || apiError) {
    throw new Error(
      getString(data, 'error_description') || apiError || 'app registration begin failed',
    );
  }

  const deviceCode = getString(data, 'device_code');
  const userCode = getString(data, 'user_code');
  if (!deviceCode || !userCode) {
    throw new Error('app registration begin succeeded but missing device_code or user_code');
  }

  const verificationUrl = buildVerificationUrl(brand, userCode);

  return {
    deviceCode,
    userCode,
    verificationUrl,
    expiresIn: getNumber(data, 'expires_in', 300),
    interval: getNumber(data, 'interval', 5),
  };
}

export async function pollAppRegistration(
  httpPostForm: HttpPostForm,
  brand: LarkBrand,
  deviceCode: string,
  interval: number,
): Promise<AppRegistrationPollResult> {
  const form = new URLSearchParams();
  form.set('action', 'poll');
  form.set('device_code', deviceCode);

  const res = await httpPostForm(registrationEndpoint(brand), form);
  const data = asRecord(res.body);
  const err = getString(data, 'error');
  const userInfo = asRecord(data.user_info);
  const tenantBrand = normalizeBrand(getString(userInfo, 'tenant_brand'));
  const brandDiscovery = tenantBrand ? { tenantBrand } : {};

  if (!err && getString(data, 'client_id')) {
    return {
      status: 'success',
      result: {
        clientId: getString(data, 'client_id'),
        clientSecret: getString(data, 'client_secret'),
        ownerOpenId: getString(userInfo, 'open_id') || null,
        tenantBrand,
      },
    };
  }

  if (!err && res.status < 400) {
    return { status: 'pending', ...brandDiscovery };
  }

  switch (err) {
    case 'authorization_pending':
      return { status: 'pending', ...brandDiscovery };
    case 'slow_down':
      return { status: 'slow_down', interval: Math.min(interval + 5, 60), ...brandDiscovery };
    case 'access_denied':
      return {
        status: 'denied',
        message: getString(data, 'error_description') || 'Authorization denied by user',
        ...brandDiscovery,
      };
    case 'expired_token':
    case 'invalid_grant':
      return {
        status: 'expired',
        message: getString(data, 'error_description') || 'Device code expired, please try again',
        ...brandDiscovery,
      };
  }

  const msg = getString(data, 'error_description') || err || `HTTP ${res.status}`;
  log.warn(`[feishu/appRegistration] poll failed brand=${brand}: ${msg}`);
  return { status: 'error', message: msg, ...brandDiscovery };
}

function normalizeBrand(value: string): LarkBrand | null {
  if (value === 'feishu' || value === 'lark') return value;
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function getString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === 'string' ? value : '';
}

function getNumber(obj: Record<string, unknown>, key: string, fallback: number): number {
  const value = obj[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
