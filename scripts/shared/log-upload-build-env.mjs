/**
 * 客户端日志上报目标的**构建期**注入。
 *
 * 真值不进仓：唯一事实源是 `config/log-upload.json`（主仓 gitignore，打包机由
 * cindy-build-scripts 的 `sync-desktop-release-kit.sh` 拷回），仓内只有 `.example`。
 * 与 `config/endpoint.dev.json` / `apps/desktop/scripts/release-regions.json` 同款约定。
 *
 * 只烘焙**当前构建区域那一个**目标：cn 包里物理上不含 global 的 logstore 地址，反之亦然。
 * 埋点曾因 global 构建报进国内采集端导致国际项目缺失全部客户端数据——让另一区的地址根本不
 * 出现在包里，是比"运行时按 region 选"更强的隔离。
 *
 * ⚠️ **fail-closed 的位置从 typecheck 搬到了这里。** 值写在 TS 里时，
 * `Record<CindyRegion, …>` 让"新增区域忘了做选择"直接编译失败（需求 §4.4「必须被强制要求
 * 做出选择」）。值搬进 JSON 后那条保证没了，必须由本模块的硬校验替代：**除 dev 外的每个
 * 区域都是必填**，缺失或非法一律抛错让打包失败。不要把这里改成"缺失就返回空、静默关闭"
 * ——那样一次漏配就是发版后才发现的观测能力真空。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLIENT_BUILD_REGIONS, resolveClientBuildRegion } from './client-endpoint-build-env.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 注入给 main bundle 的变量名（main-only，不暴露到 renderer/preload）。 */
export const LOG_UPLOAD_TARGET_ENV = 'XDT_LOG_UPLOAD_TARGET';

/**
 * 允许缺省的区域。dev 是内部开发构建身份，不面向用户发行，缺省即该渠道功能整体关闭。
 * 其余区域（当前 cn / global，以及将来新增的任何发行区域）**自动成为必填**——这样新增
 * 区域时不需要有人记得来改这份名单。
 */
const OPTIONAL_REGIONS = new Set(['dev']);

/** 目标配置文件路径（真值；不存在时调用方按各自语义处理）。 */
export function logUploadConfigPath(repoRoot = REPO_ROOT) {
  return path.join(repoRoot, 'config', 'log-upload.json');
}

/** SLS 服务区域代号 → 接入域名。不含协议、不含 project 前缀。 */
export function slsEndpointHost(slsRegion) {
  return `${slsRegion}.log.aliyuncs.com`;
}

/** SLS project / logstore 命名：小写字母数字与连字符，首字符不能是连字符。 */
const SLS_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
/** 区域代号：小写字母数字与连字符（cn-shanghai / ap-southeast-1）。 */
const SLS_REGION_RE = /^[a-z0-9][a-z0-9-]*$/;

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`日志上报配置缺少非空字符串字段 ${label}`);
  }
  return value.trim();
}

/**
 * 校验并归一化单个区域的配置。
 *
 * 校验得比"非空"更严，因为配错的表现是**静默不上报**（请求发出去拿个 404，日志里一行 warn，
 * 没人会注意），不是编译失败。所以这里把能在构建期判死的形状全判掉。
 */
function normalizeRegionTarget(raw, region) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`日志上报配置的 ${region} 必须是 JSON object 或 null`);
  }
  const project = requireString(raw.project, `${region}.project`);
  const logstore = requireString(raw.logstore, `${region}.logstore`);
  const slsRegion = requireString(raw.slsRegion, `${region}.slsRegion`);

  if (!SLS_NAME_RE.test(project)) {
    throw new Error(`日志上报配置 ${region}.project 不是合法 SLS project 名: ${project}`);
  }
  if (!SLS_NAME_RE.test(logstore)) {
    throw new Error(`日志上报配置 ${region}.logstore 不是合法 SLS logstore 名: ${logstore}`);
  }
  // 「写成完整域名」这条排在通用格式校验**之前**:它是最可能犯的错(直接把接入域名粘进来),
  // 而 SLS_REGION_RE 也会拒掉它、只是报一句看不出所以然的「不是合法区域代号」。
  // 写成 'cn-shanghai.log.aliyuncs.com' 会被拼成 '<那一串>.log.aliyuncs.com',DNS 直接失败。
  if (slsRegion.includes('.')) {
    throw new Error(
      `日志上报配置 ${region}.slsRegion 只写区域代号(如 cn-shanghai),不要写完整域名: ${slsRegion}`,
    );
  }
  if (!SLS_REGION_RE.test(slsRegion)) {
    throw new Error(`日志上报配置 ${region}.slsRegion 不是合法区域代号: ${slsRegion}`);
  }
  return { region, project, logstore, endpointHost: slsEndpointHost(slsRegion) };
}

/**
 * 读取并全量校验配置文件。返回 `{ [region]: target | null }`。
 *
 * 全量校验（而不是只看当前构建区域）是有意的：跨区域隔离这条不变量只有同时看到两份配置才能
 * 验证，而打包一次只构建一个区域。任一区域配错都让打包失败，早于发布。
 */
/**
 * `allowMissing`：**文件缺失**（ENOENT）时不抛错，返回 `null`（= 全区域无目标 ⇒ 功能整体
 * 关闭）。给版本无关 / 开源打包用：默认 checkout 里 `config/log-upload.json` 是 gitignore 的、
 * 不存在,不该因此打不出包(2026-08-04 review P1)。注意**只对「缺失」放宽** —— 文件在但内容
 * 损坏 / 非法仍然硬失败(半截配置比没有更危险),发行(有版本)打包也仍然要求文件必须在。
 */
export function loadLogUploadTargets({ repoRoot = REPO_ROOT, configPath, allowMissing = false } = {}) {
  const file = configPath ?? logUploadConfigPath(repoRoot);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      if (allowMissing) return null;
      throw new Error(
        `缺少日志上报配置: ${file}\n` +
          '真值不进仓,唯一事实源在 cindy-build-scripts 仓根;打包机由 sync-desktop-release-kit.sh ' +
          '拷回。本地验证可从 config/log-upload.json.example 复制一份并填入测试 logstore。',
      );
    }
    if (error instanceof SyntaxError) {
      throw new Error(`日志上报配置不是合法 JSON: ${file}`);
    }
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`日志上报配置必须是 JSON object: ${file}`);
  }
  if (!Number.isInteger(parsed.schemaVersion) || parsed.schemaVersion < 1) {
    throw new Error(`日志上报配置 schemaVersion 非法: ${file}`);
  }

  const targets = {};
  for (const region of CLIENT_BUILD_REGIONS) {
    const target = normalizeRegionTarget(parsed[region], region);
    if (target === null && !OPTIONAL_REGIONS.has(region)) {
      throw new Error(
        `日志上报配置缺少必填区域 ${region}: ${file}\n` +
          '发行区域的上报目标缺失属发版事故(功能会静默关闭、发版后才发现观测真空),' +
          '因此这里硬失败。注意**缺 key 和显式写 null 都不接受**,两者都会走到这里——' +
          '想临时关掉某个发行区域的上报,只能把它加进本模块的 OPTIONAL_REGIONS 并在 PR 里' +
          '说明理由,不存在「在配置里写个 null 就静默关掉」这条路。',
      );
    }
    targets[region] = target;
  }

  assertRegionsIsolated(targets, file);
  return targets;
}

/**
 * 跨区域隔离：任意两个区域的 project 与 logstore 都必须互不相同。
 *
 * 有事故先例（global 构建报进国内采集端 → 国际项目缺失全部客户端数据）。两区共用同一个
 * logstore 时，后台再也分不清哪条记录来自哪个版本，且合规上等于把境外用户日志写进境内。
 */
function assertRegionsIsolated(targets, file) {
  const seen = new Map();
  for (const [region, target] of Object.entries(targets)) {
    if (!target) continue;
    for (const [field, value] of [
      ['project', target.project],
      ['logstore', target.logstore],
    ]) {
      const key = `${field}:${value}`;
      const owner = seen.get(key);
      if (owner && owner !== region) {
        throw new Error(
          `日志上报配置的 ${owner} 与 ${region} 共用同一个 ${field}(${value}): ${file}\n` +
            '跨区域必须完全隔离 —— 共用会让后台分不清记录来源,并把境外用户日志写进境内。',
        );
      }
      seen.set(key, region);
    }
  }
}

/**
 * Desktop 打包所需的 main-only 环境变量。
 *
 * 返回 `{ XDT_LOG_UPLOAD_TARGET: '<json>' }`；目标缺省（只可能是 dev）时值为空串，
 * 运行时据此判定"未配置 ⇒ 功能整体关闭"。
 *
 * 注入串里带 `region`，运行时会与烘焙的 `VITE_CINDY_AUTH_REGION` 交叉校验，不一致即视为
 * 未配置。这样"cn 包误带 global 目标"这类错配在运行时也拦得住，而不是只靠打包脚本正确。
 *
 * `allowMissing`（版本无关 / 开源打包传 true）：配置文件缺失时注入空串而不是抛错，让功能整体
 * 关闭。发行(有版本)打包传 false（默认），缺失即硬失败。
 */
export function desktopLogUploadBuildEnv({ authRegion, repoRoot, configPath, allowMissing = false } = {}) {
  const region = resolveClientBuildRegion(
    authRegion || process.env.CINDY_AUTH_REGION?.trim(),
  );
  const targets = loadLogUploadTargets({ repoRoot, configPath, allowMissing });
  // targets === null 只在 allowMissing 且文件缺失时发生 ⇒ 无目标,功能整体关闭。
  const target = targets?.[region] ?? null;
  return {
    [LOG_UPLOAD_TARGET_ENV]: target ? JSON.stringify(target) : '',
  };
}

export const __testing = { OPTIONAL_REGIONS, normalizeRegionTarget, assertRegionsIsolated };
