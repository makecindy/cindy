import Constants from 'expo-constants';
import { Platform } from 'react-native';
import {
  clearTapdbUser as clearNativeTapdbUser,
  initializeTapdb,
  setTapdbUserId,
  type TapdbRegion,
} from 'xdt-tapdb';

import { hydrateAnalyticsConsent, isAnalyticsAllowed } from './analyticsConsentStore';

export type MobileTapdbInitStatus =
  | { ok: true }
  | {
      ok: false;
      reason: 'not_consented' | 'missing_config' | 'native_unavailable' | 'native_error';
    };

let initPromise: Promise<MobileTapdbInitStatus> | null = null;

/** 自建线通过 Expo extra 烘焙的 TapDB 公开配置。 */
interface SelfHostTapdbConfig {
  clientId?: string;
  clientToken?: string;
  region?: string;
  channel?: string;
}

function selfHostTapdbConfig(): SelfHostTapdbConfig {
  const cindy = Constants.expoConfig?.extra?.cindy as
    | { tapdb?: SelfHostTapdbConfig }
    | undefined;
  return cindy?.tapdb ?? {};
}

/**
 * 初始化 TapDB —— **只有用户明示同意《隐私政策》且统计开关开启时**才会真正初始化
 * 原生 SDK。
 *
 * 原生 SDK 一旦 init 就无法反初始化(TapTap Core 没有 opt-out API),所以同意闸必须
 * 挡在 init 之前,而不是靠事后停止上报。未放行时返回 `not_consented` 且**不缓存**
 * 这个结果——用户在登录页同意后会再调一次,那一次才真正 init。
 */
export function initMobileTapdb(): Promise<MobileTapdbInitStatus> {
  if (initPromise) return initPromise;

  return hydrateAnalyticsConsent().then(() => {
    if (initPromise) return initPromise;
    if (!isAnalyticsAllowed()) {
      return { ok: false as const, reason: 'not_consented' as const };
    }
    return startInit();
  });
}

function startInit(): Promise<MobileTapdbInitStatus> {
  const selfHostConfig = selfHostTapdbConfig();
  const clientId =
    selfHostConfig.clientId?.trim() ||
    process.env.EXPO_PUBLIC_TAPTAP_CLIENT_ID?.trim();
  const clientToken =
    selfHostConfig.clientToken?.trim() ||
    process.env.EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN?.trim();
  if (!clientId || !clientToken) {
    initPromise = Promise.resolve({ ok: false, reason: 'missing_config' });
    return initPromise;
  }

  initPromise = initializeTapdb({
    clientId,
    clientToken,
    region: resolveTapdbRegion(
      selfHostConfig.region || process.env.EXPO_PUBLIC_TAPDB_REGION,
    ),
    channel: resolveTapdbChannel(
      selfHostConfig.channel || process.env.EXPO_PUBLIC_TAPDB_CHANNEL,
      Platform.OS,
    ),
    properties: {
      xdt_surface: 'mobile',
      xdt_platform: Platform.OS,
      xdt_app_version: getMobileTapdbVersion(),
    },
  })
    .then((available) => available ? { ok: true as const } : { ok: false as const, reason: 'native_unavailable' as const })
    .catch(() => ({ ok: false as const, reason: 'native_error' as const }));

  return initPromise;
}

/**
 * 每次用到 SDK 之前都要重新问一遍同意闸,不能只信 `initPromise` 的缓存结果。
 *
 * 反例:账号 A 同意过 → SDK 已 init(initPromise 永久 resolved)→ 登出撤销同意 →
 * 账号 B 走企业 SSO 登录(SSO 被协议门豁免,B 从没同意过)。若直接复用缓存的
 * `{ ok: true }`,就会给一个从未同意的用户绑定账号标识并上报。
 */
async function ensureReportingAllowed(): Promise<boolean> {
  await hydrateAnalyticsConsent();
  if (!isAnalyticsAllowed()) return false;
  const status = await initMobileTapdb();
  return status.ok;
}

export async function setTapdbUser(userId: string): Promise<void> {
  if (!(await ensureReportingAllowed())) return;
  await setTapdbUserId(userId).catch(() => undefined);
}

export async function clearTapdbUser(): Promise<void> {
  // 只对已经 init 的实例有意义;没 init 过就没什么可解绑的,更不该为了一次登出
  // 把 SDK 拉起来。这里不用 ensureReportingAllowed:解绑是"减少"而非"开始"采集,
  // 撤销同意后仍然应该允许执行。
  if (!initPromise) return;
  const status = await initPromise;
  if (!status.ok) return;
  await clearNativeTapdbUser().catch(() => undefined);
}

/**
 * 用户在设置里关掉统计时调用:立刻解绑账号标识,并停止我们主动触发的一切上报。
 *
 * 原生 SDK 不支持反初始化,本次进程内已 init 的实例依然在;"完全不初始化"在下次
 * 冷启动生效(那时 isAnalyticsAllowed() 已经是 false)。这也是设置页文案不承诺
 * "立即抹除"的原因。
 */
export async function stopMobileTapdbReporting(): Promise<void> {
  if (!initPromise) return;
  const status = await initPromise;
  if (!status.ok) return;
  await clearNativeTapdbUser().catch(() => undefined);
}

export function resolveTapdbChannel(value: string | undefined, platform = Platform.OS): string {
  const trimmed = value?.trim();
  if (trimmed) return trimmed;
  return platform === 'ios' ? 'AppStore' : 'NPKG';
}

export function resolveTapdbRegion(value: string | undefined): TapdbRegion {
  return value?.trim().toLowerCase() === 'global' ? 'global' : 'cn';
}

export function getMobileTapdbVersion(): string {
  return Constants.nativeAppVersion ?? Constants.expoConfig?.version ?? '0.0.0';
}

export const __testing = {
  resetInitPromise(): void {
    initPromise = null;
  },
};
