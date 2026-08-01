#!/usr/bin/env node
/**
 * 客户端端点单一来源门禁。
 *
 * 真实运行期地址只允许进入受 Git 管理的 config/endpoint*.json。本脚本验证关键
 * 消费源码与 EAS profile 不重新烘焙业务端点；飞书登录相关构建变量继续列入退役
 * 键，防止旧登录链复活。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EAS_ENDPOINT_ENV_KEYS = Object.freeze([
  'EXPO_PUBLIC_FEISHU_APP_ID',
  // 现役:本区与对端的两份清单自举基址,由发版脚本临时注入。
  'EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL',
  'EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL',
  // 以下为已退役键(2026-07 端点清单重构后不再注入)——保留在名单里防复活。
  'EXPO_PUBLIC_CINDY_AUTH_BASE_URL',
  'EXPO_PUBLIC_XDT_API_BASE_URL',
  'EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL',
  'EXPO_PUBLIC_XDT_MOBILE_VOICE_LITELLM_BASE_URL',
]);
const CONTROLLED_SOURCE_FILES = Object.freeze([
  'apps/desktop/src/shared/endpoints.ts',
  'apps/desktop/src/shared/hookControlIpc.ts',
  'apps/desktop/src/main/clientEndpointsService.ts',
  'apps/mobile/src/config/env.ts',
  'apps/mobile/src/config/clientEndpointStartup.ts',
  'apps/mobile/eas.json',
  'packages/embedding-client/src/client.ts',
  'packages/embedding-client/src/types.ts',
]);
const CONTROLLED_APP_CONFIG_FILES = Object.freeze([
  'scripts/restart-desktop-remote.mjs',
  'apps/mobile/eas.json',
  'apps/mobile/app.json',
  'apps/mobile/app.config.js',
]);
const ALLOWED_NON_PRODUCTION_ORIGINS = new Set([
  'http://localhost:3333',
  'http://localhost:3344',
  'http://localhost:3335',
  // model-access-server 本地开发兜底(服务端仓,端口 3339)
  'http://localhost:3339',
  // TapDB 埋点采集端(cn / global 各一),第三方固定协议地址而非本产品生产端点,
  // 不进入 config/endpoint*.json;与项目 appId 的区域配对见
  // renderer/analytics/tapdbClient.ts 的 TAPDB_PROJECT_BY_REGION。
  'https://e.tapdb.com',
  'https://e.tapdb.ap-sg.tapapis.com',
]);

/** 解析单个 EAS profile 的继承 env，供门禁测试复用。 */
export function resolveEasBuildProfileEnv(buildProfiles, profileName, stack = []) {
  const profile = buildProfiles?.[profileName];
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error(`EAS build profile 不存在或格式非法: ${profileName}`);
  }
  if (stack.includes(profileName)) {
    throw new Error(`EAS build profile extends 循环: ${[...stack, profileName].join(' -> ')}`);
  }
  const inherited = profile.extends
    ? resolveEasBuildProfileEnv(buildProfiles, profile.extends, [...stack, profileName])
    : {};
  const own = profile.env ?? {};
  if (!own || typeof own !== 'object' || Array.isArray(own)) {
    throw new Error(`EAS build profile ${profileName} 的 env 必须是 object`);
  }
  return { ...inherited, ...own };
}

function findAbsoluteOrigins(content) {
  return [
    ...content.matchAll(/(?:https?|wss?):\/\/[A-Za-z0-9.-]+(?::\d+)?/gi),
  ].map((match) => match[0].toLowerCase());
}

function main() {
  const errors = [];

  for (const file of CONTROLLED_SOURCE_FILES) {
    const content = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    for (const origin of findAbsoluteOrigins(content)) {
      if (!ALLOWED_NON_PRODUCTION_ORIGINS.has(origin)) {
        errors.push(`${file} 不允许包含生产 URL 字面量: ${origin}`);
      }
    }
  }
  for (const file of CONTROLLED_APP_CONFIG_FILES) {
    const content = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    if (/\bcli_[a-z0-9]{8,}\b/i.test(content)) {
      errors.push(`${file} 不允许包含飞书 App ID 字面量`);
    }
  }

  try {
    const eas = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'apps/mobile/eas.json'), 'utf8'));
    for (const profileName of Object.keys(eas.build ?? {})) {
      const env = resolveEasBuildProfileEnv(eas.build, profileName);
      for (const key of EAS_ENDPOINT_ENV_KEYS) {
        if (Object.hasOwn(env, key)) errors.push(`apps/mobile/eas.json build.${profileName} 不应提交 ${key}`);
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (errors.length) {
    console.error(`生产端点门禁失败 (${errors.length}):`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log('endpoint source guard passed');
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) main();
