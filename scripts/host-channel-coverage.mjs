#!/usr/bin/env node
/**
 * Inventory every IPC channel the desktop main process registers and how far
 * cindy-host covers it when the window runs as a client.
 *
 * Channel names are resolved with the TypeScript checker (literals, constant
 * objects, template literals, `as const` loops, `Object.entries` of handler
 * maps, and one-parameter wrappers followed to their call sites), so the result
 * is generated rather than maintained by hand.
 *
 * Each channel lands in one category:
 *   contract  — proxied to cindy-host (HOST_CONTRACT_CHANNELS, the extra
 *               client-mode proxies in host-delegation.ts, and the entries of
 *               the Host's generic IPC route in maker-shared hostIpcEntries/)
 *   client    — registered by client mode itself (connection status, retry)
 *   A         — must be served by the backend (reads or writes data or runtime
 *               state the backend owns)
 *   B         — stays in the window for good (only Electron/GUI can do it)
 *   C         — undecided, with the reason (usually it touches both sides)
 *
 * Ownership comes from OWNERSHIP_RULES (file / prefix) plus a dependency check:
 * the handler and the functions it calls (two levels, desktop sources only, not
 * their nested callbacks) are scanned for window-only Electron APIs (GUI_EXPORTS / GUI_MEMBERS). A backend
 * domain whose handler uses one becomes C; an unlisted channel is A unless its
 * handler uses one, then C.
 *
 * Usage:
 *   node scripts/host-channel-coverage.mjs                 # rewrite docs/host/channel-coverage.md
 *   node scripts/host-channel-coverage.mjs --json <file>   # also write the raw inventory
 *   node scripts/host-channel-coverage.mjs --usage <file>  # rank backend gaps by another usage report
 *   node scripts/host-channel-coverage.mjs --stdout        # print instead of writing the doc
 *
 * The ranking defaults to the committed fixture-tour report (USAGE_REL_PATH);
 * how to record a new one is in apps/desktop/scripts/host-client-usage-tour.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopRoot = path.join(repoRoot, 'apps/desktop');
const mainRoot = path.join(desktopRoot, 'src/main');
const ts = createRequire(path.join(desktopRoot, 'package.json'))('typescript');

export const DOC_REL_PATH = 'docs/host/channel-coverage.md';
export const USAGE_REL_PATH = 'docs/host/evidence/channel-usage-mock-tour.json';
export const CLIENT_USAGE_REL_PATH = 'docs/host/evidence/channel-usage-client-login.json';

/**
 * Ownership rules, first match wins. A channel matches on its name or on its
 * registering module (path under apps/desktop/src/main). B and C are final; an
 * A rule only names the domain, and the dependency check can still turn it
 * into C. Reasons are printed in the doc, so keep them short.
 */
export const OWNERSHIP_RULES = [
  {
    owner: 'B',
    reason: '窗口外壳、窗口布局与多窗口',
    channel: /^(window[-:]|window$|win:|titlebar|fullscreen|toggle-fullscreen|get-fullscreen-state|find-in-page|page-zoom|theme:|app-menu:|app-locale:|startup-gate|maker:open-session-in-new-window|maker:session-drag-preview|maker:sidebar-tab-drag-preview|maker:sidebar-tab-window|sidebar-tab-window|maker:rsb-window|rsb-window|resource-usage-window|agent-island|menubar)/,
    module: /^(sidebar-tab-window|sidebarWindowExpansionIpc|right-sidebar-window|resource-usage-window|agent-island|menubar)\b/,
  },
  {
    owner: 'B',
    reason: '原生对话框、剪贴板、系统外壳与通知',
    channel: /^(dialog:|show-open-directory-dialog|clipboard:|shell:|open-with:|notification:|media:copy-(png-)?to-clipboard|media:open-with-default-app|media:save-as|chat-attachment:save-as|login-item:|accessibility-support)/,
    module: /^(notificationService|appBadgeService|login-item-ipc|accessibility-support-ipc)\b/,
  },
  {
    owner: 'B',
    reason: '本机屏幕截取、录制与远程桌面',
    channel: /^(region-screenshot|recording-preview|recording-audio|remote-desktop|away-guard)/,
    module: /^(region-screenshot|remote-desktop|remote-desktop-viewer)\b/,
  },
  {
    owner: 'B',
    reason: '图形能力，由窗口替 Agent 执行（平台 RPC）',
    channel: /^(maker:computer|browser-backend|rsb-browser-bridge|rsb-native-popup)/,
    module: /^(rsb-browser-bridge)\b/,
  },
  {
    owner: 'B',
    reason: '本机输入设备与语音',
    channel: /^(voice-input|voice-conversation|xbox-gamepad|worklouder-codex|codex-micro-guard|app-shortcuts:set-recording)/,
    module: /^(voice-input|voice-conversation|xbox-gamepad|worklouder-codex)\b/,
  },
  {
    owner: 'B',
    reason: '桌面安装包自身：更新、版本、日志与诊断',
    channel: /^(update-(?!relaunch:)|get-app-version|get-app-display-version-info|get-os-release|release-notes:|app:get-arm64-translation|app:open-logs-dir|crash-diagnosis|log-upload|performance-trace|renderer:log|dev:|cc:set-debug-net|deep-link:)/,
    module: /^(updateService|crash-diagnosis|log-upload|performance-trace)\b/,
  },
  {
    owner: 'C', sub: 'special',
    reason: '安全边界待专项设计：用户填写的值只交给宿主执行（input-handoff），远程控制派发；方案出来前不动',
    channel: /^(input-handoff:|device-link:invoke$)/,
  },
  {
    owner: 'C', sub: 'backend',
    reason: '终端 PTY：换窗口时不能断，网页和手机也要用（优先级低，放后面批次）',
    channel: /^terminal:/,
  },
  {
    owner: 'C', sub: 'backend',
    reason: '任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时',
    channel: /^(maker:file-browser|maker:chat-file|maker:chat-folder|maker:html-preview|maker:search:|file-browser:remote-op$)/,
  },
  {
    owner: 'C', sub: 'window',
    reason: '用户在本窗口选择或拖入的本机文件、本机进程监视：窗口直接处理，客户端模式下照常注册',
    channel: /^(fs:|read-file-bytes|read-file-for-attachment|peek-file-header|text-file:|file:thumbnail|process-monitor:subscribe$)/,
    module: /^fsBrowse\b/,
  },
  {
    owner: 'C', sub: 'two-phase',
    reason: '弹出系统选择框后写入后台数据：选择在窗口，结果归后台',
    channel: /(^|:)(choose|pick)([A-Z-]|$)/,
  },
  {
    owner: 'C', sub: 'two-phase',
    reason: '在访达／资源管理器或系统浏览器里打开后台持有的内容',
    channel: /(:|-)(open-dir|reveal)$|:open-[a-z-]*-dir(ectory)?$|^billing:open-/,
  },
  {
    owner: 'R',
    reason: '主进程向界面要数据的回执协议：数据在界面本地存储，Host 要用需经窗口往返，先不排期',
    channel: /(^|:)(host-ready|host-reply|host-changed)$|^app-preferences:reply$/,
  },
  {
    owner: 'W',
    reason: '窗口本地设置：窗口直接读写同一份 profile 文件，不经 Host',
    channel: /^sidebar-settings:/,
  },
  {
    owner: 'A',
    reason: '升级与交接（归交接任务：它留在原工作区的升级流程）',
    channel: /^update-relaunch:/,
  },
  {
    owner: 'A',
    reason: 'Agent 浏览器：客户端模式下归 Host 的浏览器运行时（窗口再开一个会争用同一个 Chrome 用户目录）',
    channel: /^maker:browser:/,
  },
  { owner: 'A', reason: '任务、消息与输入队列', channel: /^(local-db:(sessions|messages|history|session-share|session-import|right-sidebar-tabs|recent-workdirs|subagent-runs|conversations|task-tags|project-aliases|ensure-ready|maintenance)|maker:(session|input|send|steer|create-session|close-session|abort-session|fork|rewind|compact|message|get-session|navigate-session|side-chat|goal|turn-change|persist-turn|working-status|any-session|export-session|generate-title|regenerate-title|auto-title|predict-prompt|switch-session-agent|write-plan-file|images|list-desktop-commands|execute-desktop-command|get-context|set-))/ },
  { owner: 'A', reason: '自动化', channel: /^maker:schedule/ },
  { owner: 'A', reason: 'Orca', channel: /^(maker:(orca|worker|team|mark-orca|sync-worker)|local-db:orca)/ },
  { owner: 'A', reason: '伙伴与 IM', channel: /^(maker:(bot|companion|im-)|local-db:bots|binding:|botImConnection|telegramBot|wechatBot|feishuBot|discordBot|dingtalkBot|wecomBot|wecomGroupNotification|desktop:cc-prefs|companion-import)/, module: /^(im|bot-import)\b/ },
  { owner: 'A', reason: '账号与凭据', channel: /^(auth:|safe-storage|builtin-api-key|plugin-oauth|maker:(api-key|claude-oauth|xai-oauth|auth:|subscription))/ },
  { owner: 'A', reason: '供应商与模型', channel: /^(maker:(provider|model|usage|local-model|llamacpp|sync-provider|auxiliary-model|subagent-model|vision-bridge|claude-session-route)|provider-group|provider-share|model-favorites|model-access)/ },
  { owner: 'A', reason: '插件、技能与 MCP', channel: /^(ghosts:|ghost-pipe|forge-oidc|maker:(plugins|plugin-setup|mcp|runtime-plugins|pi-packages)|plugin-market|plugin-publisher|plugin-contributions|skillhub)/ },
  { owner: 'A', reason: '设备互联与远程执行', channel: /^(device-link|direct-link|file-peer|shared-task|self-hosted-relay|local-agent|maker:(remote-resources|shared-task|remote-ssh|provider-share))/ },
  { owner: 'A', reason: 'git 与工作树', channel: /^(git-context|git-review|worktree|remote-precreated-worktree|maker:git-safety)/ },
  { owner: 'A', reason: '记忆、学习与钩子', channel: /^(maker:(memory|maker-memory|hook-control)|learn:)/ },
  { owner: 'A', reason: '附件与媒体库', channel: /^(chat-attachment|cindy-media|image-cache|media:)/ },
  { owner: 'A', reason: '设置与偏好', channel: /^(sidebar-settings|app-shortcuts|appearance-settings|layout:|analytics|database-size-warning|app-preferences|local-themes|profile:|projects-root|maker:[a-z-]*settings)/ },
  { owner: 'A', reason: 'Cindy Make', channel: /^app:(.*cindy-make|cindy-versions)/ },
];

/** A-rule domains whose synchronous reads the window serves from the shared profile files. */
export const SYNC_LOCAL_DOMAINS = new Set(['设置与偏好', '账号与凭据']);

/** Electron exports that only a window process can use. */
export const GUI_EXPORTS = new Set([
  'dialog', 'shell', 'clipboard', 'Menu', 'MenuItem', 'screen', 'desktopCapturer', 'Notification',
  'globalShortcut', 'systemPreferences', 'nativeTheme', 'Tray', 'TouchBar', 'BrowserView',
  'WebContentsView', 'powerSaveBlocker', 'nativeImage', 'autoUpdater',
]);
/** Sender trust checks: client mode authenticates with the Host token instead, so they are not window work. */
export const GUI_SKIP_MODULES = /\/src\/main\/security\//;
/** Members of otherwise neutral Electron objects that act on a window or the app shell. */
export const GUI_MEMBERS = {
  BrowserWindow: new Set(['fromWebContents', 'getFocusedWindow', 'fromId', 'fromBrowserView']),
  app: new Set(['focus', 'dock', 'setBadgeCount', 'relaunch', 'quit', 'exit', 'setLoginItemSettings',
    'getLoginItemSettings', 'show', 'hide', 'setAsDefaultProtocolClient', 'getFileIcon']),
};

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

function rel(file) {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

function isTestFile(file) {
  return /(^|\/)__tests__\//.test(file) || /\.(test|spec|e2e)\.[cm]?tsx?$/.test(file) || /\.d\.ts$/.test(file);
}

function listMainSources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !isTestFile(full)) {
        out.push(full);
      }
    }
  };
  walk(mainRoot);
  return out.sort();
}

function createService(rootNames) {
  const configPath = path.join(desktopRoot, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, desktopRoot);
  const options = { ...parsed.options, noEmit: true };
  const snapshots = new Map();
  const host = {
    getScriptFileNames: () => rootNames,
    getScriptVersion: () => '0',
    getScriptSnapshot: (file) => {
      if (!snapshots.has(file)) {
        snapshots.set(file, fs.existsSync(file) ? ts.ScriptSnapshot.fromString(fs.readFileSync(file, 'utf8')) : undefined);
      }
      return snapshots.get(file);
    },
    getCurrentDirectory: () => desktopRoot,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
  };
  return ts.createLanguageService(host, ts.createDocumentRegistry());
}

const REGISTER_METHODS = new Map([
  ['handle', 'invoke'],
  ['handleOnce', 'invoke'],
  ['on', 'event'],
  ['once', 'event'],
]);

/** Window API dependency scan shared by inventory and focused source-analysis tests. */
export function createWindowApiScanner(checker) {
  // TypeScript uses slash paths on Windows too; normalize both sides before matching.
  const sourcePath = (file) => file.replace(/\\/g, '/');
  const desktopSourcePrefix = sourcePath(path.join(desktopRoot, 'src')) + '/';
  const isDesktopSource = (sf) => sf && !sf.isDeclarationFile && sourcePath(sf.fileName).startsWith(desktopSourcePrefix);
  const electronExport = (node) => {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const decl = symbol?.declarations?.[0];
    return decl && /node_modules\/electron\/electron\.d\.ts$/.test(sourcePath(decl.getSourceFile().fileName)) ? symbol.getName() : null;
  };
  const functionBody = (node) => {
    if (!node) return null;
    if (ts.isFunctionLike(node) && node.body) return node;
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const decl = symbol?.valueDeclaration;
    if (!decl || !isDesktopSource(decl.getSourceFile()) || GUI_SKIP_MODULES.test(sourcePath(decl.getSourceFile().fileName))) return null;
    if (ts.isFunctionLike(decl) && decl.body) return decl;
    const init = (ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl)) ? decl.initializer : undefined;
    return init && ts.isFunctionLike(init) && init.body ? init : null;
  };
  const guiMemo = [new Map(), new Map(), new Map()];
  const guiOf = (fn, depth) => {
    const memo = guiMemo[depth];
    if (memo.has(fn)) return memo.get(fn);
    const found = new Set();
    memo.set(fn, found);
    const visitBody = (node) => {
      // A called function's nested callbacks are wiring that may run later (e.g. an
      // `openExternal` dependency), not part of this call; the handler's own are.
      if (depth > 0 && node !== fn.body && ts.isFunctionLike(node)) return;
      if (ts.isIdentifier(node)) {
        const name = GUI_EXPORTS.has(node.text) ? electronExport(node) : null;
        if (name && GUI_EXPORTS.has(name)) found.add(name);
      } else if (ts.isPropertyAccessExpression(node)) {
        const owner = node.expression;
        if (ts.isIdentifier(owner) && GUI_MEMBERS[owner.text]?.has(node.name.text) && electronExport(owner)) {
          found.add(`${owner.text}.${node.name.text}`);
        }
      } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'BrowserWindow' && electronExport(node.expression)) {
        found.add('new BrowserWindow');
      } else if (ts.isCallExpression(node) && depth < 2) {
        const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
        const target = functionBody(callee);
        if (target && target !== fn) for (const name of guiOf(target, depth + 1)) found.add(name);
      }
      ts.forEachChild(node, visitBody);
    };
    // Defaults run as part of the call, just like the body. Nested callback
    // declarations retain the same bounded scan policy as callbacks in the body.
    for (const parameter of fn.parameters) if (parameter.initializer) visitBody(parameter.initializer);
    visitBody(fn.body);
    return found;
  };
  return { functionBody, guiOf };
}

const ITERATION_METHODS = new Set(['map', 'flatMap', 'forEach', 'filter']);

/**
 * Keys of `X` when `decl` is the key of an iteration callback over it:
 * `Object.entries(X).map(([key, value]) => …)` or `Object.keys(X).map(key => …)`.
 * The key's own type is just `string`, so only X's declared properties name it.
 */
export function callbackEntryKeys(decl, checker) {
  let parameter;
  let source;
  if (ts.isBindingElement(decl) && ts.isArrayBindingPattern(decl.parent)
    && decl.parent.elements.indexOf(decl) === 0 && ts.isParameter(decl.parent.parent)) {
    parameter = decl.parent.parent;
    source = 'entries';
  } else if (ts.isParameter(decl) && ts.isIdentifier(decl.name)) {
    parameter = decl;
    source = 'keys';
  } else {
    return null;
  }
  const fn = parameter.parent;
  if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || fn.parameters[0] !== parameter) return null;
  const call = fn.parent;
  if (!call || !ts.isCallExpression(call) || call.arguments[0] !== fn || !ts.isPropertyAccessExpression(call.expression)) return null;
  if (!ITERATION_METHODS.has(call.expression.name.text)) return null;
  const iterated = call.expression.expression;
  if (!ts.isCallExpression(iterated) || !ts.isPropertyAccessExpression(iterated.expression)) return null;
  const callee = iterated.expression;
  if (callee.expression.getText() !== 'Object' || callee.name.text !== source || !iterated.arguments[0]) return null;
  const names = checker.getPropertiesOfType(checker.getTypeAtLocation(iterated.arguments[0])).map((p) => p.getName());
  return names.length ? names : null;
}

/**
 * Statically known string values of an expression (literal types, constants,
 * templates, `+` concatenation, enum members, iteration keys). `wrapperArguments`
 * resolves a parameter through its call sites; without it parameters stay unknown.
 */
export function createConstResolver(checker, wrapperArguments = () => null) {
  const literalStrings = (type) => {
    if (type.isStringLiteral()) return [type.value];
    if (type.isUnion() && type.types.every((t) => t.isStringLiteral())) return type.types.map((t) => t.value);
    return null;
  };

  const constValues = (expr, depth = 0) => {
    if (depth > 8 || !expr) return null;
    if (ts.isStringLiteralLike(expr)) return [expr.text];
    if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression?.(expr) || ts.isTypeAssertionExpression(expr)) {
      return constValues(expr.expression, depth + 1);
    }
    const literal = literalStrings(checker.getTypeAtLocation(expr));
    if (literal) return literal;
    if (ts.isTemplateExpression(expr)) {
      let results = [expr.head.text];
      for (const span of expr.templateSpans) {
        const values = constValues(span.expression, depth + 1);
        if (!values) return null;
        results = results.flatMap((prefix) => values.map((value) => `${prefix}${value}${span.literal.text}`));
      }
      return results;
    }
    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = constValues(expr.left, depth + 1);
      const right = constValues(expr.right, depth + 1);
      return left && right ? left.flatMap((l) => right.map((r) => `${l}${r}`)) : null;
    }
    if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
      let symbol = checker.getSymbolAtLocation(ts.isElementAccessExpression(expr) ? expr.argumentExpression : expr);
      if (ts.isElementAccessExpression(expr)) symbol = undefined;
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const decl = symbol?.valueDeclaration;
      if (decl && (ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl)) && decl.initializer) {
        return constValues(decl.initializer, depth + 1);
      }
      if (decl && ts.isEnumMember(decl)) {
        const value = checker.getConstantValue(decl);
        return typeof value === 'string' ? [value] : null;
      }
      const keys = decl && callbackEntryKeys(decl, checker);
      if (keys) return keys;
      // `handle(name, …)` helpers that build the channel from a parameter.
      if (decl && ts.isParameter(decl) && ts.isIdentifier(expr) && depth < 4) {
        const args = wrapperArguments(decl);
        if (!args || !args.length) return null;
        const values = [];
        for (const arg of args) {
          const resolved = constValues(arg, depth + 1);
          if (!resolved) return null;
          values.push(...resolved);
        }
        return values;
      }
    }
    return null;
  };

  return { literalStrings, constValues };
}

export function collectInventory() {
  const sources = listMainSources();
  const service = createService(sources);
  const program = service.getProgram();
  const checker = program.getTypeChecker();
  const unresolved = [];
  const registrations = [];

  const position = (node) => {
    const sf = node.getSourceFile();
    return { file: rel(sf.fileName), line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 };
  };

  const { literalStrings, constValues } = createConstResolver(checker, (parameter) => wrapperArguments(parameter));

  const isIpcReceiver = (expr) => {
    const name = checker.typeToString(checker.getTypeAtLocation(expr));
    return /^(Electron\.)?IpcMain$/.test(name) || name === 'IpcHandlerRegistry';
  };

  /** Property names of the value an `Object.entries(x)` / `Object.keys(x)` loop iterates. */
  const entriesKeys = (identifier) => {
    const symbol = checker.getSymbolAtLocation(identifier);
    const decl = symbol?.valueDeclaration;
    if (!decl || !ts.isBindingElement(decl) && !ts.isVariableDeclaration(decl)) return null;
    let node = decl;
    while (node && !ts.isVariableDeclarationList(node)) node = node.parent;
    const loop = node?.parent;
    if (!loop || !ts.isForOfStatement(loop)) return null;
    const source = loop.expression;
    if (!ts.isCallExpression(source) || !ts.isPropertyAccessExpression(source.expression)) return null;
    const callee = source.expression;
    if (callee.expression.getText() !== 'Object' || !['entries', 'keys'].includes(callee.name.text)) return null;
    const target = source.arguments[0];
    if (!target) return null;
    const names = checker.getPropertiesOfType(checker.getTypeAtLocation(target)).map((p) => p.getName());
    return names.length ? names : returnedObjectKeys(target);
  };

  /** Keys of `x` when `const x = makeHandlers()` returns an object literal behind a Record<string, …> type. */
  const returnedObjectKeys = (target) => {
    if (!ts.isIdentifier(target)) return null;
    const decl = checker.getSymbolAtLocation(target)?.valueDeclaration;
    const init = decl && ts.isVariableDeclaration(decl) ? decl.initializer : undefined;
    if (!init || !ts.isCallExpression(init)) return null;
    let callee = checker.getSymbolAtLocation(init.expression);
    if (callee && callee.flags & ts.SymbolFlags.Alias) callee = checker.getAliasedSymbol(callee);
    const fn = callee?.valueDeclaration;
    if (!fn || !ts.isFunctionDeclaration(fn) || !fn.body) return null;
    const keys = [];
    let complete = true;
    const visit = (node) => {
      if (ts.isFunctionLike(node) && node !== fn) return;
      if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
        for (const property of node.expression.properties) {
          const name = property.name;
          if (!name) { complete = false; continue; }
          if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) keys.push(name.text);
          else if (ts.isComputedPropertyName(name)) {
            const values = constValues(name.expression);
            if (values) keys.push(...values);
            else complete = false;
          } else complete = false;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(fn.body);
    return complete && keys.length ? keys : null;
  };


  /** Call sites of the function that declares `parameter`, with the argument at its index. */
  const wrapperArguments = (parameter) => {
    const fn = parameter.parent;
    const index = fn.parameters.indexOf(parameter);
    let nameNode;
    if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) nameNode = fn.name;
    else if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.parent) {
      if (ts.isVariableDeclaration(fn.parent) || ts.isPropertyAssignment(fn.parent)) nameNode = fn.parent.name;
    }
    if (!nameNode) return null;
    const sf = nameNode.getSourceFile();
    const refs = service.getReferencesAtPosition(sf.fileName, nameNode.getStart()) ?? [];
    const args = [];
    for (const ref of refs) {
      const refFile = program.getSourceFile(ref.fileName);
      if (!refFile || isTestFile(ref.fileName)) continue;
      const node = findNode(refFile, ref.textSpan.start);
      let callee = node;
      if (callee?.parent && ts.isPropertyAccessExpression(callee.parent) && callee.parent.name === callee) callee = callee.parent;
      const call = callee?.parent;
      if (call && ts.isCallExpression(call) && call.expression === callee && call.arguments[index]) {
        args.push(call.arguments[index]);
      }
    }
    return args;
  };

  const parameterOf = (expr) => {
    if (!ts.isIdentifier(expr)) return undefined;
    const decl = checker.getSymbolAtLocation(expr)?.valueDeclaration;
    return decl && ts.isParameter(decl) ? decl : undefined;
  };

  /** Resolve a registration's channel; wrapper parameters resolve at (and are attributed to) their call sites. */
  const resolveChannel = (expr, depth = 0) => {
    const parameter = parameterOf(expr);
    if (parameter && !literalStrings(checker.getTypeAtLocation(expr)) && depth < 3) {
      const args = wrapperArguments(parameter);
      if (args && args.length) return args.flatMap((arg) => resolveChannel(arg, depth + 1));
    }
    const direct = constValues(expr);
    if (direct) return [{ values: direct, site: expr }];
    if (ts.isIdentifier(expr)) {
      const keys = entriesKeys(expr);
      if (keys) return [{ values: keys, site: expr }];
    }
    return [{ values: null, site: expr }];
  };

  /**
   * `{ handle(channel, handler) { registry.handle(channel, …) } }` adapters that
   * only forward to another registry. Their callers register through a receiver
   * this scan already counts, so an unresolved forward is not a missing channel.
   */
  const isForwardingAdapter = (expr) => {
    const parameter = parameterOf(expr);
    const fn = parameter?.parent;
    return Boolean(fn && ts.isMethodDeclaration(fn) && ts.isObjectLiteralExpression(fn.parent)
      && ts.isIdentifier(fn.name) && REGISTER_METHODS.has(fn.name.text));
  };
  const adapters = [];

  // --- Window-only Electron API use by a handler (dependency check) ---
  const { functionBody, guiOf } = createWindowApiScanner(checker);
  /** True when a handler answers synchronously (assigns `<event>.returnValue`). */
  const syncMemo = new Map();
  const assignsReturnValue = (fn) => {
    if (syncMemo.has(fn)) return syncMemo.get(fn);
    let found = false;
    const visit = (node) => {
      if (found) return;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'returnValue') found = true;
      else ts.forEachChild(node, visit);
    };
    visit(fn.body);
    syncMemo.set(fn, found);
    return found;
  };
  const handlerSync = (site) => {
    const call = site.parent;
    if (!call || !ts.isCallExpression(call)) return false;
    return call.arguments.some((arg) => {
      if (arg === site) return false;
      const fn = functionBody(arg);
      return Boolean(fn && assignsReturnValue(fn));
    });
  };
  /** Window APIs used by the handler arguments of the call that registers `site`. */
  const handlerGui = (site) => {
    const call = site.parent;
    if (!call || !ts.isCallExpression(call)) return [];
    const found = new Set();
    for (const arg of call.arguments) {
      if (arg === site) continue;
      const fn = functionBody(arg);
      if (fn) for (const name of guiOf(fn, 0)) found.add(name);
    }
    return [...found].sort();
  };

  for (const file of sources) {
    const sf = program.getSourceFile(file);
    if (!sf) continue;
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const kind = REGISTER_METHODS.get(method);
        if (kind && node.arguments.length >= 2 && isIpcReceiver(node.expression.expression)) {
          const registeredAt = position(node);
          const enclosing = enclosingFunctionName(node);
          for (const { values, site } of resolveChannel(node.arguments[0])) {
            const at = position(site);
            if (!values) {
              const entry = { ...registeredAt, expression: site.getText().slice(0, 80) };
              if (isForwardingAdapter(site)) {
                if (!adapters.some((a) => a.file === entry.file && a.line === entry.line)) adapters.push(entry);
              } else {
                unresolved.push(entry);
              }
              continue;
            }
            const gui = handlerGui(site);
            const sync = kind === 'event' && handlerSync(site);
            for (const channel of values) {
              registrations.push({
                gui,
                sync,
                channel,
                kind,
                file: at.file,
                line: at.line,
                registeredAt: at.file === registeredAt.file && at.line === registeredAt.line ? undefined : `${registeredAt.file}:${registeredAt.line}`,
                enclosing,
                perWebContents: /\.ipc$/.test(node.expression.expression.getText()),
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  const bootstrap = program.getSourceFile(path.join(mainRoot, 'bootstrap-electron.ts'));
  return {
    registrations, unresolved, adapters,
    contract: readContract(program, checker, constValues),
    clientRegistrars: [...clientModeRegistrars(bootstrap)].sort(),
  };
}

function findNode(sf, pos) {
  let found;
  const visit = (node) => {
    if (pos >= node.getStart(sf) && pos < node.getEnd()) {
      found = node;
      ts.forEachChild(node, visit);
    }
  };
  visit(sf);
  return found;
}

function enclosingFunctionName(node) {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    if ((ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) && cur.parent && ts.isVariableDeclaration(cur.parent) && ts.isIdentifier(cur.parent.name)) {
      return cur.parent.name.text;
    }
  }
  return undefined;
}

/**
 * Values of every `property: …` assignment in `sf` (optionally only inside
 * function `within`). A value the resolver cannot name is returned in
 * `unresolved` instead of being dropped: a silently skipped contract channel
 * would be reported as window-local while the client actually proxies it.
 */
export function collectContractChannels(sf, property, constValues, within) {
  const values = [];
  const unresolved = [];
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === property) {
      const resolved = isContractPassThrough(node.initializer) ? [] : constValues(node.initializer);
      if (resolved) values.push(...resolved);
      else unresolved.push({
        file: rel(sf.fileName),
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        expression: node.initializer.getText(sf).slice(0, 80),
      });
    }
    ts.forEachChild(node, visit);
  };
  if (within) {
    const visitFn = (node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === within) visit(node);
      else ts.forEachChild(node, visitFn);
    };
    visitFn(sf);
  } else {
    visit(sf);
  }
  return { values, unresolved };
}

/**
 * `HOST_CONTRACT_CHANNELS.map((def) => ({ channel: def.desktopChannel, … }))`
 * re-reads contract entries whose names come from the contract file itself.
 */
function isContractPassThrough(expr) {
  if (!ts.isPropertyAccessExpression(expr) || expr.name.text !== 'desktopChannel' || !ts.isIdentifier(expr.expression)) return false;
  for (let fn = expr.parent; fn; fn = fn.parent) {
    if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) continue;
    const parameter = fn.parameters[0];
    if (!parameter || !ts.isIdentifier(parameter.name) || parameter.name.text !== expr.expression.text) return false;
    const call = fn.parent;
    return Boolean(call && ts.isCallExpression(call) && call.arguments[0] === fn
      && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'map'
      && call.expression.expression.getText() === 'HOST_CONTRACT_CHANNELS');
  }
  return false;
}

/** Generation stops when any proxied channel name cannot be resolved statically. */
export function requireResolvedContract(unresolved) {
  if (!unresolved.length) return;
  const sites = unresolved.map((entry) => `${entry.file}:${entry.line} ${entry.expression}`).join('\n  ');
  throw new Error(`host channel contract has ${unresolved.length} channel name(s) the scanner cannot resolve; teach the scanner or write them as literals:\n  ${sites}`);
}

export const HOST_IPC_ENTRIES_PREFIX = 'packages/maker-shared/src/hostIpcEntries/';

/**
 * Functions the client-mode branch of `registerMakerIpcsAfterSplash` calls.
 * Their registrations run in client mode too. Read from source, so a
 * window-local registration added after the client snapshot is not reported
 * as rejected; generation stops if the branch can no longer be found.
 */
export function clientModeRegistrars(sf) {
  const names = new Set();
  let found = false;
  const collectCalls = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) names.add(node.expression.text);
    ts.forEachChild(node, collectCalls);
  };
  const findBranch = (node) => {
    if (ts.isIfStatement(node) && ts.isIdentifier(node.expression) && node.expression.text === 'hostClientMode') {
      found = true;
      collectCalls(node.thenStatement);
      return;
    }
    ts.forEachChild(node, findBranch);
  };
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'registerMakerIpcsAfterSplash' && node.initializer) {
      findBranch(node.initializer);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!found) throw new Error('client-mode branch (`if (hostClientMode)`) of registerMakerIpcsAfterSplash not found');
  return names;
}

/** Channels the client proxies to cindy-host, read from the same sources the client uses. */
function readContract(program, checker, constValues) {
  const contractFile = program.getSourceFiles().find((sf) => rel(sf.fileName) === 'packages/maker-shared/src/hostChannelContract.ts');
  const delegationFile = program.getSourceFile(path.join(mainRoot, 'host-delegation.ts'));
  const bootstrapFile = program.getSourceFile(path.join(mainRoot, 'bootstrap-electron.ts'));
  if (!contractFile || !delegationFile || !bootstrapFile) throw new Error('host channel contract sources not found');
  // Channels the Host serves through its generic route, one family per file.
  const registryFiles = program.getSourceFiles().filter((sf) => rel(sf.fileName).startsWith(HOST_IPC_ENTRIES_PREFIX));
  if (!registryFiles.length) throw new Error(`host IPC registry entries (${HOST_IPC_ENTRIES_PREFIX}) not found`);
  const parts = [
    collectContractChannels(contractFile, 'desktopChannel', constValues),
    collectContractChannels(delegationFile, 'channel', constValues),
    // Sync channels prefetched from the host at client-mode start.
    collectContractChannels(bootstrapFile, 'channel', constValues, 'installHostClientMode'),
    ...registryFiles.map((sf) => collectContractChannels(sf, 'channel', constValues)),
  ];
  requireResolvedContract(parts.flatMap((part) => part.unresolved));
  const proxied = new Set(parts.flatMap((part) => part.values));
  proxied.delete('');
  return proxied;
}

const MAIN_PREFIX = 'apps/desktop/src/main/';

/** The desktop module that owns a registration: packages register through a desktop adapter. */
export function owningFile(registration) {
  if (registration.file.startsWith(MAIN_PREFIX) || !registration.registeredAt) return registration.file;
  return registration.registeredAt.replace(/:\d+$/, '');
}

const UNLISTED_DOMAIN = '未登记前缀';

/**
 * contract / client first, then ownership. `basis` says which part decided:
 * `rule` (OWNERSHIP_RULES), `dependency` (window API use or a synchronous
 * handler), or `default`. `sub` refines S (local / mirror) and C (backend /
 * window / two-phase / special).
 */
export function classify(registration, contract) {
  if (contract.has(registration.channel)) return { category: 'contract' };
  if (registration.enclosing === 'installHostClientMode') return { category: 'client' };
  if (registration.perWebContents) return { category: 'B', reason: '单个窗口内的插件页面 IPC（webContents.ipc）', basis: 'rule' };
  const module = owningFile(registration).replace(MAIN_PREFIX, '');
  const rule = OWNERSHIP_RULES.find((r) => r.channel?.test(registration.channel) || r.module?.test(module));
  if (rule?.owner === 'B') return { category: 'B', reason: rule.reason, basis: 'rule' };
  if (registration.sync) {
    // A synchronous answer cannot wait for an HTTP round trip to the Host.
    if (!rule || rule.owner === 'W' || SYNC_LOCAL_DOMAINS.has(rule.reason)) {
      const reason = rule?.reason === '账号与凭据'
        ? '同步通道·账号提示：只读 profile 里的首帧提示（事件流连上之前就要回答），登录状态仍以 Host 为准'
        : '同步通道·界面设置：窗口本地读同一份 profile 文件';
      return { category: 'S', sub: 'local', reason, basis: 'dependency' };
    }
    return {
      category: 'S', sub: 'mirror', basis: 'dependency',
      reason: `同步通道·${rule.reason}：数据归 Host，需窗口缓存镜像（Host 经事件流推送，窗口同步回答缓存）或改界面为异步，放进对应小批单独设计`,
    };
  }
  if (rule && rule.owner !== 'A') return { category: rule.owner, sub: rule.sub, reason: rule.reason, domain: rule.reason, basis: 'rule' };
  const gui = registration.gui ?? [];
  const domain = rule?.reason ?? UNLISTED_DOMAIN;
  if (gui.length) {
    return { category: 'C', sub: 'two-phase', domain, reason: `${domain}，但处理函数用到窗口 API：${gui.join('、')}；窗口做界面动作，数据那一半调 Host`, basis: 'dependency' };
  }
  if (rule) return { category: 'A', reason: domain, domain, basis: 'rule' };
  return { category: 'A', reason: '未登记前缀，处理函数没有用到窗口 API', domain, basis: 'default' };
}

export function moduleGroup(file) {
  const inner = file.replace(MAIN_PREFIX, '');
  const parts = inner.split('/');
  return parts.length > 1 ? parts[0] : inner.replace(/\.tsx?$/, '');
}

const CATEGORIES = ['contract', 'client', 'A', 'B', 'W', 'S', 'R', 'C'];
const SUBS = ['S:local', 'S:mirror', 'C:backend', 'C:two-phase', 'C:window', 'C:special'];
export const SUB_LABELS = {
  'S:local': '同步·本地（窗口读 profile：界面设置与首帧提示）',
  'S:mirror': '同步·数据归 Host（需窗口缓存镜像）',
  'C:backend': 'C-后台',
  'C:two-phase': 'C-两段式（窗口做界面动作，数据调 Host）',
  'C:window': 'C-窗口本地',
  'C:special': 'C-专项设计（安全边界）',
};
const subKey = (row) => (row.sub ? `${row.category}:${row.sub}` : null);

/** What the Host still has to implement: A plus the backend half of C. */
export function isHostWork(row) {
  return row.category === 'A' || (row.category === 'C' && (row.sub === 'backend' || row.sub === 'two-phase'));
}
/** Channels the window keeps answering itself when it runs as a client. */
export function isWindowClass(row) {
  return row.category === 'B' || row.category === 'W' || (row.category === 'S' && row.sub === 'local')
    || (row.category === 'C' && row.sub === 'window');
}

/** Location for the doc: file only, so the doc does not go stale with every edit (lines stay in --json). */
const fileOnly = (site) => site.replace(MAIN_PREFIX, '').replace(/:\d+$/, '');

const channelKey = (kind, channel) => `${kind}:${channel}`;

const unservedCount = (entry) => entry.missing + entry.unsupported;

/**
 * Real calls per channel. An embedded run (`mode: 'embedded'`) counts every call
 * the window made; a client run counts only calls that found no handler.
 * Reports come from apps/desktop/src/main/ipcChannelUsage.ts.
 */
export function usageCounts(usage) {
  const counts = new Map();
  if (!usage) return counts;
  for (const [channel, entry] of Object.entries(usage.channels ?? {})) {
    const count = usage.mode === 'client' ? unservedCount(entry) : entry.count;
    // Old reports keyed only by channel; entry.kind is the only recorded kind.
    const key = usage.version === 2 ? channel : channelKey(entry.kind, channel);
    if (count > 0) counts.set(key, count);
  }
  return counts;
}

/** Channels matching `filter` ranked by real calls; channels outside the inventory count as Host work. */
export function rankUsage(rows, usage, filter = isHostWork) {
  const byChannel = new Map(rows.map((row) => [channelKey(row.kind, row.channel), row]));
  return [...usageCounts(usage)]
    .map(([key, count]) => {
      const row = byChannel.get(key);
      const split = key.indexOf(':');
      const kind = key.slice(0, split);
      const channel = key.slice(split + 1);
      return {
        kind, channel, count, category: row?.category ?? 'unregistered', sub: row?.sub,
        group: row?.group ?? '-', reason: row?.reason ?? '不在静态清单里', row,
      };
    })
    .filter((entry) => (entry.row ? filter(entry.row) : filter === isHostWork))
    .map(({ row: _row, ...entry }) => entry)
    .sort((a, b) => b.count - a.count || a.channel.localeCompare(b.channel) || a.kind.localeCompare(b.kind));
}

/**
 * What a window-class channel does in client mode today, from the handler
 * snapshots of a client-mode run and an embedded run. Absent from the client
 * snapshot but present in the embedded one means the window rejects it although
 * it should answer locally. A channel registered by a function the client-mode
 * branch calls (`clientRegistrars`) is local from source even when the snapshot
 * predates it.
 */
export function clientBehavior(row, clientReport, embeddedReport, clientRegistrars = new Set()) {
  if (row.perWebContents) return 'per-webcontents';
  const has = (report) => {
    const registered = report?.registered;
    if (!registered) return null;
    return (row.kind === 'invoke' ? registered.invoke : registered.event).includes(row.channel);
  };
  const client = has(clientReport);
  if (client) return 'local';
  if (row.enclosing && clientRegistrars.has(row.enclosing)) return 'local-source';
  if (client === null) return 'unknown';
  if (has(embeddedReport) === false) return 'not-registered-either';
  if (row.kind === 'event') return 'dropped';
  return row.channel.startsWith('maker:') ? 'unsupported' : 'no-handler';
}

export const CLIENT_BEHAVIOR_LABELS = {
  local: '窗口本地照常处理',
  'local-source': '窗口本地照常处理（源码判定：客户端分支调用其注册函数；客户端快照早于这次改动，未实测）',
  unsupported: '被拒：UNSUPPORTED_CAPABILITY',
  'no-handler': '被拒：No handler registered',
  dropped: '消息无人监听（被丢弃）',
  'not-registered-either': '两次快照都未注册（按需注册或未走到）',
  'per-webcontents': '注册在插件页面的 webContents.ipc 上，主进程快照不覆盖',
  unknown: '没有客户端模式快照',
};
const REJECTED = new Set(['unsupported', 'no-handler', 'dropped']);

const LOCAL = new Set(['local', 'local-source']);

/**
 * Host work grouped by domain (the A-rule or C-rule reason): channels of one
 * domain usually need the same Host service, so batches are cut by domain.
 * Ranked by real calls, then by channel count.
 */
export function hostFamilies(hostRows, usage) {
  const families = new Map();
  for (const row of hostRows) {
    const domain = row.domain ?? row.reason;
    const family = families.get(domain) ?? { domain, total: 0, used: 0, calls: 0, groups: new Map() };
    family.total += 1;
    if (row.used) {
      family.used += 1;
      family.calls += row.used;
    }
    family.groups.set(row.group, (family.groups.get(row.group) ?? 0) + 1);
    families.set(domain, family);
  }
  return [...families.values()]
    .map((family) => ({
      ...family,
      used: usage ? family.used : null,
      calls: usage ? family.calls : null,
      groups: [...family.groups].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    }))
    .sort((a, b) => (b.calls ?? 0) - (a.calls ?? 0) || b.total - a.total || a.domain.localeCompare(b.domain));
}

export function summarize({ registrations, unresolved, adapters = [], contract, clientRegistrars = [] }, usage, clientUsage = null) {
  const registrars = new Set(clientRegistrars);
  const channels = new Map();
  for (const registration of registrations) {
    const key = `${registration.kind}:${registration.channel}`;
    const existing = channels.get(key);
    if (existing) {
      existing.sites.push(`${registration.file}:${registration.line}`);
      existing.gui = [...new Set([...existing.gui, ...(registration.gui ?? [])])].sort();
      existing.sync ||= Boolean(registration.sync);
      continue;
    }
    channels.set(key, {
      ...registration,
      gui: registration.gui ?? [],
      group: moduleGroup(owningFile(registration)),
      sites: [`${registration.file}:${registration.line}`],
    });
  }
  for (const row of channels.values()) {
    row.sites = [...new Set(row.sites)];
    Object.assign(row, classify(row, contract));
  }
  const rows = [...channels.values()].sort((a, b) => a.group.localeCompare(b.group) || a.channel.localeCompare(b.channel) || a.kind.localeCompare(b.kind));
  const totals = Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
  const subs = Object.fromEntries(SUBS.map((key) => [key, 0]));
  const basis = {};
  for (const row of rows) {
    totals[row.category] += 1;
    if (subKey(row)) subs[subKey(row)] += 1;
    if (row.basis) basis[`${row.category}:${row.basis}`] = (basis[`${row.category}:${row.basis}`] ?? 0) + 1;
  }
  const missingContract = [...contract].filter((channel) => !rows.some((row) => row.channel === channel)).sort();
  const groups = new Map();
  for (const row of rows) {
    const group = groups.get(row.group) ?? { group: row.group, total: 0, ...Object.fromEntries(CATEGORIES.map((c) => [c, 0])) };
    group[row.category] += 1;
    group.total += 1;
    groups.set(row.group, group);
  }
  const counts = usageCounts(usage);
  for (const row of rows) {
    row.used = counts.get(channelKey(row.kind, row.channel)) ?? 0;
    if (isWindowClass(row)) row.clientBehavior = clientBehavior(row, clientUsage, usage, registrars);
  }
  let usedTotals = null;
  if (usage) {
    const byChannel = new Map(rows.map((row) => [channelKey(row.kind, row.channel), row]));
    usedTotals = { total: 0, calls: 0, unregistered: 0, ...Object.fromEntries([...CATEGORIES, ...SUBS].map((c) => [c, 0])) };
    for (const [key, count] of counts) {
      const row = byChannel.get(key);
      usedTotals.total += 1;
      usedTotals.calls += count;
      if (!row) { usedTotals.unregistered += 1; continue; }
      usedTotals[row.category] += 1;
      if (subKey(row)) usedTotals[subKey(row)] += 1;
    }
  }
  const hostRows = rows.filter(isHostWork);
  const ranking = usage ? rankUsage(rows, usage) : null;
  const hostWork = {
    total: hostRows.length,
    A: totals.A,
    cBackend: subs['C:backend'],
    cTwoPhase: subs['C:two-phase'],
    used: ranking ? ranking.length : null,
    calls: ranking ? ranking.reduce((sum, entry) => sum + entry.count, 0) : null,
    usedA: ranking ? ranking.filter((e) => e.category === 'A' || e.category === 'unregistered').length : null,
  };
  const families = hostFamilies(hostRows, usage);
  const windowRows = rows.filter(isWindowClass);
  const windowStatus = {
    total: windowRows.length,
    registered: windowRows.filter((row) => LOCAL.has(row.clientBehavior)).length,
    fromSource: windowRows.filter((row) => row.clientBehavior === 'local-source').length,
    unregistered: windowRows.filter((row) => REJECTED.has(row.clientBehavior)).length,
    other: windowRows.filter((row) => !LOCAL.has(row.clientBehavior) && !REJECTED.has(row.clientBehavior)).length,
  };
  return {
    rows, totals, subs, basis, usedTotals, ranking, hostWork, windowStatus, families,
    groups: [...groups.values()].sort((a, b) => b.A - a.A || a.group.localeCompare(b.group)),
    unresolved, adapters, missingContract,
  };
}

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', '--short=10', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function code(text) {
  const value = String(text);
  // GFM splits table cells before parsing code spans: \| is special even
  // inside backticks. HTML entities preserve literal slashes, pipes and ticks
  // without changing escape parity or letting the input close the code element.
  if (!/[\\`|&<>\r\n]/.test(value)) return `\`${value}\``;
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '|': '&#124;',
    '\\': '&#92;', '`': '&#96;', '\r': '&#13;', '\n': '&#10;' };
  return `<code>${value.replace(/[&<>|\\`\r\n]/g, (char) => entities[char])}</code>`;
}
const label = (row) => (subKey(row) ? SUB_LABELS[subKey(row)] : row.category);

export function renderMarkdown(summary, { usageSource, clientSource } = {}) {
  const { rows, totals, subs, basis, groups, unresolved, adapters, missingContract, ranking, usedTotals, hostWork, windowStatus, families = [] } = summary;
  const lines = [];
  const push = (...items) => lines.push(...items);
  const used = (key) => (usedTotals ? `（巡检调用 ${usedTotals[key]}）` : '');
  push('# Host 通道覆盖清单（脚本生成）', '');
  push('> 由 `node scripts/host-channel-coverage.mjs` 生成，不要手工修改；行号只在 `--json` 输出里。');
  push(`> 生成时的源码提交：\`${gitHead()}\`。归属规则见下方「归属规则」，正本在脚本的 \`OWNERSHIP_RULES\`。`, '');
  push('统计对象是桌面主进程（`apps/desktop/src/main`，不含测试）里所有 `ipcMain.handle/on`');
  push('及其包装函数注册的通道；注册、调用次数和排行均按 `(kind, channel)` 区分。', '');
  push('计数报告 v2 分别保存同名 invoke / event。旧报告按记录的 `kind` 归类；若旧采样已混算，无法事后拆分，需重新采样。', '');

  push('## 总口径', '');
  push(`**真正要 Host 做的 = A + C-后台 + C-两段式 = ${hostWork.A} + ${hostWork.cBackend} + ${hostWork.cTwoPhase} = ${hostWork.total}**`
    + (ranking ? `；巡检实际调用到 **${hostWork.used}** 个（${hostWork.calls} 次，其中 A ${hostWork.usedA}）。` : '。'));
  push('同步通道（S）与回执通道（R）已单列，不在 A 里；C-窗口本地与 C-专项设计不计入。', '');
  push('| 分类 | 含义 | 通道数 |', '|---|---|---:|');
  push(`| contract | 已在 Host 通道合同或通用路由登记表里，窗口做客户端时转发给 Host | ${totals.contract}${used('contract')} |`);
  push(`| client | 客户端模式自己的通道（连接状态、重连） | ${totals.client}${used('client')} |`);
  push(`| **A** | 必须由后台处理：读写后台持有的数据或运行状态 | ${totals.A}${used('A')} |`);
  push(`| **B** | 永久留在窗口：只能在 Electron／图形界面里做 | ${totals.B}${used('B')} |`);
  push(`| **W** | 窗口本地设置：窗口直接读写同一份 profile，不经 Host | ${totals.W}${used('W')} |`);
  push(`| **S** | 同步通道（给 \`event.returnValue\` 赋值）：不能转发给 Host | ${totals.S}${used('S')} |`);
  push(`| 　S·本地 | ${SUB_LABELS['S:local']} | ${subs['S:local']}${used('S:local')} |`);
  push(`| 　S·镜像 | ${SUB_LABELS['S:mirror']} | ${subs['S:mirror']}${used('S:mirror')} |`);
  push(`| **R** | 回执通道：主进程向界面要数据，界面回执；先不排期 | ${totals.R}${used('R')} |`);
  push(`| **C** | 跨两边，按处理方式分四种 | ${totals.C}${used('C')} |`);
  for (const key of ['C:backend', 'C:two-phase', 'C:window', 'C:special']) push(`| 　${SUB_LABELS[key]} | | ${subs[key]}${used(key)} |`);
  push(`| 合计 | | ${rows.length} |`, '');
  push('**窗口类**（B + W + S·本地 + C-窗口本地）在客户端模式下：');
  push(`已注册 **${windowStatus.registered}**`
    + (windowStatus.fromSource ? `（其中 ${windowStatus.fromSource} 个只有源码判定，客户端快照里还没有）` : '')
    + `、未注册 **${windowStatus.unregistered}**（今天被拒或无人监听，见下文）、快照无法判断 ${windowStatus.other}。`, '');
  push(`判定依据：${Object.entries(basis).sort().map(([key, count]) => `${key} ${count}`).join('、')}`
    + '（rule = 规则表，dependency = 窗口 API 或同步返回值判定，default = 未登记前缀且没用窗口 API）。', '');
  push('合同一侧（`hostChannelContract.ts`、`host-delegation.ts`、客户端模式预取、Host 通用路由的登记表 `hostIpcEntries/`）的通道名全部静态解析：解析不出任何一个时脚本直接失败，不会生成本清单。', '');
  if (unresolved.length) {
    push(`未能静态解析通道名的注册点 ${unresolved.length} 处（不计入上表）：`, '');
    for (const entry of unresolved) push(`- \`${fileOnly(entry.file)}\` — ${code(entry.expression)}`);
    push('');
  }
  if (adapters.length) {
    push(`转发适配器 ${adapters.length} 处（把通道原样转给另一个注册表，通道已在调用处计入）：`);
    push([...new Set(adapters.map((entry) => `\`${fileOnly(entry.file)}\``))].join('、'), '');
  }
  if (missingContract.length) {
    push(`合同里有、但桌面主进程没有注册的通道 ${missingContract.length} 个（Host 独有或桌面已改名）：`, '');
    push(missingContract.map((channel) => `\`${channel}\``).join('、'), '');
  }

  push('## 归属规则', '');
  push('按顺序匹配，先中先得；通道名或注册模块（`apps/desktop/src/main` 下的路径）命中即算。');
  push('1. B 规则直接定类。');
  push(`2. 处理函数给 \`event.returnValue\` 赋值的同步通道判 S：命中 W 规则、领域为${[...SYNC_LOCAL_DOMAINS].join('、')}或未登记前缀的为 S·本地，其余为 S·镜像。`);
  push('3. W、R、C 规则直接定类（C 规则带细分）。');
  push('4. A 规则只标领域；处理函数及其调用的两层桌面源码函数（含参数默认值，不含被调函数里的嵌套回调）若用到下面的窗口 API，改判 C-两段式。');
  push('5. 没有命中任何规则：用到窗口 API 判 C-两段式，否则判 A（默认）。', '');
  push('| 归属 | 原因 | 通道名 | 注册模块 |', '|---|---|---|---|');
  for (const rule of OWNERSHIP_RULES) {
    const owner = rule.sub ? SUB_LABELS[`${rule.owner}:${rule.sub}`] : rule.owner;
    push(`| ${owner} | ${rule.reason} | ${rule.channel ? code(rule.channel.source) : '—'} | ${rule.module ? code(rule.module.source) : '—'} |`);
  }
  push('');
  push(`窗口 API：Electron 导出 ${[...GUI_EXPORTS].map(code).join('、')}；`
    + `成员 ${Object.entries(GUI_MEMBERS).flatMap(([owner, members]) => [...members].map((m) => code(`${owner}.${m}`))).join('、')}；`
    + '以及 `new BrowserWindow`。不计入：发送方校验（`src/main/security/`，客户端模式下由 Host 令牌鉴权），'
    + '以及发给某个窗口的推送（`webContents.fromId`、`event.sender`，客户端模式下推送走 Host 事件流）。', '');

  if (families.length) {
    push('## 要 Host 做的：按领域排行', '');
    push('领域取自归属规则的原因（A 规则与 C 规则）；同一领域的通道通常共用一个 Host 服务，各批按领域切。'
      + '按巡检调用次数排序，次数相同按通道数。“主要模块”是该领域通道最多的三个注册模块。', '');
    push('| # | 领域 | 通道数 | 巡检调用到 | 调用次数 | 主要模块 |', '|---:|---|---:|---:|---:|---|');
    families.forEach((family, index) => {
      const top = family.groups.slice(0, 3).map(([group, count]) => `${group} ${count}`).join('、');
      push(`| ${index + 1} | ${family.domain} | ${family.total} | ${family.used ?? '-'} | ${family.calls ?? '-'} | ${top} |`);
    });
    push('');
  }

  if (ranking) {
    push('## 要 Host 做的：实际调用排行', '');
    push(`来源：${usageSource ?? '调用计数报告'}。范围是 A + C-后台 + C-两段式；这次共调用 ${usedTotals.total} 个通道（${usedTotals.calls} 次）。`, '');
    push('| # | 通道 | 类型 | 调用次数 | 归属 | 领域／原因 | 模块 |', '|---:|---|---|---:|---|---|---|');
    ranking.forEach((entry, index) => {
      const owner = entry.sub ? SUB_LABELS[`${entry.category}:${entry.sub}`] : entry.category;
      push(`| ${index + 1} | ${code(entry.channel)} | ${entry.kind} | ${entry.count} | ${owner} | ${entry.reason} | ${entry.group} |`);
    });
    push('');
  }

  const listSection = (title, filter, note) => {
    const selected = rows.filter(filter).sort((a, b) => b.used - a.used || a.channel.localeCompare(b.channel) || a.kind.localeCompare(b.kind));
    push(`## ${title}（${selected.length}）`, '');
    if (note) push(note, '');
    push('| 通道 | 类型 | 归属 | 原因 | 调用次数 | 注册文件 |', '|---|---|---|---|---:|---|');
    for (const row of selected) push(`| ${code(row.channel)} | ${row.kind} | ${label(row)} | ${row.reason} | ${row.used} | \`${fileOnly(row.sites[0])}\` |`);
    push('');
  };
  listSection('同步通道 S', (row) => row.category === 'S',
    'S·本地：界面设置与登录首帧提示，由窗口本地读同一份 profile 文件，客户端模式下照常注册（登录状态本身仍以 Host 为准）。S·镜像：数据归 Host（插件状态），'
    + '需要“窗口缓存镜像”（Host 经事件流推送、窗口同步回答缓存）或把界面改成异步，单独设计，放进对应的小批（插件那批），不混进 1a。');
  listSection('回执通道 R', (row) => row.category === 'R',
    '主进程发请求、界面用本地存储里的数据回执。Host 要这些数据得经窗口往返一次，不是普通的“接一个接口”；先标出来，不排期。');
  listSection('C 类全量', (row) => row.category === 'C',
    'C-后台：换窗口时不能断、网页和手机也要用，计入要 Host 做的（终端优先级低）。C-两段式：窗口保留处理者做界面动作，数据那一半调 Host，'
    + '每个需要一个 Host 接口，计入但低频、排在后面。C-窗口本地：路径来自用户在本窗口的选择，客户端模式下照常注册，不计入。'
    + 'C-专项设计：安全边界，先读 docs/product-rules/input-handoff.md，方案出来前不动。');

  const windowRows = rows.filter(isWindowClass);
  const behaviorCounts = {};
  for (const row of windowRows) behaviorCounts[row.clientBehavior] = (behaviorCounts[row.clientBehavior] ?? 0) + 1;
  push('## 窗口类在客户端模式下的实际行为', '');
  push(`来源：${clientSource ?? '没有客户端模式快照'}；对照 ${usageSource ?? '没有普通模式快照'}。`);
  push('两份快照都是报告写入时主进程已注册的处理者；客户端快照里没有、普通模式快照里有，就是该在窗口本地处理却没有注册的通道。');
  push('客户端快照取在登录页（Host 没有免账号模式），登录后才注册的处理者不在其中。');
  push('快照之后客户端分支新调用的注册函数从源码读出（`registerMakerIpcsAfterSplash` 的 `if (hostClientMode)` 分支），'
    + '其通道记为“源码判定”，下次录制客户端快照后以快照为准。', '');
  push('| 行为 | 通道数 |', '|---|---:|');
  for (const [key, text] of Object.entries(CLIENT_BEHAVIOR_LABELS)) if (behaviorCounts[key]) push(`| ${text} | ${behaviorCounts[key]} |`);
  push('');
  const rejected = windowRows.filter((row) => REJECTED.has(row.clientBehavior)).sort((a, b) => b.used - a.used || a.channel.localeCompare(b.channel) || a.kind.localeCompare(b.kind));
  if (rejected.length) {
    push(`### 窗口类但客户端模式下未注册（${rejected.length}，尚未实现）`, '');
    push('| 通道 | 类型 | 归属 | 客户端模式下 | 调用次数 | 注册文件 |', '|---|---|---|---|---:|---|');
    for (const row of rejected) {
      push(`| ${code(row.channel)} | ${row.kind} | ${label(row)}（${row.reason}） | ${CLIENT_BEHAVIOR_LABELS[row.clientBehavior]} | ${row.used} | \`${fileOnly(row.sites[0])}\` |`);
    }
    push('');
  }
  const unclear = windowRows.filter((row) => !LOCAL.has(row.clientBehavior) && !REJECTED.has(row.clientBehavior));
  if (unclear.length) {
    push(`快照无法判断的窗口类通道（${unclear.length}）：${unclear.map((row) => `${code(row.channel)}（${CLIENT_BEHAVIOR_LABELS[row.clientBehavior]}）`).join('、')}`, '');
  }

  push('## 按注册模块', '');
  push('| 模块 | 已代理 | A | B | W | S | R | C | 合计 |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const group of groups) {
    push(`| ${group.group} | ${group.contract + group.client} | ${group.A} | ${group.B} | ${group.W} | ${group.S} | ${group.R} | ${group.C} | ${group.total} |`);
  }
  push('');

  push('## 全部通道', '');
  let currentGroup = '';
  rows.forEach((row, index) => {
    if (row.group !== currentGroup) {
      currentGroup = row.group;
      push(`### ${currentGroup}`, '', '| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |', '|---|---|---|---:|---|');
    }
    const category = row.reason ? `${label(row)}（${row.reason}）` : row.category;
    const files = [...new Set(row.sites.map(fileOnly))];
    const more = files.length > 1 ? ` 等 ${files.length} 个文件` : '';
    push(`| ${code(row.channel)} | ${row.kind} | ${category} | ${row.used} | \`${files[0]}\`${more} |`);
    if (rows[index + 1]?.group !== currentGroup) push('');
  });
  return `${lines.join('\n').trimEnd()}\n`;
}

function readReport(explicit, fallbackRel) {
  const fallback = path.join(repoRoot, fallbackRel);
  const file = explicit ?? (fs.existsSync(fallback) ? fallback : undefined);
  if (!file) return { report: null, source: undefined };
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rel = path.relative(repoRoot, path.resolve(file)).split(path.sep).join('/');
  return { report, source: `\`${rel}\`（${report.source}；${report.mode} 模式，${report.startedAt.slice(0, 10)}）` };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const started = Date.now();
  const inventory = collectInventory();
  const usage = readReport(option('--usage'), USAGE_REL_PATH);
  const clientUsage = readReport(option('--client-usage'), CLIENT_USAGE_REL_PATH);
  const summary = summarize(inventory, usage.report, clientUsage.report);
  const markdown = renderMarkdown(summary, { usageSource: usage.source, clientSource: clientUsage.source });
  const jsonPath = option('--json');
  if (jsonPath) fs.writeFileSync(jsonPath, `${JSON.stringify({ ...summary, contract: [...inventory.contract].sort() }, null, 2)}\n`);
  if (flag('--stdout')) process.stdout.write(markdown);
  else fs.writeFileSync(path.join(repoRoot, DOC_REL_PATH), markdown);
  const { totals } = summary;
  console.error(`[host-channel-coverage] ${summary.rows.length} channels: contract=${totals.contract} client=${totals.client} A=${totals.A} B=${totals.B} W=${totals.W} S=${totals.S} R=${totals.R} C=${totals.C} hostWork=${summary.hostWork.total} unresolved=${summary.unresolved.length} (${Date.now() - started}ms)`);
}
