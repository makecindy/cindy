#!/usr/bin/env node
// scheduler-ci-guard.mjs — Phase 7 CI 守门
//
// 必须 ERROR + exit 1（绝不 WARN-only）。任一规则失败 pipeline 整体红。
//
// 跑：node scripts/scheduler-ci-guard.mjs
//
// 3 条 anti-pattern grep + 3 条 ESLint 反向依赖（lint 在 maker-scheduler /
// maker-core 的 eslint.config.mjs 里 no-restricted-imports 落地）。
//
// 守门规则与解耦边界以本脚本、maker-scheduler 和 maker-core 的 ESLint 配置为准。

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// fileURLToPath 而非 URL.pathname:后者是百分号编码的, 不是文件系统路径 ——
// 检出路径含空格或非 ASCII(中文用户名的 Windows 极常见)时推导出不存在的
// ROOT, collectSourceFiles 的 existsSync 守卫会让全部 grep 规则对 0 个文件
// 空转通过(fail-open)。仓库其余脚本均用 fileURLToPath。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function failure(rule, detail) {
  failures.push({ rule, detail });
  console.error(`❌  [${rule}] FAIL`);
  if (detail) console.error(detail);
}

function ok(rule, note) {
  console.log(`✅  [${rule}] PASS${note ? ' — ' + note : ''}`);
}

// ---------------------------------------------------------------------------
// 工具：递归收集源码文件
// ---------------------------------------------------------------------------

function collectSourceFiles(dir, exts = ['.ts', '.tsx', '.mjs', '.js']) {
  const out = [];
  if (!existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const p = stack.pop();
    let entries;
    try {
      entries = readdirSync(p, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.vite' || e.name === 'out') continue;
      const full = path.join(p, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (exts.some((x) => e.name.endsWith(x))) out.push(full);
    }
  }
  return out;
}

function grepAcross(files, pattern, options = {}) {
  const { excludeTypeOnly = false } = options;
  const hits = [];
  for (const f of files) {
    let lines;
    try {
      lines = readFileSync(f, 'utf8').split(/\r?\n/);
    } catch {
      continue;
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!pattern.test(line)) continue;
      if (excludeTypeOnly && /import\s+type\b/.test(line)) continue;
      hits.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Anti-pattern grep #1 — scheduler 包不能有 host 类
// ---------------------------------------------------------------------------

const schedSrc = collectSourceFiles(path.join(ROOT, 'packages/maker-scheduler/src'));
{
  const electronHits = grepAcross(schedSrc, /from\s+['"]electron['"]/);
  const drizzleHits = grepAcross(schedSrc, /from\s+['"]drizzle/);
  const makerCoreHits = grepAcross(schedSrc, /from\s+['"]@cindy\/maker-core['"]/, { excludeTypeOnly: true });
  const liziImHits = grepAcross(schedSrc, /from\s+['"]@cindy\/im['"]/);
  const liziMcpsHits = grepAcross(schedSrc, /from\s+['"]@cindy\/mcps['"]/);
  const allHits = [...electronHits, ...drizzleHits, ...makerCoreHits, ...liziImHits, ...liziMcpsHits];
  if (allHits.length) {
    failure(
      '#1 scheduler-pure',
      `packages/maker-scheduler/src 不能 import host 类（electron / drizzle / maker-core[非 type-only] / @cindy/im / @cindy/mcps）。\n命中：\n` +
        allHits.map((h) => '  ' + h).join('\n'),
    );
  } else {
    ok('#1 scheduler-pure', 'maker-scheduler/src 无 host 类 import');
  }
}

// ---------------------------------------------------------------------------
// Anti-pattern grep #3 — 没装新 cron npm 包
// ---------------------------------------------------------------------------

{
  const forbidden = ['node-cron', 'cron-parser', 'cronstrue'];
  const pkgJsons = [
    'package.json',
    'apps/desktop/package.json',
    'packages/maker-scheduler/package.json',
    'packages/maker-core/package.json',
    'packages/lizi-im/package.json',
    'packages/lizi-mcps/package.json',
  ];
  const hits = [];
  for (const rel of pkgJsons) {
    const full = path.join(ROOT, rel);
    if (!existsSync(full)) continue;
    let json;
    try {
      json = JSON.parse(readFileSync(full, 'utf8'));
    } catch {
      continue;
    }
    const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
    for (const section of sections) {
      const deps = json[section] || {};
      for (const dep of forbidden) {
        if (Object.prototype.hasOwnProperty.call(deps, dep)) {
          hits.push(`${rel} ${section}.${dep}`);
        }
      }
    }
  }
  if (hits.length) {
    failure(
      '#3 no-cron-lib',
      'RFC §3.1 / Phase 1 决策：cron 解析自实现，不允许引入第三方 cron 库。\n命中：\n' +
        hits.map((h) => '  ' + h).join('\n'),
    );
  } else {
    ok('#3 no-cron-lib', '所有 package.json 无 node-cron / cron-parser / cronstrue');
  }
}

// ---------------------------------------------------------------------------
// Anti-pattern grep #4 — scheduler renderer 色值白名单
//
// Phase 7 plan 原文用 WARN，本守门按用户硬规则升级到 ERROR + exit 1。
// 白名单来自 Phase 6 changelog L1601（docs/design-rules/cindy-design-system.md §2 / §9 全部允许色 + #3b82f6 焦点环）。
// ---------------------------------------------------------------------------

{
  const ALLOWED = new Set([
    '#000000',
    '#1f1f1e',
    '#262626',
    '#2c2c2a',
    '#3b82f6', // 焦点环唯一允许 chromatic（docs/design-rules/cindy-design-system.md §2）
    '#3c3c3a',
    '#404040',
    '#525252',
    '#737373',
    '#a3a3a3',
    '#c4c4c4',
    '#d4d4d4',
    '#d7d7d4',
    '#e5e5e5',
    '#f8f8f6',
    '#ffffff',
  ]);
  const schedulerUiDir = path.join(ROOT, 'apps/desktop/src/renderer/features/scheduler');
  const uiFiles = collectSourceFiles(schedulerUiDir, ['.ts', '.tsx', '.css']);
  const hexRe = /#[0-9a-fA-F]{3,8}\b/g;
  const violations = [];
  for (const f of uiFiles) {
    const text = readFileSync(f, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('// allow-color')) continue; // 显式豁免标记
      const matches = [...line.matchAll(hexRe)];
      if (matches.length === 0) continue;
      for (const match of matches) {
        const raw = match[0];
        const before = line.slice(0, match.index ?? 0);
        // 注释 / 测试名里的 PR 编号不是 CSS 色值，例如 `PR #103`、
        // `codex review #966`；保留 3 位短色扫描，但排除这两种明确语法。
        if (/(?:\bpr|\breview)\s*$/i.test(before)) continue;
        const lower = raw.toLowerCase();
        // 把 3 位短色 + #RRGGBBAA 都先归一到 6 位 #RRGGBB 比较；不在白名单的红
        let normalized = lower;
        if (lower.length === 4) {
          normalized = '#' + lower[1] + lower[1] + lower[2] + lower[2] + lower[3] + lower[3];
        } else if (lower.length === 9) {
          normalized = lower.slice(0, 7);
        }
        if (!ALLOWED.has(normalized)) {
          violations.push(`${path.relative(ROOT, f)}:${i + 1}: ${raw} (在 ${line.trim()})`);
        }
      }
    }
  }
  if (violations.length) {
    failure(
      '#4 color-whitelist',
      'apps/desktop/src/renderer/features/scheduler/ 出现 docs/design-rules/cindy-design-system.md §2 白名单外的色值。\n' +
        '允许色见 scripts/scheduler-ci-guard.mjs 的 ALLOWED 常量；' +
        '若是有意豁免（如 ConfirmDialog Danger 变体）请在该行末尾追加 `// allow-color` 注释。\n命中：\n' +
        violations.map((v) => '  ' + v).join('\n'),
    );
  } else {
    ok('#4 color-whitelist', `scheduler renderer 全部色值在 docs/design-rules/cindy-design-system.md 白名单（${ALLOWED.size} 色）`);
  }
}

// ---------------------------------------------------------------------------
// 反向依赖 grep —— maker-core 不能 import @cindy/maker-scheduler
// （ESLint 配置 packages/maker-core/eslint.config.mjs 的 no-restricted-imports
//   是开发者本地的 first-line 兜底；CI 用 grep 防止无关 pre-existing lint error
//   干扰守门信号）
// ---------------------------------------------------------------------------

{
  const coreSrc = collectSourceFiles(path.join(ROOT, 'packages/maker-core/src'));
  const hits = grepAcross(coreSrc, /from\s+['"]@cindy\/maker-scheduler(?:\/[^'"]*)?['"]/);
  if (hits.length) {
    failure(
      '#6 core-no-scheduler',
      'packages/maker-core 不能 import @cindy/maker-scheduler（反向依赖）。\n' +
        '调度在 host 层（apps/desktop/src/main/scheduler-host/）组装并消费 maker-core，maker-core 不感知调度。\n命中：\n' +
        hits.map((h) => '  ' + h).join('\n'),
    );
  } else {
    ok('#6 core-no-scheduler', 'maker-core 0 处 import @cindy/maker-scheduler');
  }
}

// ---------------------------------------------------------------------------
// maker-scheduler ESLint 跑通 —— 包本身 lint 干净；这一项不会被无关包污染
// ---------------------------------------------------------------------------

{
  const r = spawnSync('pnpm', ['--filter', '@cindy/maker-scheduler', 'lint'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: 'pipe',
  });
  if (r.status !== 0) {
    failure(
      'lint:@cindy/maker-scheduler',
      `maker-scheduler lint 失败 (exit ${r.status})\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`,
    );
  } else {
    ok('lint:@cindy/maker-scheduler', '@cindy/maker-scheduler eslint 通过（含 no-restricted-imports 反向依赖规则）');
  }
}

// ---------------------------------------------------------------------------
// 反向依赖 grep —— @cindy/mcps 不能 deep-import @cindy/maker-scheduler/engine/*
// （@cindy/mcps 没有独立 ESLint 配置，用 grep 兜底；同 RFC §6 self-check）
// ---------------------------------------------------------------------------

{
  const mcpsSrc = collectSourceFiles(path.join(ROOT, 'packages/lizi-mcps/src'));
  const hits = grepAcross(mcpsSrc, /from\s+['"]@cindy\/maker-scheduler\/engine[^'"]*['"]/);
  if (hits.length) {
    failure(
      '#5 mcps-no-engine-deepimport',
      'packages/lizi-mcps 不能深入 import @cindy/maker-scheduler/engine/*；只允许从顶层 `@cindy/maker-scheduler` 拿 type。\n命中：\n' +
        hits.map((h) => '  ' + h).join('\n'),
    );
  } else {
    ok('#5 mcps-no-engine-deepimport', '@cindy/mcps 全部 import 走顶层 @cindy/maker-scheduler');
  }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

console.log('');
if (failures.length) {
  console.error(`\n❌  scheduler-ci-guard FAILED (${failures.length} rule(s)):`);
  for (const f of failures) console.error(`  - ${f.rule}`);
  process.exit(1);
}
console.log('✅  scheduler-ci-guard PASSED — 所有 ' + 6 + ' 条守门规则通过');
