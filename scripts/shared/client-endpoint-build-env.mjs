/**
 * 客户端构建期端点自举配置。
 *
 * 运行期业务端点的唯一事实源是 region 对应的 config/endpoint*.json；构建期只需
 * 烘焙 region 与“去哪里拉这份清单”的 CDN 基址。该基址直接取同一份仓内正本的
 * cdnBaseUrl，避免再维护一份 production-endpoints.json 镜像。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLIENT_BUILD_REGIONS = Object.freeze(['cn', 'global', 'dev']);

/** 规范化并校验构建 region。 */
export function resolveClientBuildRegion(authRegion) {
  const region = authRegion?.trim() || 'global';
  if (!CLIENT_BUILD_REGIONS.includes(region)) {
    throw new Error(`Invalid Cindy auth region: ${region}; expected cn, global or dev`);
  }
  return region;
}

/** 返回 region 对应的仓内端点清单正本路径。 */
export function clientEndpointManifestPath(authRegion, repoRoot = REPO_ROOT) {
  const region = resolveClientBuildRegion(authRegion);
  const fileByRegion = { cn: 'endpoint.json', global: 'endpoint.global.json', dev: 'endpoint.dev.json' };
  return path.join(repoRoot, 'config', fileByRegion[region]);
}

/**
 * 从仓内端点清单读取不可自引用覆盖的 CDN 自举基址。
 * @param {{ authRegion?: string, repoRoot?: string }} [options]
 */
export function loadEndpointManifestBaseUrl(options = {}) {
  const region = resolveClientBuildRegion(options.authRegion);
  const manifestPath = clientEndpointManifestPath(region, options.repoRoot);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(`缺少 ${region} 客户端端点清单: ${manifestPath}`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`客户端端点清单不是合法 JSON: ${manifestPath}`);
    }
    throw error;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`客户端端点清单必须是 JSON object: ${manifestPath}`);
  }
  if (!Number.isInteger(parsed.schemaVersion) || parsed.schemaVersion < 1) {
    throw new Error(`客户端端点清单 schemaVersion 非法: ${manifestPath}`);
  }

  const raw = parsed.cdnBaseUrl;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`客户端端点清单缺少非空字段 cdnBaseUrl: ${manifestPath}`);
  }
  const normalized = raw.trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`客户端端点清单字段 cdnBaseUrl 不是合法绝对 URL: ${manifestPath}`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`客户端端点清单字段 cdnBaseUrl 必须是无凭据 HTTPS URL: ${manifestPath}`);
  }
  return normalized;
}

/** Desktop 正式构建所需的公开 Vite 变量。 */
export function desktopClientBuildEnv({ allowEnvOverride = true, authRegion, repoRoot } = {}) {
  const region = resolveClientBuildRegion(
    authRegion ||
      process.env.CINDY_AUTH_REGION?.trim() ||
      (allowEnvOverride ? process.env.VITE_CINDY_AUTH_REGION?.trim() : ''),
  );
  const override = allowEnvOverride
    ? process.env.VITE_ENDPOINT_MANIFEST_BASE_URL?.trim()
    : '';
  return {
    VITE_CINDY_AUTH_REGION: region,
    VITE_ENDPOINT_MANIFEST_BASE_URL:
      override || loadEndpointManifestBaseUrl({ authRegion: region, repoRoot }),
  };
}

/** Mobile/EAS 构建所需的公开变量。 */
export function mobileClientBuildEnv({ authRegion, repoRoot } = {}) {
  const region = resolveClientBuildRegion(
    authRegion || process.env.EXPO_PUBLIC_CINDY_AUTH_REGION?.trim(),
  );
  return {
    EXPO_PUBLIC_CINDY_AUTH_REGION: region,
    EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL: loadEndpointManifestBaseUrl({
      authRegion: region,
      repoRoot,
    }),
  };
}
