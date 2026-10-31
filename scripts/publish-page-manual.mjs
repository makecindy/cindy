#!/usr/bin/env node
// =============================================================================
// publish-page-manual.mjs — 发布《Cindy MCP Apps 页面生成手册》到按内容寻址的 CDN 路径
//
// 业务后端里生成交互页面的模型需要读 PAGE-GENERATION.md。手册随客户端内置 Skill 发版，
// 这里把仓库当前的手册按 sha256 上传：
//   {cdnBaseUrl}/plugin-pages/manual/<sha256>.md
// 客户端用自己内置手册的 sha256 拼出同一地址（路径约定见
// apps/desktop/src/shared/pluginPageManual.mjs），所以手册改动后须在对应客户端上线前
// 发布到每个区域，并用 --check-cdn 核对。脚本读取当前检出里的手册，所以发布与 --check-cdn
// 都在本次发版所用的提交（发版分支或 tag 的检出）上执行，不要在最新 main 上执行。
// 与 publish-wallpaper-videos.mjs 一样手动执行：
//
//   node --env-file=<发布配置> scripts/publish-page-manual.mjs --region=cn|global|dev
//   node scripts/publish-page-manual.mjs --region=global --dry-run    只打印，不连 OSS、不联网
//   node scripts/publish-page-manual.mjs --region=global --check-cdn  只读核对线上文件
//
// 区域必须显式传。仓库里没有手册时跳过、退出码 0。同一 key 的内容不会变，远端已有
// 相同内容时不再上传；上传时仍由 OSS 拒绝覆盖。本脚本不加载 .env，凭证只在真正上传时
// 由 scripts/shared/oss.mjs 从进程环境变量读取。
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  OSS_ENV_NAMES_BY_REGION,
  RELEASE_REGIONS,
  createOSSClient,
  resolveOssConfig,
} from './shared/oss.mjs';
import {
  PLUGIN_PAGE_MANUAL_SKILL_PATH,
  pluginPageManualCdnPath,
} from '../apps/desktop/src/shared/pluginPageManual.mjs';

const USAGE = 'Usage: node scripts/publish-page-manual.mjs --region=cn|global|dev [--dry-run | --check-cdn]';
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MANUAL_REPO_PATH = `apps/desktop/resources/system-skills/${PLUGIN_PAGE_MANUAL_SKILL_PATH}`;
const CONTENT_TYPE = 'text/markdown; charset=utf-8';
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
// 只读模式未配置本区 CDN 变量时，读取客户端运行期同一份端点清单（同壁纸脚本）；dev 清单不入仓。
const ENDPOINT_FILE_BY_REGION = {
  global: 'endpoint.global.json',
  cn: 'endpoint.json',
  dev: 'endpoint.dev.json',
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const joinUrl = (base, relative) => `${base.replace(/\/+$/, '')}/${relative}`;

export function parsePublishPageManualArgs(argv) {
  let region;
  let dryRun = false;
  let checkCdn = false;
  for (const arg of argv) {
    if (arg.startsWith('--region=')) region = arg.slice('--region='.length);
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--check-cdn') checkCdn = true;
    // 拼错的模式参数不能静默落到真实上传。
    else throw new Error(`未知参数: ${arg}\n${USAGE}`);
  }
  if (!RELEASE_REGIONS.includes(region)) throw new Error(`必须显式指定 --region=cn|global|dev\n${USAGE}`);
  if (dryRun && checkCdn) throw new Error(`--dry-run 与 --check-cdn 不能同时使用\n${USAGE}`);
  return { region, mode: dryRun ? 'dry-run' : checkCdn ? 'check-cdn' : 'publish' };
}

function defaultDeps() {
  return {
    repoRoot: REPO_ROOT,
    env: process.env,
    log: (line) => console.log(line),
    resolveOssConfig,
    createClient: createOSSClient,
    fetch: (...args) => globalThis.fetch(...args),
  };
}

function readCdnBase(deps, region, { required }) {
  const envName = OSS_ENV_NAMES_BY_REGION[region].cdnBase;
  const fromEnv = deps.env[envName]?.trim();
  if (fromEnv) return fromEnv;
  try {
    const file = path.join(deps.repoRoot, 'config', ENDPOINT_FILE_BY_REGION[region]);
    const cdnBaseUrl = JSON.parse(fs.readFileSync(file, 'utf8')).cdnBaseUrl;
    if (typeof cdnBaseUrl === 'string' && cdnBaseUrl.trim()) return cdnBaseUrl.trim();
  } catch {
    // 端点清单缺失或不可读时按下面的规则处理。
  }
  if (!required) return `<${envName}>`;
  throw new Error(`找不到 ${region} 区 CDN 地址：请设置 ${envName}`);
}

async function remoteSha256(client, key) {
  let res;
  try {
    res = await client.head(key);
  } catch (err) {
    const status = err?.status ?? err?.res?.status;
    if (status === 404 || err?.code === 'NoSuchKey') return null;
    throw err;
  }
  const recorded = res?.meta?.sha256 ?? res?.res?.headers?.['x-oss-meta-sha256'];
  if (recorded) return recorded;
  // 没有 sha256 meta 的对象（例如手工上传）下载回来比对，不凭对象存在就认定内容正确。
  const { content } = await client.get(key);
  return sha256(content);
}

async function putImmutable(client, manual, log) {
  let existing = await remoteSha256(client, manual.key);
  if (existing === null) {
    try {
      await client.put(manual.key, manual.body, {
        headers: {
          'Content-Type': CONTENT_TYPE,
          'Cache-Control': IMMUTABLE_CACHE_CONTROL,
          // 由 OSS 原子拒绝覆盖：同一 key 只应有一种内容。
          'x-oss-forbid-overwrite': 'true',
        },
        meta: { sha256: manual.sha256 },
      });
      log(`已上传 ${manual.key}`);
      return;
    } catch (err) {
      const status = err?.status ?? err?.res?.status;
      if (status !== 409 && err?.code !== 'FileAlreadyExists') throw err;
      existing = await remoteSha256(client, manual.key);
    }
  }
  if (existing === null) throw new Error(`${manual.key} 写入冲突后远端对象又消失了，请重试`);
  if (existing !== manual.sha256) {
    throw new Error(`${manual.key} 远端内容的 sha256 为 ${existing}，与 key 不符；请人工检查该对象，脚本不覆盖`);
  }
  log(`远端已有相同内容，跳过上传 ${manual.key}`);
}

async function verifyCdn(fetchImpl, manual, log) {
  // 带一次性查询参数，绕开 CDN 可能缓存的发布前 404（同 releaseNotesService 的 ?t=）。
  const response = await fetchImpl(`${manual.url}?t=${Date.now()}`, {
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`CDN 读取失败 ${manual.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.equals(manual.body)) throw new Error(`CDN 内容与仓库手册不一致: ${manual.url}`);
  log(`已核对 ${manual.url}`);
}

export async function runPublishPageManual(argv, deps = defaultDeps()) {
  const { region, mode } = parsePublishPageManualArgs(argv);
  const manualFile = path.join(deps.repoRoot, MANUAL_REPO_PATH);
  if (!fs.existsSync(manualFile)) {
    deps.log(`跳过：仓库里没有 PAGE-GENERATION.md（${MANUAL_REPO_PATH}）`);
    return { status: 'skipped' };
  }
  const body = fs.readFileSync(manualFile);
  const digest = sha256(body);
  const relative = pluginPageManualCdnPath(digest);

  let prefix;
  let cdnBase;
  if (mode === 'publish') {
    ({ prefix, cdnBase } = deps.resolveOssConfig(region));
  } else {
    prefix = deps.env[OSS_ENV_NAMES_BY_REGION[region].prefix]?.trim() || `<${OSS_ENV_NAMES_BY_REGION[region].prefix}>`;
    cdnBase = readCdnBase(deps, region, { required: mode === 'check-cdn' });
  }
  const manual = { body, sha256: digest, key: joinUrl(prefix, relative), url: joinUrl(cdnBase, relative) };

  deps.log(`页面手册 ${region} sha256=${digest} size=${body.length}`);
  if (mode === 'dry-run') {
    deps.log(`[dry-run] ${manual.key} -> ${manual.url}`);
    return { status: 'dry-run', manual };
  }
  if (mode === 'publish') await putImmutable(deps.createClient(region), manual, deps.log);
  await verifyCdn(deps.fetch, manual, deps.log);
  return { status: mode === 'publish' ? 'published' : 'verified', manual };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPublishPageManual(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
