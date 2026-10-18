import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const repository = process.argv.find(arg => arg.startsWith('--repository='))?.slice('--repository='.length);
const base = repository ? pathToFileURL(repository + '/apps/desktop/scripts/runner.mjs') : import.meta.url;
const require = createRequire(base);
const { app, BrowserWindow } = require('electron');
const ts = createRequire(new URL('../../../package.json', base))('typescript');
const content = fs.readFileSync(new URL('../src/main/cindy-brain/runtime/electronSandboxAdapter.ts', base), 'utf8');
const source = ts.createSourceFile('adapter.ts', content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const owner = source.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'ElectronSandboxHandle');
const destroy = owner?.members.find(n => ts.isMethodDeclaration(n) && n.name.getText(source) === 'destroy');
if (!destroy?.body || source.parseDiagnostics.length) throw new Error('Cannot extract production destroy method');
const ctor = owner.members.find(ts.isConstructorDeclaration);
const statements = ctor?.body?.statements || [];
const compact = n => n.getText(source).replace(/\s+/g, '');
const index = statements.findIndex(n => compact(n) === 'this.webContentsId=this.win.webContents.id;');
assert.ok(index > 0 && compact(statements[index - 1]).startsWith('this.win=newBrowserWindow('), 'constructor must cache the created window ID');
const logicWebContentsToGhost = new Map();
const compiled = ts.transpileModule('class Handle { ' + destroy.getText(source) + ' }', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const Handle = new Function('logicWebContentsToGhost', compiled + '; return Handle;')(logicWebContentsToGhost);
// Do not await whenReady at ESM top level: Electron waits for module evaluation
// before emitting ready. An infrastructure deadline is never a test failure.
setTimeout(() => app.exit(2), 60000).unref();
app.whenReady().then(() => {
const cases = [
  ['normal destroy', false, false],
  ['repeated normal destroy', false, true],
  ['external destroy clears mapping', true, false],
  ['repeated external destroy', true, true],
];
const assertions = [];
for (const [name, external, repeat] of cases) {
  if (process.argv.includes('--normal-only') && external) continue;
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const id = win.webContents.id;
  const handle = Object.assign(new Handle(), { win, destroyed: false, webContentsId: id });
  logicWebContentsToGhost.set(id, 'synthetic-ghost');
  try {
    if (external) win.destroy();
    handle.destroy();
    if (repeat) handle.destroy();
    assert.equal(win.isDestroyed(), true);
    assert.equal(handle.win, null);
    assert.equal(handle.destroyed, true);
    assert.equal(logicWebContentsToGhost.has(id), false);
    assertions.push({ fullName: name, status: 'passed', failureMessages: [] });
  } catch (error) {
    assertions.push({ fullName: name, status: 'failed', failureMessages: [String(error)] });
  } finally {
    if (!win.isDestroyed()) win.destroy();
    logicWebContentsToGhost.clear();
  }
}
const failed = assertions.filter(n => n.status === 'failed').length;
console.log('CINDY_LIFECYCLE_REPORT=' + JSON.stringify({ success: failed === 0, numTotalTests: assertions.length, numFailedTests: failed, numPendingTests: 0, numTodoTests: 0, testResults: [{ message: '', assertionResults: assertions }] }));
app.exit(failed ? 1 : 0);
}).catch(error => { console.error(String(error)); app.exit(2); });
