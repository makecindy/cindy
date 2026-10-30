// Explicit Electron regression: node apps/desktop/scripts/test-worktree-recovery-asar.mjs
// Uses only synthetic temp fixtures; never starts Cindy or reads its profile/keychain.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire, builtinModules } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'vite';
import { createPackage } from '@electron/asar';

const require = createRequire(import.meta.url);
const desktop = fileURLToPath(new URL('..', import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-asar-recovery-'));
try {
  const bundle = path.join(root, 'bundle');
  const contents = path.join(root, 'contents');
  const source = path.join(root, 'source');
  await fs.mkdir(bundle);
  await fs.mkdir(contents);
  await fs.mkdir(source);
  await fs.writeFile(path.join(contents, 'inside.txt'), 'physical ASAR fixture');
  await createPackage(contents, path.join(source, 'app.asar'));
  await fs.chmod(path.join(source, 'app.asar'), 0o644);
  await fs.mkdir(path.join(source, 'app.asar.unpacked'));
  await fs.writeFile(path.join(source, 'app.asar.unpacked', 'native.node'), 'unpacked fixture');
  await fs.writeFile(path.join(source, '.env'), 'synthetic ignored fixture');
  await fs.writeFile(path.join(source, '.git'), 'excluded Git admin pointer');
  for (const [entry, name] of [
    ['recoveryArchiveWorker', 'recoveryArchiveWorker.js'],
    ['recoveryArchiveWorkerClient', 'client.cjs'],
    ['recoveryArchiveIO', 'io.cjs'],
  ]) {
    await build({
      configFile: path.join(desktop, 'vite.recovery-archive-worker.config.ts'),
      logLevel: 'error',
      build: {
        outDir: bundle, emptyOutDir: false, minify: false,
        lib: { entry: path.join(desktop, `src/main/worktree/${entry}.ts`), formats: ['cjs'], fileName: () => name },
        rollupOptions: { external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)] },
      },
    });
  }
  await fs.copyFile(path.join(desktop, 'scripts/fixtures/worktree-recovery-asar.cjs'), path.join(bundle, 'main.cjs'));
  await fs.writeFile(path.join(bundle, 'package.json'), JSON.stringify({ main: 'main.cjs' }));
  const packaged = path.join(root, 'app.asar');
  await createPackage(bundle, packaged);
  const env = { ...process.env, CINDY_RECOVERY_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await promisify(execFile)(require('electron'), [packaged], { env, timeout: 60_000 });
  assert.match(result.stdout, /PASS:/);
  process.stdout.write(result.stdout);
} finally { await fs.rm(root, { recursive: true, force: true }); }
