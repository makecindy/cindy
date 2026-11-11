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
 *   window    — belongs to the window process (WINDOW_RULES below)
 *   backend   — needs a cindy-host implementation that does not exist yet
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

/**
 * Window-owned surfaces: they stay in the desktop process when it runs as a
 * client of cindy-host. A channel matches on its name or on its registering
 * module (path under apps/desktop/src/main); first rule wins. Reasons are
 * printed in the doc, so keep them short.
 */
export const WINDOW_RULES = [
  {
    reason: '窗口外壳、窗口布局与多窗口',
    channel: /^(window[-:]|window$|win:|titlebar|fullscreen|toggle-fullscreen|get-fullscreen-state|find-in-page|page-zoom|theme:|app-menu:|app-locale:|startup-gate|maker:open-session-in-new-window|maker:session-drag-preview|maker:sidebar-tab-drag-preview|maker:sidebar-tab-window|sidebar-tab-window|maker:rsb-window|rsb-window|resource-usage-window|agent-island|menubar)/,
    module: /^(sidebar-tab-window|sidebarWindowExpansionIpc|right-sidebar-window|resource-usage-window|agent-island|menubar)\b/,
  },
  {
    reason: '原生对话框、剪贴板、系统外壳与通知',
    channel: /^(dialog:|show-open-directory-dialog|clipboard:|shell:|open-with:|notification:|media:copy-(png-)?to-clipboard|media:open-with-default-app|media:save-as|chat-attachment:save-as|login-item:|accessibility-support)/,
    module: /^(notificationService|appBadgeService|login-item-ipc|accessibility-support-ipc)\b/,
  },
  {
    reason: '本机屏幕截取、录制与远程桌面',
    channel: /^(region-screenshot|recording-preview|recording-audio|remote-desktop|away-guard)/,
    module: /^(region-screenshot|remote-desktop|remote-desktop-viewer)\b/,
  },
  {
    reason: '图形能力，由窗口替 Agent 执行（平台 RPC）',
    channel: /^(maker:computer|maker:browser|browser-backend|rsb-browser-bridge|rsb-native-popup)/,
    module: /^(rsb-browser-bridge)\b/,
  },
  {
    reason: '本机输入设备与语音',
    channel: /^(voice-input|voice-conversation|xbox-gamepad|worklouder-codex|codex-micro-guard|app-shortcuts:set-recording)/,
    module: /^(voice-input|voice-conversation|xbox-gamepad|worklouder-codex)\b/,
  },
  {
    reason: '桌面安装包自身：更新、版本、日志与诊断',
    channel: /^(update-|get-app-version|get-app-display-version-info|get-os-release|release-notes:|app:get-arm64-translation|app:open-logs-dir|crash-diagnosis|log-upload|performance-trace|renderer:log|dev:|cc:set-debug-net)/,
    module: /^(updateService|relaunchBusyActivityIpc|crash-diagnosis|log-upload|performance-trace)\b/,
  },
];

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
            for (const channel of values) {
              registrations.push({
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

export function classify(registration, contract) {
  if (contract.has(registration.channel)) return { category: 'contract' };
  if (registration.enclosing === 'installHostClientMode') return { category: 'client' };
  const module = owningFile(registration).replace(MAIN_PREFIX, '');
  if (registration.perWebContents) return { category: 'window', reason: '单个窗口内的插件页面 IPC（webContents.ipc）' };
  for (const rule of WINDOW_RULES) {
    if (rule.module.test(module) || rule.channel.test(registration.channel)) return { category: 'window', reason: rule.reason };
  }
  return { category: 'backend' };
}

export function moduleGroup(file) {
  const inner = file.replace(MAIN_PREFIX, '');
  const parts = inner.split('/');
  return parts.length > 1 ? parts[0] : inner.replace(/\.tsx?$/, '');
}

export function summarize({ registrations, unresolved, adapters = [], contract }, usage) {
  const channels = new Map();
  for (const registration of registrations) {
    const key = `${registration.kind}:${registration.channel}`;
    const existing = channels.get(key);
    if (existing) {
      existing.sites.push(`${registration.file}:${registration.line}`);
      continue;
    }
    channels.set(key, {
      ...registration,
      ...classify(registration, contract),
      group: moduleGroup(owningFile(registration)),
      sites: [`${registration.file}:${registration.line}`],
    });
  }
  for (const row of channels.values()) row.sites = [...new Set(row.sites)];
  const rows = [...channels.values()].sort((a, b) => a.group.localeCompare(b.group) || a.channel.localeCompare(b.channel));
  const totals = { contract: 0, client: 0, window: 0, backend: 0 };
  for (const row of rows) totals[row.category] += 1;
  const missingContract = [...contract].filter((channel) => !rows.some((row) => row.channel === channel)).sort();
  const groups = new Map();
  for (const row of rows) {
    const group = groups.get(row.group) ?? { group: row.group, contract: 0, client: 0, window: 0, backend: 0, total: 0 };
    group[row.category] += 1;
    group.total += 1;
    groups.set(row.group, group);
  }
  const ranking = usage ? rankUsage(rows, usage) : null;
  let usedTotals = null;
  if (usage) {
    const byChannel = new Map(rows.map((row) => [row.channel, row.category]));
    usedTotals = { total: 0, contract: 0, client: 0, window: 0, backend: 0, unregistered: 0 };
    for (const channel of Object.keys(usage.channels ?? {})) {
      usedTotals.total += 1;
      usedTotals[byChannel.get(channel) ?? 'unregistered'] += 1;
    }
  }
  return { usedTotals, rows, totals, groups: [...groups.values()].sort((a, b) => b.backend - a.backend || a.group.localeCompare(b.group)), unresolved, adapters, missingContract, ranking };
}

/**
 * Order backend gaps by real calls. An embedded run (`mode: 'embedded'`) counts
 * every call the window made; a client run counts only calls that found no
 * handler. Reports come from apps/desktop/src/main/ipcChannelUsage.ts.
 */
export function rankUsage(rows, usage) {
  const byChannel = new Map(rows.map((row) => [row.channel, row]));
  const client = usage.mode === 'client';
  return Object.entries(usage.channels ?? {})
    .map(([channel, entry]) => {
      const row = byChannel.get(channel);
      const unserved = entry.missing + entry.unsupported;
      return {
        channel,
        count: client ? unserved : entry.count,
        outcome: entry.unsupported ? 'UNSUPPORTED_CAPABILITY' : entry.missing ? '无处理者' : '桌面本地处理',
        category: row?.category ?? 'unregistered',
        group: row?.group ?? '-',
      };
    })
    .filter((entry) => entry.count > 0 && !['contract', 'window', 'client'].includes(entry.category))
    .sort((a, b) => b.count - a.count || a.channel.localeCompare(b.channel));
}

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', '--short=10', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export function renderMarkdown(summary, { usageSource } = {}) {
  const { rows, totals, groups, unresolved, adapters, missingContract, ranking } = summary;
  const total = rows.length;
  const lines = [];
  lines.push('# Host 通道覆盖清单（脚本生成）');
  lines.push('');
  lines.push('> 由 `node scripts/host-channel-coverage.mjs` 生成，不要手工修改。');
  lines.push(`> 源码提交：\`${gitHead()}\`。分类规则在脚本的 \`WINDOW_RULES\` 与 \`classify()\` 里。`);
  lines.push('');
  lines.push('统计对象是桌面主进程（`apps/desktop/src/main`，不含测试）里所有 `ipcMain.handle/on`');
  lines.push('及其包装函数注册的通道；同名通道按 invoke / event 各计一次。');
  lines.push('');
  lines.push('| 分类 | 含义 | 通道数 |');
  lines.push('|---|---|---:|');
  lines.push(`| contract | 已在 Host 通道合同里，窗口做客户端时转发给 Host | ${totals.contract} |`);
  lines.push(`| client | 客户端模式自己的通道（连接状态、重连） | ${totals.client} |`);
  lines.push(`| window | 只属于窗口（窗口管理、菜单、对话框、剪贴板、本机输入设备等） | ${totals.window} |`);
  lines.push(`| backend | 应由 Host 提供但还没接 | ${totals.backend} |`);
  lines.push(`| 合计 | | ${total} |`);
  lines.push('');
  if (unresolved.length) {
    lines.push(`未能静态解析通道名的注册点 ${unresolved.length} 处（不计入上表）：`);
    lines.push('');
    for (const entry of unresolved) lines.push(`- \`${entry.file}:${entry.line}\` — \`${entry.expression.replace(/`/g, "'")}\``);
    lines.push('');
  }
  if (adapters.length) {
    lines.push(`转发适配器 ${adapters.length} 处（把通道原样转给另一个注册表，通道已在调用处计入）：`);
    lines.push(adapters.map((entry) => `\`${entry.file}:${entry.line}\``).join('、'));
    lines.push('');
  }
  if (missingContract.length) {
    lines.push(`合同里有、但桌面主进程没有注册的通道 ${missingContract.length} 个（Host 独有或桌面已改名）：`);
    lines.push('');
    lines.push(missingContract.map((channel) => `\`${channel}\``).join('、'));
    lines.push('');
  }
  if (ranking) {
    lines.push('## 实际调用到、Host 还没接的通道');
    lines.push('');
    lines.push(`来源：${usageSource ?? '调用计数报告'}。`);
    if (summary.usedTotals) {
      const used = summary.usedTotals;
      lines.push(`这次共调用 ${used.total} 个通道：contract ${used.contract}、client ${used.client}、window ${used.window}、`
        + `backend ${used.backend}、清单外 ${used.unregistered}。下表只列 backend 与清单外的通道；`
        + 'embedded 模式按全部调用次数排序，client 模式按没有处理者的调用次数排序。');
    }
    lines.push('');
    lines.push('| # | 通道 | 调用次数 | 结果 | 模块 |');
    lines.push('|---:|---|---:|---|---|');
    ranking.forEach((entry, index) => {
      lines.push(`| ${index + 1} | \`${entry.channel}\` | ${entry.count} | ${entry.outcome} | ${entry.group} |`);
    });
    lines.push('');
  }
  lines.push('## 按注册模块');
  lines.push('');
  lines.push('| 模块 | contract | window | backend | 合计 |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const group of groups) {
    lines.push(`| ${group.group} | ${group.contract + group.client} | ${group.window} | ${group.backend} | ${group.total} |`);
  }
  lines.push('');
  lines.push('## 全部通道');
  lines.push('');
  let currentGroup = '';
  for (const row of rows) {
    if (row.group !== currentGroup) {
      currentGroup = row.group;
      lines.push(`### ${currentGroup}`);
      lines.push('');
      lines.push('| 通道 | 类型 | 分类 | 注册位置 |');
      lines.push('|---|---|---|---|');
    }
    const category = row.reason ? `${row.category}（${row.reason}）` : row.category;
    const site = row.sites[0].replace(/^apps\/desktop\/src\/main\//, '');
    const more = row.sites.length > 1 ? ` 等 ${row.sites.length} 处` : '';
    lines.push(`| \`${row.channel}\` | ${row.kind} | ${category} | \`${site}\`${more} |`);
    const next = rows[rows.indexOf(row) + 1];
    if (!next || next.group !== currentGroup) lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const started = Date.now();
  const inventory = collectInventory();
  const defaultUsage = path.join(repoRoot, USAGE_REL_PATH);
  const usagePath = option('--usage') ?? (fs.existsSync(defaultUsage) ? defaultUsage : undefined);
  const usage = usagePath ? JSON.parse(fs.readFileSync(usagePath, 'utf8')) : null;
  const summary = summarize(inventory, usage);
  const usageSource = usage
    ? `\`${path.relative(repoRoot, path.resolve(usagePath)).split(path.sep).join('/')}\`（${usage.source}；${usage.mode} 模式，${usage.startedAt.slice(0, 10)}）`
    : undefined;
  const markdown = renderMarkdown(summary, { usageSource });
  const jsonPath = option('--json');
  if (jsonPath) fs.writeFileSync(jsonPath, `${JSON.stringify({ ...summary, contract: [...inventory.contract].sort() }, null, 2)}\n`);
  if (flag('--stdout')) process.stdout.write(markdown);
  else fs.writeFileSync(path.join(repoRoot, DOC_REL_PATH), markdown);
  const { totals } = summary;
  console.error(`[host-channel-coverage] ${summary.rows.length} channels: contract=${totals.contract} client=${totals.client} window=${totals.window} backend=${totals.backend} unresolved=${summary.unresolved.length} (${Date.now() - started}ms)`);
}
