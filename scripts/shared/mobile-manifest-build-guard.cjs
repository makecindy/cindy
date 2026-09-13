/**
 * 校验最终传给 Metro 的区域清单地址。CommonJS 供 Metro config 与 ESM 构建
 * 脚本共用；预期值由调用方从仓内清单派生，不维护另一份端点表。
 */
const { createHash } = require('node:crypto');

const REGION_KEY = 'EXPO_PUBLIC_CINDY_AUTH_REGION';
const BASE_KEY = 'EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL';
const PEER_KEY = 'EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL';

function hashManifestEnv(env) {
  // Babel 内联原字节：即使 URL 规范化后等价，原值变化也必须换转换缓存。
  return createHash('sha256')
    .update(JSON.stringify([REGION_KEY, BASE_KEY, PEER_KEY].map((key) => env[key] ?? null)))
    .digest('hex');
}

/** 在 Metro / WorkerFarm 初始化前固定缓存身份；不保存或回显原始地址。 */
function createMobileManifestBuildSnapshot(env) {
  const region = env[REGION_KEY]?.trim();
  const hash = hashManifestEnv(env);
  return Object.freeze({
    cacheKey: `cindy-mobile-manifest-v1:${hash}`,
    assertUnchanged(nextEnv) {
      // 只有一直处于 CindyDev 的构建保留开发覆盖；切换成 dev 不能绕过正式区守卫。
      if (region === 'dev' && nextEnv[REGION_KEY]?.trim() === 'dev') return;
      if (hashManifestEnv(nextEnv) !== hash) {
        throw new Error('Mobile 构建区域或清单配置在初始化后发生变化：请重启 Metro 后重新打包');
      }
    },
  });
}

function normalizeManifestBaseUrl(value, key) {
  // 不附带原值或 URL parser 的异常，防止 runner 误填的凭据进入构建日志。
  const invalid = () => new Error(`Mobile 构建配置错误：${key} 必须是非空、无凭据的 HTTPS URL`);
  if (typeof value !== 'string' || !value.trim()) throw invalid();
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw invalid();
  }
  if (url.protocol !== 'https:' || url.username || url.password) throw invalid();
  return url.href.replace(/\/+$/, '');
}

/**
 * @param {Record<string, string | undefined>} env 最终 bundling 环境
 * @param {Record<string, string | undefined>} expectedEnv 仓内派生值
 */
function assertMobileManifestBuildEnv(env, expectedEnv) {
  const region = expectedEnv[REGION_KEY];
  if (!['cn', 'global', 'dev'].includes(region) || env[REGION_KEY]?.trim() !== region) {
    throw new Error(`Mobile 构建配置错误：${REGION_KEY} 与所选构建区域不一致`);
  }
  // CindyDev 是独立开发身份，保留既有开发端点覆盖契约。
  if (region === 'dev') return;

  const base = normalizeManifestBaseUrl(env[BASE_KEY], BASE_KEY);
  const peer = normalizeManifestBaseUrl(env[PEER_KEY], PEER_KEY);
  if (base === peer) {
    throw new Error(`Mobile 构建配置错误：${BASE_KEY} 与 ${PEER_KEY} 规范化后不能相同`);
  }
  for (const [key, value] of [[BASE_KEY, base], [PEER_KEY, peer]]) {
    if (value !== normalizeManifestBaseUrl(expectedEnv[key], key)) {
      throw new Error(
        `Mobile 构建配置错误：${key} 与所选区域的仓内清单不一致；请清理 shell / .env 残留，或修正 config/endpoint*.json`,
      );
    }
  }
}

module.exports = { assertMobileManifestBuildEnv, createMobileManifestBuildSnapshot };
