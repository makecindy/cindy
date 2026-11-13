import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// node:test has no default timeout. These tests start subprocesses or use real temporary
// files; an explicit bound turns a stuck child or lock into a failure, not a stalled gate.
const TEST_TIMEOUT_MS = 120_000;

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const hostDir = path.dirname(srcDir);


test('the boot step removes the same keys as Desktop and keeps the import source directory', { timeout: TEST_TIMEOUT_MS }, () => {
  const probe = `
    const { localImportClaudeConfigDirectory } = await import('../desktop/src/main/provider-import/local/sourceEnvironment.js');
    await import('./src/boot-env.ts');
    process.stdout.write(JSON.stringify({
      key: process.env.ANTHROPIC_API_KEY ?? null,
      baseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
      configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
      importDir: localImportClaudeConfigDirectory() ?? null,
      unrelated: process.env.CINDY_BOOT_ENV_PROBE ?? null,
    }));`;
  const out = execFileSync(process.execPath, ['--import', 'tsx', '--import', './src/loaders/register-raw.mjs',
    '--input-type=module', '-e', probe], {
    cwd: hostDir,
    env: { ...process.env,
      ANTHROPIC_API_KEY: 'fixture-shell-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/fixture',
      CLAUDE_CONFIG_DIR: '/fixture/claude-home',
      CINDY_BOOT_ENV_PROBE: 'kept' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.deepEqual(JSON.parse(out), {
    key: null, baseUrl: null, configDir: null, importDir: '/fixture/claude-home', unrelated: 'kept',
  });
});
