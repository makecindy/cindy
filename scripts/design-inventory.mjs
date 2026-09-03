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
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BARE_RADIUS_RE,
  createBareRadiusRe,
  INVENTORY_REL_PATH,
  MAIN_ENTRY_REL_PATH,
  RENDERER_INDEX_REL_PATH,
  ROUTER_REL_PATH,
  buildGeneratedSurfaces,
  stripJsComments,
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
  const { surfaces, missingStyleRoots, danglingExtraStyleRoots } = buildGeneratedSurfaces(
    repoRoot,
    { catalog },
  );
  const routerCoverage = productionRouterCoverage(routerSource, catalog);
  const redirects = listRedirectExclusions(routerSource);
  const snapshotDate = checkOnly ? snapshotDateFromExisting(existing) : new Date().toISOString().slice(0, 10);
  const generated = renderGeneratedBlock(surfaces, {
    snapshotDate,
    generateCommand: GENERATE_COMMAND,
    routerCoverage,
    redirects,
  });
  return { surfaces, routerCoverage, generated, missingStyleRoots, danglingExtraStyleRoots };
}

const catalog = catalogSurfaces();

const existing = readExisting();
const { surfaces, routerCoverage, generated, missingStyleRoots, danglingExtraStyleRoots } =
  buildGenerated(existing);
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
    // 报告差异细节：跨平台排查（ICU/EOL/大小写/文件集）需要看到 diff 本身。
    // 逐 surface 对比主表行,打印每个分歧 surface 的统计三元组与来源文件数——
    // 统计数字或文件集的分歧一眼可见,不再被长 styleSources 列表淹没。
    const rowRe = /^\| `([^`]+)` \|/;
    const currentRows = new Map();
    for (const line of normalizeDocEol(comparison.current).split('\n')) {
      const m = rowRe.exec(line);
      if (m) currentRows.set(m[1], line);
    }
    const nextRows = new Map();
    for (const line of normalizeDocEol(comparison.next).split('\n')) {
      const m = rowRe.exec(line);
      if (m) nextRows.set(m[1], line);
    }
    const diffLines = [];
    for (const [id, nextLine] of nextRows) {
      const currentLine = currentRows.get(id);
      if (currentLine === nextLine) continue;
      const statsOf = (line) => {
        const cells = line.split('|').map((c) => c.trim());
        // | ID | 平台 | 标题 | 生产入口 | 可达组件 | 样式来源 | Token | 裸色 | 圆角 |
        const sources = (cells[6] ?? '').split(',').filter(Boolean);
        return `tokens=${cells[7]} colors=${cells[8]} radii=${cells[9]} files=${sources.length}`;
      };
      diffLines.push(`  - ${id}:`);
      diffLines.push(`    文件: ${currentLine ? statsOf(currentLine) : '(缺行)'}`);
      diffLines.push(`    重算: ${statsOf(nextLine)}`);
      // 逐文件计数表：定位跨平台分歧到具体文件（CI 日志与本地表逐行对比）。
      // 每行带文件内容 sha256 前 12 位——若 CI 读到的文件与本仓 git blob 不同，
      // 哈希会直接分叉，不再需要猜测内容差异。
      const surface = surfaces.find((s) => s.id === id);
      if (surface) {
        const perFile = surface.styleSources.map((file) => {
          const raw = fs.readFileSync(path.join(repoRoot, ...file.split('/')));
          const scan = stripJsComments(raw.toString('utf8'));
          const re = createBareRadiusRe();
          const matches = [...scan.matchAll(re)];
          const sha = createHash('sha256').update(raw).digest('hex').slice(0, 12);
          return `    ${matches.length} ${sha} ${file}`;
        });
        diffLines.push(...perFile);
      }
    }
    console.error(
      '[design-inventory] ❌ GENERATED 区块与源码不同步。\n' +
        '  运行 pnpm design:inventory 重新生成。\n' +
        '  分歧 surface 统计对比:\n' +
        (diffLines.length > 0 ? diffLines.join('\n') : '  (主表行一致,差异在其他段落)'),
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
