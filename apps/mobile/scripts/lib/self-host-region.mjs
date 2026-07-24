// =============================================================================
// self-host-region.mjs —— 自建线「地区分包」配置的唯一加载入口(cn / global)
//
// 自建冷更/热更脚本(release-{ios,android}-{local,ota,check}.mjs)通过 `--region cn|global`
// 选出本次出包的地区,所有随地区变化的**非机密**分包参数(bundleId / package /
// TapDB / Google 公开 client 配置、OSS 落点 bucket、非机密签名描述符)集中在打包机本地的
// scripts/self-host-regions.json 里(纯值,不进 git;缺失时报错指向 .example)。真机密
// (keystore 两个口令、OSS AK/SK)仍走 env,凭证不入仓。
// OTA 更新域名不属于构建/分包参数:由对应地区 endpoint.json 的 mobileUpdateBaseUrl 运行时下发。
//
// 设计对齐 scripts/shared/client-endpoint-build-env.mjs 的 region 解析:
//   - 缺文件 / 非法 JSON / 缺 region / 身份字段为空或 URL 非法 → 立即抛错,禁止回落默认值。
//   - oss.* 与 *Signing.* 的叶子值在“加载”时允许为空(dry-run 只需身份字段),
//     真正 --execute 用到时由签名 resolver / OSS 应用点各自强校验非空(与既有“签名零默认值、
//     构建时才强制解析”一致)。
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SELF_HOST_REGIONS_PATH = path.join(SCRIPTS_DIR, 'self-host-regions.json');
export const SELF_HOST_REGIONS_EXAMPLE_PATH = path.join(SCRIPTS_DIR, 'self-host-regions.json.example');

/**
 * 合法地区集合(与 desktop CindyRegion 同集合)。dev 为第三目标(2026-07-20):
 * 块结构必须存在,叶子允许留空(装载不炸,真发 dev 时由 resolveSelfHostRegion
 * 用时强校验)——保证现有 cn/global 打包机在 dev 未配置时零影响。
 */
export const SELF_HOST_REGIONS = Object.freeze(['cn', 'global', 'dev']);

/** 每个 region 必须“加载即非空”的身份字段(dry-run 也要用来打印计划 / 选 bundle)。 */
const REQUIRED_IDENTITY_FIELDS = Object.freeze([
  'iosBundleId',
  'iosAppStoreId',
  'androidPackage',
  'npkgExpectBundle',
]);
/** 必须存在(但叶子值允许 --execute 时才填)的子对象。 */
const REQUIRED_OSS_KEYS = Object.freeze(['cdnBaseUrl', 'bucket', 'prefix', 'ossRegion']);
const REQUIRED_TAPDB_KEYS = Object.freeze(['clientId', 'clientToken']);
const REQUIRED_GOOGLE_KEYS = Object.freeze(['webClientId', 'iosClientId', 'iosUrlScheme']);
const SELF_HOST_REGION_ENV_KEYS = Object.freeze([
  'EXPO_PUBLIC_TAPTAP_CLIENT_ID',
  'EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN',
  'EXPO_PUBLIC_TAPDB_CHANNEL',
  'EXPO_PUBLIC_TAPDB_REGION',
  'EXPO_PUBLIC_CINDY_GOOGLE_WEB_CLIENT_ID',
  'EXPO_PUBLIC_CINDY_GOOGLE_IOS_CLIENT_ID',
  'EXPO_PUBLIC_CINDY_GOOGLE_IOS_URL_SCHEME',
]);

/** 解析真文件路径;显式 env 覆盖仅供测试 / 特殊打包机。 */
export function resolveSelfHostRegionsPath(filePath = process.env.CINDY_SELF_HOST_REGIONS_FILE) {
  if (!filePath?.trim()) return SELF_HOST_REGIONS_PATH;
  return path.resolve(SCRIPTS_DIR, filePath.trim());
}

/**
 * 读取并校验打包机本地的 self-host-regions.json。返回冻结的 { cn, global }。
 * @param {{ filePath?: string, mode?: 'release' | 'local' }} [options]
 */
export function loadSelfHostRegions(options = {}) {
  const configPath = resolveSelfHostRegionsPath(options.filePath);
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(
        `缺少自建线地区配置: ${configPath}。请复制 ${SELF_HOST_REGIONS_EXAMPLE_PATH} 为 self-host-regions.json 并在打包机上填值(该文件已 gitignore)。`,
      );
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`自建线地区配置不是合法 JSON: ${configPath}`);
  }
  return validateSelfHostRegions(parsed, { source: configPath, mode: options.mode });
}

/**
 * 校验 { cn, global } 结构。mode 决定叶子值的严格程度:
 *  - 'release'(默认,自建发布线):身份字段、TapDB 公开配置与 global Google 公开配置
 *    严格非空——漏填 TapDB 会静默发出无统计的正式包,必须在装载时拦下。
 *  - 'local'(本地 Xcode / Simulator 构建):叶子值允许留空。选中 region 缺身份字段由
 *    app.config.js 构建时按需报错;TapDB 留空 = 运行时统计 no-op(mobileTapdb.ts),
 *    global.google 留空 = 跳过 Google 登录,外部开发者无需这些账号即可本地构建。
 * 两种 mode 下 oss/signing 叶子值都允许空(--execute 用时再校验)。
 * @param {unknown} value
 * @param {{ source?: string, mode?: 'release' | 'local' }} [options]
 */
export function validateSelfHostRegions(value, options = {}) {
  const source = options.source ?? 'self-host regions';
  const mode = options.mode ?? 'release';
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source} 必须是 JSON object`);
  }
  const result = {};
  for (const region of SELF_HOST_REGIONS) {
    const block = value[region];
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      throw new Error(`${source} 缺少 region 配置块: ${region}`);
    }
    if (block.authRegion !== region) {
      throw new Error(`${source} 的 ${region}.authRegion 必须等于 "${region}"`);
    }
    // dev 块允许身份留空(装载即校验会拖垮 cn/global 打包;发 dev 时用时强校验)。
    const requireFilled = region !== 'dev' && mode !== 'local';
    for (const key of REQUIRED_IDENTITY_FIELDS) {
      if (typeof block[key] !== 'string' || (requireFilled && !block[key].trim())) {
        throw new Error(`${source} 的 ${region}.${key} 必须是${requireFilled ? '非空' : ''}字符串`);
      }
    }
    if (block.iosAppStoreId.trim() && !/^\d+$/.test(block.iosAppStoreId.trim())) {
      throw new Error(`${source} 的 ${region}.iosAppStoreId 必须是纯数字 App Store ID`);
    }
    if (typeof block.androidStoreUrl !== 'string') {
      throw new Error(`${source} 的 ${region}.androidStoreUrl 必须是字符串(可留空,空时回退 OSS APK)`);
    }
    if (block.androidStoreUrl.trim()) {
      try {
        new URL(block.androidStoreUrl.trim());
      } catch {
        throw new Error(`${source} 的 ${region}.androidStoreUrl 必须是绝对 URL 或应用商店 deep link`);
      }
    }
    const tapdb = block.tapdb;
    if (!tapdb || typeof tapdb !== 'object' || Array.isArray(tapdb)) {
      throw new Error(`${source} 的 ${region}.tapdb 必须是 object`);
    }
    for (const key of REQUIRED_TAPDB_KEYS) {
      if (typeof tapdb[key] !== 'string' || (requireFilled && !tapdb[key].trim())) {
        throw new Error(`${source} 的 ${region}.tapdb.${key} 必须是${requireFilled ? '非空' : ''}字符串`);
      }
    }
    const google = block.google;
    if (region !== 'global') {
      // dev 行为语义归 cn 系:与 cn 同样禁止 google(Google 登录仅 global 线)。
      if (Object.hasOwn(block, 'google')) {
        throw new Error(`${source} 的 ${region} 不得配置 google;Google 登录仅允许 global 线`);
      }
    } else {
      if (!google || typeof google !== 'object' || Array.isArray(google)) {
        throw new Error(`${source} 的 global.google 必须是 object`);
      }
      // local 模式允许 google 整体留空(跳过 Google 登录);只要填了任意一个字段,
      // 三个字段与格式就全量强校验,防止部分填写被静默丢弃。
      const googleFilled = REQUIRED_GOOGLE_KEYS.some(
        (key) => typeof google[key] === 'string' && google[key].trim(),
      );
      for (const key of REQUIRED_GOOGLE_KEYS) {
        if (typeof google[key] !== 'string' || ((requireFilled || googleFilled) && !google[key].trim())) {
          throw new Error(`${source} 的 global.google.${key} 必须是非空字符串`);
        }
      }
      if (requireFilled || googleFilled) {
        const webClientId = google.webClientId.trim();
        const iosClientId = google.iosClientId.trim();
        const iosUrlScheme = google.iosUrlScheme.trim();
        const clientIdSuffix = '.apps.googleusercontent.com';
        if (!webClientId.endsWith(clientIdSuffix)) {
          throw new Error(`${source} 的 global.google.webClientId 必须是 Google OAuth client id`);
        }
        if (!iosClientId.endsWith(clientIdSuffix)) {
          throw new Error(`${source} 的 global.google.iosClientId 必须是 Google OAuth client id`);
        }
        const expectedScheme = `com.googleusercontent.apps.${iosClientId.slice(0, -clientIdSuffix.length)}`;
        if (iosUrlScheme !== expectedScheme) {
          throw new Error(
            `${source} 的 global.google.iosUrlScheme 必须由 iosClientId 反写为 ${expectedScheme}`,
          );
        }
      }
    }
    // oss 子对象必须存在且含全部键(叶子值允许空,--execute 应用 OSS 时再强校验非空)。
    const oss = block.oss;
    if (!oss || typeof oss !== 'object' || Array.isArray(oss)) {
      throw new Error(`${source} 的 ${region}.oss 必须是 object`);
    }
    for (const key of REQUIRED_OSS_KEYS) {
      if (typeof oss[key] !== 'string') {
        throw new Error(`${source} 的 ${region}.oss.${key} 必须是字符串(可留空,--execute 时才需填)`);
      }
    }
    // 签名子对象存在即可(叶子值由签名 resolver 在 --execute 时强校验)。
    for (const key of ['iosSigning', 'androidSigning']) {
      if (!block[key] || typeof block[key] !== 'object' || Array.isArray(block[key])) {
        throw new Error(`${source} 的 ${region}.${key} 必须是 object`);
      }
    }
    result[region] = Object.freeze({
      ...block,
      tapdb: Object.freeze({ ...tapdb }),
      ...(google ? { google: Object.freeze({ ...google }) } : {}),
      oss: Object.freeze({ ...oss }),
      iosSigning: Object.freeze({ ...block.iosSigning }),
      androidSigning: Object.freeze({ ...block.androidSigning }),
    });
  }
  return Object.freeze(result);
}

/**
 * 自建线的 TapDB / Google 配置来自 self-host-regions.json → Expo extra。主动清掉同名
 * EXPO_PUBLIC_* 环境变量,避免打包机 shell/.env 残留值被 Metro 再次内联进 bundle。
 * @param {Record<string, string | undefined>} env
 */
export function stripSelfHostRegionEnv(env) {
  for (const key of SELF_HOST_REGION_ENV_KEYS) delete env[key];
  return env;
}

/**
 * 从 parseArgs 的结果里解析 region,**必填、不 fallback**。
 * @param {{ region?: unknown }} args
 * @param {{ regions?: Record<string, unknown> }} [options] 测试可注入 regions 免文件 IO。
 */
export function resolveSelfHostRegion(args, options = {}) {
  const raw = args?.region;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(
      '自建线出包必须显式指定 --region cn|global|dev(不提供默认值);例:pnpm mobile:build:ios -- --region global',
    );
  }
  const region = raw.trim();
  if (!SELF_HOST_REGIONS.includes(region)) {
    throw new Error(`--region 只能是 ${SELF_HOST_REGIONS.join(' 或 ')},收到: ${region}`);
  }
  const regions = options.regions ?? loadSelfHostRegions();
  const block = regions[region];
  if (!block) throw new Error(`自建线地区配置缺少 region: ${region}`);
  // dev 块装载时允许留空,真的发 dev 渠道时在此强校验(fail closed,指明要填什么)。
  if (region === 'dev') {
    const missing = ['iosBundleId', 'androidPackage', 'npkgExpectBundle'].filter(
      (key) => !block[key]?.trim(),
    );
    if (missing.length > 0) {
      throw new Error(
        `dev 渠道尚未配置:请在 self-host-regions.json 的 dev 块填 ${missing.join(' / ')}` +
          '(建议身份用 com.xd.cindydev,与 desktop CindyDev 同一套命名)',
      );
    }
  }
  return block;
}

/**
 * selfhost 构建(EXPO_PUBLIC_XDT_OTA_SELFHOST=1 的 prebuild)在 app.config.js 装载
 * region 配置时硬校验的烘焙字段:TapDB 两字段全区域必填(防漏填统计静默发出无统计
 * 正式包),global 另需 google 三字段(Google 登录)。返回缺失字段名列表(空数组 =
 * 齐全),供纯构建脚本 dry-run 预告、--execute 在 prebuild 前 fail-fast;校验口径以
 * apps/mobile/app.config.js 的 loadRegionBuildConfig 为准,此处只查非空,格式校验
 * (google client id 后缀 / iosUrlScheme 反写)仍由 app.config.js 把关。
 */
export function missingSelfHostBakeFields(regionConfig) {
  const missing = [];
  const tapdb = regionConfig?.tapdb ?? {};
  for (const key of REQUIRED_TAPDB_KEYS) {
    if (!String(tapdb[key] ?? '').trim()) missing.push(`tapdb.${key}`);
  }
  if (regionConfig?.authRegion === 'global') {
    const google = regionConfig?.google ?? {};
    for (const key of REQUIRED_GOOGLE_KEYS) {
      if (!String(google[key] ?? '').trim()) missing.push(`google.${key}`);
    }
  }
  return missing;
}

/**
 * 判定 iOS 自建 canary 冷更的安装入口模式(显式配置优先):
 *   - iosAppStoreId 是纯数字(任何 region)→ App Store 模式,record 写商店网页 + deep link;
 *   - 为空且 region=dev → 企业重签模式,record 写 NPKG 企业重签后上传 OSS 的安装页 + itms-services 链接
 *     (dev 无上架商店,以企业重签 IPA 的 itms 链接作正式安装入口;客户端契约本就优先走 itmsUrl);
 *   - 为空且 region=cn/global → fail closed(正式线必须有商店入口,红线不放松;dev 例外仅限开发渠道)。
 * 返回 { mode: 'appstore', appStoreId } | { mode: 'enterprise', appStoreId: '' }。
 */
export function resolveIosInstallEntryMode(regionConfig) {
  const id = String(regionConfig?.iosAppStoreId ?? '').trim();
  if (/^\d+$/.test(id)) return { mode: 'appstore', appStoreId: id };
  const region = regionConfig?.authRegion ?? '?';
  if (region === 'dev') return { mode: 'enterprise', appStoreId: '' };
  throw new Error(
    `iOS 自建 canary 发布需要 ${region}.iosAppStoreId 为纯数字 App Store ID;` +
      'dev 渠道无商店入口时改用企业重签安装页,但 cn/global 正式线必须配置商店入口(否则客户端没有正常安装入口)',
  );
}

/**
 * 生成自建线发版命令,确保后续操作沿用当前地区,不回落到隐式默认值。
 * @param {'ios' | 'android'} platform
 * @param {'check' | 'local' | 'ota' | 'promote'} action
 * @param {string | { authRegion?: string }} region
 * @param {{ execute?: boolean; yes?: boolean }} [options]
 */
export function formatSelfHostReleaseCommand(platform, action, region, options = {}) {
  if (!['ios', 'android'].includes(platform)) throw new Error(`未知自建线平台: ${platform}`);
  if (!['check', 'local', 'ota', 'promote'].includes(action)) throw new Error(`未知自建线操作: ${action}`);
  const authRegion = typeof region === 'string' ? region : region?.authRegion;
  if (!SELF_HOST_REGIONS.includes(authRegion)) {
    throw new Error(`自建线命令 region 只能是 ${SELF_HOST_REGIONS.join(' 或 ')},收到: ${authRegion}`);
  }
  const execute = options.execute === true ? ' --execute' : '';
  const yes = options.yes === true ? ' --yes' : '';
  return `pnpm mobile:release:${platform}:${action} -- --region ${authRegion}${execute}${yes}`;
}

/** region 对应的 env 后缀(CN / GLOBAL),用于机密类 env 变量名。 */
export function regionEnvSuffix(regionConfig) {
  return String(regionConfig.authRegion).toUpperCase();
}

/**
 * 生成把 OSS 落点切到本 region bucket 所需的 process.env 覆盖(纯函数)。
 * - bucket / cdn / prefix / ossRegion 从 region.oss 取(非机密)。
 * - AK/SK 是机密、不入 JSON:优先读 region 后缀 env(XDT_OSS_ACCESS_KEY_ID_<SUFFIX> / ..._SECRET_<SUFFIX>),
 *   有值才覆盖 oss.mjs getAKSK 读取的 FP_DEV_OSS_ACCESS_KEY_ID/SECRET;缺省则不覆盖(走现有 FP_DEV_*,
 *   适配“同账号两 bucket”一套 AK/SK)。
 * 调用方 Object.assign(process.env, ...) 后再 refreshOssConfig()。
 * @param {object} regionConfig
 * @param {Record<string, string | undefined>} [baseEnv]
 */
export function regionEnvOverrides(regionConfig, baseEnv = process.env) {
  const oss = regionConfig.oss ?? {};
  const overrides = {};
  // 只覆盖非空项:空值留给 resolveOssConfig 回落(仅 dry-run 未配置态会命中;--execute 由
  // assertRegionOssComplete 拦截,避免空值静默落到默认桶或 bucket/prefix 半配)。
  const setIf = (key, value) => {
    const v = String(value ?? '').trim();
    if (v) overrides[key] = v;
  };
  setIf('XDT_CDN_BASE_URL', oss.cdnBaseUrl);
  setIf('XDT_OSS_BUCKET', oss.bucket);
  setIf('XDT_OSS_PREFIX', oss.prefix);
  setIf('XDT_OSS_REGION', oss.ossRegion);
  const suffix = regionEnvSuffix(regionConfig);
  const ak = String(baseEnv[`XDT_OSS_ACCESS_KEY_ID_${suffix}`] ?? '').trim();
  const sk = String(baseEnv[`XDT_OSS_ACCESS_KEY_SECRET_${suffix}`] ?? '').trim();
  if (ak) overrides.FP_DEV_OSS_ACCESS_KEY_ID = ak;
  if (sk) overrides.FP_DEV_OSS_ACCESS_KEY_SECRET = sk;
  return overrides;
}

/**
 * --execute 前强校验本 region 的 oss.* 四项都已填(bucket / cdn / prefix / ossRegion 全非空),
 * 防止空值静默回落到默认桶、或 bucket 与 prefix 半配导致上传去错地方。dry-run 不调用。
 */
export function assertRegionOssComplete(regionConfig) {
  const oss = regionConfig.oss ?? {};
  const region = regionConfig.authRegion ?? '?';
  const missing = REQUIRED_OSS_KEYS.filter((k) => !String(oss[k] ?? '').trim());
  if (missing.length) {
    throw new Error(
      `self-host-regions.json 的 ${region}.oss 缺少非空字段:${missing.join(', ')}(--execute 需要完整 OSS 落点;dry-run 可留空)`,
    );
  }
}
