#!/usr/bin/env node
/**
 * 生成 / 校验 docs/design-rules/design-inventory.md 的 GENERATED 区块。
 *
 * 台账是混合文件：机器事实与人工决策物理分开（治理合同 §2.1）。
 * 本脚本只重写 BEGIN/END GENERATED: surface-facts；人工区原样保留。
 * --check 只比对 GENERATED 区块，并报告孤儿人工行（只报告不删除）。
 *
 * 用法:
 *   node scripts/design-inventory.mjs          # 生成（root: pnpm design:inventory）
 *   node scripts/design-inventory.mjs --check  # 只校验 GENERATED 是否最新，不写盘
 *   CINDY_INVENTORY_DOC=<path> 覆盖台账写读路径（测试用：指向临时目录拷贝，
 *   不改真实 docs/design-rules/design-inventory.md）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INVENTORY_REL_PATH,
  ROUTER_REL_PATH,
  buildGeneratedSurfaces,
  catalogSurfaces,
  compareGenerated,
  defaultHumanSeed,
  ensureHumanRows,
  findOrphanHumanIds,
  formatOrphanReport,
  listRedirectExclusions,
  mergeInventoryDocument,
  normalizeDocEol,
  productionRouterCoverage,
  renderGeneratedBlock,
  splitInventoryDocument,
} from './shared/design-inventory.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// CINDY_INVENTORY_DOC 只重定向台账读写：统计仍扫真实源码（这正是被测行为），
// 但 generate 不再改写仓库内受版本控制的文件——测试跨日运行不产生脏工作区。
const DOC_PATH =
  process.env.CINDY_INVENTORY_DOC ??
  path.join(repoRoot, ...INVENTORY_REL_PATH.split('/'));
const ROUTER_PATH = path.join(repoRoot, ...ROUTER_REL_PATH.split('/'));

/**
 * 生成模式用当天日期快照计数事实；--check 用文件里已有日期重渲染，避免跨日假红。
 * 日期只在生成时求值（不进 shared 纯函数），保证同一天内连续两次生成字节一致。
 */
const GENERATE_COMMAND = 'pnpm design:inventory';

const checkOnly = process.argv.includes('--check');

function readExisting() {
  return fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, 'utf8') : '';
}

function snapshotDateFromExisting(existing) {
  const match = /计数快照日期：(\d{4}-\d{2}-\d{2})/.exec(existing);
  return match?.[1] ?? new Date().toISOString().slice(0, 10);
}

function buildGenerated(existing) {
  const routerSource = fs.readFileSync(ROUTER_PATH, 'utf8');
  const catalog = catalogSurfaces();
  const { surfaces, missingStyleRoots } = buildGeneratedSurfaces(repoRoot, { catalog });
  const routerCoverage = productionRouterCoverage(routerSource, catalog);
  const redirects = listRedirectExclusions(routerSource);
  const snapshotDate = checkOnly ? snapshotDateFromExisting(existing) : new Date().toISOString().slice(0, 10);
  const generated = renderGeneratedBlock(surfaces, {
    snapshotDate,
    generateCommand: GENERATE_COMMAND,
    routerCoverage,
    redirects,
  });
  return { surfaces, routerCoverage, generated, missingStyleRoots };
}

const existing = readExisting();
const { surfaces, routerCoverage, generated, missingStyleRoots } = buildGenerated(existing);
const orphanIds = findOrphanHumanIds(
  splitInventoryDocument(existing).suffix,
  surfaces.map((surface) => surface.id),
);
const orphanReport = formatOrphanReport(orphanIds);

if (routerCoverage.missing.length > 0) {
  const missing = routerCoverage.missing
    .map((row) => `  - ${row.path} (${row.component})`)
    .join('\n');
  console.error(
    '[design-inventory] ❌ router.tsx 有生产路由未映射到 surface：\n' +
      missing +
      '\n  请在 scripts/shared/design-inventory.mjs 的 catalogSurfaces() 补 routerPaths。',
  );
  process.exit(1);
}

if (routerCoverage.stale.length > 0) {
  const stale = routerCoverage.stale.map((path) => `  - ${path}`).join('\n');
  console.error(
    '[design-inventory] ❌ catalog 里登记的路由已不在 router.tsx 生产路由中：\n' +
      stale +
      '\n  路由已删除或改名时，请同步清理 catalogSurfaces() 对应 surface 的 routerPaths。',
  );
  process.exit(1);
}

if (routerCoverage.componentMismatch.length > 0) {
  const mismatch = routerCoverage.componentMismatch
    .map(
      (row) =>
        `  - ${row.path}: router 实际 ${row.actualComponent}, catalog 登记 ${row.catalogComponents.join(' / ')}（surface ${row.surfaceId}）`,
    )
    .join('\n');
  console.error(
    '[design-inventory] ❌ 路由入口组件与 catalog 不一致：\n' +
      mismatch +
      '\n  换组件时请同步更新 catalogSurfaces() 对应 surface 的 routeComponents / reachableComponents / productionEntry / styleRoots。',
  );
  process.exit(1);
}

if (missingStyleRoots.length > 0) {
  const missing = missingStyleRoots.map((root) => `  - ${root}`).join('\n');
  console.error(
    '[design-inventory] ❌ catalog 里的 styleRoot 路径不存在：\n' +
      missing +
      '\n  源码移动或改名时请同步更新 catalogSurfaces() 对应 surface 的 styleRoots，统计不会静默归零。',
  );
  process.exit(1);
}

if (checkOnly) {
  const comparison = compareGenerated(existing, generated);
  if (!comparison.equal) {
    console.error(
      '[design-inventory] ❌ GENERATED 区块与源码不同步。\n' +
        '  运行 pnpm design:inventory 重新生成。',
    );
    if (orphanReport) console.error(orphanReport);
    process.exit(1);
  }
  if (orphanReport) {
    console.error(orphanReport);
    process.exit(1);
  }
  console.log(
    `[design-inventory] ✅ GENERATED 区块最新（${surfaces.length} 个 surface）`,
  );
  process.exit(0);
}

let nextDoc = mergeInventoryDocument(existing, generated, {
  seedHuman: defaultHumanSeed(surfaces),
});
nextDoc = ensureHumanRows(nextDoc, surfaces);
fs.mkdirSync(path.dirname(DOC_PATH), { recursive: true });
fs.writeFileSync(DOC_PATH, nextDoc, 'utf8');
if (orphanReport) console.warn(orphanReport);
console.log(
  `[design-inventory] ✅ 已更新 ${INVENTORY_REL_PATH}` +
    `（${surfaces.length} 个 surface；人工区已保留）`,
);
