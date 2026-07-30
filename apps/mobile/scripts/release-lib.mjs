// =============================================================================
// release-lib.mjs —— 纯构建脚本共用的参数解析 / git 闸门 / 公开 env 校验与展示
//
// 公开版说明:内部发布线(release-*.mjs:OTA 判定、OSS/CDN 上传、商店分发)不随
// 开源仓发布,原 release-lib 中的发布专用函数(computeFingerprint、版本基线拉取等)
// 也随之移除。本文件只保留 build-android.mjs / build-ios.mjs 这两个「本机纯构建」
// 脚本仍需要的通用工具,全部离线、零机密:
//   - parseArgs                  通用 CLI 参数解析(kebab-case 自动转 camelCase)
//   - assertProductionGitGate    main / clean / 与 origin/main 一致 三项闸门
//   - SELF_HOST_PUBLIC_ENV_KEYS  自建构建必须齐全的公开 EXPO_PUBLIC_ 键
//   - assertPublicEnv            构建 env 的公开键完整性 + variant 防呆校验
//   - formatBakedEnvLines        dry-run 计划里展示 baked 公开变量(过滤非公开键)
//
// ⚠️ ci-fingerprint.mjs 会被单文件复制到 RUNNER_TEMP 运行,不得 import 本文件
// (它自带 parseFingerprintArgs);同理本文件不 import 仓内其他模块,保持自包含。
// =============================================================================

import { spawnSync } from 'node:child_process';

/**
 * 解析 CLI 参数。支持 `--flag`、`--key value`、`--key=value`;裸词进 `_`;
 * kebab-case 键名转 camelCase(`--skip-git-gate` → `args.skipGitGate`)。
 * @param {string[]} argv
 * @returns {{ _: string[], [key: string]: string | boolean | string[] }}
 */
export function parseArgs(argv) {
  /** @type {{ _: string[]; [key: string]: string | boolean | string[] }} */
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (!arg.startsWith('--')) {
      args._.push(arg);
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
    const key = rawKey.replace(/-+([a-z0-9])/g, (_, ch) => ch.toUpperCase());
    if (inlineValue != null) {
      args[key] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    if (next != null && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

/** 默认 git 执行器(可注入替身供单测)。失败即抛错,stderr 带回原因。 */
function runGit(gitArgs, cwd) {
  const r = spawnSync('git', gitArgs, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${gitArgs.join(' ')} 失败: ${r.stderr?.trim() || r.error?.message || `exit ${r.status}`}`);
  }
  return r.stdout.trim();
}

/**
 * 生产构建 git 闸门:必须在 main 分支、工作区 clean、且 HEAD 与本地 origin/main
 * 引用一致(不做网络 fetch;要求构建前自行同步远端)。任何一项不满足即抛错。
 * 本地迭代绕过方式是脚本参数 --skip-git-gate,不在这里提供开关。
 * @param {{ cwd?: string, git?: (args: string[], cwd?: string) => string }} [options]
 */
export function assertProductionGitGate({ cwd = process.cwd(), git = runGit } = {}) {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (branch !== 'main') {
    throw new Error(`发布级构建必须在 main 分支(当前 ${branch});本地迭代请传 --skip-git-gate`);
  }
  const dirty = git(['status', '--porcelain'], cwd);
  if (dirty) {
    throw new Error('工作区不干净(git status --porcelain 非空);发布级构建要求 clean checkout,本地迭代请传 --skip-git-gate');
  }
  const head = git(['rev-parse', 'HEAD'], cwd);
  const originMain = git(['rev-parse', 'origin/main'], cwd);
  if (head !== originMain) {
    throw new Error(
      `HEAD(${head.slice(0, 7)})与本地 origin/main 引用(${originMain.slice(0, 7)})不一致;` +
        '请先 git fetch && 对齐远端后再构建,本地迭代请传 --skip-git-gate',
    );
  }
  return { branch, head };
}

/**
 * 自建纯构建必须齐全的公开构建变量:region 身份、本区/对端清单自举基址、
 * 自建门控标志。
 * 值全部来自仓内 config/endpoint*.json 与脚本字面量(见 build 脚本的 selfhostEnv)。
 */
export const SELF_HOST_PUBLIC_ENV_KEYS = Object.freeze([
  'EXPO_PUBLIC_CINDY_AUTH_REGION',
  'EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL',
  'EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL',
  'EXPO_PUBLIC_XDT_OTA_SELFHOST',
]);

/**
 * 校验构建 env:requiredKeys 必须逐个非空;variant 'production' 额外要求
 * EXPO_PUBLIC_APP_VARIANT 未设或为 'production'(app.config.js 会对 'beta' 改名 /
 * 改配置,混入生产构建会烤出错版包且事后难察觉)。
 * @param {Record<string, string | undefined>} env
 * @param {{ variant?: 'production', requiredKeys?: readonly string[] }} [options]
 */
export function assertPublicEnv(env, { variant, requiredKeys = [] } = {}) {
  const missing = requiredKeys.filter((key) => !String(env?.[key] ?? '').trim());
  if (missing.length > 0) {
    throw new Error(`构建 env 缺少必需公开变量:${missing.join(', ')}(应由构建脚本从仓内配置注入,不要手工 export)`);
  }
  if (variant === 'production') {
    const appVariant = String(env?.EXPO_PUBLIC_APP_VARIANT ?? '').trim();
    if (appVariant && appVariant !== 'production') {
      throw new Error(
        `EXPO_PUBLIC_APP_VARIANT=${appVariant} 与 production 构建冲突(beta 变体会改应用名/配置);请清理 shell / .env 残留后重试`,
      );
    }
  }
}

/**
 * 生成 dry-run 计划里展示 baked 变量的行。只展示 EXPO_PUBLIC_ 前缀键与 extraKeys
 * 显式点名的键——兜底防止调用方误把机密 env 混进日志(调用方本就应只传公开值)。
 * @param {Record<string, string>} bakedEnv
 * @param {{ extraKeys?: readonly string[] }} [options]
 * @returns {string[]}
 */
export function formatBakedEnvLines(bakedEnv, { extraKeys = [] } = {}) {
  const keys = Object.keys(bakedEnv ?? {}).filter(
    (key) => key.startsWith('EXPO_PUBLIC_') || extraKeys.includes(key),
  );
  return [
    'baked env(本脚本注入的公开构建变量,均为非机密值):',
    ...keys.map((key) => `  ${key}=${bakedEnv[key]}`),
  ];
}
