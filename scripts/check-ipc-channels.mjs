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
import { fileURLToPath } from 'node:url';
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

function hasAllowComment(text, sourceFile, node) {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const lines = text.split(/\r?\n/);
  return [line, line - 1].some((index) => index >= 0 && lines[index]?.includes(ALLOW_COMMENT));
}

function checkFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const errors = [];

  function visit(node) {
    if (ts.isCallExpression(node) && isLowLevelIpcCall(node, sourceFile)) {
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
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return errors;
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

main();
