import Constants from 'expo-constants';

import {
  CLIENT_ENDPOINT_KEYS,
  parseClientEndpointManifest,
  type ClientEndpointKey,
  type ClientEndpointMap,
  type ClientEndpointRegion,
  type RealmManifestBaseUrls,
} from '@cindy/maker-shared/client-endpoints';

import type { LoginMessageKey } from '@/auth/loginMessages';

export type CindyAuthRegion = 'cn' | 'global' | 'dev';

export interface MobileGoogleConfig {
  webClientId: string;
  iosClientId: string;
  iosUrlScheme: string;
}

const configuredExpoExtra =
  (Constants.expoConfig?.extra as {
    xdtProductionEnv?: Record<string, string>;
    cindy?: {
      regionConfigSource?: string;
      google?: Partial<MobileGoogleConfig>;
    };
  } | null) ?? {};
const configuredBuildEnv = (configuredExpoExtra.xdtProductionEnv ??
  {}) as Record<string, string>;
const configuredRegionGoogle = configuredExpoExtra.cindy?.google;

function configuredValue(key: string): string {
  return process.env[key]?.trim() || configuredBuildEnv[key]?.trim() || '';
}

export const AUTH_REGION: CindyAuthRegion = (() => {
  const value = configuredValue('EXPO_PUBLIC_CINDY_AUTH_REGION');
  return value === 'global' ? 'global' : value === 'dev' ? 'dev' : 'cn';
})();
export const BUILD_AUTH_REGION: ClientEndpointRegion =
  AUTH_REGION === 'global' ? 'global' : 'cn';
export const APP_SCHEME = { cn: 'cindycn', global: 'cindy', dev: 'cindydev' }[
  AUTH_REGION
];
export const MOBILE_REDIRECT_URL = `${APP_SCHEME}://auth`;

// __DEV__ 端点初值来源:metro 构建期按 AUTH_REGION 把仓内
// config/endpoint.json 或 config/endpoint.global.json require 进 dev bundle
// (__DEV__ 常量折叠 + DCE 后 prod bundle 不含该 JSON)。与 desktop dev 读同一份
// region 正本同语义;正本非法直接抛错红屏(阻断语义:配置错要炸出来)。
// 显式 EXPO_PUBLIC_* env 仍然优先——「手机连本地 server」的既有工作流不变。
// prod(非 __DEV__)此处为空:生效端点由启动闸门拉取的 endpoint.json 回填
// live binding,闸门放行前业务树不挂载,初值空串不会被真实消费。
const DEV_MANIFEST_PARSED = (() => {
  if (!__DEV__) return null;
  const manifestPath = {
    cn: 'config/endpoint.json',
    global: 'config/endpoint.global.json',
    dev: 'config/endpoint.dev.json',
  }[AUTH_REGION];
  const raw: unknown =
    AUTH_REGION === 'global'
      ? // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../../../../config/endpoint.global.json')
      : AUTH_REGION === 'dev'
        ? // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('../../../../config/endpoint.dev.json')
        : // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('../../../../config/endpoint.json');
  const parsed = parseClientEndpointManifest(JSON.stringify(raw), {
    allowHttp: true,
  });
  if (!parsed.ok) {
    throw new Error(
      `${manifestPath} invalid (${parsed.reason}) — dev 端点正本必须能过客户端 parser`,
    );
  }
  return parsed;
})();
const DEV_MANIFEST: Partial<Record<string, string>> =
  DEV_MANIFEST_PARSED?.endpoints ?? {};

let buildEndpointMap: ClientEndpointMap | null =
  DEV_MANIFEST_PARSED?.endpoints ?? null;
let endpointManifestRegion: ClientEndpointRegion | null =
  DEV_MANIFEST_PARSED?.region ?? null;
let activeSessionRealm: ClientEndpointRegion = BUILD_AUTH_REGION;
const realmEndpointCache = new Map<ClientEndpointRegion, ClientEndpointMap>();
if (buildEndpointMap) {
  realmEndpointCache.set(
    endpointManifestRegion ?? BUILD_AUTH_REGION,
    buildEndpointMap,
  );
}

// 显式 env 优先,dev 回落仓内正本;prod 为空串(闸门回填,见上)。
export const DEFAULT_DEVICE_LINK_API_BASE_URL =
  configuredValue('EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL') ||
  DEV_MANIFEST.deviceLinkApiBaseUrl ||
  '';
// 语音网关(litellm)地址仅剩本地 e2e / dev 显式覆写与测试 fixture 用途:手机
// 语音输入已只保留 Cindy 官方托管路径(VOICE_API_BASE_URL + 一次性票据),桌面
// device-link 凭据同步与 BYOK 直连均已删除,生产不再消费本值。
export const DEFAULT_MOBILE_VOICE_LITELLM_BASE_URL =
  configuredValue('EXPO_PUBLIC_XDT_MOBILE_VOICE_LITELLM_BASE_URL') || '';

export interface MobileConfigIssue {
  key: string;
  /** 展示文案走 loginMessages 5 语 catalog,本层只产出 key(文案 key 化,SC-4)。 */
  messageKey: LoginMessageKey;
}

export function normalizeBaseUrlWithDefault(
  value: string | undefined,
  fallback: string,
): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/$/, '') : fallback;
}

// 老 3333→3335 的"从主 API base 派生 relay"逻辑已随 apiBaseUrl 退役删除
// (本地没有 3333 主 server 了):连本地 relay 直接设
// EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL。
export function resolveDeviceLinkApiBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed
    ? trimmed.replace(/\/$/, '')
    : DEFAULT_DEVICE_LINK_API_BASE_URL;
}

export function deviceLinkWsUrl(apiBaseUrl = DEVICE_LINK_API_BASE_URL): string {
  return apiBaseUrl.replace(/^http/, 'ws') + '/api/device-link/ws';
}

export function resolveEnvFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

export const DEV_LOGIN_ENABLED = resolveEnvFlag(
  process.env.EXPO_PUBLIC_XDT_DEV_LOGIN_ENABLED,
);

export const MOBILE_VISUAL_MOCK_ENABLED =
  __DEV__ && resolveEnvFlag(process.env.EXPO_PUBLIC_CINDY_MOBILE_VISUAL_MOCK);

export const MOBILE_VISUAL_MOCK_REALDATA_URL = __DEV__
  ? process.env.EXPO_PUBLIC_CINDY_MOBILE_REALDATA_URL?.trim() || ''
  : '';

export function getMobileConfigIssues(
  env: Record<string, string | undefined> = {
    EXPO_PUBLIC_CINDY_AUTH_BASE_URL:
      process.env.EXPO_PUBLIC_CINDY_AUTH_BASE_URL,
  },
): MobileConfigIssue[] {
  const issues: MobileConfigIssue[] = [];
  const explicitBaseUrl = env.EXPO_PUBLIC_CINDY_AUTH_BASE_URL?.trim();
  if (explicitBaseUrl && !isHttpUrl(explicitBaseUrl)) {
    issues.push({
      key: 'EXPO_PUBLIC_CINDY_AUTH_BASE_URL',
      messageKey: 'configIssueAuthBaseUrl',
    });
  }
  return issues;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      Boolean(url.hostname)
    );
  } catch {
    return false;
  }
}

// ── 运行期可覆写端点(ESM live binding)─────────────────────────────────────
// 下面四个端点用 `export let`:启动闸门(useStartupEndpointGate)拉取远程端点
// 清单后经 applyResolvedClientEndpoints 重赋值,importer 通过 live binding 看到
// 新值(消费点全部是调用时读取,无模块顶层捕获——新增顶层派生前先想清楚)。
// 初始值即构建期烘焙值;__DEV__ 下闸门不拉取,行为与现状完全一致。

// 默认 auth 来自构建区域清单；组织 SSO 登录时会把 token 消费端点整体切到
// session realm。显式 env 覆写仍只影响 dev/构建区域初值。
export let AUTH_API_BASE_URL = normalizeBaseUrlWithDefault(
  configuredValue('EXPO_PUBLIC_CINDY_AUTH_BASE_URL'),
  DEV_MANIFEST.authApiBaseUrl ?? '',
);

/** 登录后读取用户级 isCanary feature flag；正式包由 endpoint.json 运行期回写。 */
export let OAUTH_BROKER_API_BASE_URL = normalizeBaseUrlWithDefault(
  '',
  DEV_MANIFEST.oauthBrokerApiBaseUrl ?? '',
);

/** 本地 / self-host 构建只认 region JSON 写入的 Expo extra;EAS 线使用 EXPO_PUBLIC_*。 */
export function resolveMobileGoogleConfig(
  regionConfigAuthoritative: boolean,
  regionConfig: Partial<MobileGoogleConfig> | undefined,
  env: Record<string, string | undefined> = process.env,
): MobileGoogleConfig {
  if (regionConfigAuthoritative) {
    return {
      webClientId: regionConfig?.webClientId?.trim() || '',
      iosClientId: regionConfig?.iosClientId?.trim() || '',
      iosUrlScheme: regionConfig?.iosUrlScheme?.trim() || '',
    };
  }
  return {
    webClientId: env.EXPO_PUBLIC_CINDY_GOOGLE_WEB_CLIENT_ID?.trim() || '',
    iosClientId: env.EXPO_PUBLIC_CINDY_GOOGLE_IOS_CLIENT_ID?.trim() || '',
    iosUrlScheme: env.EXPO_PUBLIC_CINDY_GOOGLE_IOS_URL_SCHEME?.trim() || '',
  };
}

const GOOGLE_CONFIG = resolveMobileGoogleConfig(
  configuredExpoExtra.cindy?.regionConfigSource === 'self-host-regions',
  configuredRegionGoogle,
  {
    EXPO_PUBLIC_CINDY_GOOGLE_WEB_CLIENT_ID:
      process.env.EXPO_PUBLIC_CINDY_GOOGLE_WEB_CLIENT_ID,
    EXPO_PUBLIC_CINDY_GOOGLE_IOS_CLIENT_ID:
      process.env.EXPO_PUBLIC_CINDY_GOOGLE_IOS_CLIENT_ID,
    EXPO_PUBLIC_CINDY_GOOGLE_IOS_URL_SCHEME:
      process.env.EXPO_PUBLIC_CINDY_GOOGLE_IOS_URL_SCHEME,
  },
);
export const GOOGLE_WEB_CLIENT_ID = GOOGLE_CONFIG.webClientId;
export const GOOGLE_IOS_CLIENT_ID = GOOGLE_CONFIG.iosClientId;
export const GOOGLE_IOS_URL_SCHEME = GOOGLE_CONFIG.iosUrlScheme;
export const WECHAT_APP_ID =
  process.env.EXPO_PUBLIC_CINDY_WECHAT_APP_ID?.trim() || '';
export const WECHAT_UNIVERSAL_LINK =
  process.env.EXPO_PUBLIC_CINDY_WECHAT_UNIVERSAL_LINK?.trim() || '';

export let DEVICE_LINK_API_BASE_URL = resolveDeviceLinkApiBaseUrl(
  configuredValue('EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL'),
);

/** voice-server 数据面；正式包由启动端点清单回填。 */
export let VOICE_API_BASE_URL = normalizeBaseUrlWithDefault(
  configuredValue('EXPO_PUBLIC_CINDY_VOICE_API_BASE_URL'),
  DEV_MANIFEST.voiceApiBaseUrl ?? '',
);

function syncBuildTokenEndpointCache(): void {
  if (!buildEndpointMap) return;
  const buildRealm = endpointManifestRegion ?? BUILD_AUTH_REGION;
  buildEndpointMap = {
    ...buildEndpointMap,
    authApiBaseUrl: AUTH_API_BASE_URL,
    oauthBrokerApiBaseUrl: OAUTH_BROKER_API_BASE_URL,
    deviceLinkApiBaseUrl: DEVICE_LINK_API_BASE_URL,
    voiceApiBaseUrl: VOICE_API_BASE_URL,
  };
  realmEndpointCache.set(buildRealm, buildEndpointMap);
}

// __DEV__ 的显式 EXPO_PUBLIC_* 覆写必须同时进入构建区域缓存。认证客户端和
// logout/reset 现在从 realm cache 取值；只改 live binding 会导致首次登录看似
// 命中本地服务，后续 realm 激活却悄悄退回仓内正本。
syncBuildTokenEndpointCache();

// 二进制版本号:审核模式匹配基准。优先原生层版本(iOS CFBundleShortVersionString /
// Android versionName,OTA 热更后不漂移),expoConfig.version 兜底(dev / 测试环境
// 拿不到原生值)。与 mobileTapdb 的版本上报取值口径一致。
export const APP_BINARY_VERSION = (
  Constants.nativeAppVersion ??
  Constants.expoConfig?.version ??
  ''
).trim();

// 运行平台标识:只会是 'ios' / 'android' / ''(拿不到)。审核模式的平台门控要在 env.ts
// 顶层就能判定,而这里不能引 react-native 的 Platform:env.ts 被 node 环境单测直接
// 导入,react-native 真模块会把 Flow 语法拖进依赖链(同 vitest.config.ts 对
// expo-localization 的处理)。改用两路互不依赖的 RN-free 信号:
// 1. `process.env.EXPO_OS` —— babel-preset-expo 打包期按目标平台内联(仓内无
//    babel.config.js,@expo/metro-config 回落 expo/internal/babel-preset,该内联恒生效);
//    JS 常量,不进 @expo/fingerprint,不改 runtimeVersion。
// 2. `Constants.platform` 的平台段兜底 —— 万一内联缺失(自定义 babel 配置等)仍能判出
//    Android,避免「安卓被审核模式误冻结热更」这个高代价失效模式静默复发。
// 取值收敛为白名单:两路信号都只认 'ios' / 'android',其余(web、未来新平台、
// 被改写成意外值)一律当作「拿不到」→ 空串,由消费方按平台未知的语义处理,
// 不让未预期的值逸出取值域后再去参与平台门控。
const NATIVE_PLATFORMS = ['ios', 'android'] as const;

export type AppPlatform = (typeof NATIVE_PLATFORMS)[number] | '';

function resolveAppPlatform(): AppPlatform {
  const inlined = (process.env.EXPO_OS ?? '').trim().toLowerCase();
  const matched = NATIVE_PLATFORMS.find((platform) => platform === inlined);
  if (matched) return matched;
  const platformManifest = Constants.platform;
  if (platformManifest?.android) return 'android';
  if (platformManifest?.ios) return 'ios';
  return '';
}

export const APP_PLATFORM: AppPlatform = resolveAppPlatform();

/**
 * 纯函数:清单 review(送审版本号)与二进制版本号严格相等、且当前安装不是
 * TestFlight 时才进入审核模式;
 * 任一侧为空恒 false(清单没填 = 关闭;拿不到版本号 = 宁可不进审核模式,
 * 也不能让线上用户误失去更新通道)。
 * Android 恒 false:审核模式只为 iOS 商店送审存在(见下方 REVIEW_MODE 注释),
 * 而清单 review 是 region 级单值、不分平台,iOS 送审期间填的版本号会连带命中同版本号的
 * 安卓自建装机,把它们的热更与整包检查一起冻结(2026-07 实踩:review="0.1.0" 冻结全部
 * 0.1.0 安卓装机)。安卓自建线不过商店审核,没有需要关闭更新检查的场景,故在此豁免。
 * 只豁免 android:iOS(含平台未知)一律保持原语义,不弱化送审合规。
 * platform 形参收敛为 AppPlatform 而非 string:拼写 / 大小写错误('Android')会静默
 * 走回 iOS 语义、丢掉安卓豁免,这类误用要在类型层就挡住,不留给运行期。
 */
export function isReviewModeActive(
  reviewVersion: string | null | undefined,
  appBinaryVersion: string,
  isTestFlight = false,
  platform: AppPlatform = APP_PLATFORM,
): boolean {
  if (platform === 'android') return false;
  const review = reviewVersion?.trim();
  const binary = appBinaryVersion.trim();
  return !isTestFlight && Boolean(review) && review === binary;
}

// 手机版审核模式(清单可选字段 review = 送审版本号,缺失/空串 = 关闭):App 审核
// 期间线上清单填送审构建的二进制版本号,仅 **iOS** 上版本命中且 StoreKit 未识别为
// TestFlight 的构建关闭全部 JS 显式更新检查;android 恒不进审核模式(清单 review 是
// region 级单值不分平台,安卓自建线不过商店审核,理由见 isReviewModeActive)。
// TestFlight 不进入审核模式,但由整包更新策略单独
// 禁用会外跳安装的整包检查,只保留 JS OTA。设置页在审核模式隐藏统一「检查更新」入口;
// 存量其它版本用户不受影响。覆盖边界与运维义务(原生层后台检查管不到、
// 过审发布后须清空字段)见 maker-shared clientEndpoints 的 CLIENT_ENDPOINT_REVIEW_KEY
// 注释。live binding:prod 由启动闸门回填,闸门 ready 前业务树不挂载,消费点
// (更新 hooks / 设置页)读到的一定是清单值;dev 读仓内正本。仅 mobile 消费,
// desktop 忽略该字段。
let resolvedReviewVersion = DEV_MANIFEST_PARSED?.reviewVersion ?? null;

/** StoreKit 在 endpoint 闸门期间识别出的 TestFlight 状态；供更新策略与诊断同步消费。 */
export let IS_TESTFLIGHT_BUILD = false;

export let REVIEW_MODE = isReviewModeActive(
  resolvedReviewVersion,
  APP_BINARY_VERSION,
  IS_TESTFLIGHT_BUILD,
);

// 非 live binding(清单不再承载语音网关地址,启动闸门无覆写路径):env 覆写为空时
// 即空串。生产语音输入走 VOICE_API_BASE_URL 的托管路径,本值仅供本地 e2e / dev。
export const MOBILE_VOICE_LITELLM_BASE_URL =
  DEFAULT_MOBILE_VOICE_LITELLM_BASE_URL
    ? normalizeBaseUrlWithDefault(DEFAULT_MOBILE_VOICE_LITELLM_BASE_URL, '')
    : '';

// 本区与对端 endpoint.json 的自举拉取基址，均由构建期从两份仓内清单的
// cdnBaseUrl 注入。**烘焙常量、不接受远程覆盖**——区域身份由受信任地址表
// 决定，远端清单只提供该区域的业务端点。
export const ENDPOINT_MANIFEST_BASE_URL = configuredValue(
  'EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL',
).replace(/\/+$/, '');
export const ENDPOINT_MANIFEST_PEER_BASE_URL = (
  // Expo/Metro 只内联静态属性访问；不能改回 configuredValue(dynamicKey)。
  process.env.EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL?.trim() ||
  configuredBuildEnv.EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL?.trim() ||
  ''
).replace(/\/+$/, '');

function trustedMobileRealmManifestBaseUrls(): RealmManifestBaseUrls {
  return BUILD_AUTH_REGION === 'global'
    ? {
        cn: ENDPOINT_MANIFEST_PEER_BASE_URL,
        global: ENDPOINT_MANIFEST_BASE_URL,
      }
    : {
        cn: ENDPOINT_MANIFEST_BASE_URL,
        global: ENDPOINT_MANIFEST_PEER_BASE_URL,
      };
}

/**
 * 启动闸门拉到远程端点清单后回写运行期端点。`undefined` 表示调用方未提供、
 * 不修改;空串表示清单缺失/留空后的权威结果,必须清空旧值。启动清单写入
 * 构建区域默认值；跨区域组织会话由 activateMobileSessionRealm 整体切换
 * token 消费端点。
 */
export function applyResolvedClientEndpoints(resolved: {
  authApiBaseUrl?: string;
  oauthBrokerApiBaseUrl?: string;
  deviceLinkApiBaseUrl?: string;
  voiceApiBaseUrl?: string;
  mobileUpdateBaseUrl?: string;
  /** 审核模式送审版本号(parser 产出,null = 清单未填;undefined = 不改动)。 */
  reviewVersion?: string | null;
  /** iOS StoreKit 分发环境；TestFlight 保留 OTA、禁用整包外跳。 */
  isTestFlight?: boolean;
  region?: ClientEndpointRegion | null;
}): void {
  if (resolved.authApiBaseUrl !== undefined) {
    AUTH_API_BASE_URL = normalizeBaseUrlWithDefault(
      resolved.authApiBaseUrl,
      '',
    );
  }
  if (resolved.oauthBrokerApiBaseUrl !== undefined) {
    OAUTH_BROKER_API_BASE_URL = normalizeBaseUrlWithDefault(
      resolved.oauthBrokerApiBaseUrl,
      '',
    );
  }
  if (resolved.deviceLinkApiBaseUrl !== undefined) {
    DEVICE_LINK_API_BASE_URL = resolved.deviceLinkApiBaseUrl.replace(/\/$/, '');
  }
  if (resolved.voiceApiBaseUrl !== undefined) {
    VOICE_API_BASE_URL = resolved.voiceApiBaseUrl.replace(/\/$/, '');
  }
  // partial apply 也必须保持构建缓存与 live binding 一致；测试、dev 热重载和
  // 未来的局部配置刷新都不能在下一次 realm reset 时退回旧值。
  syncBuildTokenEndpointCache();
  // 仅自建变体吃清单覆写,保住「非自建 ⇒ OTA_SERVER_BASE_URL 恒空串」不变量
  // (调用点虽都有 IS_OTA_SELFHOST 门控,这里再挡一层,变体身份始终由烧包决定)。
  if (resolved.mobileUpdateBaseUrl !== undefined && IS_OTA_SELFHOST) {
    OTA_SERVER_BASE_URL = resolved.mobileUpdateBaseUrl.replace(/\/+$/, '');
  }
  if (resolved.reviewVersion !== undefined) {
    resolvedReviewVersion = resolved.reviewVersion;
  }
  if (resolved.isTestFlight !== undefined) {
    IS_TESTFLIGHT_BUILD = resolved.isTestFlight;
  }
  if (
    resolved.reviewVersion !== undefined ||
    resolved.isTestFlight !== undefined
  ) {
    REVIEW_MODE = isReviewModeActive(
      resolvedReviewVersion,
      APP_BINARY_VERSION,
      IS_TESTFLIGHT_BUILD,
    );
  }

  const hasCompleteEndpointMap = CLIENT_ENDPOINT_KEYS.every(
    (key) => typeof (resolved as Partial<ClientEndpointMap>)[key] === 'string',
  );
  if (hasCompleteEndpointMap) {
    buildEndpointMap = resolved as ClientEndpointMap;
    endpointManifestRegion = resolved.region ?? null;
    activeSessionRealm = endpointManifestRegion ?? BUILD_AUTH_REGION;
    realmEndpointCache.clear();
    realmEndpointCache.set(activeSessionRealm, buildEndpointMap);
  }
}

export function getMobileEndpointRealmConfig(): {
  buildRegion: ClientEndpointRegion;
  manifestRegion: ClientEndpointRegion | null;
  crossRealmOrgLoginEnabled: boolean;
  realmManifestBaseUrls: RealmManifestBaseUrls;
} {
  return {
    buildRegion: BUILD_AUTH_REGION,
    manifestRegion: endpointManifestRegion,
    crossRealmOrgLoginEnabled: AUTH_REGION !== 'dev',
    realmManifestBaseUrls: trustedMobileRealmManifestBaseUrls(),
  };
}

const MOBILE_REALM_MANIFEST_TIMEOUT_MS = 10_000;

/** 当前登录态消费业务请求的区域；与安装包/更新通道所在区域相互独立。 */
export function getActiveMobileSessionRealm(): ClientEndpointRegion {
  return activeSessionRealm;
}

export async function loadMobileEndpointsForRealm(
  region: ClientEndpointRegion,
): Promise<ClientEndpointMap> {
  const cached = realmEndpointCache.get(region);
  if (cached) return cached;
  const baseUrl = trustedMobileRealmManifestBaseUrls()[region];
  if (!baseUrl) {
    throw new Error('realm-manifest-url-unavailable');
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    MOBILE_REALM_MANIFEST_TIMEOUT_MS,
  );
  try {
    const response = await fetch(`${baseUrl}/endpoint.json?t=${Date.now()}`, {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`http-${response.status}`);
    const parsed = parseClientEndpointManifest(await response.text());
    if (!parsed.ok) throw new Error(parsed.reason);
    if (parsed.region !== null && parsed.region !== region) {
      throw new Error(`region-mismatch:${region}:${parsed.region}`);
    }
    realmEndpointCache.set(region, parsed.endpoints);
    return parsed.endpoints;
  } finally {
    clearTimeout(timer);
  }
}

export function getMobileEndpointForRealm(
  region: ClientEndpointRegion,
  key: ClientEndpointKey,
): string {
  const endpoints = realmEndpointCache.get(region);
  if (!endpoints)
    throw new Error(`mobile endpoints for realm '${region}' not loaded`);
  return endpoints[key];
}

/** 只切 token 消费端点；mobileUpdate/review/更新身份仍由构建清单控制。 */
export function activateMobileSessionRealm(region: ClientEndpointRegion): void {
  const endpoints = realmEndpointCache.get(region);
  if (!endpoints)
    throw new Error(`mobile endpoints for realm '${region}' not loaded`);
  activeSessionRealm = region;
  AUTH_API_BASE_URL = endpoints.authApiBaseUrl;
  OAUTH_BROKER_API_BASE_URL = endpoints.oauthBrokerApiBaseUrl;
  DEVICE_LINK_API_BASE_URL = endpoints.deviceLinkApiBaseUrl;
  VOICE_API_BASE_URL = endpoints.voiceApiBaseUrl;
}

export function resetMobileSessionRealm(): void {
  const buildRealm = endpointManifestRegion ?? BUILD_AUTH_REGION;
  const endpoints = realmEndpointCache.get(buildRealm) ?? buildEndpointMap;
  activeSessionRealm = buildRealm;
  if (!endpoints) return;
  AUTH_API_BASE_URL = endpoints.authApiBaseUrl;
  OAUTH_BROKER_API_BASE_URL = endpoints.oauthBrokerApiBaseUrl;
  DEVICE_LINK_API_BASE_URL = endpoints.deviceLinkApiBaseUrl;
  VOICE_API_BASE_URL = endpoints.voiceApiBaseUrl;
}

// 自建分发服务基址,唯一来源是 endpoint.json 的 mobileUpdateBaseUrl:
// - `${base}/manifest`:useStartupOtaGate 在手动 check/fetch 前运行时覆写 expo-updates URL;
// - `${base}/latest`:整包发现(runtimeVersion 不同则引导安装新包)。
// live binding:启动闸门成功前保持空串,业务树与 OTA 门均未挂载;自建变体由
// applyResolvedClientEndpoints 回填,非自建变体恒空串。真实更新地址不再构建期注入。
export let OTA_SERVER_BASE_URL = '';

// 是否自建变体 —— 必须与 app.config.js 的构建门控读同一个 EXPO_PUBLIC_XDT_OTA_SELFHOST 标志。
// 真实更新地址只来自 endpoint 清单,不能拿它反推包身份,否则会破坏 EAS / 自建两条线隔离。
// EXPO_PUBLIC_ 前缀保证该标志会被 inline 进 JS bundle,
// 与包的真实身份严格对齐。
export const IS_OTA_SELFHOST = process.env.EXPO_PUBLIC_XDT_OTA_SELFHOST === '1';

// 二级版本号:本次自建线打包所配对的桌面产品线版本(如 `0.0.147`)。仅自建线发版脚本
// 会经 selfhostEnv() 注入该值(取自桌面 CDN manifest 的当前版本),EAS beta/prod 不注入。
// EXPO_PUBLIC_ 前缀由 Metro 在打包时内联进 JS bundle(不进 @expo/fingerprint,OTA 安全、
// 不改 runtimeVersion)。空值表示 dev / 非自建 / 未注入,设置页据此不渲染该行。
export const DESKTOP_PACKAGE_VERSION =
  process.env.EXPO_PUBLIC_DESKTOP_VERSION?.trim() || '';
