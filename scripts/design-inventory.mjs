#!/usr/bin/env node
/**
 * 生成 / 校验 docs/design-rules/design-inventory.md 的 GENERATED 区块。
 *
 * 台账是混合文件：登记事实与人工决策物理分开（治理合同 §2.1）。
 * 本脚本只重写 BEGIN/END GENERATED: surface-facts；人工区原样保留。
 * --check 校验登记结构与 GENERATED 区块，并报告孤儿人工行（只报告不删除）。
 * 可达组件、样式来源与 Token / 裸值统计不入库，由 --report 按需输出到 tmp/。
 *
 * 用法:
 *   node scripts/design-inventory.mjs           # 生成（root: pnpm design:inventory）
 *   node scripts/design-inventory.mjs --check   # 只校验，不写盘
 *   node scripts/design-inventory.mjs --report  # 统计报告（root: pnpm design:inventory:report）
 *   CINDY_INVENTORY_DOC=<path> 覆盖台账写读路径（测试用：指向临时目录拷贝，
 *   不改真实 docs/design-rules/design-inventory.md）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  mobileRouteCoverage,
  INVENTORY_REL_PATH,
  MAIN_ENTRY_REL_PATH,
  RENDERER_INDEX_REL_PATH,
  REPORT_REL_PATH,
  ROUTER_REL_PATH,
  buildGeneratedSurfaces,
  catalogSurfaces,
  compareGenerated,
  defaultHumanSeed,
  ensureHumanRows,
  extractRendererEntries,
  extractViewEntries,
  findOrphanHumanIds,
  formatOrphanReport,
  listRedirectExclusions,
  mergeInventoryDocument,
  normalizeDocEol,
  productionRouterCoverage,
  renderGeneratedBlock,
  renderStatsReport,
  splitInventoryDocument,
} from './shared/design-inventory.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// CINDY_INVENTORY_DOC 只重定向台账读写：统计仍扫真实源码（这正是被测行为），
// 但 generate 不再改写仓库内受版本控制的文件——测试跨日运行不产生脏工作区。
const DOC_PATH =
  process.env.CINDY_INVENTORY_DOC ??
  path.join(repoRoot, ...INVENTORY_REL_PATH.split('/'));
const ROUTER_PATH = path.join(repoRoot, ...ROUTER_REL_PATH.split('/'));
const MAIN_ENTRY_PATH = path.join(repoRoot, ...MAIN_ENTRY_REL_PATH.split('/'));
const RENDERER_INDEX_PATH = path.join(repoRoot, ...RENDERER_INDEX_REL_PATH.split('/'));
const REPORT_PATH = path.join(repoRoot, ...REPORT_REL_PATH.split('/'));

const checkOnly = process.argv.includes('--check');
const reportOnly = process.argv.includes('--report');

function readExisting() {
  return fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, 'utf8') : '';
}

function buildGenerated() {
  const routerSource = fs.readFileSync(ROUTER_PATH, 'utf8');
  const { surfaces, missingStyleRoots, danglingExtraStyleRoots } = buildGeneratedSurfaces(
    repoRoot,
    { catalog },
  );
  const routerCoverage = productionRouterCoverage(routerSource, catalog);
  const redirects = listRedirectExclusions(routerSource);
  const mobileCoverage = mobileRouteCoverage(repoRoot, catalog);
  if (mobileCoverage.missing.length || mobileCoverage.stale.length) {
    throw new Error('Mobile route inventory mismatch: ' + JSON.stringify(mobileCoverage));
  }
  const generated = renderGeneratedBlock(surfaces, {
    routerCoverage,
    redirects,
    mobileCoverage,
  });
  return { surfaces, routerCoverage, generated, missingStyleRoots, danglingExtraStyleRoots };
}

const catalog = catalogSurfaces();

const existing = readExisting();
const { surfaces, routerCoverage, generated, missingStyleRoots, danglingExtraStyleRoots } =
  buildGenerated();
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
      '\n  换组件时请同步更新 catalogSurfaces() 对应 surface 的 routeEntryComponents / reachableComponents / productionEntry / styleRoots。',
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

if (danglingExtraStyleRoots.length > 0) {
  const dangling = danglingExtraStyleRoots.map((ref) => `  - ${ref}`).join('\n');
  console.error(
    '[design-inventory] ❌ extraStyleRoots 引用了 catalog 里不存在的 surface ID：\n' +
      dangling +
      '\n  被引用 surface 改名/删除时请同步更新引用方，继承的样式事实不会静默丢失。',
  );
  process.exit(1);
}

// ?view= 分支覆盖守卫：main-entry.tsx 的 view 分支是非 router 生产入口，源码新增
// 分支而 catalog 未登记 surface 时，这里必须失败——否则权威台账会静默漏掉整个 surface。
// 此外还核对「view → 渲染组件」映射：view 名保留但分支改渲染别的组件（换浮窗
// 实现）时，catalog 的 productionEntry / reachableComponents / styleRoots 仍指向
// 旧组件，这里必须失败——与路由组件核对、模块图入口核对同构。
{
  const actualViews = extractViewEntries(fs.readFileSync(MAIN_ENTRY_PATH, 'utf8'));
  const coveredViews = new Map(
    catalog.flatMap((surface) =>
      Object.entries(surface.viewEntryComponents ?? {}).map(([view, component]) => [
        view,
        { component, surfaceId: surface.id },
      ]),
    ),
  );
  const lines = [];
  for (const [view, component] of actualViews) {
    const covered = coveredViews.get(view);
    if (!covered) {
      lines.push(`  - view 分支 ${view} 渲染 ${component}，但 catalog 未登记 viewEntryComponents`);
    } else if (covered.component !== component) {
      lines.push(
        `  - view 分支 ${view} 实际渲染 ${component}，catalog 登记 ${covered.component}（surface ${covered.surfaceId}）`,
      );
    }
  }
  for (const [view, covered] of coveredViews) {
    if (!actualViews.has(view)) {
      lines.push(`  - catalog 登记的 view 分支 ${view} 已不在 main-entry.tsx 中（surface ${covered.surfaceId}）`);
    }
  }
  if (lines.length > 0) {
    console.error(
      '[design-inventory] ❌ ?view= 分支映射不一致：\n' +
        lines.join('\n') +
        '\n  请同步更新 catalogSurfaces() 对应 surface 的 viewEntryComponents。',
    );
    process.exit(1);
  }
}

// renderer 模块图入口守卫：index.tsx 的查询参数决定加载哪个 entry 模块，与 view
// 分支同构——新增查询参数入口而 catalog 未登记 surface 时必须失败。此外还核对
// 「参数 → 入口模块」映射：参数保留但分支改加载别的入口（换窗口实现）时，
// catalog 的 productionEntry / styleRoots 仍指向旧窗口，这里必须失败。
{
  const actualEntries = extractRendererEntries(fs.readFileSync(RENDERER_INDEX_PATH, 'utf8'));
  const coveredEntries = new Map(
    catalog.flatMap((surface) =>
      Object.entries(surface.rendererEntryModules ?? {}).map(([param, module]) => [
        param,
        { module, surfaceId: surface.id },
      ]),
    ),
  );
  const lines = [];
  for (const [param, module] of actualEntries) {
    const covered = coveredEntries.get(param);
    if (!covered) {
      lines.push(`  - 参数 ${param} 加载 ${module}，但 catalog 未登记 rendererEntryModules`);
    } else if (covered.module !== module) {
      lines.push(
        `  - 参数 ${param} 实际加载 ${module}，catalog 登记 ${covered.module}（surface ${covered.surfaceId}）`,
      );
    }
  }
  for (const [param, covered] of coveredEntries) {
    if (!actualEntries.has(param)) {
      lines.push(`  - catalog 登记的参数 ${param} 已不在 renderer/index.tsx 中（surface ${covered.surfaceId}）`);
    }
  }
  if (lines.length > 0) {
    console.error(
      '[design-inventory] ❌ renderer 模块图入口映射不一致：\n' +
        lines.join('\n') +
        '\n  请同步更新 catalogSurfaces() 对应 surface 的 rendererEntryModules。',
    );
    process.exit(1);
  }
}

if (checkOnly) {
  const comparison = compareGenerated(existing, generated);
  if (!comparison.equal) {
    // 逐 surface 打印分歧行，跨平台排查（ICU/EOL/大小写）需要看到差异本身。
    const rowRe = /^\| `([^`]+)` \|/;
    const rowsOf = (text) => {
      const rows = new Map();
      for (const line of normalizeDocEol(text).split('\n')) {
        const m = rowRe.exec(line);
        if (m) rows.set(m[1], line);
      }
      return rows;
    };
    const currentRows = rowsOf(comparison.current);
    const nextRows = rowsOf(comparison.next);
    const diffLines = [];
    for (const id of new Set([...currentRows.keys(), ...nextRows.keys()])) {
      const currentLine = currentRows.get(id);
      const nextLine = nextRows.get(id);
      if (currentLine === nextLine) continue;
      diffLines.push(`  - ${id}:`);
      diffLines.push(`    文件: ${currentLine ?? '(缺行)'}`);
      diffLines.push(`    重算: ${nextLine ?? '(已移除)'}`);
    }
    console.error(
      '[design-inventory] ❌ GENERATED 区块与源码不同步。\n' +
        '  运行 pnpm design:inventory 重新生成。\n' +
        '  分歧行:\n' +
        (diffLines.length > 0 ? diffLines.join('\n') : '  (表格行一致,差异在其他段落)'),
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

if (reportOnly) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, renderStatsReport(surfaces), 'utf8');
  console.log(
    `[design-inventory] ✅ 统计报告已写入 ${REPORT_REL_PATH}` +
      `（${surfaces.length} 个 surface；不入库，台账未改动）`,
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
