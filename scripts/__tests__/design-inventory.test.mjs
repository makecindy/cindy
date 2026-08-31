/**
 * DS-2a 生产 UI 台账生成器。
 *
 * 钉住治理合同 §2.1 的核心不变量：生成器只重写 GENERATED 区块、人工区原样保留、
 * 连续两次生成字节一致、生产路由全覆盖、裸颜色与 hardcoded-color-audit 共用匹配器。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { matchBareColors } from '../shared/hardcoded-color-match.mjs';
import {
  GENERATED_BEGIN,
  GENERATED_END,
  INVENTORY_REL_PATH,
  MAIN_ENTRY_REL_PATH,
  RENDERER_INDEX_REL_PATH,
  ROUTER_REL_PATH,
  buildGeneratedSurfaces,
  catalogSurfaces,
  compareGenerated,
  defaultHumanSeed,
  ensureHumanRows,
  extractHumanSurfaceIds,
  extractRendererEntries,
  extractRouterFacts,
  extractViewEntries,
  filterInventoryBareColors,
  findOrphanHumanIds,
  formatOrphanReport,
  listLayoutExclusions,
  listRedirectExclusions,
  mergeInventoryDocument,
  normalizeDocEol,
  productionRouterCoverage,
  renderGeneratedBlock,
  splitInventoryDocument,
  stripJsComments,
} from '../shared/design-inventory.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const INVENTORY_PATH = path.join(ROOT, ...INVENTORY_REL_PATH.split('/'));
const ROUTER_PATH = path.join(ROOT, ...ROUTER_REL_PATH.split('/'));
const MAIN_ENTRY_PATH = path.join(ROOT, ...MAIN_ENTRY_REL_PATH.split('/'));
const RENDERER_INDEX_PATH = path.join(ROOT, ...RENDERER_INDEX_REL_PATH.split('/'));
const CLI_PATH = path.join(ROOT, 'scripts', 'design-inventory.mjs');

function readRouter() {
  return fs.readFileSync(ROUTER_PATH, 'utf8');
}

function tinySurface(id = 'desktop.test.surface') {
  return {
    id,
    platform: 'desktop',
    title: '测试面',
    productionEntry: 'fixture',
    reachableComponents: ['FixtureView'],
    styleSources: ['apps/desktop/src/renderer/fixture.tsx'],
    tokenCount: 1,
    bareColors: 2,
    bareRadii: 3,
    routerPaths: ['/fixture'],
  };
}

function renderWithCoverage(surfaces, routerSource, extra = {}) {
  return renderGeneratedBlock(surfaces, {
    snapshotDate: '2026-08-30',
    generateCommand: 'pnpm design:inventory',
    routerCoverage: productionRouterCoverage(routerSource, extra.catalog ?? catalogSurfaces()),
    redirects: listRedirectExclusions(routerSource),
  });
}

test('stripJsComments: 去掉插在对象字面量里的行注释,不碰 https://', () => {
  const source = `
    {
      // Issue Tracker — 已迁移
      path: 'issues',
      element: <IssueTrackerFeatureLayout />,
    }
    const url = 'https://example.test/agent';
  `;
  const stripped = stripJsComments(source);
  assert.equal(stripped.includes('Issue Tracker'), false);
  assert.equal(stripped.includes("path: 'issues'"), true);
  // 不用 includes(URL) 子串断言(CodeQL js/incomplete-url-substring-sanitization 会拦):
  // 检查行注释剥离后该行完整保留即可。
  const urlLine = stripped.split('\n').find((line) => line.includes('const url'));
  assert.equal(urlLine, "    const url = 'https://example.test/agent';");
});

test('extractRouterFacts: 真实 router.tsx 的三类去向逐条钉死', () => {
  const { production, redirects, layouts } = extractRouterFacts(readRouter());

  // 全路径由父子结构拼出，不是手写前缀表 —— 嵌套段与 index 路由都必须落到完整 hash 路径。
  assert.deepEqual(production.map((row) => `${row.path} ${row.component}`), [
    '/add-account AddAccountLoginPage',
    '/apps/:ghostId GhostMainViewFeatureLayout',
    '/cc-agent/:sessionId CCAgentSessionView',
    '/cc-agent/boot SecondaryWindowBootGate',
    '/cc-agent/files/:sessionId WorkdirBrowseRoute',
    '/cc-agent/new NewMakerDraftRoute',
    '/cc-agent/orca/:sessionId OrcaWorkflowRoute',
    '/cc-agent/scheduled SchedulerPage',
    '/ghost-panel-window GhostPanelWindowLayout',
    '/issues IssueTrackerFeatureLayout',
    '/login LoginPage',
    '/maker-experimental MakerExperimentalView',
    '/plugins GhostPluginPage',
    '/settings SettingsView',
    '/sidebar-window SidebarWindowLayout',
    '/skillhub/local SkillhubHomeView',
    '/skillhub/local/:kind/global/:name SkillhubDetailView',
    '/skillhub/local/:kind/project/:projectHash/:name SkillhubDetailView',
    '/skillhub/market SkillhubMarketListView',
  ]);

  assert.deepEqual(redirects.map((row) => `${row.path} -> ${row.to}`), [
    '/ -> /cc-agent',
    '/billing -> /settings?tab=billing',
    '/cc-agent -> (runtime session redirect)',
    '/cc-agent/new-dialogue -> /cc-agent/new',
    '/cc-agent/orca/new -> /cc-agent/new',
    '/skillhub -> /skillhub/local',
    '/skillhub/market/:kind/:name -> /skillhub/market',
    '/skillhub/market/:name -> /skillhub/market',
    '/skillhub/market/manage/:name -> /skillhub/market',
  ]);

  assert.deepEqual(layouts.map((row) => `${row.path} ${row.component}`), [
    '/ LocalDbGate',
    '/ MainLayout',
    '/ ProtectedRoute',
    '/cc-agent CCAgentFeatureLayout',
    '/login GuestRoute',
    '/skillhub SkillhubFeatureLayout',
  ]);
});

test('extractRouterFacts: 注释插在 { 与 path 之间仍能抽出;Navigate 不得跨对象绑定', () => {
  const fixture = `
    export const router = createHashRouter([
      {
        // Issue Tracker — 已迁移至 GitHub
        path: 'issues',
        element: <IssueTrackerFeatureLayout />,
      },
      { path: 'scheduled', element: <SchedulerPage /> },
      { path: 'new-dialogue', element: <Navigate to="/cc-agent/new" replace /> },
      { path: 'settings', element: <SettingsView /> },
      { path: 'billing', element: <Navigate to="/settings?tab=billing" replace /> },
    ]);
  `;
  const { production, redirects } = extractRouterFacts(fixture);
  assert.deepEqual(
    production.map((row) => `${row.path}:${row.component}`),
    ['/issues:IssueTrackerFeatureLayout', '/scheduled:SchedulerPage', '/settings:SettingsView'],
  );
  assert.deepEqual(
    redirects.map((row) => `${row.path}->${row.to}`),
    ['/billing->/settings?tab=billing', '/new-dialogue->/cc-agent/new'],
  );
});

test('extractRouterFacts: 嵌套 children 的全路径由结构拼出,不靠前缀表', () => {
  const fixture = `
    export const router = createHashRouter([
      {
        path: '/',
        element: <ProtectedRoute />,
        children: [
          {
            path: 'deep',
            element: <DeepFeatureLayout />,
            children: [
              { index: true, element: <Navigate to="/deep/one" replace /> },
              { path: 'one', element: <DeepOne /> },
              { path: 'nested/:id', element: <DeepNested /> },
            ],
          },
        ],
      },
    ]);
  `;
  const { production, redirects, layouts } = extractRouterFacts(fixture);
  // DeepFeatureLayout 不在布局壳白名单里 → 当生产 surface 登记，逼人显式决策而不是静默丢掉。
  assert.deepEqual(
    production.map((row) => row.path),
    ['/deep', '/deep/nested/:id', '/deep/one'],
  );
  // index 路由继承父级全路径，不是 '/deep/index'。
  assert.deepEqual(
    redirects.map((row) => `${row.path}->${row.to}`),
    ['/deep->/deep/one'],
  );
  assert.deepEqual(
    layouts.map((row) => row.component),
    ['ProtectedRoute'],
  );
});

test('连续两次渲染 GENERATED 区块字节一致', () => {
  const routerSource = readRouter();
  const surfaces = [tinySurface()];
  const first = renderWithCoverage(surfaces, routerSource);
  const second = renderWithCoverage(surfaces, routerSource);
  assert.equal(first, second);
  assert.equal(first.includes('Date.now'), false);
  assert.equal(/\b(?:[A-Z]:\\|\/Users\/)\S+/.test(first), false, 'GENERATED 不得含绝对路径');
});

test('排序用码点序而非 localeCompare——跨平台字节一致', () => {
  // localeCompare 对连字符等标点的排序权重随 ICU 版本(Windows/Linux/macOS 各不同)
  // 漂移,曾让 --check 在 Windows CI 假红。钉死:同一批输入的排序结果必须与
  // 码点序逐字节一致,不受宿主 locale 影响。
  const source = `
    export const router = createHashRouter([
      { path: 'b-x', element: <BView /> },
      { path: 'bx', element: <BXView /> },
      { path: 'a', element: <AView /> },
    ]);
  `;
  const { production } = extractRouterFacts(source);
  // extractRouterFacts 内部排序:结果必须等于码点序(而非 en collation 的 b-x < bx)。
  const codepointSorted = [...production].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  assert.deepEqual(production, codepointSorted);
  // 含连字符路径:码点序 '-'(45) < 'x'(120),b-x 排在 bx 前。
  assert.deepEqual(
    production.map((row) => row.path),
    ['/a', '/b-x', '/bx'],
  );
});

test('人工区块被改后 merge 仍原样保留', () => {
  const generated = renderGeneratedBlock([tinySurface()], {
    snapshotDate: '2026-08-30',
    generateCommand: 'pnpm design:inventory',
    routerCoverage: { mapped: [], missing: [] },
    redirects: [],
  });
  const human =
    '\n## 人工标注\n\n| ID | owner | 迁移状态 | protected | 目标道路 | 下一动作 |\n| --- | --- | --- | --- | --- | --- |\n| `desktop.test.surface` | kiro | pilot | 手改标签 | 手改道路 | 手改动作 |\n';
  const existing = `# Cindy 生产 UI 台账\n${generated}${human}`;
  const nextGenerated = renderGeneratedBlock([{ ...tinySurface(), bareColors: 99 }], {
    snapshotDate: '2026-08-30',
    generateCommand: 'pnpm design:inventory',
    routerCoverage: { mapped: [], missing: [] },
    redirects: [],
  });
  const merged = mergeInventoryDocument(existing, nextGenerated);
  const parts = splitInventoryDocument(merged);
  assert.equal(parts.suffix, human);
  assert.equal(parts.suffix.includes('手改标签'), true);
  assert.equal(parts.generated.includes('99'), true);
  assert.equal(parts.generated.includes('| 2 |'), false);
});

test('compareGenerated: 最新通过、过期失败', () => {
  const generated = renderGeneratedBlock([tinySurface()], {
    snapshotDate: '2026-08-30',
    generateCommand: 'pnpm design:inventory',
    routerCoverage: { mapped: [], missing: [] },
    redirects: [],
  });
  const doc = `# 台账\n${generated}\n人工区\n`;
  assert.equal(compareGenerated(doc, generated).equal, true);
  const stale = doc.replace('裸颜色', '裸色值');
  assert.equal(compareGenerated(stale, generated).equal, false);
});

test('router.tsx 每条生产路由都能映射到 surface,布局壳在排除清单', () => {
  const routerSource = readRouter();
  const catalog = catalogSurfaces();
  const coverage = productionRouterCoverage(routerSource, catalog);
  assert.deepEqual(
    coverage.missing,
    [],
    `未映射生产路由: ${coverage.missing.map((row) => row.path).join(', ')}`,
  );
  assert.deepEqual(
    coverage.stale,
    [],
    `catalog 已失效路由: ${coverage.stale.join(', ')}`,
  );
  const mappedPaths = coverage.mapped.map((row) => row.path);
  assert.ok(mappedPaths.includes('/issues'));
  assert.ok(mappedPaths.includes('/login'));
  assert.ok(mappedPaths.includes('/skillhub/local'));
  assert.ok(mappedPaths.includes('/skillhub/market'));
  assert.equal(mappedPaths.includes('/'), false);
  assert.equal(mappedPaths.includes('/cc-agent'), false);
  assert.equal(mappedPaths.includes('/skillhub'), false);
  assert.equal(mappedPaths.includes('/billing'), false);

  const layoutPaths = new Set(listLayoutExclusions(routerSource).map((row) => row.path));
  assert.ok(layoutPaths.has('/'));
  assert.ok(layoutPaths.has('/login'));
  assert.ok(layoutPaths.has('/cc-agent'));
  assert.ok(layoutPaths.has('/skillhub'));

  const redirects = listRedirectExclusions(routerSource);
  const redirectPaths = redirects.map((row) => row.path);
  assert.ok(redirectPaths.includes('/'));
  assert.ok(redirectPaths.includes('/cc-agent'));
  assert.ok(redirectPaths.includes('/skillhub'));
  assert.ok(redirectPaths.includes('/billing'));
  assert.ok(redirectPaths.includes('/cc-agent/new-dialogue'));
});

test('GENERATED 含 §2.1 六项字段,裸颜色与 audit 共用匹配器', () => {
  const generated = renderGeneratedBlock([tinySurface()], {
    snapshotDate: '2026-08-30',
    generateCommand: 'pnpm design:inventory',
    routerCoverage: { mapped: [], missing: [] },
    redirects: [],
  });
  assert.equal(generated.includes('| ID | 平台 | 标题 | 生产入口 | 可达组件 | 样式来源 | Token 数 | 裸颜色 | 裸圆角 |'), true);
  assert.equal(generated.includes('计数快照日期：2026-08-30'), true);
  assert.equal(generated.includes('生成命令：`pnpm design:inventory`'), true);
  assert.equal(generated.includes('hardcoded-color-match.mjs'), true);

  const auditSource = fs.readFileSync(path.join(ROOT, 'scripts', 'hardcoded-color-audit.mjs'), 'utf8');
  assert.equal(auditSource.includes('from "./shared/hardcoded-color-match.mjs"'), true);
  assert.equal(/HEX_RE\s*=/.test(auditSource), false, 'audit 不得再内联第二套 HEX 正则');

  const hits = matchBareColors('color:#fff; bg:rgb(1, 2, 3); overlay:rgba(0,0,0,.4); hsl(120, 10%, 20%); hsla(1,2%,3%,.5)');
  assert.deepEqual(hits, ['#fff', 'rgb(1, 2, 3)', 'rgba(0,0,0,.4)', 'hsl(120, 10%, 20%)', 'hsla(1,2%,3%,.5)']);
});

test('孤儿人工行只报告不删除', () => {
  const generated = renderGeneratedBlock([tinySurface()], {
    snapshotDate: '2026-08-30',
    generateCommand: 'pnpm design:inventory',
    routerCoverage: { mapped: [], missing: [] },
    redirects: [],
  });
  const human =
    '\n| ID | owner | 迁移状态 | protected | 目标道路 | 下一动作 |\n| --- | --- | --- | --- | --- | --- |\n| `desktop.test.surface` | unassigned | legacy | — | x | y |\n| `desktop.orphan.gone` | unassigned | legacy | — | x | y |\n';
  const doc = `# 台账\n${generated}${human}`;
  const merged = mergeInventoryDocument(doc, generated);
  assert.equal(merged.includes('desktop.orphan.gone'), true);
  const orphans = findOrphanHumanIds(
    splitInventoryDocument(merged).suffix,
    ['desktop.test.surface'],
  );
  assert.deepEqual(orphans, ['desktop.orphan.gone']);
  assert.match(formatOrphanReport(orphans), /desktop\.orphan\.gone/);
  assert.equal(formatOrphanReport([]), '');
});

test('fixture 新增或删除一条生产路由会改变 GENERATED,使 compare 失败', () => {
  const baseRouter = `
    export const router = createHashRouter([
      { path: 'fixture', element: <FixtureView /> },
    ]);
  `;
  const addedRouter = `
    export const router = createHashRouter([
      { path: 'fixture', element: <FixtureView /> },
      { path: 'extra', element: <ExtraView /> },
    ]);
  `;
  const removedRouter = `
    export const router = createHashRouter([
    ]);
  `;
  const catalog = [
    {
      id: 'desktop.test.surface',
      routerPaths: ['/fixture'],
    },
  ];
  const surfaces = [tinySurface()];
  const base = renderGeneratedBlock(surfaces, {
    snapshotDate: '2026-08-30',
    generateCommand: 'pnpm design:inventory',
    routerCoverage: productionRouterCoverage(baseRouter, catalog),
    redirects: listRedirectExclusions(baseRouter),
  });
  const added = renderGeneratedBlock(surfaces, {
    snapshotDate: '2026-08-30',
    generateCommand: 'pnpm design:inventory',
    routerCoverage: productionRouterCoverage(addedRouter, catalog),
    redirects: listRedirectExclusions(addedRouter),
  });
  const removed = renderGeneratedBlock(surfaces, {
    snapshotDate: '2026-08-30',
    generateCommand: 'pnpm design:inventory',
    routerCoverage: productionRouterCoverage(removedRouter, catalog),
    redirects: listRedirectExclusions(removedRouter),
  });
  assert.notEqual(added, base);
  assert.equal(added.includes('`/extra`'), true);
  assert.equal(added.includes('UNMAPPED'), true);
  assert.notEqual(removed, base);
  assert.equal(removed.includes('`/fixture`'), false);
  const doc = `# 台账\n${base}\n`;
  assert.equal(compareGenerated(doc, added).equal, false);
  assert.equal(compareGenerated(doc, removed).equal, false);
});

test('catalog 路由被删除后 stale 反向核对能发现,不再静默通过', () => {
  const routerSource = `
    export const router = createHashRouter([
      { path: 'fixture', element: <FixtureView /> },
    ]);
  `;
  const catalog = [
    { id: 'desktop.test.surface', routerPaths: ['/fixture'] },
    { id: 'desktop.test.renamed', routerPaths: ['/old-name'] },
  ];
  const coverage = productionRouterCoverage(routerSource, catalog);
  assert.deepEqual(coverage.missing, []);
  assert.deepEqual(coverage.stale, ['/old-name']);
  // 反向也钉死:真实路由全部在册时 stale 必须为空。
  const freshCoverage = productionRouterCoverage(routerSource, [
    { id: 'desktop.test.surface', routerPaths: ['/fixture'] },
  ]);
  assert.deepEqual(freshCoverage.stale, []);
});

test('路径保留但 element 换组件时 componentMismatch 能发现', () => {
  const routerSource = `
    export const router = createHashRouter([
      { path: 'fixture', element: <NewSwappedView /> },
    ]);
  `;
  const catalog = [
    {
      id: 'desktop.test.surface',
      routerPaths: ['/fixture'],
      routeEntryComponents: { '/fixture': 'FixtureView' },
    },
  ];
  const coverage = productionRouterCoverage(routerSource, catalog);
  assert.deepEqual(coverage.missing, []);
  assert.deepEqual(coverage.stale, []);
  assert.deepEqual(coverage.componentMismatch, [
    {
      path: '/fixture',
      actualComponent: 'NewSwappedView',
      catalogComponents: ['FixtureView'],
      surfaceId: 'desktop.test.surface',
    },
  ]);
  // 组件一致(路径级映射逐字对上)时不得误报。
  const okCoverage = productionRouterCoverage(routerSource, [
    {
      id: 'desktop.test.surface',
      routerPaths: ['/fixture'],
      routeEntryComponents: { '/fixture': 'NewSwappedView' },
    },
  ]);
  assert.deepEqual(okCoverage.componentMismatch, []);
  // 未登记 routeEntryComponents 的 surface 只按路径映射,不受影响(历史形态不强制回填)。
  const legacyCoverage = productionRouterCoverage(routerSource, [
    { id: 'desktop.test.surface', routerPaths: ['/fixture'] },
  ]);
  assert.deepEqual(legacyCoverage.componentMismatch, []);
});

test('多路由 surface 内部换入口组件(并集内)也会被发现', () => {
  // surface 级并集防不住的场景:两条路径各有入口,把 A 路径换成同 surface 的 B 组件。
  const routerSource = `
    export const router = createHashRouter([
      { path: 'home', element: <DetailView /> },
      { path: 'detail/:id', element: <DetailView /> },
    ]);
  `;
  const catalog = [
    {
      id: 'desktop.test.multi',
      routerPaths: ['/home', '/detail/:id'],
      routeEntryComponents: { '/home': 'HomeView', '/detail/:id': 'DetailView' },
    },
  ];
  const coverage = productionRouterCoverage(routerSource, catalog);
  assert.deepEqual(coverage.componentMismatch, [
    {
      path: '/home',
      actualComponent: 'DetailView',
      catalogComponents: ['HomeView'],
      surfaceId: 'desktop.test.multi',
    },
  ]);
});

test('componentMismatch 报错路径可完整渲染,不再 TypeError', () => {
  // 回归:catalogComponents 曾被赋成字符串(routeEntryComponents[path] 的值),CLI 的
  // 报错拼接 row.catalogComponents.join(' / ') 会 TypeError,把真实的组件不一致
  // 信息吞掉。此测试钉住两层:共享层输出数组,且 CLI 报错文本可正常生成。
  const routerSource = `
    export const router = createHashRouter([
      { path: 'fixture', element: <SwappedView /> },
    ]);
  `;
  const catalog = [
    {
      id: 'desktop.test.surface',
      routerPaths: ['/fixture'],
      routeEntryComponents: { '/fixture': 'FixtureView' },
    },
  ];
  const coverage = productionRouterCoverage(routerSource, catalog);
  // 共享层:数组形态(消费侧可安全 join)。
  assert.deepEqual(coverage.componentMismatch[0].catalogComponents, ['FixtureView']);
  assert.ok(Array.isArray(coverage.componentMismatch[0].catalogComponents));
  // CLI 报错拼接:与 scripts/design-inventory.mjs 的失败路径同构,必须不抛异常。
  const mismatchLine = coverage.componentMismatch
    .map(
      (row) =>
        `  - ${row.path}: router 实际 ${row.actualComponent}, catalog 登记 ${row.catalogComponents.join(' / ')}（surface ${row.surfaceId}）`,
    )
    .join('\n');
  assert.match(mismatchLine, /\/fixture: router 实际 SwappedView, catalog 登记 FixtureView/);
  // 登记缺路径(undefined)也兜底成空数组,不炸 join。
  const missingPathCatalog = [
    {
      id: 'desktop.test.partial',
      routerPaths: ['/fixture'],
      routeEntryComponents: { '/other': 'OtherView' },
    },
  ];
  const partial = productionRouterCoverage(routerSource, missingPathCatalog);
  if (partial.componentMismatch.length > 0) {
    assert.ok(Array.isArray(partial.componentMismatch[0].catalogComponents));
    // 不抛即可:
    partial.componentMismatch[0].catalogComponents.join(' / ');
  }
});

test('真实 router.tsx 的每条路由组件都与 catalog 的 routeEntryComponents 一致', () => {
  const coverage = productionRouterCoverage(readRouter(), catalogSurfaces());
  assert.deepEqual(
    coverage.componentMismatch,
    [],
    `组件不一致: ${JSON.stringify(coverage.componentMismatch)}`,
  );
  // 每个 routerPaths 非空的 surface 都必须登记 routeEntryComponents 且逐路径覆盖
  // ——防未来新增路由面漏登记、或多路由 surface 漏某条路径的映射。
  const missingRegistration = catalogSurfaces().filter(
    (surface) =>
      (surface.routerPaths ?? []).length > 0 &&
      Object.keys(surface.routeEntryComponents ?? {}).length === 0,
  );
  assert.deepEqual(
    missingRegistration.map((surface) => surface.id),
    [],
    '路由级 surface 必须登记 routeEntryComponents',
  );
  const incomplete = catalogSurfaces().filter((surface) => {
    const paths = surface.routerPaths ?? [];
    const entries = surface.routeEntryComponents ?? {};
    return paths.length > 0 && paths.some((routePath) => entries[routePath] === undefined);
  });
  assert.deepEqual(
    incomplete.map((surface) => surface.id),
    [],
    'routeEntryComponents 必须覆盖 routerPaths 的每条路径',
  );
});

test('styleRoot 路径不存在时 missingStyleRoots 报告,统计不静默归零', () => {
  const base = {
    platform: 'desktop',
    title: '测试面',
    productionEntry: 'fixture',
    reachableComponents: ['FixtureView'],
    routerPaths: [],
  };
  const catalog = [
    {
      ...base,
      id: 'desktop.test.surface',
      styleRoots: ['scripts/__tests__/design-inventory.test.mjs'],
    },
    {
      ...base,
      id: 'desktop.test.gone',
      styleRoots: ['apps/desktop/src/renderer/does-not-exist.tsx'],
    },
  ];
  const { surfaces, missingStyleRoots } = buildGeneratedSurfaces(ROOT, { catalog });
  assert.deepEqual(missingStyleRoots, ['apps/desktop/src/renderer/does-not-exist.tsx']);
  // 存在的 root 照常统计;失效的 root 对应 surface 统计为 0——事实是「没有可统计文件」,
  // 由 missingStyleRoots 让 CLI 报错,而不是让 0 假装是真实统计。
  const ok = surfaces.find((surface) => surface.id === 'desktop.test.surface');
  assert.ok(ok.styleSources.length > 0);
  const gone = surfaces.find((surface) => surface.id === 'desktop.test.gone');
  assert.deepEqual(gone.styleSources, []);
  // 真实 catalog 上跑一遍:不得有失效 root。
  const real = buildGeneratedSurfaces(ROOT, {});
  assert.deepEqual(real.missingStyleRoots, []);
});

test('catalog 含 App 顶层非路由生产 UI(LegacyMigrationDialog)且统计非零', () => {
  const catalog = catalogSurfaces();
  const migration = catalog.find((surface) => surface.id === 'desktop.auth.legacy-migration');
  assert.ok(migration, 'catalog 必须登记 desktop.auth.legacy-migration');
  assert.deepEqual(migration.routerPaths, []);
  assert.equal(migration.productionEntry.includes('LegacyMigrationDialog'), true);
  const { surfaces } = buildGeneratedSurfaces(ROOT, {});
  const generated = surfaces.find((surface) => surface.id === 'desktop.auth.legacy-migration');
  assert.ok(generated, 'GENERATED 必须含 desktop.auth.legacy-migration 行');
  assert.ok(generated.tokenCount > 0, '迁移弹窗消费 --login-* token,统计不得为 0');
  assert.ok(
    generated.styleSources.includes('apps/desktop/src/renderer/components/auth/LegacyMigrationDialog.tsx'),
  );
});

test('薄壳 surface 经 extraStyleRoots 继承被委托 surface 的样式事实', () => {
  const { surfaces } = buildGeneratedSurfaces(ROOT, {});
  const login = surfaces.find((surface) => surface.id === 'desktop.auth.login');
  const addAccount = surfaces.find((surface) => surface.id === 'desktop.auth.add-account');
  assert.ok(login && addAccount);
  // AddAccountLoginPage 渲染即委托 LoginPage;统计必须与登录页同一组事实源,不再全 0。
  assert.deepEqual(
    { tokens: addAccount.tokenCount, colors: addAccount.bareColors, radii: addAccount.bareRadii },
    { tokens: login.tokenCount, colors: login.bareColors, radii: login.bareRadii },
  );
});

test('Orca 工作台继承会话视图样式事实,不再把聊天界面统计成全 0', () => {
  const { surfaces } = buildGeneratedSurfaces(ROOT, {});
  const session = surfaces.find((surface) => surface.id === 'desktop.chat.session');
  const orca = surfaces.find((surface) => surface.id === 'desktop.chat.orca-workflow');
  assert.ok(session && orca);
  // OrcaSplitView / OrcaWorkerPanel 直接渲染 <CCAgentSessionView compact orcaMode>,
  // 样式事实必须覆盖会话视图本体(继承 desktop.chat.session),再叠加 Orca 包装层。
  assert.ok(
    orca.reachableComponents.includes('CCAgentSessionView'),
    'CCAgentSessionView 必须列入 orca 可达组件',
  );
  assert.ok(orca.tokenCount >= session.tokenCount && orca.tokenCount > 0);
  assert.ok(orca.bareColors >= session.bareColors && orca.bareColors > 0);
  assert.ok(orca.bareRadii >= session.bareRadii && orca.bareRadii > 0);
});

test('统计层排除 var() 包装与注释伪裸色,共享匹配器口径不变', () => {
  // 1) hsl(var(--token)) 是语义 token 消费,不是裸值——audit 共享匹配器会命中
  //    `hsl(var(--content-area)` 前缀,台账统计层必须过滤。
  assert.deepEqual(
    filterInventoryBareColors(['hsl(var(--content-area)', 'hsla(var(--accent)', '#fff']),
    ['#fff'],
  );
  assert.deepEqual(filterInventoryBareColors(['rgba(var(--overlay)', 'rgb(1,2,3)']), ['rgb(1,2,3)']);
  // 2) 共享匹配器本身不动:audit 侧仍按宽松口径命中(治理合同要求两边同一套正则)。
  assert.equal(matchBareColors('hsl(var(--content-area))').length, 1);
  assert.equal(matchBareColors('/* PR #104 */').includes('#104'), true);
  // 3) 注释里的 PR 编号、坐标不是组件样式:TS/TSX 统计前剥注释(块注释与整行 //
  //    注释;行尾 // 注释是已知边界,与本仓 stripJsComments 路由解析同口径)。
  const withComments = `
    // PR #104 撤 wave4 双红渐变
    /* 坐标 @(698,1046) */
    const style = { color: '#ff0000' };
  `;
  const hits = filterInventoryBareColors(matchBareColors(stripJsComments(withComments)));
  assert.deepEqual(hits, ['#ff0000']);
  // 4) 真实台账上不再有注释伪色:登录页的 #EDEDED/#1F1F1E/#104 全在注释里,
  //    过滤后裸色基线只反映代码真实消费。
  const { surfaces } = buildGeneratedSurfaces(ROOT, {});
  const login = surfaces.find((surface) => surface.id === 'desktop.auth.login');
  assert.ok(login.bareColors < 42, `注释剥离应移除登录页注释色(实际 ${login.bareColors})`);
  const market = surfaces.find((surface) => surface.id === 'desktop.skillhub.market');
  // market 的 2 个"裸颜色"全部是 hsl(var(--content-area)) → 归零。
  assert.equal(market.bareColors, 0);
});

test('市场页直接渲染的子组件纳入样式统计', () => {
  const catalog = catalogSurfaces();
  const market = catalog.find((surface) => surface.id === 'desktop.skillhub.market');
  assert.ok(market);
  for (const component of ['MarketCard', 'InstallTargetPicker', 'SkillhubMarketPreviewPanel', 'MarketInfoEditDialog', 'VisibilityEditorDialog']) {
    assert.ok(
      market.reachableComponents.includes(component),
      `${component} 必须列入市场页可达组件`,
    );
  }
  assert.ok(market.styleRoots.includes('apps/desktop/src/renderer/features/skillhub/components'));
  const { surfaces } = buildGeneratedSurfaces(ROOT, {});
  const generated = surfaces.find((surface) => surface.id === 'desktop.skillhub.market');
  // 子组件文件进统计后样式来源必须包含 MarketCard 等真实文件。
  assert.ok(
    generated.styleSources.some((file) => file.endsWith('components/MarketCard.tsx')),
    'MarketCard.tsx 必须进样式来源',
  );
  assert.ok(generated.styleSources.length > 1, '不能只扫入口文件');
});

test('view 分支覆盖守卫: main-entry 的 view→组件映射必须与 catalog 一致', () => {
  const actualViews = extractViewEntries(fs.readFileSync(MAIN_ENTRY_PATH, 'utf8'));
  // 与源码实况钉死:当前 4 个 view 分支各自渲染的组件。
  assert.deepEqual(Object.fromEntries(actualViews), {
    'computer-permission-backdrop': 'ComputerPermissionBackdrop',
    'computer-permission-guide': 'ComputerPermissionGuideWindow',
    'voice-input-dictionary-toast': 'VoiceInputDictionaryToast',
    'voice-input-overlay': 'VoiceInputOverlay',
  });
  const covered = new Map(
    catalogSurfaces().flatMap((surface) => Object.entries(surface.viewEntryComponents ?? {})),
  );
  for (const [view, component] of actualViews) {
    assert.ok(covered.has(view), `未映射 view 分支: ${view}`);
    assert.equal(covered.get(view), component, `view ${view} 的渲染组件不一致`);
  }
  for (const [view] of covered) {
    assert.ok(actualViews.has(view), `已失效 view 登记: ${view}`);
  }
});

test('extractViewEntries: view 名保留但渲染组件换了会被发现(fixture)', () => {
  // 这正是「只比 view 名」防不住的场景:view 名不动,浮窗实现换成别的组件。
  const swapped = `
    const isVoiceInputOverlay = view === 'voice-input-overlay';
    if (isVoiceInputOverlay) {
      const { VoiceInputDictionaryToast } = await import('./voice-input/VoiceInputDictionaryToast');
      root.render(<VoiceInputDictionaryToast />);
    }
  `;
  const mappings = extractViewEntries(swapped);
  assert.deepEqual(Object.fromEntries(mappings), {
    'voice-input-overlay': 'VoiceInputDictionaryToast',
  });
  // 新增 view 分支。
  const added = `
    const isNewOverlay = view === 'brand-new-overlay';
    if (isNewOverlay) {
      const { NewOverlay } = await import('./NewOverlay');
      root.render(<NewOverlay />);
    }
  `;
  assert.deepEqual(Object.fromEntries(extractViewEntries(added)), {
    'brand-new-overlay': 'NewOverlay',
  });
  // 注释里的 view === 不算(无 if 块时映射为空)。
  const withComment = `
    // view === 'commented-view' 已退役
    const isX = view === 'live-view';
  `;
  assert.deepEqual(Object.fromEntries(extractViewEntries(withComment)), {});
});

test('Token 统计基于去注释源码,注释里的 var(--xxx) 占位符不进基线', () => {
  const source = `
    // 占位示例:var(--placeholder-doc-only)
    /* var(--another-doc-token) */
    const style = { color: 'var(--real-token)', bg: 'hsl(var(--real-hsl-token))' };
  `;
  const stripped = stripJsComments(source);
  const tokens = new Set();
  for (const match of stripped.matchAll(/(?:hsl\(\s*var\(|var\()(--[a-zA-Z0-9-]+)/g)) {
    tokens.add(match[1]);
  }
  assert.deepEqual([...tokens].sort(), ['--real-hsl-token', '--real-token']);
});

test('CSS 文件同样剥块注释后统计,globals.css 注释色值不进基线', () => {
  const cssWithComments = `
    /* 高亮主题示例:#ffffff / #f0fff4 / #ffeef0 */
    :root {
      --real-value: #102030;
    }
    .card { border-radius: 8px; }
  `;
  const stripped = stripJsComments(cssWithComments);
  assert.equal(stripped.includes('#ffffff'), false);
  assert.equal(stripped.includes('#102030'), true);
  const hits = filterInventoryBareColors(matchBareColors(stripped));
  assert.deepEqual(hits, ['#102030']);
  // 真实 globals.css 上验证:剥注释后裸色显著低于未剥(注释示例色被剔除)。
  const { surfaces } = buildGeneratedSurfaces(ROOT, {});
  const shell = surfaces.find((surface) => surface.id === 'desktop.shell.main-layout');
  // 上一轮口径(CSS 不剥注释)主窗口裸色为 92;剥注释后应显著下调。
  assert.ok(
    shell.bareColors < 92,
    `CSS 注释剥离后主窗口裸色应低于 92(实际 ${shell.bareColors})`,
  );
  assert.ok(shell.bareColors > 0, '真实规则色值仍应计入');
});

test('skillhub.local 纳入直接渲染子组件的样式事实', () => {
  const catalog = catalogSurfaces();
  const local = catalog.find((surface) => surface.id === 'desktop.skillhub.local');
  assert.ok(local);
  for (const component of ['PluginManagementLayout', 'SkillhubMarketPreviewPanel', 'InstallTargetPicker']) {
    assert.ok(
      local.reachableComponents.includes(component),
      `${component} 必须列入 skillhub.local 可达组件`,
    );
  }
  assert.ok(
    local.styleRoots.includes('apps/desktop/src/renderer/features/plugin/PluginManagementLayout.tsx'),
  );
  const { surfaces } = buildGeneratedSurfaces(ROOT, {});
  const generated = surfaces.find((surface) => surface.id === 'desktop.skillhub.local');
  assert.ok(generated.styleSources.some((file) => file.endsWith('PluginManagementLayout.tsx')));
  assert.ok(generated.tokenCount > 33, `子组件并入后 token 数应高于只扫路由组件(实际 ${generated.tokenCount})`);
});

test('plugins.installed 纳入直接渲染子组件与 plugin-motion.css', () => {
  const catalog = catalogSurfaces();
  const installed = catalog.find((surface) => surface.id === 'desktop.plugins.installed');
  assert.ok(installed);
  for (const component of [
    'PluginManagementLayout',
    'MarketPluginDetailView',
    'PluginScopePicker',
    'MyPublishesSection',
    'AddMarketplaceDialog',
    'UpdateAllDialog',
  ]) {
    assert.ok(
      installed.reachableComponents.includes(component),
      `${component} 必须列入 plugins.installed 可达组件`,
    );
  }
  assert.ok(
    installed.styleRoots.includes('apps/desktop/src/renderer/features/plugin/plugin-motion.css'),
  );
  const { surfaces } = buildGeneratedSurfaces(ROOT, {});
  const generated = surfaces.find((surface) => surface.id === 'desktop.plugins.installed');
  assert.ok(generated.styleSources.some((file) => file.endsWith('plugin-motion.css')));
  assert.ok(generated.styleSources.some((file) => file.endsWith('MyPublishesSection.tsx')));
});

test('主窗口壳纳入全局基础样式 globals.css', () => {
  const catalog = catalogSurfaces();
  const shell = catalog.find((surface) => surface.id === 'desktop.shell.main-layout');
  assert.ok(shell);
  // main-entry.tsx 无条件导入 globals.css，其中 CINDY 皮肤段直接改写主窗口壳。
  assert.ok(
    shell.styleRoots.includes('apps/desktop/src/renderer/styles/globals.css'),
  );
  const { surfaces } = buildGeneratedSurfaces(ROOT, {});
  const generated = surfaces.find((surface) => surface.id === 'desktop.shell.main-layout');
  assert.ok(generated.styleSources.some((file) => file.endsWith('styles/globals.css')));
  // globals.css 的 :root 渐变等真实色值进入统计,基线不再低报。
  assert.ok(generated.bareColors > 3, `globals.css 并入后裸色应高于 3(实际 ${generated.bareColors})`);
});

test('主窗口壳纳入 MainLayout 直接挂载的全局浮层', () => {
  // MainLayout.tsx:1548,1601,1611,1615 直接渲染四个全局浮层,触发时都是生产可见 UI。
  const catalog = catalogSurfaces();
  const shell = catalog.find((surface) => surface.id === 'desktop.shell.main-layout');
  assert.ok(shell);
  for (const component of [
    'GhostMediaLightboxHost',
    'UpdateNoticeDialog',
    'FeishuConflictDialogHost',
    'SessionShareImportWizard',
  ]) {
    assert.ok(
      shell.reachableComponents.includes(component),
      `${component} 必须列入主窗口壳可达组件`,
    );
  }
  const { surfaces } = buildGeneratedSurfaces(ROOT, {});
  const generated = surfaces.find((surface) => surface.id === 'desktop.shell.main-layout');
  assert.ok(generated.styleSources.some((file) => file.endsWith('GhostMediaLightboxHost.tsx')));
  assert.ok(generated.styleSources.some((file) => file.endsWith('UpdateNoticeDialog.tsx')));
  assert.ok(generated.styleSources.some((file) => file.endsWith('FeishuConflictDialogHost.tsx')));
  assert.ok(generated.styleSources.some((file) => file.endsWith('SessionShareImportWizard.tsx')));
});

test('主窗口壳与右侧栏独立窗口纳入 RightSidebarShell 的实现目录', () => {
  // RightSidebar.tsx:26,263 与 SidebarWindowLayout.tsx:31 都渲染
  // features/right-sidebar/RightSidebarShell——TabBar/下拉/插件体/FileBrowserBody.css
  // 的样式事实在那棵树里,只扫 wrapper/layout 目录会系统性低报。
  const rightSidebarTree = 'apps/desktop/src/renderer/features/right-sidebar';
  const catalog = catalogSurfaces();
  for (const surfaceId of ['desktop.shell.main-layout', 'desktop.window.sidebar']) {
    const surface = catalog.find((entry) => entry.id === surfaceId);
    assert.ok(surface, surfaceId);
    assert.ok(
      surface.styleRoots.includes(rightSidebarTree),
      `${surfaceId} 必须登记 features/right-sidebar`,
    );
    assert.ok(
      surface.reachableComponents.includes('RightSidebarShell'),
      `${surfaceId} 可达组件须含 RightSidebarShell`,
    );
  }
  const { surfaces } = buildGeneratedSurfaces(ROOT, {});
  const shell = surfaces.find((surface) => surface.id === 'desktop.shell.main-layout');
  assert.ok(shell.styleSources.some((file) => file.endsWith('right-sidebar/RightSidebarShell.tsx')));
  assert.ok(shell.styleSources.some((file) => file.endsWith('TabBar.tsx')));
  assert.ok(
    shell.styleSources.some((file) => file.endsWith('FileBrowserBody.css')),
    'file-browser 插件样式须进主窗口壳统计',
  );
  assert.ok(
    shell.bareRadii > 103,
    `并入右侧栏实现后主窗口裸圆角应高于 103(实际 ${shell.bareRadii})`,
  );
  const sidebarWindow = surfaces.find((surface) => surface.id === 'desktop.window.sidebar');
  assert.ok(
    sidebarWindow.styleSources.some((file) => file.endsWith('right-sidebar/RightSidebarShell.tsx')),
  );
});

test('设置页纳入 sortable.css（providers tab 拖拽行样式）', () => {
  // ProvidersSection.tsx:2426 的 provider-settings-sortable-row 样式定义在
  // sortable.css:88-109,由 main-entry.tsx:53 无条件导入。
  const catalog = catalogSurfaces();
  const settings = catalog.find((surface) => surface.id === 'desktop.settings');
  assert.ok(settings);
  assert.ok(
    settings.styleRoots.includes('apps/desktop/src/renderer/styles/sortable.css'),
  );
  const { surfaces } = buildGeneratedSurfaces(ROOT, {});
  const generated = surfaces.find((surface) => surface.id === 'desktop.settings');
  assert.ok(generated.styleSources.some((file) => file.endsWith('styles/sortable.css')));
});

test('独立窗口 surface 纳入各自 entry 导入的 globals.css', () => {
  // resource-usage-entry.tsx:9 / sidebar-window-entry.tsx:19 /
  // ghost-panel-window-entry.tsx:21 都直接导入 globals.css,body/#root 基础
  // 样式与窗口专用规则在这些窗口实际生效。
  const globalsPath = 'apps/desktop/src/renderer/styles/globals.css';
  const catalog = catalogSurfaces();
  for (const surfaceId of [
    'desktop.window.resource-usage',
    'desktop.window.sidebar',
    'desktop.window.ghost-panel',
  ]) {
    const surface = catalog.find((entry) => entry.id === surfaceId);
    assert.ok(surface, surfaceId);
    assert.ok(
      surface.styleRoots.includes(globalsPath),
      `${surfaceId} 必须登记 globals.css`,
    );
  }
  const { surfaces } = buildGeneratedSurfaces(ROOT, {});
  for (const surfaceId of [
    'desktop.window.resource-usage',
    'desktop.window.sidebar',
    'desktop.window.ghost-panel',
  ]) {
    const generated = surfaces.find((entry) => entry.id === surfaceId);
    assert.ok(
      generated.styleSources.some((file) => file.endsWith('styles/globals.css')),
      `${surfaceId} 统计必须含 globals.css`,
    );
    // 三个窗口此前只报 4 tokens / 2 bare colors——并入全局样式后基线显著上调。
    assert.ok(generated.tokenCount > 4, `${surfaceId} token 应高于 4(实际 ${generated.tokenCount})`);
    assert.ok(generated.bareColors > 2, `${surfaceId} 裸色应高于 2(实际 ${generated.bareColors})`);
  }
});

test('语音浮窗纳入 globals.css 与直接渲染的 VoiceInputStatusNotice', () => {
  // main-entry.tsx 无条件加载 globals.css（含 data-voice-input-overlay 透明根规则）；
  // VoiceInputOverlay.tsx:1521 直接渲染 VoiceInputStatusNotice。
  const catalog = catalogSurfaces();
  const overlay = catalog.find((surface) => surface.id === 'desktop.window.voice-overlay');
  assert.ok(overlay);
  assert.ok(overlay.styleRoots.includes('apps/desktop/src/renderer/styles/globals.css'));
  assert.ok(
    overlay.reachableComponents.includes('VoiceInputStatusNotice'),
    'VoiceInputStatusNotice 必须列入可达组件',
  );
  const { surfaces } = buildGeneratedSurfaces(ROOT, {});
  const generated = surfaces.find((surface) => surface.id === 'desktop.window.voice-overlay');
  assert.ok(generated.styleSources.some((file) => file.endsWith('VoiceInputStatusNotice.tsx')));
  assert.ok(generated.styleSources.some((file) => file.endsWith('styles/globals.css')));
  // 此前 8/2/10——并入全局样式与状态条后基线显著上调。
  assert.ok(generated.tokenCount > 8, `token 应高于 8(实际 ${generated.tokenCount})`);
  assert.ok(generated.bareColors > 2, `裸色应高于 2(实际 ${generated.bareColors})`);
  assert.ok(generated.bareRadii > 10, `裸圆角应高于 10(实际 ${generated.bareRadii})`);
});

test('裸圆角统计覆盖 React style 对象的 camelCase borderRadius', () => {
  // 与 BARE_RADIUS_RE 同口径的行为级断言:经 scanStyleStats 出来的统计必须数到
  // style 对象声明。用真实文件钉死:LoginCaptchaOverlay.tsx 的 borderRadius: 18。
  const { surfaces } = buildGeneratedSurfaces(ROOT, {});
  const login = surfaces.find((surface) => surface.id === 'desktop.auth.login');
  // 上一轮口径(只认 rounded* 与 border-radius:)登录页裸圆角为 6;
  // LoginCaptchaOverlay 的 borderRadius: 18 等内联声明并入后必须更高。
  assert.ok(login.bareRadii > 6, `camelCase borderRadius 应计入裸圆角(实际 ${login.bareRadii})`);
  // 会话工作台含 ImageLightbox 的 borderRadius: '9999px'。
  const session = surfaces.find((surface) => surface.id === 'desktop.chat.session');
  assert.ok(session.bareRadii > 408, `ImageLightbox 内联圆角应计入(实际 ${session.bareRadii})`);
});

test('renderer 模块图入口双向核对: index.tsx 的参数→入口模块映射必须与 catalog 一致', () => {
  const actualEntries = extractRendererEntries(fs.readFileSync(RENDERER_INDEX_PATH, 'utf8'));
  // 与源码实况钉死:当前 3 个参数各自加载的入口模块。
  assert.deepEqual(Object.fromEntries(actualEntries), {
    resourceUsageWindow: './resource-usage-entry',
    sidebarWindow: './sidebar-window-entry',
    ghostPanelWindow: './ghost-panel-window-entry',
  });
  const covered = new Map(
    catalogSurfaces().flatMap((surface) =>
      Object.entries(surface.rendererEntryModules ?? {}),
    ),
  );
  for (const [param, module] of actualEntries) {
    assert.ok(covered.has(param), `未映射模块图入口: ${param}`);
    assert.equal(covered.get(param), module, `参数 ${param} 的入口模块不一致`);
  }
  for (const [param] of covered) {
    assert.ok(actualEntries.has(param), `已失效模块图入口登记: ${param}`);
  }
});

test('extractRendererEntries: 参数保留但分支换入口模块会被发现(fixture)', () => {
  // 这正是「只核参数名」防不住的场景:参数不动,窗口实现换成新入口。
  const swapped = `
    const urlParams = new URLSearchParams(window.location.search);
    const isSidebarWindow = urlParams.get('sidebarWindow') === '1';
    void (isSidebarWindow
      ? import('./brand-new-window-entry')
      : import('./main-entry')
    );
  `;
  assert.deepEqual(Object.fromEntries(extractRendererEntries(swapped)), {
    sidebarWindow: './brand-new-window-entry',
  });
  // 新增参数入口。
  const added = `
    const urlParams = new URLSearchParams(window.location.search);
    const isNew = urlParams.get('brandNewWindow') === '1';
    void (isNew ? import('./brand-new-entry') : import('./main-entry'));
  `;
  assert.deepEqual(Object.fromEntries(extractRendererEntries(added)), {
    brandNewWindow: './brand-new-entry',
  });
  // 注释里的 urlParams.get 不算（无 import 分支时映射为空）。
  const withComment = `
    // urlParams.get('retired-window') 已退役
    const isX = urlParams.get('live-window') === '1';
  `;
  assert.deepEqual(Object.fromEntries(extractRendererEntries(withComment)), {});
});

test('extraStyleRoots 失效引用会被报告,不静默展开为空', () => {
  const base = {
    platform: 'desktop',
    title: '测试面',
    productionEntry: 'fixture',
    reachableComponents: ['FixtureView'],
    routerPaths: [],
  };
  const catalog = [
    { ...base, id: 'desktop.test.surface', styleRoots: ['scripts/__tests__/design-inventory.test.mjs'] },
    {
      ...base,
      id: 'desktop.test.thin-shell',
      styleRoots: [],
      // 引用不存在的 surface ID —— 必须报 dangling,不能静默丢继承。
      extraStyleRoots: ['desktop.test.does-not-exist'],
    },
  ];
  const { surfaces, danglingExtraStyleRoots } = buildGeneratedSurfaces(ROOT, { catalog });
  assert.deepEqual(danglingExtraStyleRoots, ['desktop.test.thin-shell → desktop.test.does-not-exist']);
  const thin = surfaces.find((surface) => surface.id === 'desktop.test.thin-shell');
  assert.deepEqual(thin.styleSources, []);
  // 真实 catalog 上不得有失效引用。
  const real = buildGeneratedSurfaces(ROOT, {});
  assert.deepEqual(real.danglingExtraStyleRoots, []);
});

test('defaultHumanSeed: 全量 legacy + unassigned,protected 与迁移状态正交', () => {
  const seed = defaultHumanSeed(catalogSurfaces());
  const ids = extractHumanSurfaceIds(seed);
  assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)));
  assert.equal(ids.includes('desktop.auth.login'), true);
  assert.equal(seed.includes('|  |'), false, '不得有空 owner 单元格');
  assert.equal(seed.includes('unassigned'), true);
  assert.equal(seed.includes('| legacy |'), true);
  assert.equal(seed.includes('| pilot |'), false);
  assert.equal(seed.includes('待 DS-9 增量'), true);
  assert.equal(seed.includes('cindy-updater/ui'), true);
  assert.equal(seed.includes('DESIGN.md §16 登录链路'), true);
  assert.equal(seed.includes('DESIGN.md §15 CINDY 皮肤族'), true);
  assert.equal(seed.includes('DESIGN.md §10 语义豁免色族消费者'), true);
  assert.equal(seed.includes('2px status micro-cells'), true);
});

test('真实台账文件含 GENERATED 标记,人工区覆盖全部 surface ID', () => {
  const doc = fs.readFileSync(INVENTORY_PATH, 'utf8');
  assert.equal(doc.includes(GENERATED_BEGIN), true);
  assert.equal(doc.includes(GENERATED_END), true);
  const catalogIds = catalogSurfaces().map((surface) => surface.id).sort();
  const humanIds = extractHumanSurfaceIds(splitInventoryDocument(doc).suffix).sort();
  assert.deepEqual(humanIds, catalogIds);
  assert.equal(findOrphanHumanIds(splitInventoryDocument(doc).suffix, catalogIds).length, 0);
});

test('ensureHumanRows 补行后人工表仍按 surface ID 有序', () => {
  const generated = renderGeneratedBlock([tinySurface()], {
    snapshotDate: '2026-08-30',
    generateCommand: 'pnpm design:inventory',
    routerCoverage: { mapped: [], missing: [] },
    redirects: [],
  });
  const human =
    '\n## 人工标注\n\n| ID | owner | 迁移状态 | protected | 目标道路 | 下一动作 |\n| --- | --- | --- | --- | --- | --- |\n| `desktop.test.surface` | kiro | pilot | x | y | z |\n| `desktop.test.zz-tail` | kiro | pilot | x | y | z |\n';
  const existing = `# Cindy 生产 UI 台账\n${generated}${human}`;
  const nextSurfaces = [
    { id: 'desktop.test.surface' },
    { id: 'desktop.test.a-new' },
    { id: 'desktop.test.zz-tail' },
  ];
  const merged = ensureHumanRows(existing, nextSurfaces);
  const ids = extractHumanSurfaceIds(splitInventoryDocument(merged).suffix);
  assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)));
  assert.deepEqual(ids, ['desktop.test.a-new', 'desktop.test.surface', 'desktop.test.zz-tail']);
});

test.describe('CLI', { concurrency: false }, () => {
  test('CLI --check 在当前台账上通过', () => {
    const result = spawnSync(process.execPath, [CLI_PATH, '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /GENERATED 区块最新/);
  });

  test('CLI 连续两次 generate,GENERATED 区块字节一致', () => {
    // 同样在临时拷贝上跑(CINDY_INVENTORY_DOC):真实台账文件不受测试写盘影响。
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'design-inventory-idem-'));
    const sandboxDoc = path.join(sandbox, 'design-inventory.md');
    fs.copyFileSync(INVENTORY_PATH, sandboxDoc);
    const run = () =>
      spawnSync(process.execPath, [CLI_PATH], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, CINDY_INVENTORY_DOC: sandboxDoc },
      });
    try {
      const firstRun = run();
      assert.equal(firstRun.status, 0, firstRun.stderr || firstRun.stdout);
      const first = splitInventoryDocument(fs.readFileSync(sandboxDoc, 'utf8')).generated;
      const secondRun = run();
      assert.equal(secondRun.status, 0, secondRun.stderr || secondRun.stdout);
      const second = splitInventoryDocument(fs.readFileSync(sandboxDoc, 'utf8')).generated;
      assert.equal(normalizeDocEol(first), normalizeDocEol(second));
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('CLI 测试不改写真实台账文件', () => {
    // 钉死 CINDY_INVENTORY_DOC 沙箱机制的意图:CLI 测试组跑完后,真实台账文件的
    // 字节必须与本组开始前一致。对比「组内首个用例开跑前」的快照而非 git HEAD,
    // 开发者未提交的台账改动不算测试污染。
    const before = fs.readFileSync(INVENTORY_PATH, 'utf8');
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'design-inventory-guard-'));
    const sandboxDoc = path.join(sandbox, 'design-inventory.md');
    fs.copyFileSync(INVENTORY_PATH, sandboxDoc);
    try {
      const gen = spawnSync(process.execPath, [CLI_PATH], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, CINDY_INVENTORY_DOC: sandboxDoc },
      });
      assert.equal(gen.status, 0, gen.stderr || gen.stdout);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
    const after = fs.readFileSync(INVENTORY_PATH, 'utf8');
    assert.equal(
      normalizeDocEol(after),
      normalizeDocEol(before),
      '真实台账被测试改写:CLI 必须经 CINDY_INVENTORY_DOC 重定向写盘',
    );
  });

  test('CLI generate 刷新快照日期为当天;--check 沿用文件内既有日期不跨日假红', () => {
    const today = new Date().toISOString().slice(0, 10);
    // 在临时目录拷贝上跑 CLI（CINDY_INVENTORY_DOC 重定向写读）：统计仍扫真实源码，
    // 但 generate 不再改写受版本控制的真实台账——跨日跑 test:runner 不留脏工作区。
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'design-inventory-cli-'));
    const sandboxDoc = path.join(sandbox, 'design-inventory.md');
    fs.copyFileSync(INVENTORY_PATH, sandboxDoc);
    const run = (args) =>
      spawnSync(process.execPath, [CLI_PATH, ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, CINDY_INVENTORY_DOC: sandboxDoc },
      });
    try {
      // generate 用当天日期写盘。
      const gen = run([]);
      assert.equal(gen.status, 0, gen.stderr || gen.stdout);
      const doc = fs.readFileSync(sandboxDoc, 'utf8');
      assert.match(doc, new RegExp(`计数快照日期：${today}。`));
      // 把日期改成 2020(早于任何真实快照),--check 必须沿用文件里的日期重渲染
      // → 不因跨日误报。
      const aged = doc.replace(
        /计数快照日期：\d{4}-\d{2}-\d{2}。/,
        '计数快照日期：2020-01-01。',
      );
      fs.writeFileSync(sandboxDoc, aged, 'utf8');
      const agedCheck = run(['--check']);
      assert.equal(agedCheck.status, 0, agedCheck.stderr || agedCheck.stdout);
      // 再 generate 一次,确认写回的是当天(证明日期不是从旧文件继承的)。
      const restore = run([]);
      assert.equal(restore.status, 0, restore.stderr || restore.stdout);
      assert.match(
        fs.readFileSync(sandboxDoc, 'utf8'),
        new RegExp(`计数快照日期：${today}。`),
      );
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

test('os.tmpdir 仅作隔离证明:测试不得把绝对路径写进 GENERATED', () => {
  const generated = renderGeneratedBlock([tinySurface()], {
    snapshotDate: '2026-08-30',
    generateCommand: 'pnpm design:inventory',
    routerCoverage: { mapped: [], missing: [] },
    redirects: [],
  });
  assert.equal(generated.includes(os.tmpdir()), false);
  assert.equal(generated.includes(ROOT), false);
});
