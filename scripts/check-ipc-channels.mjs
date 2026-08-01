#!/usr/bin/env node
/**
 * IPC channel source-of-truth guard.
 *
 * Low-level Electron IPC APIs must receive channel constants from
 * @cindy/cindy-ipc, not string literals at call sites. This script checks the
 * first argument of ipcMain/ipcRenderer/webContents.send style calls.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOTS = Object.freeze([
  'apps/desktop/src',
  'packages/device-link/src',
]);
const ALLOW_COMMENT = 'ipc-channel-literal-ok';

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, out);
      continue;
    }
    if (/\.tsx?$/.test(entry.name)) out.push(fullPath);
  }
  return out;
}

function isLowLevelIpcCall(call, sourceFile) {
  const expression = call.expression;
  if (!ts.isPropertyAccessExpression(expression)) return false;

  const method = expression.name.text;
  const receiver = expression.expression.getText(sourceFile);

  if (receiver === 'ipcMain' && ['handle', 'handleOnce', 'on', 'once'].includes(method)) {
    return true;
  }
  if (
    receiver === 'ipcRenderer' &&
    ['invoke', 'send', 'on', 'once', 'sendSync', 'postMessage', 'sendToHost'].includes(method)
  ) {
    return true;
  }
  return method === 'send' && /(^|\.)webContents$|^event\.sender$|^sender$/.test(receiver);
}

function isIpcWrapperCall(call, sourceFile) {
  const expression = call.expression;
  const text = expression.getText(sourceFile);
  return [
    'createIpcFanOut',
    'broadcastToRenderers',
    'tapWindowBroadcast',
  ].includes(text);
}

function hasAllowComment(text, sourceFile, node) {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const lines = text.split(/\r?\n/);
  return [line, line - 1].some((index) => index >= 0 && lines[index]?.includes(ALLOW_COMMENT));
}

function isChannelLikeName(name) {
  return /(^|_)(CHANNEL|CHANNELS)$/.test(name) || /_CHANNEL(S)?_/.test(name);
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

export function collectStringLiterals(node, out = []) {
  const expression = unwrapExpression(node);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    out.push(expression);
    return out;
  }
  if (ts.isObjectLiteralExpression(expression) || ts.isArrayLiteralExpression(expression)) {
    ts.forEachChild(expression, (child) => collectNestedStringLiterals(child, out));
  }
  return out;
}

function collectNestedStringLiterals(node, out) {
  const expression = unwrapExpression(node);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    out.push(expression);
    return;
  }
  ts.forEachChild(expression, (child) => collectNestedStringLiterals(child, out));
}

function isIpcChannelLiteral(value) {
  return value.includes(':') || value.startsWith('__cindy/') || value === 'window-hidden-change';
}

export function checkSourceText(file, text) {
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const errors = [];

  function visit(node) {
    if (ts.isCallExpression(node) && (isLowLevelIpcCall(node, sourceFile) || isIpcWrapperCall(node, sourceFile))) {
      const firstArg = node.arguments[0];
      if (
        firstArg &&
        (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg)) &&
        !hasAllowComment(text, sourceFile, firstArg)
      ) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(firstArg.getStart(sourceFile));
        errors.push({
          line: line + 1,
          column: character + 1,
          call: node.expression.getText(sourceFile),
          channel: firstArg.text,
        });
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isChannelLikeName(node.name.text) && node.initializer) {
      for (const literal of collectStringLiterals(node.initializer)) {
        if (!isIpcChannelLiteral(literal.text)) continue;
        if (hasAllowComment(text, sourceFile, literal)) continue;
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(literal.getStart(sourceFile));
        errors.push({
          line: line + 1,
          column: character + 1,
          call: `const ${node.name.text}`,
          channel: literal.text,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return errors;
}

function checkFile(file) {
  return checkSourceText(file, fs.readFileSync(file, 'utf8'));
}

function main() {
  const failures = [];
  for (const root of SOURCE_ROOTS) {
    for (const file of walk(path.join(REPO_ROOT, root))) {
      const rel = path.relative(REPO_ROOT, file);
      if (rel.startsWith('packages/cindy-ipc/src/')) continue;
      for (const error of checkFile(file)) {
        failures.push(`${rel}:${error.line}:${error.column} ${error.call}(${JSON.stringify(error.channel)}, ...)`);
      }
    }
  }

  if (failures.length > 0) {
    console.error(`IPC channel guard failed (${failures.length}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error('Use @cindy/cindy-ipc constants instead of string channel literals.');
    process.exit(1);
  }

  console.log('ipc channel guard passed');
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main();
