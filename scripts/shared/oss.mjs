// =============================================================================
// 共享 OSS/CDN 发布原语 — 供自建发布脚本
// re-export)与 mobile 自托管 OTA 脚本(release-ios-*.mjs)共用。
//
// 这里只放与项目无关的纯原语:sha256 / gzip / ali-oss client / 带分片+重试的上传。
// 不含任何 manifest 业务逻辑(desktop 的 CDN manifest 拼装仍留在 ci/lib.mjs,
// mobile 的 Expo 协议 manifest 由其自身脚本负责)。
//
// ali-oss 是 heavy dependency,仅在 createOSSClient() 内惰性 require,避免 import
// 本模块就触发 node_modules 解析(script tests 等场景不需要 OSS client)。
// =============================================================================

import fs from 'node:fs';
import crypto from 'node:crypto';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';

// CDN / OSS 发布目标只接受显式环境变量：XDT_CDN_BASE_URL / XDT_OSS_BUCKET /
// XDT_OSS_PREFIX / XDT_OSS_REGION。客户端运行期端点与发布落点是两类配置，不能再
// 通过 production-endpoints.json 混装或互相兜底。
//
// 【存储类别】本文件及所有发布脚本只涉及 Public 类(匿名公开读:安装包/热更/
// agent 二进制/公告/模型目录/手机 OTA 与分发),后续拆桶时这里整体指向 public 桶。
// Private 类(skillhub 技能包、device-link 媒体)走 server 预签名,配置在
// apps/server 与 apps/device-link-server 的 OSS_PUBLIC_BUCKET / OSS_PRIVATE_BUCKET。
// 覆盖 bucket 时记得同步覆盖 CDN_BASE(CDN 域名要指向同一个 bucket),否则上传去了
// 新桶、release.json 里的链接却指向旧桶,装机端会 404。
//
// 部分 desktop 发布入口会先静态 import 本模块、再从 apps/desktop/.env 补环境变量。
// ESM 依赖会先于消费模块求值,所以配置不能永久冻结在首次 import 的时刻。
// 发布区域(国内 cn / 海外 global)各自一套独立发布目标:cn 沿用既有 XDT_* 变量名,
// global 用 XDT_GLOBAL_*。两套渠道(bucket / prefix / CDN 域名)不互相兜底,
// 少配一项就 fail closed,防止海外产物误发进国内渠道(反之亦然)。
export const RELEASE_REGIONS = Object.freeze(['cn', 'global', 'dev']);

export function resolveReleaseRegion(region) {
  const normalized = region?.trim() || 'cn';
  if (!RELEASE_REGIONS.includes(normalized)) {
    throw new Error(`Invalid release region: ${normalized}; expected cn, global or dev`);
  }
  return normalized;
}

const OSS_ENV_NAMES_BY_REGION = Object.freeze({
  cn: {
    cdnBase: 'XDT_CDN_BASE_URL',
    bucket: 'XDT_OSS_BUCKET',
    prefix: 'XDT_OSS_PREFIX',
    region: 'XDT_OSS_REGION',
  },
  global: {
    cdnBase: 'XDT_GLOBAL_CDN_BASE_URL',
    bucket: 'XDT_GLOBAL_OSS_BUCKET',
    prefix: 'XDT_GLOBAL_OSS_PREFIX',
    region: 'XDT_GLOBAL_OSS_REGION',
  },
  // dev 第三渠道(2026-07-20 预留):dev 服务器/bucket 就绪后填以下 env;在此之前 dev 渠道的发布会因缺配置 fail closed。
  // 前缀用 XDT_DEVCH_(dev channel),避免与既有 FP_DEV_* 凭证名混淆。
  dev: {
    cdnBase: 'XDT_DEVCH_CDN_BASE_URL',
    bucket: 'XDT_DEVCH_OSS_BUCKET',
    prefix: 'XDT_DEVCH_OSS_PREFIX',
    region: 'XDT_DEVCH_OSS_REGION',
  },
});

export function resolveOssConfig(releaseRegion = 'cn') {
  const names = OSS_ENV_NAMES_BY_REGION[resolveReleaseRegion(releaseRegion)];
  const required = (envName) => {
    const value = process.env[envName]?.trim();
    if (!value) throw new Error(`缺少 OSS 发布配置: 请设置 ${envName}`);
    return value;
  };
  return {
    cdnBase: required(names.cdnBase).replace(/\/+$/, ''),
    bucket: required(names.bucket),
    prefix: required(names.prefix),
    region: required(names.region),
  };
}

// 保留既有 named export 面,但改为 live binding；任何晚加载 .env 的入口必须在加载后
// 调 refreshOssConfig()。createOSSClient() 自身仍会在调用时重新解析,避免连错 bucket。
export let CDN_BASE;
export let OSS_BUCKET;
export let OSS_PREFIX;
export let OSS_REGION;

// 记住最近一次 refresh 用的区域:createOSSClient() 在调用时重新解析配置,
// 必须跟 live binding 指向同一渠道,不能悄悄回落到 cn。
let ACTIVE_RELEASE_REGION = 'cn';

export function refreshOssConfig(releaseRegion = 'cn') {
  const region = resolveReleaseRegion(releaseRegion);
  const config = resolveOssConfig(region);
  ACTIVE_RELEASE_REGION = region;
  CDN_BASE = config.cdnBase;
  OSS_BUCKET = config.bucket;
  OSS_PREFIX = config.prefix;
  OSS_REGION = config.region;
  return config;
}

// 工具库本身会被普通测试和只读脚本 import。配置不全时允许完成 import；真正的
// 发布入口调用 refreshOssConfig()/resolveOssConfig() 时再 fail closed。
const OSS_ENV_KEYS = [
  'XDT_CDN_BASE_URL',
  'XDT_OSS_BUCKET',
  'XDT_OSS_PREFIX',
  'XDT_OSS_REGION',
];
if (OSS_ENV_KEYS.every((key) => process.env[key]?.trim())) {
  refreshOssConfig();
}

// ── 哈希 / 压缩 ──────────────────────────────────────────────────────────────

export function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
}

export async function gzipFile(srcPath, destPath) {
  const src = fs.createReadStream(srcPath);
  const dest = fs.createWriteStream(destPath);
  const gzip = createGzip();
  await pipeline(src, gzip, dest);
}

// ── 阿里云 OSS ─────────────────────────────────────────────────────────────

// 凭证从环境变量读取,不进仓库。缺失时直接终止(release 脚本上下文,快速失败)。
// cn 沿用既有 FP_DEV_OSS_ACCESS_KEY_*;global 渠道 bucket 挂在不同阿里云账号时
// 可单独设 XDT_GLOBAL_OSS_ACCESS_KEY_*,不设则回落 FP_DEV_*(同账号跨区域场景)。
export function resolveOssCredentials(releaseRegion = 'cn') {
  const region = resolveReleaseRegion(releaseRegion);
  const regionKeyId = { global: 'XDT_GLOBAL_OSS_ACCESS_KEY_ID', dev: 'XDT_DEVCH_OSS_ACCESS_KEY_ID' }[region];
  const regionKeySecret = { global: 'XDT_GLOBAL_OSS_ACCESS_KEY_SECRET', dev: 'XDT_DEVCH_OSS_ACCESS_KEY_SECRET' }[region];
  const accessKeyId =
    (regionKeyId && process.env[regionKeyId]?.trim()) ||
    process.env.FP_DEV_OSS_ACCESS_KEY_ID;
  const accessKeySecret =
    (regionKeySecret && process.env[regionKeySecret]?.trim()) ||
    process.env.FP_DEV_OSS_ACCESS_KEY_SECRET;
  if (!accessKeyId || !accessKeySecret) {
    console.error('ERROR: FP_DEV_OSS_ACCESS_KEY_ID and FP_DEV_OSS_ACCESS_KEY_SECRET must be set');
    if (region === 'global') {
      console.error('       (global 渠道也可改设 XDT_GLOBAL_OSS_ACCESS_KEY_ID / XDT_GLOBAL_OSS_ACCESS_KEY_SECRET)');
    }
    process.exit(1);
  }
  return { accessKeyId, accessKeySecret };
}

export function createOSSClient(releaseRegion = ACTIVE_RELEASE_REGION) {
  const { accessKeyId, accessKeySecret } = resolveOssCredentials(releaseRegion);
  const { region, bucket } = resolveOssConfig(releaseRegion);
  const require = createRequire(import.meta.url);
  const OSS = require('ali-oss');
  return new OSS({
    region,
    accessKeyId,
    accessKeySecret,
    bucket,
    timeout: 600_000, // 10 min
  });
}

const MULTIPART_THRESHOLD = 10 * 1024 * 1024; // 10 MB

export async function uploadToOSS(client, ossKey, localPath, options = {}) {
  const MAX_RETRIES = 3;
  const size = fs.statSync(localPath).size;
  if (size > MULTIPART_THRESHOLD) {
    let lastPercent = 0;
    let checkpoint;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await client.multipartUpload(ossKey, localPath, {
          parallel: 4,
          partSize: 5 * 1024 * 1024,
          headers: options.headers,
          meta: options.meta, // 版本化二进制 immutable guard 靠 gz/binary sha256 meta,>10MB 也不能丢
          checkpoint,
          progress(p, _checkpoint) {
            checkpoint = _checkpoint;
            const pct = Math.floor(p * 100);
            if (pct >= lastPercent + 10) {
              lastPercent = pct;
              console.log(`      ${pct}%`);
            }
          },
        });
        break;
      } catch (err) {
        if (attempt === MAX_RETRIES) throw err;
        const delay = attempt * 3;
        console.warn(`      Upload failed (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`);
        console.warn(`      Retrying in ${delay}s (resuming from checkpoint)...`);
        await new Promise((r) => setTimeout(r, delay * 1000));
      }
    }
  } else {
    await client.put(ossKey, localPath, options);
  }
}

/** 删除一个可变 OSS 指针，供需要回滚“原来不存在的 key”的发布流程使用。 */
export async function deleteFromOSS(client, ossKey) {
  await client.delete(ossKey);
}
