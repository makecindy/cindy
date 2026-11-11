// Explicit Electron regression: node apps/desktop/scripts/test-cindy-make-cleanup-asar.mjs
// Synthetic temp fixtures only; never opens Cindy or a user profile.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { builtinModules, createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPackage } from '@electron/asar';
import { build } from 'vite';

const require = createRequire(import.meta.url);
const desktop = fileURLToPath(new URL('..', import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-make-cleanup-asar-'));
try {
  const contents = path.join(root, 'contents');
  const archive = path.join(root, 'fixture.asar');
  await fs.mkdir(contents);
  await fs.writeFile(path.join(contents, 'inside.txt'), 'physical ASAR fixture');
  await createPackage(contents, archive);
  await fs.chmod(archive, 0o644);
  const entry = path.join(root, 'entry.mjs');
  const modulePath = (name) => JSON.stringify(path.join(desktop, 'src/main/cindy-make', name));
  await fs.writeFile(
    entry,
    `
export { manageCindyMakeWorkspace } from ${modulePath('taskCleanup.ts')};
export { makeSourceCheckoutPath, makeTaskWorktreePath, makeTaskBranch } from ${modulePath('sourcePaths.ts')};
`,
  );
  await build({
    configFile: false,
    logLevel: 'error',
    build: {
      outDir: path.join(root, 'bundle'),
      minify: false,
      lib: { entry, formats: ['cjs'], fileName: () => 'cleanup.cjs' },
      rollupOptions: {
        external: [
          'original-fs',
          ...builtinModules,
          ...builtinModules.map((name) => `node:${name}`),
        ],
      },
    },
  });
  const probe = path.join(root, 'probe.cjs');
  await fs.writeFile(
    probe,
    String.raw`
const assert = require('node:assert/strict');
const fs = require('original-fs').promises;
const patchedFs = require('node:fs').promises;
const path = require('node:path');
const { app } = require('electron');
const { manageCindyMakeWorkspace, makeSourceCheckoutPath, makeTaskWorktreePath, makeTaskBranch } = require('./bundle/cleanup.cjs');
const root = ${JSON.stringify(root)};
const archive = path.join(root, 'fixture.asar');
(async () => {
  // Prove this is Electron's ASAR-aware runtime, not the Node unit-test alias.
  assert.equal((await patchedFs.lstat(archive)).isDirectory(), true);
  assert.equal((await fs.lstat(archive)).isFile(), true);
  for (const action of ['end', 'delete']) {
    const profile = path.join(root, action);
    const source = makeSourceCheckoutPath(profile);
    const target = makeTaskWorktreePath(profile, 'run');
    const branch = makeTaskBranch('run');
    const resources = path.join(target, 'node_modules/electron/dist/resources');
    await fs.mkdir(path.join(source, '.git'), { recursive: true });
    await fs.mkdir(resources, { recursive: true });
    await fs.copyFile(archive, path.join(resources, 'default_app.asar'));
    let branchExists = true;
    const git = async (_env, args) => {
      if (args[0] === 'branch' && args[1] === '--list') return branchExists ? branch : '';
      if (args[0] === 'worktree' && args[1] === 'list')
        return 'worktree ' + source + '\0branch refs/heads/cindy-personal\0\0';
      if (args[0] === 'update-ref') return '';
      if (args[0] === 'branch' && args[1] === '-D') {
        // Never drop the last branch before physical removal succeeds.
        await assert.rejects(fs.access(target), { code: 'ENOENT' });
        branchExists = false;
        return '';
      }
      throw new Error('Unexpected Git operation: ' + args.join(' '));
    };
    assert.equal(await manageCindyMakeWorkspace(profile, 'run', action, {}, AbortSignal.timeout(5000), {
      git, preparedWorkspace: { path: target, branch },
    }), true);
    await assert.rejects(fs.access(target), { code: 'ENOENT' });
    assert.equal(branchExists, false);
  }
  process.stdout.write('PASS: end/delete remove physical ASAR residue before deleting branches\n');
  app.exit(0);
})().catch((error) => { console.error(error); app.exit(1); });
`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await promisify(execFile)(require('electron'), [probe], {
    env,
    timeout: 30_000,
    windowsHide: true,
  });
  assert.match(result.stdout, /PASS:/);
  process.stdout.write(result.stdout);
} finally {
  // The child must exit first so even its ASAR diagnostic handle is released.
  await fs.rm(root, { recursive: true, force: true });
}
