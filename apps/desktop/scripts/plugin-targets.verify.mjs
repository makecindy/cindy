import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-plugin-targets-'));
try {
  // Integration: direct Node calls miss cross-world changes to Error properties and identity.
  // The minimum failing input is a coded Host rejection crossing the logic-page preload.
  await build({
    entryPoints: [fileURLToPath(new URL('../src/preload/ghostPreload.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'cjs', minify: true, external: ['electron'], outfile: path.join(root, 'preload.cjs'),
  });
  const main = path.join(root, 'verify.cjs');
  await writeFile(main, `
    const assert = require('node:assert/strict');
    const path = require('node:path');
    const { app, BrowserWindow, ipcMain } = require('electron');
    app.setPath('userData', path.join(__dirname, 'profile'));
    app.disableHardwareAcceleration();
    void app.whenReady().then(async () => {
      const target = { kind: 'task', id: 'fixture' };
      const receipt = { taskId: target.id, accepted: true, delivery: 'queue' };
      ipcMain.handle('ghost-pipe:send', (_event, request) => {
        assert.equal(request.type, 'targets-request');
        assert.deepEqual(request.target, target);
        if (request.kind === 'resolve') return { ok: false, error: { code: 'TARGET_UNAVAILABLE', message: 'Original task unavailable' } };
        assert.equal(request.kind, 'send');
        if (request.requestKey === 'accepted') return { ok: true, data: receipt };
        if (request.requestKey === 'transport-error') throw new Error('Fixture transport rejected');
        assert.ok(['busy', 'uncertain'].includes(request.requestKey), 'unexpected request key');
        const code = request.requestKey === 'busy' ? 'TASK_BUSY' : 'DELIVERY_UNCERTAIN';
        return { ok: false, error: { code, message: code } };
      });
      const win = new BrowserWindow({ show: false, webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
      } });
      await win.loadURL('data:text/html,' + encodeURIComponent(\`<meta http-equiv="Content-Security-Policy" content="default-src 'self'"><title>Target delivery verification</title>\`));
      const fromPage = (kind, requestKey) => win.webContents.executeJavaScript(
        'cindy.targets[' + JSON.stringify(kind) + '](' + JSON.stringify({ target, requestKey, text: 'fixture', delivery: 'queue' }) + ')' +
        '.then(value => ({ ok: true, value }), error => ({ ok: false, code: error.code, message: error.message, nativeError: error instanceof Error, display: String(error) }))');
      assert.deepEqual(await fromPage('resolve'), {
        ok: false, code: 'TARGET_UNAVAILABLE', message: 'Original task unavailable', nativeError: true, display: 'Error: Original task unavailable',
      });
      for (const [key, code] of [['busy', 'TASK_BUSY'], ['uncertain', 'DELIVERY_UNCERTAIN']])
        assert.deepEqual(await fromPage('send', key), { ok: false, code, message: code, nativeError: true, display: 'Error: ' + code });
      assert.deepEqual(await fromPage('send', 'accepted'), { ok: true, value: receipt });
      const transport = await fromPage('send', 'transport-error');
      assert.equal(transport.ok, false);
      assert.equal(transport.nativeError, true);
      assert.equal(transport.code, undefined);
      assert.match(transport.message, /Fixture transport rejected/);
      console.log('PLUGIN_TARGETS_VERDICT=passed (Electron ' + process.versions.electron + '; production logic-page preload; controlled IPC replies; 5 cases)');
      app.exit(0);
    }).catch(error => { console.error(error); app.exit(1); });
  `);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const { stdout } = await promisify(execFile)(require('electron'), [main], { env, timeout: 15000, windowsHide: true });
    assert.ok(stdout.includes('PLUGIN_TARGETS_VERDICT=passed'), stdout);
    process.stdout.write(stdout);
  } catch (error) {
    if (!error.stderr) throw error;
    process.stderr.write(error.stderr);
    process.exitCode = 1;
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
