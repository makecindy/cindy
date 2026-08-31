/**
 * Desktop 生产可达 UI 台账：事实提取 + 混合 markdown 渲染。
 *
 * 生成器只重写 GENERATED 区块；人工区按 surface ID 对齐，生成器不得删除。
 * 事实源三处交叉（DS-2a 计划 §2）：
 *   1. apps/desktop/src/renderer/router.tsx 集中路由表
 *   2. renderer 窗口类型分支（index.tsx / main-entry.tsx）
 *   3. main 侧独立 BrowserWindow
 *
 * 纯 <Navigate> 与运行期 redirect 不算 surface。粒度是用户能一眼指认的一块界面,
 * 不是每个 React 组件。
 */

import fs from 'node:fs';
import path from 'node:path';

import { matchBareColors } from './hardcoded-color-match.mjs';

export const GENERATED_BEGIN = '<!-- BEGIN GENERATED: surface-facts -->';
export const GENERATED_END = '<!-- END GENERATED: surface-facts -->';

export const INVENTORY_REL_PATH = 'docs/design-rules/design-inventory.md';
export const ROUTER_REL_PATH = 'apps/desktop/src/renderer/router.tsx';

/**
 * 布局壳：有 children 的包裹层，本身不是用户可指认的 surface。
 * 不在此集合、又带 element 的路由一律当生产 surface；漏登记会让 --check 报「未映射」，
 * 逼人做一次决策，而不是被静默丢掉。
 */
const LAYOUT_ROUTE_COMPONENTS = new Set([
  'GuestRoute',
  'ProtectedRoute',
  'LocalDbGate',
  'MainLayout',
  'CCAgentFeatureLayout',
  'SkillhubFeatureLayout',
]);

/** 运行期跳转组件：与 <Navigate> 同类，不是 surface。 */
const RUNTIME_REDIRECT_COMPONENTS = new Map([
  ['CCAgentIndexRedirect', '(runtime session redirect)'],
]);

const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.mjs', '.cjs', '.html']);
const SKIP_DIR_NAMES = new Set([
  '__tests__',
  '__mocks__',
  'node_modules',
  '.git',
  'dist',
  'out',
  'coverage',
]);

/**
 * 与 hardcoded-color-audit 并列的粗粒度裸圆角匹配：不另造颜色规则。
 * 覆盖三种声明形态：tailwind `rounded*` class、CSS `border-radius:`、
 * React style 对象的 camelCase `borderRadius:`（LoginCaptchaOverlay 等组件
 * 用内联 style 声明圆角，kebab-case 正则会系统性漏掉它们）。
 */
export const BARE_RADIUS_RE = /\b(?:rounded(?:-(?:none|sm|md|lg|xl|2xl|3xl|full))?|border-radius\s*:|borderRadius\s*:)/g;

/**
 * 裸圆角匹配（工厂：每次调用返回全新 /g 正则，杜绝共享 lastIndex 状态）。
 * 模式与 BARE_RADIUS_RE 完全一致；BARE_RADIUS_RE 保留导出仅供诊断展示。
 */
export function createBareRadiusRe() {
  return /\b(?:rounded(?:-(?:none|sm|md|lg|xl|2xl|3xl|full))?|border-radius\s*:|borderRadius\s*:)/g;
}

function posixRel(value) {
  return String(value).replace(/\\/g, '/');
}

export function normalizeDocEol(text) {
  return String(text).replace(/\r\n/g, '\n');
}

function cell(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
}

/**
 * 确定性排序比较器：用码点序（< / >），不用 localeCompare——ICU 版本在
 * Windows/Linux/macOS 间对连字符等标点的排序权重不一致，会让 GENERATED
 * 在不同平台渲染出不同字节序，--check 跨平台假红。码点序在任何 Node 上逐字节稳定。
 */
function byCodepoints(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean).map(String))].sort(byCodepoints);
}

function walkFiles(absDir, relDir, files) {
  if (!fs.existsSync(absDir)) return;
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  entries.sort((a, b) => byCodepoints(a.name, b.name));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const absPath = path.join(absDir, entry.name);
    const relPath = posixRel(path.posix.join(relDir, entry.name));
    if (entry.isDirectory()) {
      walkFiles(absPath, relPath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.posix.extname(entry.name);
    if (!SCAN_EXTENSIONS.has(ext)) continue;
    files.push(relPath);
  }
}

function collectStyleFiles(repoRoot, roots, { missing = [] } = {}) {
  const files = [];
  for (const relRoot of uniqueSorted(roots)) {
    const abs = path.join(repoRoot, ...relRoot.split('/'));
    // 不存在的 root 记入 missing 交由调用方报错，而不是静默跳过：源码移动/误拼后
    // 统计只会缩减甚至归零，--check 仍通过，台账会掩盖统计丢失。
    if (!fs.existsSync(abs)) {
      missing.push(posixRel(relRoot));
      continue;
    }
    const stat = fs.statSync(abs);
    if (stat.isFile()) {
      files.push(posixRel(relRoot));
      continue;
    }
    if (stat.isDirectory()) walkFiles(abs, posixRel(relRoot), files);
  }
  return uniqueSorted(files);
}

const TOKEN_REF_RE = /(?:hsl\(\s*var\(|var\()(--[a-zA-Z0-9-]+)/g;

/**
 * 台账统计层的裸色过滤，与共享匹配器刻意分离：
 * `matchBareColors` 与 hardcoded-color-audit 共用（治理合同：两边必须同一套正则），
 * audit 扫 diff 新增行的宽松口径不能动；台账按「迁移债务」的语义收敛两类假命中——
 *   1. `hsl(var(--token))`：HEX 正则的 `#` 不会命中，但 rgb/hsl 分支会把函数体前缀
 *      `hsl(var(--content-area)` 整段当命中——这是语义 token 消费，不是裸值；
 *   2. 注释里的 PR 编号（`PR #104`）、坐标（`@698,1046`）等 3-8 位十六进制形状文本
 *      ——注释引用不是组件样式。
 */
export function filterInventoryBareColors(hits) {
  return hits.filter((hit) => !/^(?:hsl|rgb)a?\(\s*var\(/.test(hit));
}

/**
 * 统计前统一剥注释：CSS 的 `/* ... *​/` 块注释与 TS/TSX 的块/行注释同样不是生产
 * 消费（globals.css 注释里的示例色值曾被计入权威基线）；`//` 行注释对 CSS 无害
 * （CSS 没有该语法）。radius/token 同口径。
 */
function statsSourceForColorScan(source) {
  return stripJsComments(source);
}

function scanStyleStats(repoRoot, styleRoots, { missingRoots = [] } = {}) {
  const files = collectStyleFiles(repoRoot, styleRoots, { missing: missingRoots });
  let bareColors = 0;
  let bareRadii = 0;
  const tokenHits = new Set();
  for (const relPath of files) {
    const source = fs.readFileSync(path.join(repoRoot, ...relPath.split('/')), 'utf8');
    const scanSource = statsSourceForColorScan(source);
    bareColors += filterInventoryBareColors(matchBareColors(scanSource)).length;
    bareRadii += (scanSource.match(createBareRadiusRe()) ?? []).length;
    for (const match of scanSource.matchAll(TOKEN_REF_RE)) tokenHits.add(match[1]);
  }
  return { files, bareColors, bareRadii, tokenCount: tokenHits.size };
}

/** 去掉块注释与整行 // 注释，避免插在 `{` 与 `path` 之间导致漏提取（如 `/issues`）。不碰字符串里的 `https://`。 */
export function stripJsComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const OPEN_TO_CLOSE = { '{': '}', '[': ']' };

/** 返回与 source[open] 配对的闭括号下标；跳过字符串字面量。找不到返回 -1。 */
function matchingBracket(source, open) {
  const close = OPEN_TO_CLOSE[source[open]];
  if (!close) return -1;
  let depth = 0;
  let quote = '';
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const ROUTE_KEY_RE = /(path|index|element|children)\s*:/y;

/** 抽出对象字面量体里 depth-0 的路由键，忽略嵌套对象与 JSX 属性里的同名键。 */
function topLevelRouteKeys(body) {
  const keys = new Map();
  let depth = 0;
  let quote = '';
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{' || char === '[') {
      depth++;
      continue;
    }
    if (char === '}' || char === ']') {
      depth--;
      continue;
    }
    if (depth !== 0) continue;
    ROUTE_KEY_RE.lastIndex = i;
    const match = ROUTE_KEY_RE.exec(body);
    if (!match) continue;
    if (!keys.has(match[1])) keys.set(match[1], ROUTE_KEY_RE.lastIndex);
    i = ROUTE_KEY_RE.lastIndex - 1;
  }
  return keys;
}

function parseRouteObject(body) {
  const keys = topLevelRouteKeys(body);
  const route = { path: undefined, index: false, component: undefined, to: undefined, children: [] };

  const pathAt = keys.get('path');
  if (pathAt !== undefined) route.path = /\s*'([^']*)'/.exec(body.slice(pathAt))?.[1];

  const indexAt = keys.get('index');
  if (indexAt !== undefined) route.index = /^\s*true/.test(body.slice(indexAt));

  const elementAt = keys.get('element');
  if (elementAt !== undefined) {
    const element = body.slice(elementAt);
    route.component = /^\s*<([A-Za-z][\w.]*)/.exec(element)?.[1];
    if (route.component === 'Navigate') route.to = /\bto="([^"]*)"/.exec(element)?.[1] ?? '';
  }

  const childrenAt = keys.get('children');
  if (childrenAt !== undefined) {
    const open = body.indexOf('[', childrenAt);
    if (open !== -1) route.children = parseRouteArray(body, open);
  }
  return route;
}

/** 解析 source[open] 起的路由数组字面量，返回同层路由对象。 */
function parseRouteArray(source, open) {
  const close = matchingBracket(source, open);
  if (close === -1) return [];
  const routes = [];
  let i = open + 1;
  while (i < close) {
    if (source[i] !== '{') {
      i++;
      continue;
    }
    const objectClose = matchingBracket(source, i);
    if (objectClose === -1 || objectClose > close) break;
    routes.push(parseRouteObject(source.slice(i + 1, objectClose)));
    i = objectClose + 1;
  }
  return routes;
}

function joinRoutePath(parentPath, segment) {
  if (segment === undefined || segment === '') return parentPath;
  if (segment.startsWith('/')) return segment === '/' ? '' : segment.replace(/\/$/, '');
  return `${parentPath}/${segment}`;
}

/**
 * 从 router.tsx 抽出路由事实，按对象树递归、全路径自己拼，不维护第二份路径前缀表。
 * 三类去向：布局壳（有 children 的包裹层）、redirect（<Navigate> 与运行期跳转组件）、
 * 生产 surface。index 路由继承父级全路径，所以 `/login`、`/skillhub/local` 无需特判。
 */
export function extractRouterFacts(routerSource) {
  const source = stripJsComments(routerSource);
  const open = source.indexOf('[', source.indexOf('createHashRouter'));
  const facts = { production: [], redirects: [], layouts: [] };
  if (open === -1) return facts;

  const visit = (route, parentPath) => {
    const fullPath = route.index ? parentPath : joinRoutePath(parentPath, route.path);
    const displayPath = fullPath === '' ? '/' : fullPath;
    const { component } = route;

    if (component === 'Navigate') {
      facts.redirects.push({ path: displayPath, to: route.to ?? '', kind: 'Navigate' });
    } else if (component && RUNTIME_REDIRECT_COMPONENTS.has(component)) {
      facts.redirects.push({
        path: displayPath,
        to: RUNTIME_REDIRECT_COMPONENTS.get(component),
        kind: component,
      });
    } else if (component && LAYOUT_ROUTE_COMPONENTS.has(component)) {
      facts.layouts.push({ path: displayPath, component });
    } else if (component) {
      facts.production.push({ path: displayPath, component });
    }

    for (const child of route.children) visit(child, fullPath);
  };

  for (const route of parseRouteArray(source, open)) visit(route, '');

  const byPath = (a, b) => byCodepoints(a.path, b.path);
  facts.production.sort((a, b) => byPath(a, b) || byCodepoints(a.component, b.component));
  facts.redirects.sort((a, b) => byPath(a, b) || byCodepoints(a.to, b.to));
  facts.layouts.sort((a, b) => byPath(a, b) || byCodepoints(a.component, b.component));
  return facts;
}

export const MAIN_ENTRY_REL_PATH = 'apps/desktop/src/renderer/main-entry.tsx';
export const RENDERER_INDEX_REL_PATH = 'apps/desktop/src/renderer/index.tsx';

/**
 * 从 main-entry.tsx 抽出 `?view=` 分支事实：每个 `view === '<name>'` 分支渲染一个
 * 非 router 生产入口。返回「view 名 → 渲染组件」映射——只比 view 名不够：view 名
 * 保留但分支改渲染别的组件（换浮窗实现）时，catalog 的 productionEntry /
 * reachableComponents / styleRoots 仍指向旧组件，--check 却照样通过。
 * 配对方式：`const isX = view === '<name>'` 声明后，`if (isX)` 块内第一个
 * `const { <Component> } = await import(...)` 就是该分支的入口组件。
 */
export function extractViewEntries(mainEntrySource) {
  const source = stripJsComments(mainEntrySource);
  const mappings = new Map();
  // view 名 → flag 变量名
  const flagFor = new Map();
  for (const match of source.matchAll(/const (is\w+)\s*=\s*view\s*===\s*'([^']+)'/g)) {
    flagFor.set(match[1], match[2]);
  }
  // flag 变量 → if 块内解构的组件
  for (const match of source.matchAll(/if \((is\w+)\)[^{]*\{\s*const \{ (\w+) \} = await import\(/g)) {
    const viewName = flagFor.get(match[1]);
    if (viewName) mappings.set(viewName, match[2]);
  }
  return mappings;
}

/**
 * 从 renderer/index.tsx 抽出模块图分发入口：`urlParams.get('<param>')` 条件决定
 * 加载哪个 entry 模块（resource-usage / sidebar-window / ghost-panel / main）。
 * 返回「参数名 → 入口模块」映射——只核参数名不够：参数保留但分支改加载别的入口
 * 时（换窗口实现），catalog 的 productionEntry / styleRoots 仍指向旧窗口，
 * --check 却照样通过。映射核对与路由组件核对同构。
 */
export function extractRendererEntries(indexSource) {
  const source = stripJsComments(indexSource);
  // 分发是嵌套三元链：参数条件先集中声明，import 分支按链序展开
  // `param1 ? import(a) : param2 ? import(b) : ... : import(main)`。
  // 从后往前配对：非 fallback 的 import 与最近的未消费参数按序对应（链序一致），
  // 最末的 main 入口是 fallback、无参数，自然不参与映射。
  const params = [...source.matchAll(/urlParams\.get\('([^']+)'\)/g)].map((m) => m[1]);
  const imports = [...source.matchAll(/import\('([^']+)'\)/g)].map((m) => m[1]);
  const mappings = new Map();
  const conditionalImports = imports.slice(0, params.length);
  conditionalImports.forEach((entryModule, index) => {
    if (params[index]) mappings.set(params[index], entryModule);
  });
  return mappings;
}

/**
 * 生产可达 surface 目录。ID 稳定,不随文件移动变化。
 * 路由级 surface 必须覆盖 router.tsx 里除 redirect 外的每条生产路径。
 */
export function catalogSurfaces() {
  return [
    {
      id: 'desktop.shell.main-layout',
      platform: 'desktop',
      title: '主窗口壳（标题栏 / 左右栏 / 内容区）',
      productionEntry:
        'main BrowserWindow → renderer/index.tsx → main-entry.tsx → App → MainLayout (`#/` 受保护壳)',
      reachableComponents: [
        'MainLayout',
        'Sidebar',
        'RightSidebar',
        'WindowControls',
        'ChromeActions',
        // MainLayout 直接挂载的全局浮层（更新提示/飞书冲突/媒体预览/导入向导），
        // 触发时都是生产可见 UI——不登记会漏掉它们的样式事实与保护状态。
        'GhostMediaLightboxHost',
        'UpdateNoticeDialog',
        'FeishuConflictDialogHost',
        'SessionShareImportWizard',
        // RightSidebar 的内容实现:TabBar/下拉/插件体都在 features/right-sidebar。
        'RightSidebarShell',
      ],
      styleRoots: [
        'apps/desktop/src/renderer/components/layout',
        'apps/desktop/src/renderer/components/sidebar',
        'apps/desktop/src/renderer/components/title-bar',
        'apps/desktop/src/renderer/layout',
        'apps/desktop/src/renderer/features/right-sidebar',
        'apps/desktop/src/renderer/cindy-brain/GhostMediaLightboxHost.tsx',
        'apps/desktop/src/renderer/components/UpdateNoticeDialog.tsx',
        'apps/desktop/src/renderer/components/feishuBot',
        'apps/desktop/src/renderer/components/settings/SessionShareImportWizard.tsx',
        // main-entry.tsx 无条件导入 globals.css，其中 CINDY 皮肤段直接改写
        // MainLayout 根容器与侧栏的背景/token/模糊——全局基础样式是主窗口壳的
        // 实际生效样式源（其它 surface 消费同一文件时同样按各自入口登记）。
        'apps/desktop/src/renderer/styles/globals.css',
      ],
      routerPaths: [],
    },
    {
      id: 'desktop.auth.login',
      platform: 'desktop',
      title: '登录页',
      productionEntry: 'hash `/login`（GuestRoute → LoginPage）',
      reachableComponents: ['LoginPage', 'LoginBrandStage', 'LoginControls', 'LoginCaptchaOverlay'],
      styleRoots: [
        'apps/desktop/src/renderer/components/login/LoginPage.tsx',
        'apps/desktop/src/renderer/components/login/LoginBrandStage.tsx',
        'apps/desktop/src/renderer/components/login/LoginControls.tsx',
        'apps/desktop/src/renderer/components/login/LoginCaptchaOverlay.tsx',
        'apps/desktop/src/renderer/components/login/loginDesignTokens.ts',
      ],
      routerPaths: ['/login'],
      routeEntryComponents: { '/login': 'LoginPage' },
    },
    {
      id: 'desktop.auth.add-account',
      platform: 'desktop',
      title: '添加账号',
      productionEntry: 'hash `/add-account`（ProtectedRoute → AddAccountLoginPage）',
      reachableComponents: ['AddAccountLoginPage'],
      // AddAccountLoginPage 是薄壳,渲染即委托 <LoginPage intent="add-account">;
      // 样式事实在 LoginPage 一侧,只扫壳会得到全 0 的假统计,故并入登录皮肤同组 roots。
      styleRoots: ['apps/desktop/src/renderer/components/login/AddAccountLoginPage.tsx'],
      extraStyleRoots: ['desktop.auth.login'],
      routerPaths: ['/add-account'],
      routeEntryComponents: { '/add-account': 'AddAccountLoginPage' },
    },
    {
      id: 'desktop.chat.session',
      platform: 'desktop',
      title: '会话工作台',
      productionEntry:
        'hash `/cc-agent/:sessionId`；副窗经 `/cc-agent/boot` 解析后落到同一会话视图',
      reachableComponents: [
        'CCAgentSessionView',
        'CCAgentFeatureLayout',
        'AssistantMessage',
        'ChatInput',
        'PermissionPrompt',
      ],
      styleRoots: [
        'apps/desktop/src/renderer/features/cc-agent/CCAgentSessionView.tsx',
        'apps/desktop/src/renderer/features/cc-agent/CCAgentFeatureLayout.tsx',
        'apps/desktop/src/renderer/components/chat',
        'apps/desktop/src/renderer/components/new-chat',
      ],
      routerPaths: ['/cc-agent/:sessionId', '/cc-agent/boot'],
      routeEntryComponents: { '/cc-agent/:sessionId': 'CCAgentSessionView', '/cc-agent/boot': 'SecondaryWindowBootGate' },
    },
    {
      id: 'desktop.chat.new-draft',
      platform: 'desktop',
      title: '新建任务草稿页',
      productionEntry: 'hash `/cc-agent/new`（NewMakerDraftRoute）',
      reachableComponents: ['NewMakerDraftRoute'],
      styleRoots: ['apps/desktop/src/renderer/features/cc-agent/NewMakerDraftRoute.tsx'],
      routerPaths: ['/cc-agent/new'],
      routeEntryComponents: { '/cc-agent/new': 'NewMakerDraftRoute' },
    },
    {
      id: 'desktop.chat.orca-workflow',
      platform: 'desktop',
      title: 'Orca 协同工作台',
      productionEntry: 'hash `/cc-agent/orca/:sessionId`（OrcaWorkflowRoute）',
      reachableComponents: [
        'OrcaWorkflowRoute',
        'OrcaSplitView',
        'OrcaWorkerPanel',
        'CCAgentSessionView',
      ],
      styleRoots: [
        'apps/desktop/src/renderer/features/cc-agent/OrcaWorkflowRoute.tsx',
        'apps/desktop/src/renderer/features/cc-agent/OrcaSplitView.tsx',
        'apps/desktop/src/renderer/features/cc-agent/OrcaWorkerPanel.tsx',
      ],
      // OrcaSplitView / OrcaWorkerPanel 都直接渲染 <CCAgentSessionView compact orcaMode>:
      // 会话视图本体(chat 组件、composer 等)的样式事实在 desktop.chat.session 一侧,
      // 只扫三个 Orca 包装文件会把完整聊天界面统计成全 0。
      extraStyleRoots: ['desktop.chat.session'],
      routerPaths: ['/cc-agent/orca/:sessionId'],
      routeEntryComponents: { '/cc-agent/orca/:sessionId': 'OrcaWorkflowRoute' },
    },
    {
      id: 'desktop.chat.scheduled',
      platform: 'desktop',
      title: '调度任务列表',
      productionEntry: 'hash `/cc-agent/scheduled`（SchedulerPage）',
      reachableComponents: ['SchedulerPage'],
      styleRoots: ['apps/desktop/src/renderer/features/scheduler'],
      routerPaths: ['/cc-agent/scheduled'],
      routeEntryComponents: { '/cc-agent/scheduled': 'SchedulerPage' },
    },
    {
      id: 'desktop.chat.files',
      platform: 'desktop',
      title: '工作目录文件浏览',
      productionEntry: 'hash `/cc-agent/files/:sessionId`（WorkdirBrowseRoute）',
      reachableComponents: ['WorkdirBrowseRoute', 'FileTreeView', 'FileBodyView'],
      styleRoots: ['apps/desktop/src/renderer/features/cc-agent/workdir-browse'],
      routerPaths: ['/cc-agent/files/:sessionId'],
      routeEntryComponents: { '/cc-agent/files/:sessionId': 'WorkdirBrowseRoute' },
    },
    {
      id: 'desktop.issues.guide',
      platform: 'desktop',
      title: 'Issue 引导页',
      productionEntry: 'hash `/issues`（IssueTrackerFeatureLayout，已迁 GitHub 后的引导页）',
      reachableComponents: ['IssueTrackerFeatureLayout'],
      styleRoots: ['apps/desktop/src/renderer/features/issue-tracker'],
      routerPaths: ['/issues'],
      routeEntryComponents: { '/issues': 'IssueTrackerFeatureLayout' },
    },
    {
      id: 'desktop.skillhub.local',
      platform: 'desktop',
      title: 'SkillHub 本地技能',
      productionEntry:
        'hash `/skillhub/local` 及详情 `/skillhub/local/:kind/global/:name`、`/skillhub/local/:kind/project/:projectHash/:name`',
      // SkillhubHomeView 直接渲染 PluginManagementLayout（features/plugin 共享布局）、
      // SkillhubMarketPreviewPanel 与 InstallTargetPicker——只扫三个路由组件文件
      // 会漏掉这些子组件的样式事实。
      reachableComponents: [
        'SkillhubHomeView',
        'SkillhubDetailView',
        'SkillhubFeatureLayout',
        'PluginManagementLayout',
        'SkillhubMarketPreviewPanel',
        'InstallTargetPicker',
      ],
      styleRoots: [
        'apps/desktop/src/renderer/features/skillhub/SkillhubHomeView.tsx',
        'apps/desktop/src/renderer/features/skillhub/SkillhubDetailView.tsx',
        'apps/desktop/src/renderer/features/skillhub/SkillhubFeatureLayout.tsx',
        'apps/desktop/src/renderer/features/skillhub/SkillhubMarketPreviewPanel.tsx',
        'apps/desktop/src/renderer/features/skillhub/components/InstallTargetPicker.tsx',
        'apps/desktop/src/renderer/features/plugin/PluginManagementLayout.tsx',
      ],
      routerPaths: [
        '/skillhub/local',
        '/skillhub/local/:kind/global/:name',
        '/skillhub/local/:kind/project/:projectHash/:name',
      ],
      routeEntryComponents: { '/skillhub/local': 'SkillhubHomeView', '/skillhub/local/:kind/global/:name': 'SkillhubDetailView', '/skillhub/local/:kind/project/:projectHash/:name': 'SkillhubDetailView' },
    },
    {
      id: 'desktop.skillhub.market',
      platform: 'desktop',
      title: 'SkillHub 市场',
      productionEntry: 'hash `/skillhub/market`（SkillhubMarketListView）',
      // 市场页直接渲染的子组件（MarketCard / InstallTargetPicker / 预览面板 / 两个编辑
      // 弹窗）在 components/ 与同目录下，只扫入口文件会漏掉它们的全部样式事实。
      reachableComponents: [
        'SkillhubMarketListView',
        'MarketCard',
        'InstallTargetPicker',
        'SkillhubMarketPreviewPanel',
        'MarketInfoEditDialog',
        'VisibilityEditorDialog',
      ],
      styleRoots: [
        'apps/desktop/src/renderer/features/skillhub/SkillhubMarketListView.tsx',
        'apps/desktop/src/renderer/features/skillhub/SkillhubMarketPreviewPanel.tsx',
        'apps/desktop/src/renderer/features/skillhub/components',
      ],
      routerPaths: ['/skillhub/market'],
      routeEntryComponents: { '/skillhub/market': 'SkillhubMarketListView' },
    },
    {
      id: 'desktop.settings',
      platform: 'desktop',
      title: '设置',
      productionEntry:
        'hash `/settings`（SettingsView；tab 含 general / personalization / providers / billing / usage / voice-input / im-bot / shortcuts / agent-island / import / remote-control / ghosts / builtin-tools / computer-use / help / about）',
      reachableComponents: ['SettingsView'],
      styleRoots: [
        'apps/desktop/src/renderer/components/settings',
        // providers tab 的拖拽排序行(provider-settings-sortable-row)样式定义在
        // sortable.css,由 main-entry.tsx 无条件导入;会话队列与侧栏消费同一文件,
        // 各自 surface 按同样方式登记共享全局样式源。
        'apps/desktop/src/renderer/styles/sortable.css',
      ],
      routerPaths: ['/settings'],
      routeEntryComponents: { '/settings': 'SettingsView' },
    },
    {
      id: 'desktop.plugins.installed',
      platform: 'desktop',
      title: '已装插件',
      productionEntry: 'hash `/plugins`（GhostPluginPage）',
      // GhostPluginPage 直接渲染 PluginManagementLayout、MarketPluginDetailView、
      // PluginScopePicker、MyPublishesSection、AddMarketplaceDialog、UpdateAllDialog,
      // 并直接导入 plugin-motion.css——只扫页面与详情两个文件会漏掉这些样式事实。
      reachableComponents: [
        'GhostPluginPage',
        'GhostPluginDetailView',
        'PluginManagementLayout',
        'MarketPluginDetailView',
        'PluginScopePicker',
        'MyPublishesSection',
        'AddMarketplaceDialog',
        'UpdateAllDialog',
      ],
      styleRoots: [
        'apps/desktop/src/renderer/features/plugin/GhostPluginPage.tsx',
        'apps/desktop/src/renderer/features/plugin/GhostPluginDetailView.tsx',
        'apps/desktop/src/renderer/features/plugin/PluginManagementLayout.tsx',
        'apps/desktop/src/renderer/features/plugin/MarketPluginDetailView.tsx',
        'apps/desktop/src/renderer/features/plugin/PluginScopePicker.tsx',
        'apps/desktop/src/renderer/features/plugin/MyPublishesSection.tsx',
        'apps/desktop/src/renderer/features/plugin/AddMarketplaceDialog.tsx',
        'apps/desktop/src/renderer/features/plugin/UpdateAllDialog.tsx',
        'apps/desktop/src/renderer/features/plugin/plugin-motion.css',
      ],
      routerPaths: ['/plugins'],
      routeEntryComponents: { '/plugins': 'GhostPluginPage' },
    },
    {
      id: 'desktop.plugins.app-main',
      platform: 'desktop',
      title: '插件主视图',
      productionEntry: 'hash `/apps/:ghostId`（GhostMainViewFeatureLayout）',
      reachableComponents: ['GhostMainViewFeatureLayout', 'GhostMainViewHost'],
      styleRoots: [
        'apps/desktop/src/renderer/features/plugin/GhostMainViewFeatureLayout.tsx',
        'apps/desktop/src/renderer/features/plugin/GhostMainViewHost.tsx',
      ],
      routerPaths: ['/apps/:ghostId'],
      routeEntryComponents: { '/apps/:ghostId': 'GhostMainViewFeatureLayout' },
    },
    {
      id: 'desktop.dev.maker-experimental',
      platform: 'desktop',
      title: 'Maker 实验诊断页',
      productionEntry:
        'hash `/maker-experimental`（MakerExperimentalView；EXPERIMENTAL_FEATURES 现为空，仍是生产路由）',
      reachableComponents: ['MakerExperimentalView'],
      styleRoots: ['apps/desktop/src/renderer/features/maker-experimental'],
      routerPaths: ['/maker-experimental'],
      routeEntryComponents: { '/maker-experimental': 'MakerExperimentalView' },
    },
    {
      id: 'desktop.window.sidebar',
      platform: 'desktop',
      title: '右侧栏独立窗口',
      productionEntry:
        '`?sidebarWindow=1` → renderer/sidebar-window-entry.tsx；hash `/sidebar-window`',
      reachableComponents: ['SidebarWindowLayout', 'RightSidebar', 'RightSidebarShell'],
      styleRoots: [
        'apps/desktop/src/renderer/sidebar-window-entry.tsx',
        'apps/desktop/src/renderer/components/layout/SidebarWindowLayout.tsx',
        // SidebarWindowLayout 同样渲染 RightSidebarShell(features/right-sidebar),
        // 该目录含 TabBar/下拉/插件体与 FileBrowserBody.css 等样式事实。
        'apps/desktop/src/renderer/features/right-sidebar',
        'apps/desktop/src/main/right-sidebar-window',
        // sidebar-window-entry.tsx 直接导入 globals.css，body/#root 基础样式与
        // 窗口专用规则在该窗口实际生效——独立窗口与主窗口共享同一全局样式源。
        'apps/desktop/src/renderer/styles/globals.css',
      ],
      routerPaths: ['/sidebar-window'],
      rendererEntryModules: { sidebarWindow: './sidebar-window-entry' },
      routeEntryComponents: { '/sidebar-window': 'SidebarWindowLayout' },
    },
    {
      id: 'desktop.window.ghost-panel',
      platform: 'desktop',
      title: '插件面板独立窗口',
      productionEntry:
        '`?ghostPanelWindow=<id>` → renderer/ghost-panel-window-entry.tsx；hash `/ghost-panel-window`',
      reachableComponents: ['GhostPanelWindowLayout'],
      styleRoots: [
        'apps/desktop/src/renderer/ghost-panel-window-entry.tsx',
        'apps/desktop/src/renderer/components/layout/GhostPanelWindowLayout.tsx',
        'apps/desktop/src/main/ghost-panel-window',
        // ghost-panel-window-entry.tsx 直接导入 globals.css（同侧栏窗理由）。
        'apps/desktop/src/renderer/styles/globals.css',
      ],
      routerPaths: ['/ghost-panel-window'],
      rendererEntryModules: { ghostPanelWindow: './ghost-panel-window-entry' },
      routeEntryComponents: { '/ghost-panel-window': 'GhostPanelWindowLayout' },
    },
    {
      id: 'desktop.window.resource-usage',
      platform: 'desktop',
      title: '资源用量窗口',
      productionEntry:
        '`?resourceUsageWindow=1` → renderer/resource-usage-entry.tsx（不走 router.tsx）',
      reachableComponents: ['ResourceUsageWindowRoot', 'ResourceUsageWindowLayout'],
      styleRoots: [
        'apps/desktop/src/renderer/resource-usage-entry.tsx',
        'apps/desktop/src/renderer/components/resource-usage',
        'apps/desktop/src/main/resource-usage-window',
        // resource-usage-entry.tsx 直接导入 globals.css（同侧栏窗理由）。
        'apps/desktop/src/renderer/styles/globals.css',
      ],
      routerPaths: [],
      rendererEntryModules: { resourceUsageWindow: './resource-usage-entry' },
    },
    {
      id: 'desktop.window.voice-overlay',
      platform: 'desktop',
      title: '语音输入浮窗',
      productionEntry: '`?view=voice-input-overlay` → main-entry.tsx → VoiceInputOverlay',
      // VoiceInputOverlay 直接渲染 VoiceInputStatusNotice(状态提示条);
      // main-entry.tsx 无条件加载 globals.css,其中 data-voice-input-overlay
      // 透明根节点规则是该浮窗专用。
      reachableComponents: ['VoiceInputOverlay', 'VoiceInputStatusNotice'],
      styleRoots: [
        'apps/desktop/src/renderer/voice-input/VoiceInputOverlay.tsx',
        'apps/desktop/src/renderer/voice-input/VoiceInputStatusNotice.tsx',
        'apps/desktop/src/main/voice-input/global.ts',
        'apps/desktop/src/renderer/styles/globals.css',
      ],
      routerPaths: [],
      viewEntryComponents: { 'voice-input-overlay': 'VoiceInputOverlay' },
    },
    {
      id: 'desktop.window.voice-dictionary-toast',
      platform: 'desktop',
      title: '语音词典 Toast 窗',
      productionEntry:
        '`?view=voice-input-dictionary-toast` → main-entry.tsx → VoiceInputDictionaryToast',
      reachableComponents: ['VoiceInputDictionaryToast'],
      styleRoots: ['apps/desktop/src/renderer/voice-input/VoiceInputDictionaryToast.tsx'],
      routerPaths: [],
      viewEntryComponents: { 'voice-input-dictionary-toast': 'VoiceInputDictionaryToast' },
    },
    {
      id: 'desktop.window.computer-permission-guide',
      platform: 'desktop',
      title: '电脑使用权限引导',
      productionEntry:
        '`?view=computer-permission-guide` → ComputerPermissionGuideWindow；backdrop 同文件',
      reachableComponents: ['ComputerPermissionGuideWindow', 'ComputerPermissionBackdrop'],
      styleRoots: [
        'apps/desktop/src/renderer/components/settings/ComputerPermissionGuideWindow.tsx',
        'apps/desktop/src/main/computer-permission-guide',
      ],
      routerPaths: [],
      // guide 与 backdrop 两个 view 分支渲染同文件的两个组件，同一 surface 承载。
      viewEntryComponents: {
        'computer-permission-guide': 'ComputerPermissionGuideWindow',
        'computer-permission-backdrop': 'ComputerPermissionBackdrop',
      },
    },
    {
      id: 'desktop.window.review-artifact-confirm',
      platform: 'desktop',
      title: 'Review 成果确认窗',
      productionEntry:
        'main/reviewer/reviewArtifactConfirmWindow.ts 内联 HTML/CSS（不走 renderer 路由）',
      reachableComponents: ['reviewArtifactConfirmWindow'],
      styleRoots: ['apps/desktop/src/main/reviewer/reviewArtifactConfirmWindow.ts'],
      routerPaths: [],
    },
    {
      id: 'desktop.window.session-drag-preview',
      platform: 'desktop',
      title: '会话拖拽预览',
      productionEntry: 'main/session-drag-preview.ts 透明预览窗',
      reachableComponents: ['session-drag-preview'],
      styleRoots: ['apps/desktop/src/main/session-drag-preview.ts'],
      routerPaths: [],
    },
    {
      id: 'desktop.auth.legacy-migration',
      platform: 'desktop',
      title: '首登数据迁移弹窗',
      productionEntry:
        'App 顶层挂载 LegacyMigrationDialog（仅主窗；main 检测到旧版 userData 经 `legacy-migration:state` 驱动）',
      reachableComponents: ['LegacyMigrationDialog'],
      styleRoots: ['apps/desktop/src/renderer/components/auth/LegacyMigrationDialog.tsx'],
      routerPaths: [],
    },
    {
      id: 'desktop.overlay.toast',
      platform: 'desktop',
      title: 'Toast',
      productionEntry: 'App 常驻 ToastContainer（用户可见出口，不展开业务逻辑）',
      reachableComponents: ['ToastContainer', 'Toast'],
      styleRoots: ['apps/desktop/src/renderer/components/ui/toast'],
      routerPaths: [],
    },
    {
      id: 'desktop.overlay.confirm',
      platform: 'desktop',
      title: '确认弹窗',
      productionEntry: 'ConfirmDialogProvider 及插件确认宿主',
      reachableComponents: [
        'ConfirmDialogProvider',
        'GhostConfirmDialogHost',
        'ForgeOidcInstallConfirmHost',
        'PluginPublisherConfirmHost',
      ],
      styleRoots: [
        'apps/desktop/src/renderer/components/ui/confirm-dialog-provider.tsx',
        'apps/desktop/src/renderer/components/ui/confirm-dialog.tsx',
        'apps/desktop/src/renderer/cindy-brain/GhostConfirmDialogHost.tsx',
        'apps/desktop/src/renderer/cindy-brain/ForgeOidcInstallConfirmHost.tsx',
        'apps/desktop/src/renderer/features/plugin/PluginPublisherConfirmHost.tsx',
      ],
      routerPaths: [],
    },
    {
      id: 'desktop.overlay.interaction-portal',
      platform: 'desktop',
      title: '交互提问卡片',
      productionEntry: 'components/interaction-portal（AskUser / 权限类卡片出口）',
      reachableComponents: ['InteractionPromptHost', 'InteractionPromptCardShell'],
      styleRoots: ['apps/desktop/src/renderer/components/interaction-portal'],
      routerPaths: [],
    },
    {
      id: 'desktop.overlay.permission-prompt',
      platform: 'desktop',
      title: '权限询问',
      productionEntry: 'PermissionPrompt（会话内权限卡；DS-6 迁移前置）',
      reachableComponents: ['PermissionPrompt', 'PermissionSelector', 'AskUserQuestionPrompt'],
      styleRoots: [
        'apps/desktop/src/renderer/components/new-chat/PermissionPrompt.tsx',
        'apps/desktop/src/renderer/components/new-chat/PermissionSelector.tsx',
        'apps/desktop/src/renderer/components/new-chat/AskUserQuestionPrompt.tsx',
      ],
      routerPaths: [],
    },
    {
      id: 'desktop.overlay.splash',
      platform: 'desktop',
      title: '启动遮罩',
      productionEntry:
        'App → SplashScreen；同源 gating 下并挂 LoginBrandStage（z-9980 品牌画布，启动期即可见、Splash(z-9999) 之下）',
      reachableComponents: ['SplashScreen', 'LoginBrandStage'],
      // LoginBrandStage 同时是登录页品牌层（desktop.auth.login 已登记）；此处并挂是
      // 同一组件的启动期可达事实，样式根共享故统计一致。
      styleRoots: [
        'apps/desktop/src/renderer/components/splash',
        'apps/desktop/src/renderer/components/login/LoginBrandStage.tsx',
      ],
      routerPaths: [],
    },
    {
      id: 'desktop.overlay.route-error',
      platform: 'desktop',
      title: '路由错误页',
      productionEntry: 'router errorElement → RouteErrorFallback / TopLevelErrorBoundary',
      reachableComponents: ['RouteErrorFallback', 'TopLevelErrorBoundary', 'AppCrashScreen'],
      styleRoots: ['apps/desktop/src/renderer/components/error'],
      routerPaths: [],
    },
    {
      id: 'desktop.overlay.find-in-page',
      platform: 'desktop',
      title: '页内查找条',
      productionEntry: 'App → FindInPageBar',
      reachableComponents: ['FindInPageBar'],
      styleRoots: ['apps/desktop/src/renderer/components/find-in-page'],
      routerPaths: [],
    },
    {
      id: 'desktop.native.app-menu',
      platform: 'desktop',
      title: '应用菜单',
      productionEntry: 'Menu.setApplicationMenu（用户可见出口，不展开业务逻辑）',
      reachableComponents: ['applicationMenuLabels'],
      styleRoots: ['apps/desktop/src/main/applicationMenuLabels.ts'],
      routerPaths: [],
    },
    {
      id: 'desktop.native.tray',
      platform: 'desktop',
      title: '系统托盘',
      productionEntry: 'windowsTrayLifecycle（Windows 托盘菜单）',
      reachableComponents: ['windowsTrayLifecycle'],
      styleRoots: ['apps/desktop/src/main/windowsTrayLifecycle.ts'],
      routerPaths: [],
    },
    {
      id: 'desktop.native.system-notification',
      platform: 'desktop',
      title: '系统通知',
      productionEntry: 'notificationService（系统通知出口）',
      reachableComponents: ['notificationService'],
      styleRoots: ['apps/desktop/src/main/notificationService.ts'],
      routerPaths: [],
    },
  ];
}

export function productionRouterCoverage(routerSource, catalog = catalogSurfaces()) {
  const { production } = extractRouterFacts(routerSource);
  const byPath = new Map(catalog.flatMap((surface) => (surface.routerPaths ?? []).map((routePath) => [routePath, surface])));
  const covered = new Set(byPath.keys());
  const mapped = [];
  const missing = [];
  for (const route of production) {
    (covered.has(route.path) ? mapped : missing).push(route);
  }
  // 反向核对：catalog 里登记的路径必须仍是真实生产路由。route 删除/改名后若只做正向
  // 检查，重新生成会把它从覆盖表悄悄抹掉，--check 照样通过，台账继续宣称它生产可达。
  const actualPaths = new Set(production.map((route) => route.path));
  const stale = [...covered].filter((routePath) => !actualPaths.has(routePath));
  // 组件核对：路径保留但 element 换成新组件时，路由覆盖表会显示新组件，而该 surface 的
  // productionEntry / reachableComponents / styleRoots 仍来自旧 catalog——台账内部自相
  // 矛盾。routeEntryComponents 是「路径 → 入口组件」映射，逐路径精确比对：
  // surface 级并集不够——多路由 surface 内部把 A 路径的入口换成同集合内 B 组件时，
  // 并集检查照样通过，但该路径的生产入口事实已经错误。
  const componentMismatch = production
    .filter((route) => {
      const surface = byPath.get(route.path);
      if (!surface) return false;
      const entryComponents = surface.routeEntryComponents ?? {};
      // 未登记 routeEntryComponents 的 surface 只按路径映射（历史形态，不强制回填）。
      return Object.keys(entryComponents).length > 0 && entryComponents[route.path] !== route.component;
    })
    .map((route) => {
      const surface = byPath.get(route.path);
      return {
        path: route.path,
        actualComponent: route.component,
        // 统一成数组：消费侧（CLI 报错拼接）按数组处理；登记缺路径时是 undefined，
        // 兜底成空数组避免 join 前的运行期类型错。
        catalogComponents: [].concat(surface.routeEntryComponents[route.path] ?? []),
        surfaceId: surface.id,
      };
    });
  return { mapped, missing, stale, componentMismatch, covered: [...covered].sort() };
}

export function buildGeneratedSurfaces(repoRoot, { catalog = catalogSurfaces() } = {}) {
  const byId = new Map(catalog.map((surface) => [surface.id, surface]));
  const missingStyleRoots = [];
  // extraStyleRoots 引用必须指向 catalog 里真实存在的 surface ID：被引用 ID 改名/删除/
  // 误拼时可选链会静默展开为空数组，继承方统计骤减而 --check 照样通过——与文件型
  // styleRoot 失效同罪，必须报出来。
  const danglingExtraStyleRoots = [];
  const surfaces = catalog
    .map((surface) => {
      const extraRefs = surface.extraStyleRoots ?? [];
      for (const id of extraRefs) {
        if (!byId.has(id)) danglingExtraStyleRoots.push(`${surface.id} → ${id}`);
      }
      // 渲染即委托的薄壳（如 AddAccountLoginPage → LoginPage）按 extraStyleRoots
      // 指向被委托 surface 的 styleRoots，统计口径与其保持同一组事实源。
      const roots = [
        ...surface.styleRoots,
        ...extraRefs.flatMap((id) => byId.get(id)?.styleRoots ?? []),
      ];
      const stats = scanStyleStats(repoRoot, roots, {
        missingRoots: missingStyleRoots,
      });
      return {
        id: surface.id,
        platform: surface.platform,
        title: surface.title,
        productionEntry: surface.productionEntry,
        reachableComponents: uniqueSorted(surface.reachableComponents),
        styleSources: stats.files,
        tokenCount: stats.tokenCount,
        bareColors: stats.bareColors,
        bareRadii: stats.bareRadii,
        routerPaths: uniqueSorted(surface.routerPaths ?? []),
      };
    })
    .sort((a, b) => byCodepoints(a.id, b.id));
  return {
    surfaces,
    missingStyleRoots: uniqueSorted(missingStyleRoots),
    danglingExtraStyleRoots: uniqueSorted(danglingExtraStyleRoots),
  };
}

/** 被排除的 redirect 路由，供 GENERATED 排除表使用。 */
export function listRedirectExclusions(routerSource) {
  return extractRouterFacts(routerSource).redirects;
}

/** 被排除的布局壳路由，供测试断言「壳不是 surface」这条判据。 */
export function listLayoutExclusions(routerSource) {
  return extractRouterFacts(routerSource).layouts;
}

function mapRouteToSurfaceId(fullPath, surfaces) {
  for (const surface of surfaces) {
    if ((surface.routerPaths ?? []).includes(fullPath)) return surface.id;
  }
  return 'UNMAPPED';
}

/** 渲染 markdown 表格；rows 为空时给一行占位，保证表格结构始终合法。 */
function renderTable(headers, aligns, rows) {
  const body = rows.length > 0 ? rows : [headers.map(() => '—')];
  return [
    `| ${headers.join(' | ')} |`,
    `| ${aligns.join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
  ];
}

export function renderGeneratedBlock(
  surfaces,
  {
    snapshotDate = 'UNSET',
    generateCommand = 'pnpm design:inventory',
    routerCoverage = { mapped: [], missing: [] },
    redirects = [],
  } = {},
) {
  // 先按路径与组件排序，再渲染成单元格：排序键是事实本身，不受反引号等渲染包裹影响。
  const coverageRows = [...routerCoverage.mapped, ...routerCoverage.missing]
    .sort((a, b) => byCodepoints(a.path, b.path) || byCodepoints(a.component, b.component))
    .map((row) => [
      `\`${cell(row.path)}\``,
      cell(row.component),
      `\`${mapRouteToSurfaceId(row.path, surfaces)}\``,
    ]);

  return `${[
    GENERATED_BEGIN,
    '',
    '本区块由 `scripts/design-inventory.mjs` 生成，请勿手改。',
    '重新生成：`pnpm design:inventory`；校验：`pnpm check:design-inventory`。',
    '',
    `计数快照日期：${snapshotDate}。生成命令：\`${generateCommand}\`。裸颜色匹配与 \`scripts/hardcoded-color-audit.mjs\` 共用 \`scripts/shared/hardcoded-color-match.mjs\`（HEX / rgb() / rgba() / hsl() / hsla()），台账统计层额外剔除 \`var()\` 包装与注释（TS/TSX 剥块注释与整行注释）——语义 token 消费与注释引用不是迁移债务；裸圆角为粗粒度（\`rounded*\` class、\`border-radius:\` 与 React style 对象的 \`borderRadius:\`）。Token 计数为样式源里 \`var(--token)\` / \`hsl(var(--token)\` 的去重 ID 数。`,
    '',
    `登记 surface 数：${surfaces.length}。平台本轮仅 Desktop。`,
    '',
    ...renderTable(
      ['ID', '平台', '标题', '生产入口', '可达组件', '样式来源', 'Token 数', '裸颜色', '裸圆角'],
      ['---', '---', '---', '---', '---', '---', '---:', '---:', '---:'],
      surfaces.map((surface) => [
        `\`${cell(surface.id)}\``,
        cell(surface.platform),
        cell(surface.title),
        cell(surface.productionEntry),
        cell(surface.reachableComponents.join(', ')),
        cell(surface.styleSources.join(', ')) || '—',
        surface.tokenCount,
        surface.bareColors,
        surface.bareRadii,
      ]),
    ),
    '',
    '### 生产路由覆盖',
    '',
    '纯 `<Navigate>` 与运行期跳转组件不算 surface。布局壳（ProtectedRoute / GuestRoute / feature layout）不出现在下表。新增或删除一条生产路由会改变本表，使 `pnpm check:design-inventory` 失败。',
    '',
    ...renderTable(['路由', '组件', 'surface ID'], ['---', '---', '---'], coverageRows),
    '',
    '### 排除的 redirect',
    '',
    ...renderTable(
      ['路由', '目标', '类型'],
      ['---', '---', '---'],
      redirects.map((row) => [`\`${cell(row.path)}\``, cell(row.to), cell(row.kind)]),
    ),
    '',
    GENERATED_END,
  ].join('\n')}\n`;
}

export function splitInventoryDocument(markdown) {
  const text = normalizeDocEol(markdown);
  const begin = text.indexOf(GENERATED_BEGIN);
  const end = text.indexOf(GENERATED_END);
  if (begin === -1 || end === -1 || end < begin) {
    return {
      prefix: text,
      generated: '',
      suffix: '',
      hasMarkers: false,
    };
  }
  const generatedEnd = end + GENERATED_END.length;
  let generatedSliceEnd = generatedEnd;
  if (text[generatedSliceEnd] === '\n') generatedSliceEnd += 1;
  return {
    prefix: text.slice(0, begin),
    generated: text.slice(begin, generatedSliceEnd),
    suffix: text.slice(generatedSliceEnd),
    hasMarkers: true,
  };
}

const HUMAN_ID_RE = /^\| `([^`]+)` \|/;

export function extractHumanSurfaceIds(humanMarkdown) {
  const ids = [];
  for (const line of normalizeDocEol(humanMarkdown).split('\n')) {
    const match = HUMAN_ID_RE.exec(line);
    if (match) ids.push(match[1]);
  }
  return ids;
}

export function findOrphanHumanIds(humanMarkdown, generatedIds) {
  const known = new Set(generatedIds);
  return uniqueSorted(extractHumanSurfaceIds(humanMarkdown).filter((id) => !known.has(id)));
}

const SEED_PREFIX = [
  '# Cindy 生产 UI 台账',
  '',
  '> 台账真相正本。机器事实在 GENERATED 区块；人工决策（owner / 迁移状态 / protected / 目标道路 / 下一动作）在其后，按 surface ID 对齐。',
  '> schema 见 [`design-governance.md`](./design-governance.md) §2.1。生成器只重写 GENERATED 区块。',
  '',
  '重新生成：`pnpm design:inventory`。校验：`pnpm check:design-inventory`。',
  '',
].join('\n');

/**
 * 用新的 GENERATED 区块替换旧的，人工区（GENERATED 之后的一切）原样保留。
 * 文件不存在时用 seedHuman 建首版；已有文件但缺标记时把 GENERATED 追加到末尾，
 * 不去猜哪段是人工内容。
 */
export function mergeInventoryDocument(existingMarkdown, generatedBlock, { seedHuman = '' } = {}) {
  const existing = existingMarkdown ? normalizeDocEol(existingMarkdown) : '';
  if (!existing.trim()) return `${SEED_PREFIX}${generatedBlock}${seedHuman}`;

  const parts = splitInventoryDocument(existing);
  if (!parts.hasMarkers) return `${existing.trimEnd()}\n\n${generatedBlock}`;
  return `${parts.prefix}${generatedBlock}${parts.suffix}`;
}

export function defaultHumanSeed(surfaces) {
  const lines = [
    '',
    '## 人工标注',
    '',
    '生成器不得改本表。首轮（DS-2a）：全部 `legacy`；暂无归属写 `unassigned`。`protected` 与迁移状态正交。',
    '',
    'Mobile 本轮不展开顶层 screen，**待 DS-9 增量**。',
    '',
    '另册 / 排除（不进必做迁移清单）：',
    '',
    '- `apps/desktop/cindy-updater/ui/`：独立更新器子应用；',
    '- 插件沙箱窗 `electronSandboxAdapter.ts`：加载插件内容，不是主机 UI；',
    '- `htmlPdfRenderer.ts`：无头 PDF 渲染，用户不可见；',
    '- 测试样张与 `__tests__` fixture。',
    '',
    '| ID | owner | 迁移状态 | protected | 目标道路 | 下一动作 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...[...surfaces]
      .sort((a, b) => byCodepoints(a.id, b.id))
      .map((surface) => renderHumanRow(surface.id, defaultHumanAnnotation(surface.id))),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * 首轮 protected 标签：视觉或交互合同被有意保护的 surface（治理合同 §2.1）。
 * 与迁移状态正交，只在这里登记一次；未列出的 surface 无保护标签。
 */
const PROTECTED_TAGS = {
  'desktop.auth.login': ['DESIGN.md §16 登录链路'],
  'desktop.auth.add-account': ['DESIGN.md §16 登录链路'],
  'desktop.auth.legacy-migration': [
    'DESIGN.md §16 登录链路（消费 --login-callback-* 品牌豁免族 component token）',
  ],
  'desktop.overlay.splash': ['DESIGN.md §16 登录链路'],
  'desktop.shell.main-layout': [
    'DESIGN.md §15 CINDY 皮肤族（侧栏 vibrancy / 选中 pill）',
    '外部主题导入保护 token',
  ],
  'desktop.window.sidebar': ['DESIGN.md §15 CINDY 皮肤族'],
  'desktop.chat.session': [
    'DESIGN.md §10 语义豁免色族消费者（status / diff / 消息卡）',
    'DESIGN.md §5 2px status micro-cells',
  ],
  'desktop.chat.new-draft': ['DESIGN.md §15.15 创建页内容位'],
  'desktop.overlay.permission-prompt': [
    'DESIGN.md §5 裸文字按钮豁免（相关）',
    'DS-6 Permission 迁移前置',
  ],
  'desktop.settings': [
    'DESIGN.md §10 语义豁免色族消费者',
    '外部主题导入保护 token（资源用量类别色在独立窗）',
  ],
  'desktop.window.resource-usage': ['外部主题导入保护 token（进程类别色）'],
};

export function defaultHumanAnnotation(id) {
  return {
    owner: 'unassigned',
    status: 'legacy',
    protected: (PROTECTED_TAGS[id] ?? []).join('；') || '—',
    target: '待 DS-4 标准组件落地后按 Pattern 迁',
    next: '保持现状；发现问题记下一动作，本张不修视觉',
  };
}

function renderHumanRow(id, annotation) {
  return `| \`${id}\` | ${cell(annotation.owner)} | ${cell(annotation.status)} | ${cell(
    annotation.protected,
  )} | ${cell(annotation.target)} | ${cell(annotation.next)} |`;
}

export function ensureHumanRows(existingMarkdown, surfaces) {
  const parts = splitInventoryDocument(existingMarkdown);
  if (!parts.hasMarkers) return existingMarkdown;
  const knownHuman = new Set(extractHumanSurfaceIds(parts.suffix));
  const missing = surfaces.filter((surface) => !knownHuman.has(surface.id));
  if (missing.length === 0) return existingMarkdown;
  const extra = missing.map((surface) =>
    renderHumanRow(surface.id, defaultHumanAnnotation(surface.id)),
  );
  const suffix = parts.suffix.includes('| ID | owner |')
    ? appendRowsToHumanTable(parts.suffix, extra)
    : `${parts.suffix.trimEnd()}\n${defaultHumanSeed(missing)}`;
  return `${parts.prefix}${parts.generated}${suffix}`;
}

function appendRowsToHumanTable(suffix, extraRows) {
  const lines = suffix.split('\n');
  // 人工表按 surface ID 排序是既有不变量；新行按 ID 插到正确位置，不是无脑追加到表尾。
  const pending = extraRows
    .map((row) => ({ row, id: HUMAN_ID_RE.exec(row)?.[1] ?? '' }))
    .sort((a, b) => byCodepoints(a.id, b.id));
  const result = [];
  let insertAt = -1;
  for (const line of lines) {
    const id = HUMAN_ID_RE.exec(line)?.[1];
    while (pending.length > 0 && id && byCodepoints(pending[0].id, id) < 0) {
      result.push(pending.shift().row);
    }
    result.push(line);
    if (id) insertAt = result.length;
  }
  const rest = pending.map((item) => item.row);
  if (rest.length > 0) {
    if (insertAt === -1) return `${suffix.trimEnd()}\n${rest.join('\n')}\n`;
    result.splice(insertAt, 0, ...rest);
  }
  return result.join('\n');
}

export function formatOrphanReport(orphanIds) {
  if (orphanIds.length === 0) return '';
  return (
    `[design-inventory] 孤儿人工行（GENERATED 中已无对应 ID，只报告不删除）：\n` +
    orphanIds.map((id) => `  - ${id}`).join('\n')
  );
}

export function compareGenerated(existingMarkdown, nextGeneratedBlock) {
  const parts = splitInventoryDocument(existingMarkdown);
  const current = parts.hasMarkers ? parts.generated : '';
  return {
    equal: normalizeDocEol(current) === normalizeDocEol(nextGeneratedBlock),
    current,
    next: nextGeneratedBlock,
  };
}
