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
const DOC_PATH = path.join(repoRoot, ...INVENTORY_REL_PATH.split('/'));
const ROUTER_PATH = path.join(repoRoot, ...ROUTER_REL_PATH.split('/'));

/** 计数快照日期。写入 GENERATED 后即冻结；--check 用文件里已有日期重渲染，避免跨日假红。 */
const SNAPSHOT_DATE = '2026-08-30';
const GENERATE_COMMAND = 'pnpm design:inventory';

const checkOnly = process.argv.includes('--check');

function readExisting() {
  return fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, 'utf8') : '';
}

function snapshotDateFromExisting(existing) {
  const match = /计数快照日期：(\d{4}-\d{2}-\d{2})/.exec(existing);
  return match?.[1] ?? SNAPSHOT_DATE;
}

function buildGenerated(existing) {
  const routerSource = fs.readFileSync(ROUTER_PATH, 'utf8');
  const catalog = catalogSurfaces();
  const surfaces = buildGeneratedSurfaces(repoRoot, { catalog });
  const routerCoverage = productionRouterCoverage(routerSource, catalog);
  const redirects = listRedirectExclusions(routerSource);
  const snapshotDate = checkOnly ? snapshotDateFromExisting(existing) : SNAPSHOT_DATE;
  const generated = renderGeneratedBlock(surfaces, {
    snapshotDate,
    generateCommand: GENERATE_COMMAND,
    routerCoverage,
    redirects,
  });
  return { surfaces, routerCoverage, generated };
}

const existing = readExisting();
const { surfaces, routerCoverage, generated } = buildGenerated(existing);
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
