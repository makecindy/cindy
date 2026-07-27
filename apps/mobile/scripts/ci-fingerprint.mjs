#!/usr/bin/env node
// CI fingerprint 守卫:在同一 runner 上分别计算 base(main)与 PR 合并结果的原生
// fingerprint,回答"这个 PR 会不会改变 mobile runtime fingerprint"。
//
// ⚠️ 与发版脚本的关系(别混用):
// - release-lib 的 computeFingerprint 走 pinned eas-cli 的 fingerprint:generate,
//   其哈希才是发版判定(OTA_OK / COLD_BUILD_REQUIRED)的口径;eas-cli 需要登录态,
//   CI 里没有。
// - 本脚本直接用仓库内 @expo/fingerprint 计算,绝对哈希与 eas-cli 的**不可比**;
//   但 base / current 在同一环境、同一调用方式下对比,"变没变"的结论可靠。
//   发版时的最终判定仍以 `pnpm mobile:release:check` 为准。
//
// 计算语义 = production:剥离全部 EXPO_PUBLIC_*(app.config.js 只在
// EXPO_PUBLIC_APP_VARIANT==='beta' 时改 config),并依赖 fingerprint.config.cjs
// 剔除 beta-* EAS profiles —— 与红线"production fingerprint 与 main 基线一致"对齐。
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FINGERPRINT_PLATFORMS = ['ios', 'android'];
export const GUARD_COMMENT_MARKER = '<!-- mobile-fingerprint-guard -->';
// 机器可读结论(第二行隐藏注释):review 侧的冷更审查门读这一行判「本 PR 是否触发冷更」,
// 不靠标题文案匹配。改文案可以,这一行的格式不能动 —— 门会因此漏判(见
// docs/dev-rules/mobile-development.md「冷更边界」)。第一行仍是 sticky comment 的定位 marker。
export const guardChangedMarker = (changed) => `<!-- fingerprint-changed: ${changed ? 'true' : 'false'} -->`;

/**
 * 解析本脚本的 CLI 参数。
 *
 * fingerprint guard 会把本文件单独复制到 RUNNER_TEMP 后再切换 base checkout，
 * 因此这里必须保持自包含，不能为了通用参数解析而导入 release-lib 及其依赖树。
 */
export function parseFingerprintArgs(argv) {
  /** @type {{ _: string[]; [key: string]: string | boolean | string[] }} */
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (!arg.startsWith('--')) {
      args._.push(arg);
      continue;
    }
    const [key, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
    if (inlineValue != null) {
      args[key] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

/**
 * 从 mobile 项目目录解析 @expo/fingerprint 的 CLI 入口与版本。
 * 用 createRequire 沿 node 解析链查找(hoisted node-linker 下实际落在仓库根 node_modules),
 * 保证 base / current 各自用自己 checkout 里解析到的版本计算。
 */
export function resolveFingerprintCli(projectDir) {
  const projectRequire = createRequire(join(resolve(projectDir), 'package.json'));
  const pkgPath = projectRequire.resolve('@expo/fingerprint/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const binRelative = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.fingerprint;
  if (!binRelative) throw new Error('@expo/fingerprint package.json has no fingerprint bin');
  return { binPath: join(dirname(pkgPath), binRelative), version: pkg.version };
}

/** 构造 fingerprint 计算用 env:剥离全部 EXPO_PUBLIC_*,确保 production 语义。 */
export function buildFingerprintEnv(baseEnv = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (key.startsWith('EXPO_PUBLIC_')) continue;
    env[key] = value;
  }
  return env;
}

/** 解析 fingerprint:generate 的 stdout(整段 JSON,含全部 sources),只取 hash。 */
export function parseFingerprintCliOutput(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('@expo/fingerprint output is not valid JSON');
  }
  const hash = parsed?.hash;
  if (typeof hash !== 'string' || !hash) {
    throw new Error('@expo/fingerprint output has no hash');
  }
  return hash;
}

/** 对单个平台跑一次 fingerprint:generate。输出含全部 sources(>1MB),必须调大 maxBuffer。 */
function runFingerprintCli({ binPath, projectDir, platform }) {
  const result = spawnSync(process.execPath, [binPath, 'fingerprint:generate', '--platform', platform], {
    cwd: resolve(projectDir),
    env: buildFingerprintEnv(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`fingerprint:generate --platform ${platform} failed: ${result.stderr || result.error?.message || `exit ${result.status}`}`);
  }
  return parseFingerprintCliOutput(result.stdout);
}

/** 计算一份 fingerprint 报告:{ toolVersion, platforms: { ios: hash, android: hash } }。 */
export function computeFingerprintReport(projectDir, { platforms = FINGERPRINT_PLATFORMS, run = runFingerprintCli } = {}) {
  const { binPath, version } = resolveFingerprintCli(projectDir);
  const report = { toolVersion: version, platforms: {} };
  for (const platform of platforms) {
    report.platforms[platform] = run({ binPath, projectDir, platform });
  }
  return report;
}

/**
 * 对比 base / current 两份报告。
 * @returns {{ changed: boolean, toolVersionChanged: boolean, baseToolVersion: string,
 *   currentToolVersion: string, rows: Array<{ platform: string, baseHash: string|null,
 *   currentHash: string|null, changed: boolean }> }}
 */
export function compareFingerprintReports(base, current) {
  const platforms = [...new Set([...Object.keys(base.platforms ?? {}), ...Object.keys(current.platforms ?? {})])];
  const rows = platforms.map((platform) => {
    const baseHash = base.platforms?.[platform] ?? null;
    const currentHash = current.platforms?.[platform] ?? null;
    return { platform, baseHash, currentHash, changed: baseHash !== currentHash };
  });
  return {
    changed: rows.some((row) => row.changed),
    toolVersionChanged: base.toolVersion !== current.toolVersion,
    baseToolVersion: base.toolVersion ?? 'unknown',
    currentToolVersion: current.toolVersion ?? 'unknown',
    rows,
  };
}

/** 渲染 PR sticky comment 的 markdown 正文(含 marker,changed / unchanged 两种形态)。 */
export function renderGuardComment(comparison) {
  const lines = [GUARD_COMMENT_MARKER, guardChangedMarker(comparison.changed)];
  if (comparison.changed) {
    lines.push('### ⚠️ 本 PR 会改变 mobile 原生 runtime fingerprint');
    lines.push('');
    lines.push('| Platform | base(main) | 本 PR 合并后 | 结果 |');
    lines.push('| --- | --- | --- | --- |');
    for (const row of comparison.rows) {
      const status = row.changed ? '⚠️ 变化' : '不变';
      lines.push(`| ${row.platform} | \`${row.baseHash ?? 'unknown'}\` | \`${row.currentHash ?? 'unknown'}\` | ${status} |`);
    }
    lines.push('');
    lines.push('**含义**:合并后 production / beta 的下一次发版对已安装包无法 OTA,必须冷更出包(`COLD_BUILD_REQUIRED`,iOS 需 bump `buildNumber` 并重走 TestFlight / 自建重签分发)。');
    lines.push('');
    lines.push('- 如果这是**有意的原生变更**(升原生依赖、改 plugin、动 `app.json` / `eas.json` production 段):没问题,但请在 PR Description 里写明,发版同学好安排冷更节奏。');
    lines.push('- 如果你**只想改 JS/UI**:请检查是否误碰了 fingerprint 输入,常见踩点:`apps/mobile/package.json` 的 `scripts` 字段、`app.json`、`eas.json` 非 beta 段、原生相关依赖版本。');
    lines.push('');
    lines.push('> 哈希由仓库内 `@expo/fingerprint` 在 CI 同一环境下对 base / 合并结果各算一次,只用于判断 runtime fingerprint 是否变化。');
  } else {
    lines.push('### ✅ 最新提交已不再改变 mobile runtime fingerprint');
    lines.push('');
    lines.push('当前合并结果与 base(main)的原生 fingerprint 一致,下一次发版可正常 OTA(以 `pnpm mobile:release:check` 为准)。');
  }
  if (comparison.toolVersionChanged) {
    lines.push('');
    lines.push(`> 注意:本 PR 同时改变了 \`@expo/fingerprint\` 版本(${comparison.baseToolVersion} → ${comparison.currentToolVersion}),fingerprint 变化可能部分来自算法差异,属预期。`);
  }
  return lines.join('\n');
}

/** 把多行内容写进 GITHUB_OUTPUT(heredoc 语法)。 */
function appendGithubOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const delimiter = `__XDT_${name.toUpperCase()}_EOF__`;
  appendFileSync(outputPath, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

function commandCompute(args) {
  const projectDir = args.project ? String(args.project) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const outputPath = args.output ? String(args.output) : null;
  if (!outputPath) throw new Error('compute requires --output <file>');
  const report = computeFingerprintReport(projectDir);
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`fingerprint report written: ${outputPath}`);
  for (const [platform, hash] of Object.entries(report.platforms)) {
    console.log(`  ${platform}: ${hash}`);
  }
}

function commandCompare(args) {
  if (!args.base || !args.current) throw new Error('compare requires --base <file> --current <file>');
  const base = JSON.parse(readFileSync(String(args.base), 'utf8'));
  const current = JSON.parse(readFileSync(String(args.current), 'utf8'));
  const comparison = compareFingerprintReports(base, current);
  const comment = renderGuardComment(comparison);

  console.log(comparison.changed ? 'fingerprint CHANGED' : 'fingerprint unchanged');
  for (const row of comparison.rows) {
    console.log(`  ${row.platform}: ${row.baseHash} -> ${row.currentHash}${row.changed ? '  (changed)' : ''}`);
  }

  appendGithubOutput('changed', String(comparison.changed));
  appendGithubOutput('comment_md', comment);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = comment
      .replace(`${GUARD_COMMENT_MARKER}\n`, '')
      .replace(`${guardChangedMarker(comparison.changed)}\n`, '');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
}

function main() {
  const args = parseFingerprintArgs(process.argv.slice(2));
  const command = args._[0];
  if (command === 'compute') return commandCompute(args);
  if (command === 'compare') return commandCompare(args);
  throw new Error('usage: ci-fingerprint.mjs <compute --output <file> [--project <dir>] | compare --base <file> --current <file>>');
}

// realpath 两边再比:argv[1] 可能经过 symlink(如 macOS /tmp -> /private/tmp),
// 而 import.meta.url 是 node 加载时解析过的真实路径,直接比会误判成"被 import"。
const isDirectRun = process.argv[1]
  && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
if (isDirectRun) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
