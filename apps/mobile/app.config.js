// 动态 Expo config —— region 是 app 身份、auth-server 与 OAuth 回调 scheme 的统一构建开关。
//
// - 标准开发脚本默认显式注入 global；这里无 env 时仍保留 cn 原生基线，避免仅为
//   默认值翻转触发一次全量冷更。下次计划内冷更再单独迁移该兼容基线。
// - cn:com.xd.cindycn + cindycn://auth;global:com.xd.cindy + cindy://auth。
// - beta 只改显示名,不改变所选 region 的身份。
// - production / TestFlight 必须由发布环境注入对应 App Store 数字 ID,缺失即中止。
// - 本地 Xcode / Simulator 与自建分发变体共用 scripts/self-host-regions.json 的 app 身份、
//   TapDB / Google 公开配置;EAS 云构建看不到 gitignored 文件,继续使用 EAS environment。
// - 自建分发变体(`EXPO_PUBLIC_XDT_OTA_SELFHOST=1`):
//     · iOS 与 Android app identity 各自一个字段,可独立调整,互不影响。
//     · updates.url 只放稳定占位值;真实 mobile-update-server 地址由启动端点清单的
//       mobileUpdateBaseUrl 运行时覆写,不参与 build/fingerprint;
//     · 保留 region scheme,但使用自建 bundle identity。此变体有意改变指纹,
//       但只在该 env 开启时生效,EAS 路径仍逐字节不变。
// - 不注入任何按 commit 变化的内容(如 git hash),避免 fingerprint 每次提交漂移。
const fs = require('node:fs');
const path = require('node:path');
const appJson = require('./app.json');
const {
  loadMobileClientBuildEnv,
} = require('../../scripts/shared/client-endpoint-build-env.cjs');

// 本地 Xcode / Simulator 与 self-host release 共用同一份地区构建配置。EAS 云端看不到
// gitignored 的真文件,因此不启用 CINDY_USE_LOCAL_REGION_CONFIG 时继续走 eas.json / EAS env。
function loadRegionBuildConfig(region, { selfHosted = false } = {}) {
  const dir = path.join(__dirname, 'scripts');
  const configured = process.env.CINDY_SELF_HOST_REGIONS_FILE?.trim();
  const real = configured
    ? path.resolve(dir, configured)
    : path.join(dir, 'self-host-regions.json');
  const example = path.join(dir, 'self-host-regions.json.example');
  let file = real;
  if (!fs.existsSync(real)) {
    // 自建发布线缺文件必须硬报错;本地构建缺文件不阻断——回落到空白模板并打警告,
    // 身份字段由调用方回落内置 dev 身份,统计/Google 登录自动关闭。
    if (selfHosted) {
      throw new Error(
        `缺少地区构建配置: ${real}。请复制 ${example} 为 self-host-regions.json 并填值`,
      );
    }
    console.warn(
      `[cindy] 缺少 ${real},本地构建回落空白模板 ${path.basename(example)}` +
        '(app 身份用内置默认,统计/Google 登录关闭)。需自定义请复制该模板为 self-host-regions.json 填值。',
    );
    file = example;
  }
  const block = JSON.parse(fs.readFileSync(file, 'utf8'))[region];
  if (!block || typeof block !== 'object') {
    throw new Error(`${path.basename(file)} 缺少 region "${region}" 配置块`);
  }
  // 身份字段:自建发布线必须非空;本地构建允许留空,由调用方回落内置 dev 身份并打警告。
  if (selfHosted && !(block.iosBundleId?.trim() && block.androidPackage?.trim())) {
    throw new Error(
      `${path.basename(file)} 缺少 region "${region}" 的 iosBundleId/androidPackage`,
    );
  }
  // TapDB 只在自建发布线强制非空:漏填会静默发出无统计的正式包。本地 Xcode /
  // Simulator 构建允许留空——运行时统计模块对缺失配置自动 no-op(mobileTapdb.ts),
  // 外部开发者无需 TapDB 账号即可本地构建。
  if (selfHosted && !(block.tapdb?.clientId?.trim() && block.tapdb?.clientToken?.trim())) {
    throw new Error(
      `${path.basename(file)} 缺少 region "${region}" 的 tapdb.clientId/clientToken`,
    );
  }
  if (region === 'cn' && Object.hasOwn(block, 'google')) {
    throw new Error(`${path.basename(file)} 的 cn 不得配置 google;Google 登录仅允许 global 线`);
  }
  const google = block.google;
  const googleFields = ['webClientId', 'iosClientId', 'iosUrlScheme'];
  const hasGoogleConfig = googleFields.every((key) => google?.[key]?.trim());
  if (region === 'global' && selfHosted && !hasGoogleConfig) {
    throw new Error(
      `${path.basename(file)} 缺少 global.google.webClientId/iosClientId/iosUrlScheme`,
    );
  }
  // 本地构建 google 可整体留空(跳过 Google 登录);只要填了任意字段就必须三个齐全,
  // 防止部分填写被静默丢弃。
  if (!hasGoogleConfig && googleFields.some((key) => google?.[key]?.trim())) {
    throw new Error(
      `${path.basename(file)} 的 global.google 三个字段须同时填写或同时留空`,
    );
  }
  let normalizedGoogle;
  if (hasGoogleConfig) {
    const webClientId = google.webClientId.trim();
    const iosClientId = google.iosClientId.trim();
    const iosUrlScheme = google.iosUrlScheme.trim();
    const clientIdSuffix = '.apps.googleusercontent.com';
    if (!webClientId.endsWith(clientIdSuffix) || !iosClientId.endsWith(clientIdSuffix)) {
      throw new Error(`${path.basename(file)} 的 global.google client id 格式无效`);
    }
    const expectedScheme = `com.googleusercontent.apps.${iosClientId.slice(0, -clientIdSuffix.length)}`;
    if (iosUrlScheme !== expectedScheme) {
      throw new Error(
        `${path.basename(file)} 的 global.google.iosUrlScheme 必须由 iosClientId 反写为 ${expectedScheme}`,
      );
    }
    normalizedGoogle = { webClientId, iosClientId, iosUrlScheme };
  }
  const normalizedBlock = { ...block };
  delete normalizedBlock.google;
  if (normalizedGoogle) normalizedBlock.google = normalizedGoogle;
  return normalizedBlock;
}

// expo-updates 原生配置要求一个合法 URL 才能启用模块。自建线关闭原生启动联网检查,
// JS 启动闸门拉到 endpoint.json 后会在手动 check/fetch 前把它覆写成
// `${mobileUpdateBaseUrl}/manifest`;因此本值永不承载真实服务地址,也不得随环境变化。
const SELFHOST_UPDATES_PLACEHOLDER_URL = 'https://selfhost.invalid/manifest';

function resolveMobileBuildEnv() {
  return loadMobileClientBuildEnv();
}

function resolvePeerManifestBaseUrl(region) {
  const previousRegion = process.env.EXPO_PUBLIC_CINDY_AUTH_REGION;
  try {
    process.env.EXPO_PUBLIC_CINDY_AUTH_REGION =
      region === 'global' ? 'cn' : 'global';
    const peerBuildEnv = loadMobileClientBuildEnv();
    return peerBuildEnv.EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL;
  } finally {
    if (previousRegion === undefined) {
      delete process.env.EXPO_PUBLIC_CINDY_AUTH_REGION;
    } else {
      process.env.EXPO_PUBLIC_CINDY_AUTH_REGION = previousRegion;
    }
  }
}

const REGION_CONFIG = {
  cn: {
    scheme: 'cindycn',
    iosBundleIdentifier: 'com.xd.cindycn',
    androidPackage: 'com.xd.cindycn',
  },
  global: {
    scheme: 'cindy',
    iosBundleIdentifier: 'com.xd.cindy',
    androidPackage: 'com.xd.cindy',
  },
  // dev 第三目标(与 desktop CindyDev 同一套身份命名,可同机三装)。
  dev: {
    scheme: 'cindydev',
    iosBundleIdentifier: 'com.xd.cindydev',
    androidPackage: 'com.xd.cindydev',
  },
};

function resolveRegion() {
  const region = process.env.EXPO_PUBLIC_CINDY_AUTH_REGION?.trim() || 'cn';
  if (region !== 'cn' && region !== 'global' && region !== 'dev') {
    throw new Error(
      `EXPO_PUBLIC_CINDY_AUTH_REGION must be cn, global or dev, got: ${region}`,
    );
  }
  return region;
}

function resolveAppStoreId(region) {
  const regionKey = {
    cn: 'CINDY_CN_APP_STORE_ID',
    global: 'CINDY_GLOBAL_APP_STORE_ID',
    dev: 'CINDY_DEV_APP_STORE_ID', // dev 不上架,仅显式要求时才校验(与下方 requiresId 同语义)
  }[region];
  const value = (process.env[regionKey] || '').trim();
  const requiresId =
    process.env.XDT_REQUIRE_APP_STORE_ID === '1' ||
    [
      'production',
      'testflight',
      'production-global',
      'testflight-global',
    ].includes(process.env.EAS_BUILD_PROFILE || '');
  if (requiresId && !/^\d+$/.test(value)) {
    throw new Error(
      `Missing numeric ${regionKey} for ${region} App Store build`,
    );
  }
  return value;
}

function withNativeAuthPlugins(plugins, env) {
  const next = [...plugins];
  if (env.googleIosUrlScheme) {
    next.push([
      '@react-native-google-signin/google-signin',
      { iosUrlScheme: env.googleIosUrlScheme },
    ]);
  }
  if (env.wechatAppId && env.wechatUniversalLink) {
    next.push([
      'xdt-wechat-login/plugin',
      { appId: env.wechatAppId, universalLink: env.wechatUniversalLink },
    ]);
  }
  return next;
}

module.exports = (context = {}) => {
  const baseConfig = context.config ?? appJson.expo;
  const region = resolveRegion();
  const mobileBuildEnv = resolveMobileBuildEnv();
  const mobileBundleEnv = {
    ...mobileBuildEnv,
    EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL:
      resolvePeerManifestBaseUrl(region),
  };
  for (const [key, value] of Object.entries(mobileBundleEnv)) {
    if (!process.env[key]?.trim()) process.env[key] = value;
  }
  // xdtProductionEnv 是既有 Expo config / runtime fingerprint 的一部分。对端清单
  // 基址只需通过上面的 EXPO_PUBLIC_* 环境变量进入 Metro bundle；不要把它追加到
  // extra，否则本次纯 JS 登录路由会无意要求一次冷构建，并切断旧 runtime 的 OTA 链。
  const selfHosted = process.env.EXPO_PUBLIC_XDT_OTA_SELFHOST === '1';
  const usesLocalRegionConfig =
    process.env.CINDY_USE_LOCAL_REGION_CONFIG === '1';
  const usesRegionConfig = selfHosted || usesLocalRegionConfig;
  const regionBuildConfig = usesRegionConfig
    ? loadRegionBuildConfig(region, { selfHosted })
    : null;
  const builtInRegional = REGION_CONFIG[region];
  let regional = builtInRegional;
  if (regionBuildConfig) {
    // 身份字段留空(仅本地构建可能走到——自建线已在装载时硬校验)回落内置 dev 身份。
    const iosBundleIdentifier =
      regionBuildConfig.iosBundleId?.trim() || builtInRegional.iosBundleIdentifier;
    const androidPackage =
      regionBuildConfig.androidPackage?.trim() || builtInRegional.androidPackage;
    if (
      iosBundleIdentifier !== regionBuildConfig.iosBundleId?.trim() ||
      androidPackage !== regionBuildConfig.androidPackage?.trim()
    ) {
      console.warn(
        `[cindy] self-host-regions 的 ${region} 身份字段留空,本地构建回落内置身份 ` +
          `${iosBundleIdentifier} / ${androidPackage}(真机安装可能与商店版同 id 冲突,` +
          '可在 self-host-regions.json 填自己的 bundle id)。',
      );
    }
    regional = { ...builtInRegional, iosBundleIdentifier, androidPackage };
  }
  const regionGoogle = regionBuildConfig?.google;
  const regionTapdb = regionBuildConfig?.tapdb;
  resolveAppStoreId(region);
  // EAS 账号绑定不入仓:owner / eas.projectId / updates.url 由构建期环境变量注入
  // (EAS_OWNER / EAS_PROJECT_ID)。官方发布环境注回原值 → resolved ExpoConfig 逐字节不变
  // → runtime fingerprint 不变、不触发冷更;缺省(dev / 外部 fork)不带账号绑定,由使用者
  // 用自己的 Expo 项目(eas init)填 env。详见 docs/dev-rules/mobile-development.md。
  const easOwner = process.env.EAS_OWNER?.trim();
  const easProjectId = process.env.EAS_PROJECT_ID?.trim();
  let next = {
    ...baseConfig,
    ...(easOwner ? { owner: easOwner } : {}),
    scheme: regional.scheme,
    ios: {
      ...baseConfig.ios,
      bundleIdentifier: regional.iosBundleIdentifier,
      usesAppleSignIn: true,
    },
    android: {
      ...baseConfig.android,
      package: regional.androidPackage,
    },
    // 非自建线的 EAS Update 入口:由下发的 projectId 推导;自建分支下方会把它覆写成
    // selfhost 占位(真实地址运行时由 mobileUpdateBaseUrl 注入)。projectId 缺省则不配 OTA。
    ...(easProjectId
      ? { updates: { url: `https://u.expo.dev/${easProjectId}`, enabled: true } }
      : {}),
    plugins: withNativeAuthPlugins(baseConfig.plugins || [], {
      googleIosUrlScheme: usesRegionConfig
        ? regionGoogle?.iosUrlScheme
        : process.env.EXPO_PUBLIC_CINDY_GOOGLE_IOS_URL_SCHEME?.trim(),
      wechatAppId: process.env.EXPO_PUBLIC_CINDY_WECHAT_APP_ID?.trim(),
      wechatUniversalLink:
        process.env.EXPO_PUBLIC_CINDY_WECHAT_UNIVERSAL_LINK?.trim(),
    }),
    extra: {
      ...baseConfig.extra,
      ...(easProjectId ? { eas: { projectId: easProjectId } } : {}),
      cindy: {
        authRegion: region,
        ...(usesRegionConfig
          ? {
              regionConfigSource: 'self-host-regions',
              // TapDB 留空(仅本地构建可能)时不烘焙该键:运行时 mobileTapdb 视为
              // 未配置并关闭统计。已填值时输出与旧版逐字节一致,不动 runtime fingerprint。
              ...(regionTapdb?.clientId?.trim() && regionTapdb?.clientToken?.trim()
                ? {
                    tapdb: {
                      clientId: regionTapdb.clientId.trim(),
                      clientToken: regionTapdb.clientToken.trim(),
                      region,
                    },
                  }
                : {}),
              ...(regionGoogle
                ? {
                    google: {
                      webClientId: regionGoogle.webClientId,
                      iosClientId: regionGoogle.iosClientId,
                      iosUrlScheme: regionGoogle.iosUrlScheme,
                    },
                  }
                : {}),
            }
          : {}),
      },
      xdtProductionEnv: mobileBuildEnv,
    },
  };

  if (process.env.EXPO_PUBLIC_APP_VARIANT === 'beta') {
    const betaDev = process.env.EXPO_PUBLIC_BETA_DEV?.trim();
    const suffix = betaDev ? ` Beta (${betaDev})` : ' Beta';
    next = { ...next, name: `${next.name}${suffix}` };
  }

  // 自建门控用 EXPO_PUBLIC_XDT_OTA_SELFHOST:同一个 EXPO_PUBLIC 标志既在此决定
  // bundleId / 原生 OTA 策略,又被 inline 进 JS 供运行时 IS_OTA_SELFHOST 判定,
  // 构建与运行时严格对齐。真实 OTA 地址不再作为构建 env 注入。
  if (selfHosted) {
    // Android 自建线:versionCode 只在此自建分支注入(经 release-android-*.mjs 传入的
    // XDT_ANDROID_VERSION_CODE),APK 覆盖安装 + NPKG md5 去重要求它单调递增。app.json 里
    // **不声明** android.versionCode → 非自建 resolved config 逐字节不变(红线 1,EAS 指纹不受影响)。
    // 值来源是 committed android-version.json,由发布脚本读取并置入 env,app.config.js 不直接读文件
    // (避免把版本文件卷进 @expo/fingerprint 的配置源)。缺省(非 Android 出包路径)则不注入。
    const rawVersionCode = process.env.XDT_ANDROID_VERSION_CODE?.trim();
    const versionCode = rawVersionCode ? Number(rawVersionCode) : undefined;
    next = {
      ...next,
      android: {
        ...next.android,
        ...(Number.isInteger(versionCode) && versionCode > 0 ? { versionCode } : {}),
      },
      updates: {
        ...next.updates,
        // 原生层只负责启用 expo-updates + 本地已下载 bundle 选择;不在 JS 启动前联网。
        // endpoint 闸门完成后 useStartupOtaGate 会运行时覆写真实 /manifest URL 并手动检查。
        url: SELFHOST_UPDATES_PLACEHOLDER_URL,
        checkAutomatically: 'NEVER',
        // Expo 的运行时 URL override API 要求此开关。只在自建变体开启,EAS/TestFlight
        // 继续保留默认 anti-bricking 策略。此原生配置变化需要最后一次冷更。
        disableAntiBrickingMeasures: true,
      },
    };
  }

  return next;
};
