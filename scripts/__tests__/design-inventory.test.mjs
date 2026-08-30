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
  ROUTER_REL_PATH,
  buildGeneratedSurfaces,
  catalogSurfaces,
  compareGenerated,
  defaultHumanSeed,
  ensureHumanRows,
  extractHumanSurfaceIds,
  extractRouterFacts,
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

test('catalog 含 App 顶层非路由生产 UI(LegacyMigrationDialog)且统计非零', () => {
  const catalog = catalogSurfaces();
  const migration = catalog.find((surface) => surface.id === 'desktop.auth.legacy-migration');
  assert.ok(migration, 'catalog 必须登记 desktop.auth.legacy-migration');
  assert.deepEqual(migration.routerPaths, []);
  assert.equal(migration.productionEntry.includes('LegacyMigrationDialog'), true);
  const surfaces = buildGeneratedSurfaces(ROOT, {});
  const generated = surfaces.find((surface) => surface.id === 'desktop.auth.legacy-migration');
  assert.ok(generated, 'GENERATED 必须含 desktop.auth.legacy-migration 行');
  assert.ok(generated.tokenCount > 0, '迁移弹窗消费 --login-* token,统计不得为 0');
  assert.ok(
    generated.styleSources.includes('apps/desktop/src/renderer/components/auth/LegacyMigrationDialog.tsx'),
  );
});

test('薄壳 surface 经 extraStyleRoots 继承被委托 surface 的样式事实', () => {
  const surfaces = buildGeneratedSurfaces(ROOT, {});
  const login = surfaces.find((surface) => surface.id === 'desktop.auth.login');
  const addAccount = surfaces.find((surface) => surface.id === 'desktop.auth.add-account');
  assert.ok(login && addAccount);
  // AddAccountLoginPage 渲染即委托 LoginPage;统计必须与登录页同一组事实源,不再全 0。
  assert.deepEqual(
    { tokens: addAccount.tokenCount, colors: addAccount.bareColors, radii: addAccount.bareRadii },
    { tokens: login.tokenCount, colors: login.bareColors, radii: login.bareRadii },
  );
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
    const run = () =>
      spawnSync(process.execPath, [CLI_PATH], {
        cwd: ROOT,
        encoding: 'utf8',
      });
    const firstRun = run();
    assert.equal(firstRun.status, 0, firstRun.stderr || firstRun.stdout);
    const first = splitInventoryDocument(fs.readFileSync(INVENTORY_PATH, 'utf8')).generated;
    const secondRun = run();
    assert.equal(secondRun.status, 0, secondRun.stderr || secondRun.stdout);
    const second = splitInventoryDocument(fs.readFileSync(INVENTORY_PATH, 'utf8')).generated;
    assert.equal(normalizeDocEol(first), normalizeDocEol(second));
  });

  test('CLI generate 刷新快照日期为当天;--check 沿用文件内既有日期不跨日假红', () => {
    const today = new Date().toISOString().slice(0, 10);
    const run = (args) =>
      spawnSync(process.execPath, [CLI_PATH, ...args], { cwd: ROOT, encoding: 'utf8' });
    // generate 用当天日期写盘。
    const gen = run([]);
    assert.equal(gen.status, 0, gen.stderr || gen.stdout);
    const doc = fs.readFileSync(INVENTORY_PATH, 'utf8');
    assert.match(doc, new RegExp(`计数快照日期：${today}。`));
    // 把日期改成昨天,--check 必须沿用文件里的日期重渲染 → 不因跨日误报。
    const aged = doc.replace(
      /计数快照日期：\d{4}-\d{2}-\d{2}。/,
      '计数快照日期：2020-01-01。',
    );
    fs.writeFileSync(INVENTORY_PATH, aged, 'utf8');
    const agedCheck = run(['--check']);
    assert.equal(agedCheck.status, 0, agedCheck.stderr || agedCheck.stdout);
    // 再 generate 一次把日期复原,并确认写回的是当天。
    const restore = run([]);
    assert.equal(restore.status, 0, restore.stderr || restore.stdout);
    assert.match(
      fs.readFileSync(INVENTORY_PATH, 'utf8'),
      new RegExp(`计数快照日期：${today}。`),
    );
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
