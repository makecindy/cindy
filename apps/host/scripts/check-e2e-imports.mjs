#!/usr/bin/env node
// Load-only check of the acceptance scripts in this directory (CI: Host regressions).
//
// Most *.e2e.mjs scripts are not run in CI (native engines, browsers, long runs), so nothing
// noticed when scheduler-runtime.e2e.mjs stopped loading: a shared desktop module it reaches
// started importing Electron. This loads every module each script imports, statically or by a
// literal dynamic import(), through the loaders the scripts use, without running the script
// bodies. An Electron import fails with the chain of importers (electron-import-guard.mjs).
//
// Each script loads in its own process, with HOME, USERPROFILE and the temporary directory in a
// new empty directory; no account, credential, engine, browser or network is involved.
// usage: node scripts/check-e2e-imports.mjs   (from apps/host)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const hostDir = path.dirname(scriptsDir);

/** Scripts that are known not to load yet. Each entry says why; remove it once fixed. */
const KNOWN_LOAD_FAILURES = {
  'scheduler-runtime.e2e.mjs': 'Since main 41ed3b9f40 the desktop scheduler runner reaches electron through '
    + 'im/shared/turnRetryNotice.ts -> im/shared/imText.ts -> i18n.desktop.ts '
    + '(docs/host/personal-migration-release-table.md, row 乙 1).',
};

if (process.argv[2] === '--load') {
  // Child: load the given specifiers as the script would (this file sits in the same directory,
  // so relative and package specifiers resolve exactly as they do from the script).
  register('./electron-import-guard.mjs', import.meta.url);
  try {
    for (const specifier of process.argv.slice(4)) await import(specifier);
  } catch (error) {
    // Report and exit here: a production logger loaded above may hold an uncaught-exception listener.
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  }
  // Module top-level code may leave handles open; loading is all this child checks.
  process.exit(0);
}

const { build } = await import('esbuild');

/** The specifiers a script imports itself: static imports, re-exports and literal import(). */
async function importsOf(file) {
  const found = [];
  await build({
    entryPoints: [file], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
    plugins: [{
      name: 'collect-entry-imports',
      setup(b) {
        b.onResolve({ filter: /.*/ }, (args) => {
          if (args.kind === 'entry-point') return undefined;
          if (path.resolve(args.importer) === path.resolve(file) && (args.kind === 'import-statement' || args.kind === 'dynamic-import')) {
            found.push(args.path);
          }
          return { path: args.path, external: true };
        });
      },
    }],
  });
  return [...new Set(found)];
}

const scripts = fs.readdirSync(scriptsDir).filter((name) => name.endsWith('.e2e.mjs')).sort();
const stale = Object.keys(KNOWN_LOAD_FAILURES).filter((name) => !scripts.includes(name));
let failed = stale.length > 0;
for (const name of stale) console.error(`FAIL ${name}: listed as a known load failure but the script no longer exists`);

for (const name of scripts) {
  const file = path.join(scriptsDir, name);
  const known = KNOWN_LOAD_FAILURES[name];
  if (known) {
    console.log(`SKIP ${name}: known load failure, remove it from KNOWN_LOAD_FAILURES once it loads. ${known}`);
    continue;
  }
  const specifiers = await importsOf(file);
  if (specifiers.length === 0) {
    // Every script imports something; none found means the collection itself broke.
    failed = true;
    console.error(`FAIL ${name}: no imports found; the import collection did not see this script`);
    continue;
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-e2e-imports-'));
  const started = Date.now();
  const env = { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: home, TEMP: home, TMP: home,
    ELECTRON_SKIP_BINARY_DOWNLOAD: '1' };
  delete env.XDT_OFFICIAL_SHARED_PROFILE;
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', '--import', './src/loaders/register-raw.mjs',
    fileURLToPath(import.meta.url), '--load', name, ...specifiers,
  ], { cwd: hostDir, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  fs.rmSync(home, { recursive: true, force: true });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status === 0) {
    console.log(`PASS ${name}: ${specifiers.length} imports loaded (${seconds}s)`);
    continue;
  }
  failed = true;
  const output = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
  const reason = result.error ? result.error.message : `exit ${result.status ?? result.signal}`;
  console.error(`FAIL ${name}: ${reason} (${seconds}s)\n${output.split('\n').slice(0, 40).join('\n')}`);
}

process.exitCode = failed ? 1 : 0;
