// The Host's boot step for settings files: unreadable user settings are kept, not deleted.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { lifoCleanup } from './test-support/cleanup.mjs';

// node:test has no default timeout. These tests start subprocesses or use real temporary
// files; an explicit bound turns a stuck child or lock into a failure, not a stalled gate.
const TEST_TIMEOUT_MS = 120_000;

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const hostDir = path.dirname(srcDir);


// In a child process, so the process-wide default does not reach the other tests.
const probe = (boot) => `
  ${boot ? "await import('./src/boot-settings.ts');" : ''}
  const { createOverrideSettingsFile } = await import('../desktop/src/main/maker-host/override-settings-file.js');
  const fs = await import('node:fs');
  const file = process.env.CINDY_BOOT_SETTINGS_PROBE_FILE;
  const log = { info() {}, warn() {} };
  const store = createOverrideSettingsFile({ filePath: () => file, defaults: { limit: 5 }, normalize: raw => ({ limit: typeof raw?.limit === 'number' ? raw.limit : 5 }), log, label: 'probe' });
  const value = store.read();
  let write = 'written';
  try { store.writePatch({ limit: 9 }); } catch (error) { write = String(error.message); }
  process.stdout.write(JSON.stringify({ value, kept: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, write }));`;

for (const boot of [true, false]) {
  test(boot ? 'after the boot step an unreadable settings file is kept and not overwritten'
    : 'without the boot step (as on the desktop) it is deleted and then replaced', { timeout: TEST_TIMEOUT_MS }, t => {
      t = lifoCleanup(t);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-boot-settings-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'settings.json');
    const malformed = '{"limit":not-json}';
    fs.writeFileSync(file, malformed);
    const out = execFileSync(process.execPath, ['--import', 'tsx', '--import', './src/loaders/register-raw.mjs',
      '--input-type=module', '-e', probe(boot)], {
      cwd: hostDir, env: { ...process.env, CINDY_BOOT_SETTINGS_PROBE_FILE: file }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(out);
    assert.deepEqual(result.value, { limit: 5 });
    if (boot) {
      assert.equal(result.kept, malformed);
      assert.match(result.write, /unreadable; refusing to overwrite/);
    } else {
      assert.equal(result.write, 'written');
      assert.deepEqual(JSON.parse(result.kept), { limit: 9 });
    }
  });
}
