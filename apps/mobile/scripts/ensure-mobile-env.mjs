import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mobileClientBundleEnv } from '../../../scripts/shared/client-endpoint-build-env.mjs';

export const MOBILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 2026-07 端点清单重构后收缩:dev 业务端点初值来自仓内 config/endpoint.json
// (env.ts __DEV__ require;显式 EXPO_PUBLIC_* env 仍可覆写但不再是必填),
// .env 只需构建身份 + 清单自举基址(EXPO_PUBLIC_ENDPOINTS_CDN=1 测线上清单时用)。
export const REQUIRED_MOBILE_ENV_KEYS = [
  'EXPO_PUBLIC_CINDY_AUTH_REGION',
  'EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL',
  'EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL',
];

/**
 * @param {{
 *   mobileDir?: string,
 *   envPath?: string,
 *   easJsonPath?: string,
 *   envExamplePath?: string,
 *   endpointEnv?: Record<string, string>,
 *   authRegion?: 'cn' | 'global',
 * }} [options]
 */
export function ensureMobileEnv({
  mobileDir = MOBILE_DIR,
  envPath = resolve(mobileDir, '.env'),
  easJsonPath = resolve(mobileDir, 'eas.json'),
  envExamplePath = resolve(mobileDir, '.env.example'),
  endpointEnv,
  authRegion,
} = {}) {
  const easDefaults = readProductionEnv(easJsonPath);
  const exampleValues = existsSync(envExamplePath) ? readEnvFile(envExamplePath) : {};
  let content = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const created = !existsSync(envPath);
  const addedKeys = [];
  const needsClientBuildDefaults = REQUIRED_MOBILE_ENV_KEYS.some(
    (key) =>
      !hasPreservedEnvValue(content, key, exampleValues[key]) &&
      !String(easDefaults[key] ?? '').trim(),
  );
  const existingRegion = readEnvValue(content, 'EXPO_PUBLIC_CINDY_AUTH_REGION');
  const defaults = {
    ...easDefaults,
    ...(endpointEnv ??
      (authRegion || needsClientBuildDefaults
        ? mobileClientBundleEnv({
            authRegion:
              authRegion || existingRegion || easDefaults.EXPO_PUBLIC_CINDY_AUTH_REGION,
          })
        : {})),
  };

  for (const key of REQUIRED_MOBILE_ENV_KEYS) {
    // .env 已有用户真实值(非 example placeholder)时直接保留,不要求 defaults 提供该 key
    // (eas.json 只带少数 key,其余 base URL 在私有端点配置里;.env 齐备时不会读私有配置)。
    // 显式选择 region(authRegion)时例外:region 切换必须覆写既有值走 upsert 的
    // replaceExisting 路径,否则 --region=global 静默不生效(既有用例钉住此语义)。
    if (!authRegion && hasPreservedEnvValue(content, key, exampleValues[key])) continue;
    const value = defaults[key];
    if (!String(value ?? '').trim()) {
      if (hasPreservedEnvValue(content, key, exampleValues[key])) continue;
      throw new Error(`Missing ${key} in mobile env defaults or region endpoint manifest`);
    }
    const next = upsertEnvValue(content, key, value, exampleValues[key], Boolean(authRegion));
    if (next !== content) addedKeys.push(key);
    content = next;
  }

  if (created || addedKeys.length) {
    mkdirSync(dirname(envPath), { recursive: true });
    writeFileSync(envPath, content.endsWith('\n') ? content : `${content}\n`);
  }

  return { envPath, created, addedKeys };
}

export function formatMobileEnvStatus(result, rootDir = dirname(result.envPath)) {
  const envLabel = relative(rootDir, result.envPath) || result.envPath;
  if (result.created) return `==> Created mobile env: ${envLabel}`;
  if (result.addedKeys.length) return `==> Updated mobile env: ${envLabel} (${result.addedKeys.join(', ')})`;
  return `==> Checked mobile env: ${envLabel}`;
}

export function readProductionEnv(easJsonPath) {
  const easJson = JSON.parse(readFileSync(easJsonPath, 'utf8'));
  return resolveBuildProfile(easJson, 'production').env ?? {};
}

function upsertEnvValue(content, key, value, placeholderValue, replaceExisting = false) {
  const lines = content ? content.split(/\r?\n/) : [];
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  let found = false;

  const next = lines.map((line) => {
    if (!pattern.test(line)) return line;
    found = true;
    const current = normalizeEnvValue(line.slice(line.indexOf('=') + 1));
    return !replaceExisting && current && current !== placeholderValue ? line : `${key}=${value}`;
  });

  if (!found) next.push(`${key}=${value}`);
  return next.join('\n');
}

function readEnvValue(content, key) {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=(.*)$`, 'm');
  const match = content.match(pattern);
  return match ? normalizeEnvValue(match[1]) : '';
}

function hasPreservedEnvValue(content, key, placeholderValue) {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=(.*)$`, 'm');
  const match = content.match(pattern);
  if (!match) return false;
  const current = normalizeEnvValue(match[1]);
  return Boolean(current && current !== placeholderValue);
}

function readEnvFile(envPath) {
  const out = {};
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    out[line.slice(0, index).trim()] = normalizeEnvValue(line.slice(index + 1));
  }
  return out;
}

function normalizeEnvValue(value) {
  const trimmed = String(value ?? '').trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function resolveBuildProfile(easJson, profileName, seen = new Set()) {
  const profile = easJson?.build?.[profileName];
  if (!profile) throw new Error(`Missing EAS build profile: ${profileName}`);
  if (seen.has(profileName)) throw new Error(`Circular EAS profile extends: ${[...seen, profileName].join(' -> ')}`);
  if (!profile.extends) return clone(profile);
  const parent = resolveBuildProfile(easJson, profile.extends, new Set([...seen, profileName]));
  return deepMerge(parent, withoutKey(profile, 'extends'));
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return clone(override);
  const out = clone(base);
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : clone(value);
  }
  return out;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function withoutKey(object, key) {
  const copy = { ...object };
  delete copy[key];
  return copy;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
