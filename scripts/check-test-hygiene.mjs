#!/usr/bin/env node
// check-test-hygiene.mjs — 单测性能与价值的静态门禁（engineering-conventions.md §3.2）。
//
// 跑：node scripts/check-test-hygiene.mjs            检查（CI 阻断）
//     node scripts/check-test-hygiene.mjs --update   把基线收紧到当前计数（只降不升）
//
// 三条规则都只看源码文本，结果与机器快慢无关：
//   reset-modules  每次 vi.resetModules() 都会让后续 import 重新求值整条模块链。
//                  codexProxyHost.test.ts 逐用例重置时 285 条用例耗时 105s，不重置只要 7s。
//                  新增调用必须在上一行写 `// reset-modules: <被隔离的模块状态>`。
//                  beforeEach/afterEach 及其准备、清理 helper 不接受理由豁免。
//   real-wait      单测里 ≥100ms 的真实 setTimeout / sleep 既拖慢 CI 又制造时序抖动；
//                  改用 vi.useFakeTimers() 或等待真实事件。确需真实等待时上一行写
//                  `// real-wait: <原因>`。已切换为 fake timers 的区间不计。
//   source-read    普通单测读取生产源码文本做字面量断言。这类静态契约只能进对应包的
//                  guard tier（scripts/test-workspaces.config.mjs），不接受理由豁免。
//
// 存量计数记在 scripts/test-hygiene-baseline.json，只允许减少：某文件的计数超过基线、
// 或基线外的文件出现未豁免的命中，都会失败。门禁对照可信 Git 基准拒绝基线上调，
// 手改 JSON 与 `--update` 均不能绕过；只有确认基准提交还没有基线文件时才首次登记。

import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_REL = 'scripts/test-hygiene-baseline.json';
const BASELINE_PATH = path.join(ROOT, BASELINE_REL);
const SCAN_ROOTS = ['apps', 'packages', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'coverage', '.vite', '.expo', '.turbo']);
export const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const NON_UNIT_TEST = /(?:^|[-.])(?:integration|e2e|git-integration)\.(?:test|spec)\.|\.bench\./;
export const RULES = ['resetModules', 'realWaits', 'sourceReads'];
const REAL_WAIT_MIN_MS = 100;
const REAL_WAIT_NAMES = new Set(['sleep', 'delay', 'wait', 'waitMs', 'pause']);
// These exact root-runner suites own cross-file contracts that cannot execute
// the full application in node:test. New scripts tests receive no exemption.
const ROOT_SOURCE_CONTRACTS = new Map([
  // TS brand identity and executable/userData names mirrored by build scripts.
  ['scripts/__tests__/brand-identity-sync.test.mjs', 'cross-runtime brand identity'],
  // Documented commands, required CI gates and locale-aware QA artifact wiring.
  ['scripts/__tests__/dev-docs-contract.test.mjs', 'developer/CI and QA artifact contracts'],
  // Design inventory must agree with production entry points and shared matchers.
  ['scripts/__tests__/design-inventory.test.mjs', 'design inventory cross-file contracts'],
  // Locale declarations and diagnostic prose implement the terminology policy.
  ['scripts/__tests__/glossary-rules.test.mjs', 'locale and terminology policy contracts'],
  // Approved design exceptions are bound to exact production declarations.
  ['scripts/__tests__/hardcoded-color-audit.test.mjs', 'design exemption and CI contracts'],
  // Dev startup must prepare every supported Agent runtime before it can launch.
  ['scripts/__tests__/ensure-agent-binaries.test.mjs', 'runtime preparation startup wiring'],
  // Restart scripts and app bootstrap must agree on isolation/process boundaries.
  ['scripts/__tests__/restart-desktop-remote.test.mjs', 'restart and bootstrap isolation contracts'],
  // Packaged notice generation and both application entry points must stay wired.
  ['scripts/__tests__/third-party-notices.test.mjs', 'cross-platform bundled license contracts'],
]);
// This explicit DB-tier suite uses frozen companion bytes as input to real
// hash/manifest repair, not source-spelling assertions. Keep reload/wait checks.
const DB_SOURCE_INPUTS = new Set([
  'apps/desktop/src/main/localDb/__tests__/migrationCompatibility.test.ts',
]);
// Reuse Desktop's declared parser to locate test/hook callbacks and local helpers.
// No type checking or module loading is needed.
const requireDesktop = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
let typescript;

function parseTestSource(ts, code) {
  const tsx = ts.createSourceFile('test.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (tsx.parseDiagnostics.length === 0) return tsx;
  const plain = ts.createSourceFile('test.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return plain.parseDiagnostics.length < tsx.parseDiagnostics.length ? plain : tsx;
}

/** Replace comments with spaces (keeping newlines) so matches ignore commented-out code. */
export function stripComments(source) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (ch === '/' && next === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    out += ch;
    i += 1;
  }
  return out;
}

function lineOf(text, index) {
  let line = 0;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/** True when the closest non-blank line above `line` carries `// <marker>: <reason>`. */
function hasJustification(lines, line, marker) {
  for (let i = line - 1; i >= 0; i -= 1) {
    const text = lines[i].trim();
    if (text === '') continue;
    return new RegExp(`//\\s*${marker}:\\s*\\S`).test(text);
  }
  return false;
}

/** A per-test hook cannot turn repeated module loading into an exemption. */
function countModuleResets(code, lines) {
  if (!/\bresetModules\b/.test(code)) return 0;
  const ts = typescript ??= requireDesktop('typescript');
  const source = parseTestSource(ts, code);
  const nodeScopes = new WeakMap();
  const calls = [];
  const writes = new Map();
  const isFunction = node => ts.isFunctionLike(node) && Boolean(node.body);
  function declare(name, declaration, scope) {
    if (ts.isIdentifier(name)) scope.bindings.set(name.text, declaration);
    else for (const element of name.elements) {
      if (ts.isBindingElement(element)) declare(element.name, element, scope);
    }
  }
  function collect(node, scope) {
    if (ts.isFunctionDeclaration(node) && node.name) scope.bindings.set(node.name.text, node);
    if (ts.isSourceFile(node) || ts.isBlock(node) || isFunction(node)) {
      scope = { parent: scope, bindings: new Map() };
    }
    nodeScopes.set(node, scope);
    if (isFunction(node)) {
      if (node.name && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node))) scope.bindings.set(node.name.text, node);
      for (const parameter of node.parameters) declare(parameter.name, parameter, scope);
    }
    if (ts.isVariableDeclaration(node)) declare(node.name, node, scope);
    if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node) || ts.isImportClause(node) && node.name) scope.bindings.set(node.name.text, node);
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, child => collect(child, scope));
  }
  collect(source, null);
  function binding(identifier) {
    for (let scope = nodeScopes.get(identifier); scope; scope = scope.parent) {
      if (scope.bindings.has(identifier.text)) return scope.bindings.get(identifier.text);
    }
    return null;
  }
  function unwrap(node) {
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
    return node;
  }
  function propertyName(node) {
    return node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : null;
  }
  function recordWrite(target, expression, property = null) {
    target = unwrap(target);
    if (ts.isIdentifier(target)) {
      const bound = binding(target);
      if (bound) {
        if (!writes.has(bound)) writes.set(bound, []);
        writes.get(bound).push({ expression, property });
      }
    } else if (ts.isObjectLiteralExpression(target)) {
      for (const member of target.properties) {
        if (ts.isShorthandPropertyAssignment(member)) recordWrite(member.name, expression, member.name.text);
        else if (ts.isPropertyAssignment(member)) recordWrite(member.initializer, expression, propertyName(member.name));
      }
    }
  }
  function collectWrites(node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) recordWrite(node.left, node.right);
    ts.forEachChild(node, collectWrites);
  }
  collectWrites(source);
  function importedFromVitest(bound) {
    let declaration = bound;
    while (declaration && !ts.isImportDeclaration(declaration)) declaration = declaration.parent;
    return declaration && !declaration.importClause?.isTypeOnly && !bound.isTypeOnly
      && ts.isStringLiteral(declaration.moduleSpecifier) && declaration.moduleSpecifier.text === 'vitest';
  }
  function propertyMatches(expression, property, kind, seen) {
    if (kind === 'mock' && /^(?:vi|vitest)$/.test(property)) return matches(expression, 'namespace', seen);
    if (kind === 'reset' && property === 'resetModules') return matches(expression, 'mock', seen);
    if (kind === 'hook' && /^(?:beforeEach|afterEach)$/.test(property)) return matches(expression, 'namespace', seen);
    return false;
  }
  function boundMatches(bound, kind, seen) {
    if (!bound || seen.has(bound)) return false;
    seen = new Set(seen).add(bound);
    if (importedFromVitest(bound)) {
      if (kind === 'namespace') return ts.isNamespaceImport(bound);
      if (ts.isImportSpecifier(bound)) {
        const name = bound.propertyName?.text ?? bound.name.text;
        return kind === 'mock' && /^(?:vi|vitest)$/.test(name)
          || kind === 'hook' && /^(?:beforeEach|afterEach)$/.test(name);
      }
    }
    if (ts.isBindingElement(bound) && ts.isObjectBindingPattern(bound.parent) && !bound.dotDotDotToken) {
      const property = propertyName(bound.propertyName ?? bound.name);
      const owner = bound.parent.parent;
      if (kind === 'mock' && /^(?:vi|vitest)$/.test(property) && boundMatches(owner, 'namespace', seen)
        || kind === 'reset' && property === 'resetModules' && boundMatches(owner, 'mock', seen)
        || kind === 'hook' && /^(?:beforeEach|afterEach)$/.test(property) && boundMatches(owner, 'namespace', seen)) return true;
    }
    if (ts.isVariableDeclaration(bound) && bound.initializer && matches(bound.initializer, kind, seen)) return true;
    // Follow only local static aliases, not arbitrary returned objects or callbacks.
    return (writes.get(bound) ?? []).some(write => write.property
      ? propertyMatches(write.expression, write.property, kind, seen) : matches(write.expression, kind, seen));
  }
  function matches(node, kind, seen = new Set()) {
    node = unwrap(node);
    if (ts.isIdentifier(node)) {
      const bound = binding(node);
      if (bound) return boundMatches(bound, kind, seen);
      return kind === 'mock' && /^(?:vi|vitest)$/.test(node.text)
        || kind === 'hook' && /^(?:beforeEach|afterEach)$/.test(node.text);
    }
    if (ts.isPropertyAccessExpression(node)) return propertyMatches(node.expression, node.name.text, kind, seen);
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) return propertyMatches(node.expression, node.argumentExpression.text, kind, seen);
    return false;
  }
  function resolveHelper(node, seen = new Set()) {
    node = unwrap(node);
    if (isFunction(node)) return node;
    if (!ts.isIdentifier(node)) return null;
    const bound = binding(node);
    if (!bound || seen.has(bound)) return null;
    seen = new Set(seen).add(bound);
    if (isFunction(bound)) return bound;
    if (ts.isVariableDeclaration(bound) && bound.initializer) {
      const helper = resolveHelper(bound.initializer, seen);
      if (helper) return helper;
    }
    for (const write of writes.get(bound) ?? []) {
      if (!write.property) {
        const helper = resolveHelper(write.expression, seen);
        if (helper) return helper;
      }
    }
    return null;
  }
  const resets = new Map(calls.filter(call => matches(call.expression, 'reset')).map(call => [call.getStart(source), call]));
  const hooks = calls.filter(call => matches(call.expression, 'hook')).flatMap(call => [...call.arguments]);
  const perTest = new Set();
  const visitedFunctions = new Set();
  function visitFunction(node) {
    if (!node || visitedFunctions.has(node)) return;
    visitedFunctions.add(node);
    if (node.body) visit(node.body);
  }
  function visit(node) {
    // Defining or storing a restart callback is not a per-test reload. Only
    // follow an actual local call, or the callback registered with a hook.
    if (isFunction(node)) return;
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (matches(expression, 'reset')) perTest.add(node.getStart(source));
      visitFunction(resolveHelper(expression));
    }
    ts.forEachChild(node, visit);
  }
  for (const hook of hooks) {
    if (matches(hook, 'reset')) {
      resets.set(hook.getStart(source), hook);
      perTest.add(hook.getStart(source));
    } else visitFunction(resolveHelper(hook));
  }
  return [...resets.keys()].filter(index => perTest.has(index)
    || !hasJustification(lines, lineOf(code, index), 'reset-modules')).length;
}

/** Mask string contents while preserving line numbers and call-site punctuation. */
function maskStrings(source) {
  let out = '';
  let quote = null;
  let escaped = false;
  for (const ch of source) {
    if (quote) {
      if (escaped) {
        escaped = false;
        out += ch === '\n' ? '\n' : ' ';
      } else if (ch === '\\') {
        escaped = true;
        out += ' ';
      } else if (ch === quote) {
        quote = null;
        out += ch;
      } else {
        out += ch === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === String.fromCharCode(96)) {
      quote = ch;
      out += ch;
    } else {
      out += ch;
    }
  }
  return out;
}

function staticWaitCalls(code) {
  if (!/\bsetTimeout\b|\b(?:sleep|delay|wait|waitMs|pause)\s*\(|(?:node:)?timers\/promises/.test(code)) return [];
  const ts = typescript ??= requireDesktop('typescript');
  const source = parseTestSource(ts, code);
  const nodeScopes = new WeakMap();
  const calls = [];
  const promiseTimerNames = new Set();
  const isFunction = node => ts.isFunctionLike(node) && Boolean(node.body);
  function declare(name, declaration, scope) {
    if (ts.isIdentifier(name)) scope.bindings.set(name.text, declaration);
    else for (const element of name.elements) {
      if (ts.isBindingElement(element)) declare(element.name, element, scope);
    }
  }
  function isPromiseTimerImport(bound) {
    let declaration = bound;
    while (declaration && !ts.isImportDeclaration(declaration)) declaration = declaration.parent;
    return declaration && ts.isStringLiteral(declaration.moduleSpecifier)
      && /^(?:node:)?timers\/promises$/.test(declaration.moduleSpecifier.text);
  }
  function collect(node, scope) {
    if (ts.isFunctionDeclaration(node) && node.name) scope.bindings.set(node.name.text, node);
    if (ts.isSourceFile(node) || ts.isBlock(node) || isFunction(node)) scope = { parent: scope, bindings: new Map() };
    nodeScopes.set(node, scope);
    if (isFunction(node)) {
      for (const parameter of node.parameters) {
        declare(parameter.name, parameter, scope);
      }
    }
    if (ts.isVariableDeclaration(node)) declare(node.name, node, scope);
    if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node) || ts.isImportClause(node) && node.name) {
      scope.bindings.set(node.name.text, node);
      if (ts.isImportSpecifier(node) && (node.propertyName?.text ?? node.name.text) === 'setTimeout'
        && isPromiseTimerImport(node)) promiseTimerNames.add(node.name.text);
    }
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, child => collect(child, scope));
  }
  collect(source, null);
  function binding(identifier) {
    for (let scope = nodeScopes.get(identifier); scope; scope = scope.parent) {
      if (scope.bindings.has(identifier.text)) return scope.bindings.get(identifier.text);
    }
    return null;
  }
  function unwrap(node) {
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
    return node;
  }
  const isConst = node => ts.isVariableDeclaration(node) && (node.parent.flags & ts.NodeFlags.Const);
  function callbackTimerImport(bound) {
    let declaration = bound;
    while (declaration && !ts.isImportDeclaration(declaration)) declaration = declaration.parent;
    return declaration && !declaration.importClause?.isTypeOnly && !bound.isTypeOnly
      && ts.isStringLiteral(declaration.moduleSpecifier) && /^(?:node:)?timers$/.test(declaration.moduleSpecifier.text);
  }
  function timerObject(node, seen = new Set()) {
    node = unwrap(node);
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'default'
      && timerObject(node.expression, seen) === 'native') return 'native';
    if (!ts.isIdentifier(node)) return null;
    const bound = binding(node);
    if (!bound) return /^(?:globalThis|global|window|self)$/.test(node.text) ? 'global' : null;
    if ((ts.isNamespaceImport(bound) || ts.isImportClause(bound)) && callbackTimerImport(bound)) return 'native';
    if (seen.has(bound) || !isConst(bound) || !bound.initializer) return null;
    return timerObject(bound.initializer, new Set(seen).add(bound));
  }
  // Immutable local aliases capture the timer function, not the later global
  // clock state. Follow that capture through aliases, while respecting shadows.
  function callbackTimer(node, clockIndex, seen = new Set()) {
    node = unwrap(node);
    const property = ts.isPropertyAccessExpression(node) ? node.name.text
      : ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : null;
    if (property === 'setTimeout') {
      const owner = timerObject(node.expression);
      if (owner) return { clockIndex: owner === 'native' ? 0 : clockIndex };
    }
    if (!ts.isIdentifier(node)) return null;
    const bound = binding(node);
    if (!bound) return node.text === 'setTimeout' ? { clockIndex } : null;
    if (seen.has(bound)) return null;
    seen = new Set(seen).add(bound);
    if (isConst(bound) && bound.initializer) return callbackTimer(bound.initializer, bound.initializer.getStart(source), seen);
    if (ts.isBindingElement(bound) && ts.isObjectBindingPattern(bound.parent) && !bound.dotDotDotToken) {
      const name = bound.propertyName ?? bound.name;
      const owner = bound.parent.parent;
      if ((ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === 'setTimeout'
        && isConst(owner) && owner.initializer) {
        const object = timerObject(owner.initializer);
        if (object) return { clockIndex: object === 'native' ? 0 : owner.initializer.getStart(source) };
      }
    }
    // Builtin callback timers retain native bindings under Vitest's global fake clock.
    if (ts.isImportSpecifier(bound) && (bound.propertyName?.text ?? bound.name.text) === 'setTimeout'
      && callbackTimerImport(bound)) return { clockIndex: 0 };
    return null;
  }
  function promiseTimerNamespace(node, seen = new Set()) {
    if (!ts.isIdentifier(node) || seen.has(node)) return false;
    seen.add(node);
    const bound = binding(node);
    if (bound && ts.isVariableDeclaration(bound) && bound.initializer) return promiseTimerNamespace(bound.initializer, seen);
    return bound && (ts.isNamespaceImport(bound) || ts.isImportClause(bound)) && isPromiseTimerImport(bound);
  }
  function isPromiseTimer(node, seen = new Set()) {
    if (seen.has(node)) return false;
    seen.add(node);
    if (ts.isPropertyAccessExpression(node)) return node.name.text === 'setTimeout' && promiseTimerNamespace(node.expression);
    if (!ts.isIdentifier(node)) return false;
    const bound = binding(node);
    if (bound && ts.isVariableDeclaration(bound) && bound.initializer) return isPromiseTimer(bound.initializer, seen);
    return bound && ts.isImportSpecifier(bound) && (bound.propertyName?.text ?? bound.name.text) === 'setTimeout'
      && isPromiseTimerImport(bound);
  }
  function number(node, parameters = new Map(), seen = new Set()) {
    if (!node || seen.has(node)) return undefined;
    seen = new Set(seen).add(node);
    if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll('_', ''));
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return number(node.expression, parameters, seen);
    if (ts.isIdentifier(node)) {
      const bound = binding(node);
      if (!bound) return undefined;
      if (parameters.has(bound)) return parameters.get(bound);
      if (ts.isVariableDeclaration(bound) && (bound.parent.flags & ts.NodeFlags.Const)) return number(bound.initializer, parameters, seen);
      return undefined;
    }
    if (ts.isPrefixUnaryExpression(node)) {
      const value = number(node.operand, parameters, seen);
      if (node.operator === ts.SyntaxKind.MinusToken) return -value;
      if (node.operator === ts.SyntaxKind.PlusToken) return value;
    }
    if (ts.isBinaryExpression(node)) {
      const left = number(node.left, parameters, seen);
      const right = number(node.right, parameters, seen);
      if (left === undefined || right === undefined) return undefined;
      switch (node.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken: return left + right;
        case ts.SyntaxKind.MinusToken: return left - right;
        case ts.SyntaxKind.AsteriskToken: return left * right;
        case ts.SyntaxKind.SlashToken: return left / right;
      }
    }
    return undefined;
  }
  // Recognize direct local wrappers returning a timeout or Promise containing
  // one. Do not follow arbitrary control flow, callbacks or external helpers.
  function wrapperTimer(fn) {
    if (!fn?.body) return null;
    const timerCall = node => {
      if (!node || !ts.isCallExpression(node)) return null;
      if (callbackTimer(node.expression)) return { call: node, kind: 'callback' };
      if (isPromiseTimer(node.expression)) return { call: node, kind: 'promise' };
      return null;
    };
    const body = ts.isBlock(fn.body)
      ? fn.body.statements.find(ts.isReturnStatement)?.expression : fn.body;
    if (!body && !ts.isBlock(fn.body)) return null;
    const direct = timerCall(body);
    if (direct) return direct;
    const promiseTimer = node => {
      if (!node || !ts.isNewExpression(node) || node.expression.getText(source) !== 'Promise') return null;
      const executor = node.arguments?.[0];
      if (!executor || !isFunction(executor)) return null;
      const candidates = ts.isBlock(executor.body) ? executor.body.statements.map(statement => statement.expression) : [executor.body];
      return candidates.map(timerCall).find(Boolean) ?? null;
    };
    const directPromise = promiseTimer(body);
    if (directPromise) return directPromise;
    if (!ts.isBlock(fn.body)) return null;
    // A common async wrapper awaits a timer in an expression statement rather
    // than returning it. Follow only awaits in this wrapper body, never nested
    // functions, and let the outer call map its parameter to the timer delay.
    let awaited = null;
    const visit = node => {
      if (awaited || isFunction(node)) return;
      if (ts.isAwaitExpression(node)) {
        awaited = timerCall(node.expression) ?? promiseTimer(node.expression);
        if (awaited) return;
      }
      ts.forEachChild(node, visit);
    };
    visit(fn.body);
    return awaited;
  }
  const waits = [];
  for (const call of calls) {
    const name = ts.isIdentifier(call.expression) ? call.expression.text
      : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : '';
    let duration;
    let clockIndex;
    const callback = callbackTimer(call.expression);
    const promiseTimer = isPromiseTimer(call.expression);
    const shadowedPromiseTimer = ts.isIdentifier(call.expression) && promiseTimerNames.has(name) && !promiseTimer;
    if (promiseTimer) duration = number(call.arguments[0]);
    else if (callback) {
      duration = number(call.arguments[1]);
      clockIndex = callback.clockIndex;
    }
    // Generic wait names are only meaningful as direct local calls. A method
    // such as meter.pause(1_000) is ordinary domain data, not a real wait.
    else if (ts.isIdentifier(call.expression) && REAL_WAIT_NAMES.has(name) && !shadowedPromiseTimer) duration = number(call.arguments[0]);
    else {
      if (!ts.isIdentifier(call.expression)) continue;
      const bound = binding(call.expression);
      const fn = bound && ts.isVariableDeclaration(bound) ? bound.initializer : bound;
      if (!fn || !isFunction(fn)) continue;
      const timerInfo = wrapperTimer(fn);
      if (!timerInfo) continue;
      const timer = timerInfo.call;
      const delayArgument = timerInfo.kind === 'promise' ? 0 : 1;
      const parameters = new Map(fn.parameters.map((parameter, index) => [parameter, number(call.arguments[index] ?? parameter.initializer)]));
      // Constant waits inside a helper are already counted at their own site.
      if (number(timer.arguments[delayArgument]) !== undefined) continue;
      duration = number(timer.arguments[delayArgument], parameters);
      if (timerInfo.kind === 'callback') clockIndex = callbackTimer(timer.expression).clockIndex;
      // A wrapper-local capture executes when the wrapper is called.
      if (clockIndex >= fn.getStart(source) && clockIndex < fn.end) clockIndex = undefined;
    }
    if (Number.isFinite(duration)) waits.push({ index: call.getStart(source), duration, clockIndex });
  }
  return waits;
}

function timerScopes(code, timerEvents) {
  const ts = typescript ??= requireDesktop('typescript');
  const source = parseTestSource(ts, code);
  const scopes = [];
  const nodeScopes = new WeakMap();
  const callbackKinds = new WeakMap();
  const registeredHelpers = [];
  const calls = [];
  const functions = [];
  const writes = new Map();
  const isFunction = node => ts.isFunctionLike(node) && Boolean(node.body);
  const isTimer = name => /^(?:useFakeTimers|useRealTimers)$/.test(name);
  const isFramework = name => /^(?:describe|it|test|beforeEach|beforeAll|afterEach|afterAll)$/.test(name);
  function declare(name, declaration, scope) {
    if (ts.isIdentifier(name)) scope.bindings.set(name.text, declaration);
    else for (const element of name.elements) {
      if (ts.isBindingElement(element)) declare(element.name, element, scope);
    }
  }
  function visit(node, lexicalScope) {
    if (ts.isFunctionDeclaration(node) && node.name) lexicalScope.bindings.set(node.name.text, node);
    if (ts.isSourceFile(node) || ts.isBlock(node) || isFunction(node)) lexicalScope = { parent: lexicalScope, bindings: new Map() };
    nodeScopes.set(node, lexicalScope);
    if (isFunction(node)) {
      functions.push(node);
      if (node.name && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node))) lexicalScope.bindings.set(node.name.text, node);
      for (const parameter of node.parameters) declare(parameter.name, parameter, lexicalScope);
    }
    if (ts.isVariableDeclaration(node)) declare(node.name, node, lexicalScope);
    if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node) || ts.isImportClause(node) && node.name) lexicalScope.bindings.set(node.name.text, node);
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, child => visit(child, lexicalScope));
  }
  visit(source, null);
  function binding(identifier) {
    for (let scope = nodeScopes.get(identifier); scope; scope = scope.parent) {
      if (scope.bindings.has(identifier.text)) return scope.bindings.get(identifier.text);
    }
    return null;
  }
  function unwrap(node) {
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
    return node;
  }
  const propertyName = node => node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : null;
  function recordWrite(target, expression, property = null) {
    target = unwrap(target);
    if (ts.isIdentifier(target)) {
      const bound = binding(target);
      if (bound) writes.set(bound, [...(writes.get(bound) ?? []), { expression, property }]);
    } else if (ts.isObjectLiteralExpression(target)) {
      for (const member of target.properties) {
        if (ts.isShorthandPropertyAssignment(member)) recordWrite(member.name, expression, member.name.text);
        else if (ts.isPropertyAssignment(member)) recordWrite(member.initializer, expression, propertyName(member.name));
      }
    }
  }
  function collectWrites(node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) recordWrite(node.left, node.right);
    ts.forEachChild(node, collectWrites);
  }
  collectWrites(source);
  function member(owner, name) {
    if (owner === 'namespace') return /^(?:vi|vitest)$/.test(name) ? 'mock' : isFramework(name) ? name : '';
    return owner === 'mock' && isTimer(name) ? name : '';
  }
  function boundIdentity(bound, seen) {
    if (!bound || seen.has(bound)) return '';
    seen = new Set(seen).add(bound);
    let declaration = bound;
    while (declaration && !ts.isImportDeclaration(declaration)) declaration = declaration.parent;
    if (declaration && !declaration.importClause?.isTypeOnly && !bound.isTypeOnly
      && ts.isStringLiteral(declaration.moduleSpecifier) && declaration.moduleSpecifier.text === 'vitest') {
      if (ts.isNamespaceImport(bound)) return 'namespace';
      if (ts.isImportSpecifier(bound)) return member('namespace', bound.propertyName?.text ?? bound.name.text);
    }
    const write = writes.get(bound)?.at(-1);
    if (write) return write.property ? member(identity(write.expression, seen), write.property) : identity(write.expression, seen);
    if (ts.isBindingElement(bound) && ts.isObjectBindingPattern(bound.parent) && !bound.dotDotDotToken) {
      return member(boundIdentity(bound.parent.parent, seen), propertyName(bound.propertyName ?? bound.name));
    }
    if (ts.isVariableDeclaration(bound) && bound.initializer) return identity(bound.initializer, seen);
    return '';
  }
  // Resolve static Vitest bindings, not lookalike fixture objects or names in
  // strings. Definitions alone never switch the clock; only reachable calls do.
  function identity(expression, seen = new Set()) {
    expression = unwrap(expression);
    if (ts.isIdentifier(expression)) {
      const bound = binding(expression);
      return bound ? boundIdentity(bound, seen)
        : /^(?:vi|vitest)$/.test(expression.text) ? 'mock' : isFramework(expression.text) ? expression.text : '';
    }
    if (ts.isPropertyAccessExpression(expression)) return member(identity(expression.expression, seen), expression.name.text);
    if (ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression)) return member(identity(expression.expression, seen), expression.argumentExpression.text);
    return '';
  }
  function frameworkName(expression) {
    const name = identity(expression);
    if (isFramework(name)) return name;
    if (ts.isPropertyAccessExpression(expression) || ts.isCallExpression(expression)) return frameworkName(expression.expression);
    if (ts.isTaggedTemplateExpression(expression)) return frameworkName(expression.tag);
    return '';
  }
  for (const call of calls) {
    const kind = frameworkName(call.expression);
    if (!isFramework(kind)) continue;
    for (const argument of call.arguments) {
      if (isFunction(argument)) callbackKinds.set(argument, kind);
      else if (ts.isIdentifier(argument) || isTimer(identity(argument))) {
        const scope = { kind, start: argument.getStart(source), end: argument.end };
        scopes.push(scope);
        registeredHelpers.push({ argument, scope });
      }
    }
  }
  for (const node of functions) scopes.push({ kind: callbackKinds.get(node) ?? 'helper', start: node.getStart(source), end: node.end });
  scopes.sort((a, b) => (a.end - a.start) - (b.end - b.start));
  function helper(expression, seen = new Set()) {
    expression = unwrap(expression);
    if (isFunction(expression)) return expression;
    if (!ts.isIdentifier(expression)) return null;
    const bound = binding(expression);
    if (!bound || seen.has(bound)) return null;
    seen = new Set(seen).add(bound);
    const write = writes.get(bound)?.at(-1);
    if (write) return write.property ? null : helper(write.expression, seen);
    if (isFunction(bound)) return bound;
    if (ts.isVariableDeclaration(bound) && bound.initializer) return helper(bound.initializer, seen);
    return null;
  }
  function helperEvents(fn, seen = new Set()) {
    if (!fn?.body || seen.has(fn)) return [];
    seen = new Set(seen).add(fn);
    const events = [];
    function inspect(node) {
      if (isFunction(node)) return;
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const name = identity(expression);
        if (isTimer(name)) events.push(name);
        else events.push(...helperEvents(helper(expression), seen));
      }
      ts.forEachChild(node, inspect);
    }
    inspect(fn.body);
    return events;
  }
  function addEvents(names, index) {
    names.forEach((name, order) => timerEvents.push({ 1: name, index: index + (order + 1) / 1e6 }));
  }
  // A helper definition does not change timer mode. Apply its reachable timer
  // calls only where it is actually invoked or registered as a framework hook.
  for (const call of calls) {
    const index = call.getStart(source);
    if (scopes.find(scope => scope.start <= index && index < scope.end)?.kind === 'helper') continue;
    const name = identity(call.expression);
    addEvents(isTimer(name) ? [name] : helperEvents(helper(call.expression)), index);
  }
  for (const { argument, scope } of registeredHelpers) {
    const name = identity(argument);
    addEvents(isTimer(name) ? [name] : helperEvents(helper(argument)), scope.start);
  }
  timerEvents.sort((a, b) => a.index - b.index);
  return scopes;
}

function timerStateAt(index, timerEvents, scopes) {
  const scopeAt = (position) => scopes.find(s => s.start <= position && position < s.end);
  const localWaitScope = scopeAt(index);
  // Inline executors (for example a Promise around setTimeout) still run in
  // the surrounding test and inherit its hooks, unlike an uncalled definition.
  const waitScope = scopes.find(s => s.kind !== 'helper' && s.start <= index && index < s.end) ?? localWaitScope;
  const describeAt = (scope) => scopes.find(s => s.kind === 'describe' && s.start < scope.start && scope.end < s.end);
  const belongsToWait = (scope) => !scope || scope.kind === 'describe' && scope.start < index && index < scope.end;
  const events = timerEvents.map(event => ({ event, scope: scopeAt(event.index) }));
  let fake = false;
  // Registration-time calls and before hooks are distinct from calls in a
  // sibling test or an after hook. Inherit hooks from outer describes first.
  const inherited = events.filter(({ event, scope }) => event.index < index && belongsToWait(scope));
  for (const { event } of inherited) fake = event[1] === 'useFakeTimers';
  if (waitScope && /^(?:it|test)$/.test(waitScope.kind)) {
    // Registration-time setup, like beforeAll, runs only once. An afterEach
    // restoring real timers can invalidate it before a later test runs.
    const earlierTests = scopes.filter(scope => /^(?:it|test)$/.test(scope.kind) && scope.end < waitScope.start);
    const containsTest = (suite, test) => !suite || suite.start < test.start && test.end < suite.end;
    const restoringHooks = events.filter(entry => entry.scope?.kind === 'afterEach'
      && entry.event[1] === 'useRealTimers' && belongsToWait(describeAt(entry.scope)));
    const hasRestoredTimers = (suite) => restoringHooks.some(entry => earlierTests.some(test =>
      containsTest(suite, test) && containsTest(describeAt(entry.scope), test)));
    const restoresRealTimers = hasRestoredTimers(null);
    if (restoresRealTimers) fake = false;
    const hooks = events.filter(({ scope }) => scope && /^(?:beforeAll|beforeEach)$/.test(scope.kind) && belongsToWait(describeAt(scope)))
      .sort((a, b) => {
        const depthA = scopes.filter(s => s.kind === 'describe' && s.start < a.scope.start && a.scope.end < s.end).length;
        const depthB = scopes.filter(s => s.kind === 'describe' && s.start < b.scope.start && b.scope.end < s.end).length;
        if (a.scope.kind !== b.scope.kind) return a.scope.kind === 'beforeAll' ? -1 : 1;
        return depthA - depthB || a.event.index - b.event.index;
      });
    for (const { event, scope } of hooks) {
      // An afterEach restoring real timers invalidates beforeAll-only setup
      // for subsequent tests. Be conservative rather than exempt a real wait.
      if (scope.kind === 'beforeAll' && hasRestoredTimers(describeAt(scope))) continue;
      fake = event[1] === 'useFakeTimers';
    }
  }
  for (const { event, scope } of events) {
    if ((scope === waitScope || scope === localWaitScope) && event.index < index) fake = event[1] === 'useFakeTimers';
  }
  return fake;
}

function countRealWaits(code, lines, sourceCode = code) {
  const timerEvents = [];
  const scopes = /\buse(?:Fake|Real)Timers\b/.test(sourceCode) ? timerScopes(sourceCode, timerEvents) : [];
  let count = 0;
  const waits = staticWaitCalls(sourceCode).sort((a, b) => a.index - b.index);
  for (const wait of waits) {
    if (timerStateAt(wait.clockIndex ?? wait.index, timerEvents, scopes)) continue;
    if (wait.duration < REAL_WAIT_MIN_MS) continue;
    const line = lineOf(code, wait.index);
    if (!hasJustification(lines, line, 'real-wait')) count += 1;
  }
  return count;
}

const IMPORT_CONTEXT = /(?:\bfrom|\bimport|\brequire|\.mock|\.doMock|\.unmock|\.importActual|\.importMock|\.glob)\s*\(?\s*$/;
const SOURCE_EXTENSION = '(?:tsx?|mts|cts|css|mjs|cjs|jsx?|swift|[cmh]|mm|cc|cpp|cxx|hh|hpp|hxx|rs|go|kts?|java|cs|py|rb|sh|bash|zsh|html|vue|svelte|scss|sass|less)';
const SOURCE_EXT = new RegExp('\\.' + SOURCE_EXTENSION + '$', 'i');
const SOURCE_LITERAL = new RegExp('\\.' + SOURCE_EXTENSION + '[\'"]', 'i');
// Only anchors that point into the checkout count; generic names such as `root`
// usually hold an mkdtemp() directory whose fake source files are test input.
const REPO_ANCHOR = /__dirname|import\.meta\.(?:url|dirname)|process\.cwd\s*\(\s*\)|\b(?:REPO_ROOT|repoRoot|desktopRoot)\b/;

/** Follow simple local path bindings so an anchor-derived directory cannot be
 * hidden behind a descriptive variable name (for example agentsRoot).
 * This intentionally stays local and syntax-only; it does not evaluate
 * arbitrary expressions or cross module boundaries.
 */
function findRepoAnchorNames(code) {
  const ts = typescript ??= requireDesktop('typescript');
  const source = parseTestSource(ts, code);
  const declarations = [];
  const collect = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      declarations.push({ name: node.name.text, initializer: node.initializer });
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  const names = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const { name, initializer } of declarations) {
      const rhs = initializer.getText(source);
      const identifiers = rhs.match(/\b[A-Za-z_$][\w$]*\b/g) ?? [];
      let call = initializer;
      while (ts.isParenthesizedExpression(call) || ts.isAsExpression(call) || ts.isNonNullExpression(call)) call = call.expression;
      const callee = ts.isCallExpression(call) || ts.isNewExpression(call) ? call.expression : null;
      const factoryName = callee && (ts.isIdentifier(callee) ? callee.text
        : ts.isPropertyAccessExpression(callee) ? callee.name.text
          : ts.isElementAccessExpression(callee) && ts.isStringLiteral(callee.argumentExpression) ? callee.argumentExpression.text : null);
      const pathFactory = /^(?:resolve|join|URL)$/.test(factoryName ?? '');
      const directAnchor = /^\s*(?:__dirname|import\.meta\.(?:url|dirname)|process\.cwd\s*\(\s*\)|REPO_ROOT|repoRoot|desktopRoot)\b/.test(rhs);
      const alias = /^\s*[A-Za-z_$][\w$]*\s*$/.test(rhs);
      if ((directAnchor || pathFactory && (REPO_ANCHOR.test(rhs) || identifiers.some(identifier => names.has(identifier)))
        || alias && identifiers.some(identifier => names.has(identifier)))
        && !names.has(name)) {
        names.add(name);
        changed = true;
      }
    }
  }
  return names;
}

function hasRepoAnchor(text, anchorNames = new Set()) {
  if (REPO_ANCHOR.test(text)) return true;
  return (text.match(/\b[A-Za-z_$][\w$]*\b/g) ?? []).some(identifier => anchorNames.has(identifier));
}

/** Normalize only calls bound to fs reads, leaving strings and local shadows
 * untouched. All path/execution offsets below come from this same final text.
 * This is static local alias tracking, not arbitrary inter-module evaluation.
 */
function normalizeSourceReads(code) {
  const ts = typescript ??= requireDesktop('typescript');
  const source = parseTestSource(ts, code);
  const scopes = new WeakMap();
  const calls = [];
  const writes = new Map();
  const isFunction = node => ts.isFunctionLike(node) && Boolean(node.body);
  function declare(name, declaration, scope) {
    if (ts.isIdentifier(name)) scope.bindings.set(name.text, declaration);
    else for (const element of name.elements) {
      if (ts.isBindingElement(element)) declare(element.name, element, scope);
    }
  }
  function collect(node, scope) {
    if (ts.isFunctionDeclaration(node) && node.name) scope.bindings.set(node.name.text, node);
    if (ts.isSourceFile(node) || ts.isBlock(node) || isFunction(node) || ts.isCatchClause(node)) scope = { parent: scope, bindings: new Map() };
    scopes.set(node, scope);
    if (isFunction(node)) {
      if (node.name && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node))) scope.bindings.set(node.name.text, node);
      for (const parameter of node.parameters) declare(parameter.name, parameter, scope);
    }
    if (ts.isVariableDeclaration(node)) declare(node.name, node, scope);
    if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node) || ts.isImportClause(node) && node.name) scope.bindings.set(node.name.text, node);
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, child => collect(child, scope));
  }
  collect(source, null);
  function binding(identifier) {
    for (let scope = scopes.get(identifier); scope; scope = scope.parent) {
      if (scope.bindings.has(identifier.text)) return scope.bindings.get(identifier.text);
    }
    return null;
  }
  function unwrap(node) {
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isAwaitExpression(node)) node = node.expression;
    return node;
  }
  const propertyName = node => node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) ? node.text : null;
  function recordWrite(target, expression, property = null) {
    target = unwrap(target);
    if (ts.isIdentifier(target)) {
      const bound = binding(target);
      if (bound) writes.set(bound, [...(writes.get(bound) ?? []), { expression, property }]);
    } else if (ts.isObjectLiteralExpression(target)) {
      for (const member of target.properties) {
        if (ts.isShorthandPropertyAssignment(member)) recordWrite(member.name, expression, member.name.text);
        else if (ts.isPropertyAssignment(member)) recordWrite(member.initializer, expression, propertyName(member.name));
      }
    }
  }
  function collectWrites(node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) recordWrite(node.left, node.right);
    ts.forEachChild(node, collectWrites);
  }
  collectWrites(source);
  function propertyMatches(expression, property, kind, seen) {
    return kind === 'promises' && property === 'promises' && matches(expression, 'fs', seen)
      || kind === 'read' && (property === 'readFileSync' && matches(expression, 'fs', seen)
        || property === 'readFile' && (matches(expression, 'fs', seen) || matches(expression, 'promises', seen)));
  }
  function boundMatches(bound, kind, seen) {
    if (!bound || seen.has(bound)) return false;
    seen = new Set(seen).add(bound);
    let declaration = bound;
    while (declaration && !ts.isImportDeclaration(declaration)) declaration = declaration.parent;
    const module = declaration && !declaration.importClause?.isTypeOnly && !bound.isTypeOnly
      && ts.isStringLiteral(declaration.moduleSpecifier) ? declaration.moduleSpecifier.text : '';
    if (/^(?:node:)?fs(?:\/promises)?$/.test(module)) {
      const namespace = module.endsWith('/promises') ? 'promises' : 'fs';
      if (ts.isNamespaceImport(bound) || ts.isImportClause(bound)) return kind === namespace;
      if (ts.isImportSpecifier(bound)) {
        const name = bound.propertyName?.text ?? bound.name.text;
        return kind === 'read' && (name === 'readFile' || namespace === 'fs' && name === 'readFileSync')
          || kind === 'promises' && namespace === 'fs' && name === 'promises';
      }
    }
    if (ts.isBindingElement(bound) && ts.isObjectBindingPattern(bound.parent) && !bound.dotDotDotToken) {
      const owner = bound.parent.parent;
      const property = propertyName(bound.propertyName ?? bound.name);
      if (ts.isVariableDeclaration(owner) && owner.initializer && propertyMatches(owner.initializer, property, kind, seen)) return true;
      if (ts.isBindingElement(owner) && propertyMatches(owner, property, kind, seen)) return true;
      if ((writes.get(owner) ?? []).some(write => !write.property && propertyMatches(write.expression, property, kind, seen))) return true;
    }
    if (ts.isVariableDeclaration(bound) && bound.initializer && matches(bound.initializer, kind, seen)) return true;
    return (writes.get(bound) ?? []).some(write => write.property
      ? propertyMatches(write.expression, write.property, kind, seen) : matches(write.expression, kind, seen));
  }
  function matches(node, kind, seen = new Set()) {
    node = unwrap(node);
    if (ts.isBindingElement(node)) return boundMatches(node, kind, seen);
    if (ts.isIdentifier(node)) {
      const bound = binding(node);
      return bound ? boundMatches(bound, kind, seen)
        : kind === 'read' && /^(?:readFileSync|readFile)$/.test(node.text);
    }
    if (ts.isPropertyAccessExpression(node)) return propertyMatches(node.expression, node.name.text, kind, seen);
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return propertyMatches(node.expression, node.argumentExpression.text, kind, seen);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === 'require' && !binding(node.expression))) {
      const module = node.arguments[0];
      return module && ts.isStringLiteral(module) && /^(?:node:)?fs(?:\/promises)?$/.test(module.text)
        && kind === (module.text.endsWith('/promises') ? 'promises' : 'fs');
    }
    return false;
  }
  const wrapperReads = new WeakMap();
  function localReadWrapper(bound) {
    const value = bound && ts.isVariableDeclaration(bound) ? bound.initializer : bound;
    const fn = value && unwrap(value);
    if (!fn || !isFunction(fn)) return false;
    if (!wrapperReads.has(fn)) wrapperReads.set(fn, calls.some(call => {
      if (!matches(call.expression, 'read')) return false;
      for (let owner = call.parent; owner; owner = owner.parent) {
        if (isFunction(owner)) return owner === fn;
      }
      return false;
    }));
    return wrapperReads.get(fn);
  }
  const edits = [];
  // Inline only immutable local string/alias bindings used as a read path.
  // Reparse below so literal offsets and source-execution exemptions agree.
  function pathLiteral(node, seen = new Set()) {
    node = unwrap(node);
    if (ts.isStringLiteralLike(node)) return node;
    if (!ts.isIdentifier(node)) return null;
    const bound = binding(node);
    if (!bound || seen.has(bound) || writes.has(bound) || !ts.isVariableDeclaration(bound)
      || !ts.isVariableDeclarationList(bound.parent) || !(bound.parent.flags & ts.NodeFlags.Const)
      || !bound.initializer) return null;
    return pathLiteral(bound.initializer, new Set(seen).add(bound));
  }
  function inlinePathLiterals(node) {
    if (!node) return;
    node = unwrap(node);
    if (ts.isIdentifier(node)) {
      // Member names are labels; only value references carry path bindings.
      if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
        || ts.isPropertyAssignment(node.parent) && node.parent.name === node) return;
      const literal = pathLiteral(node);
      if (literal && SOURCE_EXT.test(literal.text)) edits.push({ start: node.getStart(source), end: node.end, text: literal.getText(source) });
      return;
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text
        : ts.isPropertyAccessExpression(callee) ? callee.name.text
          : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression) ? callee.argumentExpression.text : '';
      if (/^(?:resolve|join|URL)$/.test(name)) for (const argument of node.arguments ?? []) inlinePathLiterals(argument);
    }
  }
  for (const call of calls) {
    const expression = call.expression;
    const name = ts.isIdentifier(expression) ? expression.text
      : ts.isPropertyAccessExpression(expression) ? expression.name.text : '';
    // Retain the old read-shaped wrapper behavior for all local function forms,
    // but a same-named passthrough or shadow must not masquerade as an fs read.
    const actualRead = matches(expression, 'read') || /^(?:readFileSync|readFile)$/.test(name)
      && ts.isIdentifier(expression) && localReadWrapper(binding(expression));
    if (actualRead) inlinePathLiterals(call.arguments[0]);
    if (actualRead && /^(?:readFileSync|readFile)$/.test(name)) continue;
    if (actualRead || /^(?:readFileSync|readFile)$/.test(name)) {
      edits.push({ start: expression.getStart(source), end: expression.end, text: actualRead ? 'readFileSync' : '__nonFsRead' });
    }
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  const normalizedSource = edits.length ? parseTestSource(ts, code) : source;
  const literals = [];
  function collectLiterals(node) {
    if (ts.isStringLiteralLike(node)) {
      const literal = [node.getText(normalizedSource), null, node.text];
      literal.index = node.getStart(normalizedSource);
      literals.push(literal);
    }
    ts.forEachChild(node, collectLiterals);
  }
  collectLiterals(normalizedSource);
  return { code, literals };
}

function findEnclosingReadCall(code, index, pattern = /\breadFile(?:Sync)?\s*\(/g) {
  const starts = [...code.matchAll(pattern)];
  for (let n = starts.length - 1; n >= 0; n -= 1) {
    const start = starts[n].index;
    if (start == null || start >= index) continue;
    let depth = 1;
    let quote = null;
    let escaped = false;
    for (let i = start + starts[n][0].length; i < index; i += 1) {
      const ch = code[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === String.fromCharCode(96)) {
        quote = ch;
      } else if (ch === '(') {
        depth += 1;
      } else if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth > 0) return start;
  }
  return -1;
}

function findSourceReadHelpers(code) {
  const helpers = new Set();
  const arrowPattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=>[^;{}]{0,500}\breadFile(?:Sync)?\s*\(/g;
  for (const match of code.matchAll(arrowPattern)) helpers.add(match[1]);
  const functionPattern = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{;\n]+)?\{[^{}]{0,500}\breadFile(?:Sync)?\s*\(/g;
  for (const match of code.matchAll(functionPattern)) helpers.add(match[1]);
  return helpers;
}

function isSourcePathLiteral(code, match, sourceReadHelpers = new Set(), anchorNames = new Set()) {
  const value = match[2];
  if (!SOURCE_EXT.test(value) || /fixture|:\/\//i.test(value)) return false;
  if (IMPORT_CONTEXT.test(code.slice(Math.max(0, match.index - 24), match.index))) return false;
  const lineStart = code.lastIndexOf('\n', match.index) + 1;
  const lineEnd = code.indexOf('\n', match.index);
  const line = code.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  // Test data under a fixtures directory is input, not production source.
  if (/fixture/i.test(line)) return false;
  const prefix = line.slice(0, match.index - lineStart);
  const helperCall = prefix.match(/\b([A-Za-z_$][\w$]*)\s*\(\s*$/)?.[1];
  if (helperCall && sourceReadHelpers.has(helperCall)) return true;
  // resolve(__dirname, '..', 'Sidebar.tsx') or new URL('../x.ts', import.meta.url).
  if (hasRepoAnchor(line, anchorNames) && findEnclosingReadCall(code, match.index) >= 0) return true;
  // A separately declared sourcePath may be formatted over several lines before
  // it is passed to readFileSync. Keep that equivalent to the inline path form.
  const pathStart = findEnclosingReadCall(code, match.index, /\b(?:resolve|join|URL)\s*\(/g);
  if (pathStart >= 0) {
    const pathEnd = code.indexOf(')', match.index + match[0].length);
    const pathContext = code.slice(pathStart, pathEnd < 0 ? match.index + match[0].length : pathEnd + 1);
    const binding = code.slice(Math.max(0, pathStart - 150), pathStart)
      .match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:new\s+)?(?:[A-Za-z_$][\w$]*\.)?$/)?.[1];
    const readBinding = binding && new RegExp('\\breadFile(?:Sync)?\\s*\\(\\s*' + binding + '\\b').test(code);
    if (readBinding && hasRepoAnchor(pathContext, anchorNames) && !/fixture/i.test(pathContext)) return true;
  }
  // Keep the same decision for a formatted multi-line readFileSync call. The
  // current line may only contain the final path segment, while the repository
  // anchor and read call live on the preceding lines.
  const callStart = findEnclosingReadCall(code, match.index);
  if (callStart >= 0) {
    const callContext = code.slice(callStart, match.index + match[0].length);
    const previousContext = callContext.slice(0, -match[0].length);
    const hasPriorSourceLiteral = SOURCE_LITERAL.test(previousContext);
    if (/\n/.test(callContext) && !hasPriorSourceLiteral && !/[;{}]/.test(callContext) && hasRepoAnchor(callContext, anchorNames) && !/fixture/i.test(callContext)) return true;
  }
  // readFileSync('../x.ts') reads relative to the test process, i.e. the checkout.
  return callStart >= 0 && (value.startsWith('./') || value.startsWith('../'));
}

/** Source compiled and executed by a behavior harness is not a text assertion.
 * Follow each read's local bindings to execution and assertion sites separately:
 * an unrelated new Function must never exempt a source-literal assertion.
 */
function executedSourcePaths(code) {
  const ts = typescript ??= requireDesktop('typescript');
  const source = parseTestSource(ts, code);
  const scopes = new WeakMap();
  const reads = [];
  const calls = [];
  const strings = [];
  const isFunction = node => ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node);
  function collect(node, scope) {
    if (ts.isFunctionDeclaration(node) && node.name) scope.bindings.set(node.name.text, node);
    if (ts.isSourceFile(node) || ts.isBlock(node) || isFunction(node) || ts.isForOfStatement(node)) scope = { parent: scope, bindings: new Map() };
    scopes.set(node, scope);
    if (isFunction(node)) for (const parameter of node.parameters) {
      if (ts.isIdentifier(parameter.name)) scope.bindings.set(parameter.name.text, parameter);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) scope.bindings.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name)) {
      const loop = node.parent.parent;
      if (ts.isForOfStatement(loop)) {
        for (const element of node.name.elements) {
          if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) scope.bindings.set(element.name.text, element);
        }
      }
    }
    if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node) || ts.isImportClause(node) && node.name) scope.bindings.set(node.name.text, node);
    if (ts.isStringLiteralLike(node)) strings.push(node);
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      calls.push(node);
      const name = ts.isIdentifier(node.expression) ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
      if (name === 'readFileSync' || name === 'readFile') reads.push(node);
    }
    ts.forEachChild(node, child => collect(child, scope));
  }
  collect(source, null);
  function binding(identifier) {
    for (let scope = scopes.get(identifier); scope; scope = scope.parent) {
      if (scope.bindings.has(identifier.text)) return scope.bindings.get(identifier.text);
    }
    return null;
  }
  function vmNamespace(node, seen = new Set()) {
    if (!ts.isIdentifier(node) || seen.has(node)) return false;
    seen.add(node);
    const bound = binding(node);
    if (bound && ts.isVariableDeclaration(bound) && bound.initializer) return vmNamespace(bound.initializer, seen);
    const declaration = bound && (ts.isNamespaceImport(bound) ? bound.parent.parent
      : ts.isImportClause(bound) ? bound.parent : null);
    return declaration && ts.isImportDeclaration(declaration) && ts.isStringLiteral(declaration.moduleSpecifier)
      && /^(?:node:)?vm$/.test(declaration.moduleSpecifier.text);
  }
  function execution(node) {
    if (!ts.isNewExpression(node) && !ts.isCallExpression(node)) return false;
    if (ts.isPropertyAccessExpression(node.expression)) return /^runIn(?:New)?Context$/.test(node.expression.name.text)
      && vmNamespace(node.expression.expression);
    if (!ts.isIdentifier(node.expression)) return false;
    const bound = binding(node.expression);
    if (!bound) return node.expression.text === 'Function';
    if (!ts.isImportSpecifier(bound)) return false;
    const imported = bound.propertyName?.text ?? bound.name.text;
    const declaration = bound.parent.parent.parent;
    return /^runIn(?:New)?Context$/.test(imported) && ts.isImportDeclaration(declaration)
      && ts.isStringLiteral(declaration.moduleSpecifier) && /^(?:node:)?vm$/.test(declaration.moduleSpecifier.text);
  }
  const writes = new Map();
  function addWrite(bound, value) {
    if (bound && value) writes.set(bound, [...(writes.get(bound) ?? []), value]);
  }
  function collectWrites(node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      addWrite(binding(node.left), node.right);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const bound = binding(node.expression);
      const fn = bound && ts.isVariableDeclaration(bound) ? bound.initializer : bound;
      if (fn && isFunction(fn)) fn.parameters.forEach((parameter, index) => addWrite(parameter, node.arguments[index]));
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && /^(?:set|push|unshift|add)$/.test(node.expression.name.text) && ts.isIdentifier(node.expression.expression)) {
      for (const argument of node.arguments) addWrite(binding(node.expression.expression), argument);
    }
    ts.forEachChild(node, collectWrites);
  }
  collectWrites(source);
  const returnCache = new WeakMap();
  function returns(fn) {
    if (returnCache.has(fn)) return returnCache.get(fn);
    if (!fn.body) return [];
    if (!ts.isBlock(fn.body)) return [fn.body];
    const result = [];
    function visit(node) {
      if (isFunction(node)) return;
      if (ts.isReturnStatement(node) && node.expression) result.push(node.expression);
      ts.forEachChild(node, visit);
    }
    visit(fn.body);
    returnCache.set(fn, result);
    return result;
  }
  const readSet = new Set(reads);
  function dependencies(node, seen = new Set(), paths = false) {
    if (!node || seen.has(node)) return new Set();
    seen.add(node);
    if (paths && ts.isStringLiteralLike(node)) return new Set([node.getStart(source)]);
    if (!paths && readSet.has(node)) return new Set([node]);
    if (isFunction(node)) {
      const result = new Set();
      for (const value of returns(node)) for (const dependency of dependencies(value, seen, paths)) result.add(dependency);
      return result;
    }
    if (ts.isIdentifier(node)) {
      // A property label is not a read of a same-named local source variable.
      // Shorthand and computed properties are expressions and still propagate.
      if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
        || ts.isPropertyAssignment(node.parent) && node.parent.name === node) return new Set();
      const bound = binding(node);
      const values = [...(writes.get(bound) ?? [])];
      if (bound && (ts.isVariableDeclaration(bound) || ts.isParameter(bound))) values.push(bound.initializer);
      if (bound && ts.isBindingElement(bound)) values.push(bound.parent.parent.parent.parent.expression);
      if (bound && isFunction(bound)) values.push(...returns(bound));
      const result = new Set();
      for (const value of values) for (const dependency of dependencies(value, seen, paths)) result.add(dependency);
      return result;
    }
    // Once the compiled function is invoked, its return value is behavior, not
    // source text. Its code input is inspected independently at the sink below.
    if (!paths && (ts.isCallExpression(node) || ts.isNewExpression(node)) && execution(node)) return new Set();
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression) ? binding(node.expression) : null;
      const fn = callee && ts.isVariableDeclaration(callee) ? callee.initializer : callee;
      if (fn && isFunction(fn)) {
        // Parameters already carry their actual writes. A local helper's
        // output depends on its returns, not every unrelated input argument.
        const result = new Set();
        for (const value of returns(fn)) for (const dependency of dependencies(value, seen, paths)) result.add(dependency);
        return result;
      }
      const initializer = callee && ts.isVariableDeclaration(callee) ? callee.initializer : node.expression;
      if (!paths && initializer && execution(initializer)) return new Set();
    }
    const result = new Set();
    ts.forEachChild(node, child => {
      for (const dependency of dependencies(child, seen, paths)) result.add(dependency);
    });
    return result;
  }
  const executed = new Set();
  const asserted = new Set();
  for (const call of calls) {
    if (execution(call)) {
      for (const argument of call.arguments ?? []) for (const read of dependencies(argument)) executed.add(read);
      if (ts.isPropertyAccessExpression(call.expression)) {
        for (const read of dependencies(call.expression.expression)) executed.add(read);
      }
    }
    let assertionExpression = call.expression;
    while (ts.isPropertyAccessExpression(assertionExpression)) assertionExpression = assertionExpression.expression;
    const assertion = ts.isIdentifier(assertionExpression) ? assertionExpression.text : '';
    if (/^(?:expect|expectTypeOf|assert)$/.test(assertion)) {
      for (const argument of call.arguments ?? []) for (const read of dependencies(argument)) asserted.add(read);
    }
  }
  const exempt = new Set();
  const readHelpers = findSourceReadHelpers(code);
  for (const read of executed) {
    if (asserted.has(read)) continue;
    for (const position of dependencies(read.arguments[0], new Set(), true)) exempt.add(position);
    // readSource('../x.ts') helpers keep their path at the call site. Only
    // calls whose result actually depends on this executed read qualify.
    for (const call of calls) {
      if (!ts.isIdentifier(call.expression) || !readHelpers.has(call.expression.text) || !dependencies(call).has(read)) continue;
      for (const argument of call.arguments ?? []) for (const position of dependencies(argument, new Set(), true)) exempt.add(position);
    }
  }
  return exempt;
}

/** Count unjustified rule hits in one unit test file. */
export function scanTestSource(source, { isGuard = false } = {}) {
  const code = stripComments(source);
  const lines = source.split(/\r?\n/);
  const executableCode = maskStrings(code);
  const resetModules = countModuleResets(code, lines);
  const realWaits = countRealWaits(executableCode, lines, code);
  let sourceReads = 0;
  if (!isGuard && /\breadFile(?:Sync)?\b|\?raw/.test(code)) {
    const normalized = normalizeSourceReads(code);
    const sourceReadHelpers = findSourceReadHelpers(normalized.code);
    const anchorNames = findRepoAnchorNames(normalized.code);
    const executablePaths = /\bFunction\b|\brunIn(?:New)?Context\b/.test(normalized.code) ? executedSourcePaths(normalized.code) : new Set();
    for (const match of normalized.literals) {
      if (executablePaths.has(match.index)) continue;
      if (match[2].endsWith('?raw') || isSourcePathLiteral(normalized.code, match, sourceReadHelpers, anchorNames)) sourceReads += 1;
    }
  }
  return { resetModules, realWaits, sourceReads };
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(path.join(dir, entry.name), out);
    } else if (TEST_FILE.test(entry.name) && !NON_UNIT_TEST.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
}

async function loadGuardFiles(root) {
  const configUrl = pathToFileURL(path.join(root, 'scripts', 'test-workspaces.config.mjs'));
  const { default: manifest } = await import(configUrl.href);
  const guard = new Set();
  for (const workspace of manifest.workspaces) {
    for (const file of workspace.tiers?.guard?.include ?? []) {
      guard.add(path.posix.join(workspace.cwd, file));
    }
  }
  return guard;
}

export async function scanRepository(root = ROOT) {
  const files = [];
  for (const scanRoot of SCAN_ROOTS) walk(path.join(root, scanRoot), files);
  const guard = await loadGuardFiles(root);
  const counts = {};
  for (const file of files.sort()) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    // Only explicitly registered contracts or frozen DB inputs may inspect
    // application source; their reload/wait rules still run, like guard suites.
    const result = scanTestSource(readFileSync(file, 'utf8'), { isGuard: guard.has(rel) || ROOT_SOURCE_CONTRACTS.has(rel) || DB_SOURCE_INPUTS.has(rel) });
    if (RULES.some((rule) => result[rule] > 0)) counts[rel] = result;
  }
  return counts;
}

/** Compare current counts with the ratchet baseline. */
export function compareWithBaseline(counts, baseline) {
  const violations = [];
  const tightenable = [];
  for (const [file, current] of Object.entries(counts)) {
    const allowed = baseline[file] ?? {};
    for (const rule of RULES) {
      const limit = allowed[rule] ?? 0;
      if (current[rule] > limit) violations.push({ file, rule, current: current[rule], limit });
    }
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    const current = counts[file] ?? {};
    if (RULES.some((rule) => (current[rule] ?? 0) < (allowed[rule] ?? 0))) tightenable.push(file);
  }
  return { violations, tightenable };
}

const HINTS = {
  resetModules: 'beforeEach/afterEach 及其准备、清理 helper 禁止重载模块，写理由也不豁免；显式重启边界上一行写 `// reset-modules: <原因>`；优先用生产代码的 dispose/reset 或依赖注入',
  realWaits: '改用 vi.useFakeTimers() 或等待真实事件；确需真实等待时上一行写 `// real-wait: <原因>`',
  sourceReads: '普通单测不得读取源码文本做字面量断言；改为经生产入口验证行为，纯跨文件契约移入对应包的 guard tier',
};

function parseBaseline(text, label) {
  let body;
  try { body = JSON.parse(text); } catch { throw new Error('invalid baseline JSON: ' + label); }
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!record(body) || !record(body.files)) throw new Error('invalid baseline files: ' + label);
  for (const [file, rules] of Object.entries(body.files)) {
    if (!record(rules) || Object.entries(rules).some(([rule, count]) => !RULES.includes(rule) || !Number.isSafeInteger(count) || count < 0)) {
      throw new Error('invalid baseline limits: ' + label + ' (' + file + ')');
    }
  }
  return body.files;
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return {};
  return parseBaseline(readFileSync(BASELINE_PATH, 'utf8'), BASELINE_REL);
}

function readTrustedBaseline() {
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const remoteBase = process.env.GITHUB_BASE_REF ? 'refs/remotes/origin/' + process.env.GITHUB_BASE_REF : null;
  const eventName = process.env.GITHUB_EVENT_NAME;
  let ref;
  if (eventName === 'pull_request') ref = event.pull_request?.base?.sha ?? remoteBase;
  else if (eventName === 'merge_group') ref = event.merge_group?.base_sha;
  else if (eventName === 'push') ref = event.before;
  else ref = remoteBase ?? 'refs/remotes/origin/main';
  if (!ref || /^0+$/.test(ref)) throw new Error('trusted Git base is unavailable for ' + (eventName || 'local check'));
  const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let commit;
  let entry;
  try {
    commit = git(['rev-parse', '--verify', '--end-of-options', ref + '^{commit}']);
    entry = git(['ls-tree', '--name-only', commit, '--', BASELINE_REL]);
  } catch {
    throw new Error('trusted Git base cannot be read: ' + ref);
  }
  // Only a successfully read commit with no baseline path is first adoption.
  // Missing refs/history and Git failures must never silently bootstrap.
  if (!entry) return { files: null, commit };
  let text;
  try { text = git(['show', commit + ':' + BASELINE_REL]); }
  catch { throw new Error('trusted Git baseline cannot be read: ' + commit); }
  return { files: parseBaseline(text, 'trusted ' + commit), commit };
}

function writeBaseline(files) {
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  const body = {
    description: 'Ratchet baseline for scripts/check-test-hygiene.mjs. Counts may only go down; see engineering-conventions.md §3.2.',
    files: sorted,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(body, null, 2)}\n`);
}

export async function main(args = process.argv.slice(2)) {
  const trusted = readTrustedBaseline();
  const hasBaseline = existsSync(BASELINE_PATH);
  const baseline = readBaseline();
  if (!hasBaseline && (trusted.files !== null || !args.includes('--update'))) throw new Error('baseline is missing: ' + BASELINE_REL);
  if (trusted.files === null) console.log('[test-hygiene] bootstrap: trusted base ' + trusted.commit + ' has no baseline yet');
  else {
    const raised = compareWithBaseline(baseline, trusted.files).violations;
    if (raised.length > 0) {
      for (const item of raised) console.error('[test-hygiene] baseline cannot increase ' + item.file + ' ' + item.rule + ': ' + item.limit + ' -> ' + item.current);
      return 1;
    }
  }
  const counts = await scanRepository();
  const { violations, tightenable } = compareWithBaseline(counts, baseline);
  if (args.includes('--update')) {
    // The very first run records the existing debt; afterwards --update only tightens.
    if (violations.length > 0 && existsSync(BASELINE_PATH)) {
      for (const v of violations) console.error(`refusing to raise ${v.rule} for ${v.file}: ${v.limit} -> ${v.current}`);
      console.error('[test-hygiene] --update only tightens the baseline; fix the new hits instead.');
      return 1;
    }
    const next = {};
    for (const [file, current] of Object.entries(counts)) {
      const entry = Object.fromEntries(RULES.filter((rule) => current[rule] > 0).map((rule) => [rule, current[rule]]));
      if (Object.keys(entry).length > 0) next[file] = entry;
    }
    writeBaseline(next);
    console.log(`[test-hygiene] baseline updated: ${Object.keys(next).length} files`);
    return 0;
  }
  if (violations.length === 0) {
    if (tightenable.length > 0) {
      console.error(`[test-hygiene] FAIL — ${tightenable.length} baseline entries can be tightened; run node scripts/check-test-hygiene.mjs --update`);
      return 1;
    }
    console.log(`[test-hygiene] PASS (${Object.keys(counts).length} files within baseline)`);
    return 0;
  }
  for (const v of violations) {
    console.error(`❌ [${v.rule}] ${v.file}: ${v.current} unjustified hit(s), baseline allows ${v.limit}`);
    console.error(`   ${HINTS[v.rule]}`);
  }
  console.error('[test-hygiene] FAIL — see docs/dev-rules/engineering-conventions.md §3.2');
  return 1;
}

// macOS temp directories and linked CLI entrypoints may spell the same file
// differently from import.meta.url, which Node resolves to its real path.
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(`[test-hygiene] ${error.message}`);
    process.exitCode = 2;
  });
}
