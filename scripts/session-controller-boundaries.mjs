import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(repo, 'apps/desktop/src');
const manifestPath = path.join(repo, 'docs/dev-rules/session-controller-ports.json');
const writes = new Set(['openSession', 'patchSessionMetaInDb', 'updateSessionInDb', 'setSessionsStatusInDb', 'renameSessionTitlesInDb', 'createSessionControlService', 'createSessionPermissionChange', 'getMaker', 'getMakerIfReady']);
const native = new Set(['createSession', 'closeSession', 'abort', 'requestStop', 'setModel', 'setPermissionMode', 'send', 'steer', 'compact', 'navigateSessionTree', 'setEffort', 'setFastMode', 'setThinkingEnabled', 'setPlanMode', 'setExtraDirs', 'setVendorOptions', 'closeIfIdle', 'close']);
const nativeModule = /sessionOpening|sessionControlService|localDb\/ipc\/sessions|\.\/sessions|maker-host(?:\/index)?(?:\.js)?$/;
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.name === '__tests__' || e.name === 'node_modules') return [];
    return e.isDirectory() ? files(p) : /\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\./.test(e.name) ? [p] : [];
  });
}
function owner(node, source) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
    if ((ts.isMethodDeclaration(n) || ts.isPropertyAssignment(n) || ts.isVariableDeclaration(n)) && n.name &&
      (ts.isMethodDeclaration(n) || n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)))) return n.name.getText(source);
  }
  return '<module>';
}
export function inspectSessionBoundaries(source, file) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const hits = new Map();
  const aliases = new Map();
  const add = (kind, symbol, node) => {
    const key = JSON.stringify([file, kind, owner(node, tree), symbol]);
    hits.set(key, (hits.get(key) ?? 0) + 1);
  };
  function visit(node) {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      const specifier = node.moduleSpecifier.text;
      if (nativeModule.test(specifier)) {
        for (const item of node.importClause.namedBindings.elements) {
          const name = (item.propertyName ?? item.name).text;
          if (writes.has(name) && !item.isTypeOnly && !node.importClause.isTypeOnly) {
            aliases.set(item.name.text, name);
            add('import', `${specifier}:${name}`, node);
          }
        }
      }
    }
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings)
      && !node.importClause.isTypeOnly && nativeModule.test(node.moduleSpecifier.text)) add('import', `${node.moduleSpecifier.text}:*`, node);
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])
        && nativeModule.test(node.arguments[0].text)) add('import', `${node.arguments[0].text}:dynamic`, node);
      if (file.includes('/main/') && ts.isIdentifier(expression)) {
        const name = aliases.get(expression.text) ?? expression.text;
        if (writes.has(name) && !['getMaker', 'getMakerIfReady'].includes(name)) add('write', name, node);
      }
      if (file.includes('/main/') && ts.isPropertyAccessExpression(expression) && native.has(expression.name.text)) {
        const receiver = expression.expression.getText(tree);
        // Existing native handles and injected native ports, including this.deps.
        // HTTP clients, sockets and controller facades are different interfaces.
        if (!/Abort|abortController|RealtimeSession|window\.electronAPI/.test(receiver) && /(?:^|\.)(?:maker|session|sess|runtime|liveSession|makerSession|expectedSession|leadSess|liveAfterModel|liveBeforePick|liveForRollback|[a-zA-Z_$]*Session|[a-zA-Z_$]*Runtime|current|live|s)(?:\?|$)|getMaker\(|getSession\(/.test(receiver)) add('native', expression.getText(tree), node);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return hits;
}
export function collectSessionBoundaries() {
  const found = new Map();
  for (const f of files(root)) {
    const rel = path.relative(repo, f).replaceAll(path.sep, '/');
    // The sole native core is allowed to implement ports, not callers outside it.
    if (rel.startsWith('apps/desktop/src/main/session-controller/')) continue;
    for (const entry of inspectSessionBoundaries(fs.readFileSync(f, 'utf8'), rel)) found.set(...entry);
  }
  return found;
}
export function verifySessionBoundaries(found, registrations) {
  const problems = [];
  const expected = new Map(registrations.map(x => [JSON.stringify([x.file, x.kind, x.owner, x.symbol]), x]));
  for (const [key, count] of found) {
    const row = expected.get(key);
    if (!row || row.count !== count) problems.push(`Unregistered Session write/import: ${key} (count ${count})`);
  }
  for (const [key, row] of expected) {
    if (!found.has(key)) problems.push(`Remove stale Session port registration: ${key}`);
    if (!row.responsibility || !row.reason || !row.path || !row.exit) problems.push(`Incomplete Session port ownership: ${key}`);
  }
  return problems;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const found = collectSessionBoundaries();
  if (process.argv.includes('--inventory')) {
    process.stdout.write(JSON.stringify([...found].map(([key, count]) => {
      const [file, kind, owner, symbol] = JSON.parse(key); return { file, kind, owner, symbol, count };
    }), null, 2) + '\n');
  } else {
    const errors = verifySessionBoundaries(found, JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    if (errors.length) { process.stderr.write(errors.join('\n') + '\n'); process.exitCode = 1; }
    else process.stdout.write(`Session boundaries: ${found.size} exact implementation ports; no unregistered callers.\n`);
  }
}
