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
 *   contract  — proxied to cindy-host (HOST_CONTRACT_CHANNELS and the extra
 *               client-mode proxies in host-delegation.ts)
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
    channel: /^(maker:computer|maker:browser|browser-backend|rsb-browser-bridge|rsb-native-popup)/,
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
    channel: /^(update-|get-app-version|get-app-display-version-info|get-os-release|release-notes:|app:get-arm64-translation|app:open-logs-dir|crash-diagnosis|log-upload|performance-trace|renderer:log|dev:|cc:set-debug-net|deep-link:)/,
    module: /^(updateService|relaunchBusyActivityIpc|crash-diagnosis|log-upload|performance-trace)\b/,
  },
  {
    owner: 'C',
    reason: '终端 PTY：放窗口则换窗口时断开，放后台需要流式输出通道',
    channel: /^terminal:/,
  },
  {
    owner: 'C',
    reason: '本机文件读取：同一台电脑两边都能读，网页与手机只能走后台',
    channel: /^(maker:file-browser|maker:chat-file|maker:chat-folder|maker:html-preview|maker:search:|file-browser:|fs:|read-file-bytes|read-file-for-attachment|text-file:|peek-file-header|file:thumbnail)/,
    module: /^fsBrowse\b/,
  },
  {
    owner: 'C',
    reason: '弹出系统选择框后写入后台数据：选择在窗口，结果归后台',
    channel: /(^|:)(choose|pick)([A-Z-]|$)/,
  },
  {
    owner: 'C',
    reason: '在访达／资源管理器或系统浏览器里打开后台持有的内容',
    channel: /(:|-)(open-dir|reveal)$|:open-[a-z-]*-dir(ectory)?$|^billing:open-/,
  },
  {
    owner: 'C',
    reason: '运行时发起、窗口收集用户输入（安全输入交接）',
    channel: /^input-handoff:/,
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

  const literalStrings = (type) => {
    if (type.isStringLiteral()) return [type.value];
    if (type.isUnion() && type.types.every((t) => t.isStringLiteral())) return type.types.map((t) => t.value);
    return null;
  };

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
  const isDesktopSource = (sf) => sf && !sf.isDeclarationFile && sf.fileName.startsWith(path.join(desktopRoot, 'src') + path.sep);
  const electronExport = (node) => {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const decl = symbol?.declarations?.[0];
    return decl && /node_modules\/electron\/electron\.d\.ts$/.test(decl.getSourceFile().fileName) ? symbol.getName() : null;
  };
  const functionBody = (node) => {
    if (!node) return null;
    if (ts.isFunctionLike(node) && node.body) return node;
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const decl = symbol?.valueDeclaration;
    if (!decl || !isDesktopSource(decl.getSourceFile()) || GUI_SKIP_MODULES.test(decl.getSourceFile().fileName)) return null;
    if (ts.isFunctionLike(decl) && decl.body) return decl;
    const init = (ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl)) ? decl.initializer : undefined;
    return init && ts.isFunctionLike(init) && init.body ? init : null;
  };
  const guiMemo = new Map();
  const guiOf = (fn, depth) => {
    if (guiMemo.has(fn)) return guiMemo.get(fn);
    const found = new Set();
    guiMemo.set(fn, found);
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
    visitBody(fn.body);
    return found;
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
            for (const channel of values) {
              registrations.push({
                gui,
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

  return { registrations, unresolved, adapters, contract: readContract(program, checker, constValues) };
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

/** Channels the client proxies to cindy-host, read from the same sources the client uses. */
function readContract(program, checker, constValues) {
  const proxied = new Set();
  const contractFile = program.getSourceFiles().find((sf) => sf.fileName.endsWith('packages/maker-shared/src/hostChannelContract.ts'));
  const delegationFile = program.getSourceFile(path.join(mainRoot, 'host-delegation.ts'));
  const bootstrapFile = program.getSourceFile(path.join(mainRoot, 'bootstrap-electron.ts'));
  if (!contractFile || !delegationFile || !bootstrapFile) throw new Error('host channel contract sources not found');
  const collectProperty = (sf, property, within) => {
    const visit = (node) => {
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === property) {
        for (const value of constValues(node.initializer) ?? []) proxied.add(value);
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
  };
  collectProperty(contractFile, 'desktopChannel');
  collectProperty(delegationFile, 'channel');
  // Sync channels prefetched from the host at client-mode start.
  collectProperty(bootstrapFile, 'channel', 'installHostClientMode');
  proxied.delete('');
  return proxied;
}

const MAIN_PREFIX = 'apps/desktop/src/main/';

/** The desktop module that owns a registration: packages register through a desktop adapter. */
export function owningFile(registration) {
  if (registration.file.startsWith(MAIN_PREFIX) || !registration.registeredAt) return registration.file;
  return registration.registeredAt.replace(/:\d+$/, '');
}

/**
 * contract / client first, then ownership. `basis` says which part decided:
 * `rule` (OWNERSHIP_RULES), `dependency` (window API use), or `default`.
 */
export function classify(registration, contract) {
  if (contract.has(registration.channel)) return { category: 'contract' };
  if (registration.enclosing === 'installHostClientMode') return { category: 'client' };
  if (registration.perWebContents) return { category: 'B', reason: '单个窗口内的插件页面 IPC（webContents.ipc）', basis: 'rule' };
  const module = owningFile(registration).replace(MAIN_PREFIX, '');
  const rule = OWNERSHIP_RULES.find((r) => r.channel?.test(registration.channel) || r.module?.test(module));
  if (rule && rule.owner !== 'A') return { category: rule.owner, reason: rule.reason, basis: 'rule' };
  const gui = registration.gui ?? [];
  const domain = rule?.reason ?? '未登记前缀';
  if (gui.length) return { category: 'C', reason: `${domain}，但处理函数用到窗口 API：${gui.join('、')}`, basis: 'dependency' };
  if (rule) return { category: 'A', reason: domain, basis: 'rule' };
  return { category: 'A', reason: '未登记前缀，处理函数没有用到窗口 API', basis: 'default' };
}

export function moduleGroup(file) {
  const inner = file.replace(MAIN_PREFIX, '');
  const parts = inner.split('/');
  return parts.length > 1 ? parts[0] : inner.replace(/\.tsx?$/, '');
}

const CATEGORIES = ['contract', 'client', 'A', 'B', 'C'];

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
    if (count > 0) counts.set(channel, count);
  }
  return counts;
}

/** Channels of the given categories ranked by real calls; channels outside the inventory count as A. */
export function rankUsage(rows, usage, categories = ['A']) {
  const byChannel = new Map(rows.map((row) => [row.channel, row]));
  return [...usageCounts(usage)]
    .map(([channel, count]) => {
      const row = byChannel.get(channel);
      return { channel, count, category: row?.category ?? 'unregistered', group: row?.group ?? '-', reason: row?.reason ?? '不在静态清单里' };
    })
    .filter((entry) => categories.includes(entry.category) || (categories.includes('A') && entry.category === 'unregistered'))
    .sort((a, b) => b.count - a.count || a.channel.localeCompare(b.channel));
}

/**
 * What a B channel does in client mode today, from the handler snapshots of a
 * client-mode run and an embedded run. Absent from the client snapshot but
 * present in the embedded one means the window rejects it although it should
 * handle it locally.
 */
export function clientBehavior(row, clientReport, embeddedReport) {
  if (row.perWebContents) return 'per-webcontents';
  const has = (report) => {
    const registered = report?.registered;
    if (!registered) return null;
    return (row.kind === 'invoke' ? registered.invoke : registered.event).includes(row.channel);
  };
  const client = has(clientReport);
  if (client === null) return 'unknown';
  if (client) return 'local';
  if (has(embeddedReport) === false) return 'not-registered-either';
  if (row.kind === 'event') return 'dropped';
  return row.channel.startsWith('maker:') ? 'unsupported' : 'no-handler';
}

export const CLIENT_BEHAVIOR_LABELS = {
  local: '窗口本地照常处理',
  unsupported: '被拒：UNSUPPORTED_CAPABILITY',
  'no-handler': '被拒：No handler registered',
  dropped: '消息无人监听（被丢弃）',
  'not-registered-either': '两次快照都未注册（按需注册或未走到）',
  'per-webcontents': '注册在插件页面的 webContents.ipc 上，主进程快照不覆盖',
  unknown: '没有客户端模式快照',
};

export function summarize({ registrations, unresolved, adapters = [], contract }, usage, clientUsage = null) {
  const channels = new Map();
  for (const registration of registrations) {
    const key = `${registration.kind}:${registration.channel}`;
    const existing = channels.get(key);
    if (existing) {
      existing.sites.push(`${registration.file}:${registration.line}`);
      existing.gui = [...new Set([...existing.gui, ...(registration.gui ?? [])])].sort();
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
  const rows = [...channels.values()].sort((a, b) => a.group.localeCompare(b.group) || a.channel.localeCompare(b.channel));
  const totals = Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
  const basis = { 'A:rule': 0, 'A:default': 0, 'C:rule': 0, 'C:dependency': 0 };
  for (const row of rows) {
    totals[row.category] += 1;
    if (`${row.category}:${row.basis}` in basis) basis[`${row.category}:${row.basis}`] += 1;
  }
  const missingContract = [...contract].filter((channel) => !rows.some((row) => row.channel === channel)).sort();
  const groups = new Map();
  for (const row of rows) {
    const group = groups.get(row.group) ?? { group: row.group, contract: 0, client: 0, A: 0, B: 0, C: 0, total: 0 };
    group[row.category] += 1;
    group.total += 1;
    groups.set(row.group, group);
  }
  const counts = usageCounts(usage);
  let usedTotals = null;
  if (usage) {
    const byChannel = new Map(rows.map((row) => [row.channel, row.category]));
    usedTotals = { total: 0, calls: 0, unregistered: 0, ...Object.fromEntries(CATEGORIES.map((c) => [c, 0])) };
    for (const [channel, count] of counts) {
      usedTotals.total += 1;
      usedTotals.calls += count;
      usedTotals[byChannel.get(channel) ?? 'unregistered'] += 1;
    }
    usedTotals.aCalls = rankUsage(rows, usage, ['A']).reduce((sum, entry) => sum + entry.count, 0);
  }
  for (const row of rows) {
    row.used = counts.get(row.channel) ?? 0;
    if (row.category === 'B') row.clientBehavior = clientBehavior(row, clientUsage, usage);
  }
  const ranking = usage ? rankUsage(rows, usage, ['A']) : null;
  return {
    rows, totals, basis, usedTotals, ranking,
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

const code = (text) => `\`${String(text).replace(/`/g, "'").replace(/\|/g, '\\|')}\``;

export function renderMarkdown(summary, { usageSource, clientSource } = {}) {
  const { rows, totals, basis, groups, unresolved, adapters, missingContract, ranking, usedTotals } = summary;
  const lines = [];
  const push = (...items) => lines.push(...items);
  push('# Host 通道覆盖清单（脚本生成）', '');
  push('> 由 `node scripts/host-channel-coverage.mjs` 生成，不要手工修改。');
  push(`> 源码提交：\`${gitHead()}\`。归属规则见下方「归属规则」，正本在脚本的 \`OWNERSHIP_RULES\`。`, '');
  push('统计对象是桌面主进程（`apps/desktop/src/main`，不含测试）里所有 `ipcMain.handle/on`');
  push('及其包装函数注册的通道；同名通道按 invoke / event 各计一次。', '');
  push('| 分类 | 含义 | 通道数 |', '|---|---|---:|');
  push(`| contract | 已在 Host 通道合同里，窗口做客户端时转发给 Host | ${totals.contract} |`);
  push(`| client | 客户端模式自己的通道（连接状态、重连） | ${totals.client} |`);
  push(`| **A** | 必须由后台处理：读写后台持有的数据或运行状态 | ${totals.A} |`);
  push(`| **B** | 永久留在窗口：只能在 Electron／图形界面里做 | ${totals.B} |`);
  push(`| **C** | 待定，见各条原因 | ${totals.C} |`);
  push(`| 合计 | | ${rows.length} |`, '');
  push(`判定依据：A 类 ${basis['A:rule']} 条按规则、${basis['A:default']} 条按默认（未登记前缀且处理函数没用窗口 API）；`
    + `C 类 ${basis['C:rule']} 条按规则、${basis['C:dependency']} 条按依赖（后台领域或未登记前缀，但处理函数用到窗口 API）。`, '');
  if (unresolved.length) {
    push(`未能静态解析通道名的注册点 ${unresolved.length} 处（不计入上表）：`, '');
    for (const entry of unresolved) push(`- \`${entry.file}:${entry.line}\` — ${code(entry.expression)}`);
    push('');
  }
  if (adapters.length) {
    push(`转发适配器 ${adapters.length} 处（把通道原样转给另一个注册表，通道已在调用处计入）：`);
    push(adapters.map((entry) => `\`${entry.file}:${entry.line}\``).join('、'), '');
  }
  if (missingContract.length) {
    push(`合同里有、但桌面主进程没有注册的通道 ${missingContract.length} 个（Host 独有或桌面已改名）：`, '');
    push(missingContract.map((channel) => `\`${channel}\``).join('、'), '');
  }

  push('## 归属规则', '');
  push('按顺序匹配，先中先得；通道名或注册模块（`apps/desktop/src/main` 下的路径）命中即算。B、C 规则直接定类；');
  push('A 规则只标出领域，处理函数（及其调用的两层桌面源码函数）若用到下面的窗口 API 则改判 C；');
  push('没有命中任何规则的通道：用到窗口 API 判 C，否则判 A。', '');
  push('| 归属 | 原因 | 通道名 | 注册模块 |', '|---|---|---|---|');
  for (const rule of OWNERSHIP_RULES) {
    push(`| ${rule.owner} | ${rule.reason} | ${rule.channel ? code(rule.channel.source) : '—'} | ${rule.module ? code(rule.module.source) : '—'} |`);
  }
  push('');
  push(`窗口 API：Electron 导出 ${[...GUI_EXPORTS].map(code).join('、')}；`
    + `成员 ${Object.entries(GUI_MEMBERS).flatMap(([owner, members]) => [...members].map((m) => code(`${owner}.${m}`))).join('、')}；`
    + '以及 `new BrowserWindow`。不计入：发送方校验（`src/main/security/`，客户端模式下由 Host 令牌鉴权），'
    + '以及发给某个窗口的推送（`webContents.fromId`、`event.sender`，客户端模式下推送走 Host 事件流）。', '');

  if (ranking) {
    push('## A 类：实际调用排行', '');
    push(`来源：${usageSource ?? '调用计数报告'}。`);
    push(`这次共调用 ${usedTotals.total} 个通道（${usedTotals.calls} 次）：contract ${usedTotals.contract}、client ${usedTotals.client}、`
      + `**A ${usedTotals.A + usedTotals.unregistered}**（${usedTotals.aCalls} 次，含清单外 ${usedTotals.unregistered}）、B ${usedTotals.B}、C ${usedTotals.C}。`, '');
    push('| # | 通道 | 调用次数 | 领域 | 模块 |', '|---:|---|---:|---|---|');
    ranking.forEach((entry, index) => push(`| ${index + 1} | ${code(entry.channel)} | ${entry.count} | ${entry.reason} | ${entry.group} |`));
    push('');
  }

  const cRows = rows.filter((row) => row.category === 'C').sort((a, b) => b.used - a.used || a.channel.localeCompare(b.channel));
  push(`## C 类全量（${cRows.length}）`, '');
  push('| 通道 | 类型 | 原因 | 调用次数 | 注册位置 |', '|---|---|---|---:|---|');
  for (const row of cRows) push(`| ${code(row.channel)} | ${row.kind} | ${row.reason} | ${row.used} | \`${row.sites[0].replace(MAIN_PREFIX, '')}\` |`);
  push('');

  const bRows = rows.filter((row) => row.category === 'B');
  const behaviorCounts = {};
  for (const row of bRows) behaviorCounts[row.clientBehavior] = (behaviorCounts[row.clientBehavior] ?? 0) + 1;
  push('## B 类在客户端模式下的实际行为', '');
  push(`来源：${clientSource ?? '没有客户端模式快照'}；对照 ${usageSource ?? '没有普通模式快照'}。`);
  push('两份快照都是报告写入时主进程已注册的处理者；客户端快照里没有、普通模式快照里有，就是该在窗口本地处理却被拒的通道。', '');
  push('| 行为 | 通道数 |', '|---|---:|');
  for (const [key, label] of Object.entries(CLIENT_BEHAVIOR_LABELS)) if (behaviorCounts[key]) push(`| ${label} | ${behaviorCounts[key]} |`);
  push('');
  const rejected = bRows.filter((row) => ['unsupported', 'no-handler', 'dropped'].includes(row.clientBehavior))
    .sort((a, b) => b.used - a.used || a.channel.localeCompare(b.channel));
  if (rejected.length) {
    push(`### 被误拒的 B 类（${rejected.length}）`, '');
    push('| 通道 | 类型 | 客户端模式下 | 调用次数 | 原因 | 注册位置 |', '|---|---|---|---:|---|---|');
    for (const row of rejected) {
      push(`| ${code(row.channel)} | ${row.kind} | ${CLIENT_BEHAVIOR_LABELS[row.clientBehavior]} | ${row.used} | ${row.reason} | \`${row.sites[0].replace(MAIN_PREFIX, '')}\` |`);
    }
    push('');
  }

  push('## 按注册模块', '');
  push('| 模块 | 已代理 | A | B | C | 合计 |', '|---|---:|---:|---:|---:|---:|');
  for (const group of groups) push(`| ${group.group} | ${group.contract + group.client} | ${group.A} | ${group.B} | ${group.C} | ${group.total} |`);
  push('');

  push('## 全部通道', '');
  let currentGroup = '';
  rows.forEach((row, index) => {
    if (row.group !== currentGroup) {
      currentGroup = row.group;
      push(`### ${currentGroup}`, '', '| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |', '|---|---|---|---:|---|');
    }
    const category = row.reason ? `${row.category}（${row.reason}）` : row.category;
    const more = row.sites.length > 1 ? ` 等 ${row.sites.length} 处` : '';
    push(`| ${code(row.channel)} | ${row.kind} | ${category} | ${row.used} | \`${row.sites[0].replace(MAIN_PREFIX, '')}\`${more} |`);
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
  console.error(`[host-channel-coverage] ${summary.rows.length} channels: contract=${totals.contract} client=${totals.client} A=${totals.A} B=${totals.B} C=${totals.C} unresolved=${summary.unresolved.length} (${Date.now() - started}ms)`);
}
