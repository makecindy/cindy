// Build + stage cc-remote daemon bundles into apps/desktop/resources/<pkg>/
// so Electron Forge picks them up via packagerConfig.extraResource at release
// time. These bundles are deployed to remote SSH machines (cc-mgr.mjs daemon
// + anthropic-compat-proxy proxy.mjs) — they live OUTSIDE app.asar because
// they're scp'd to a remote host, not require()'d locally.
//
// Hooked at predev / predev:remote / prepackage / prebuild (see package.json).
// External release pipelines should also invoke this once before
// `electron-forge make` — `npx electron-forge make` does NOT trigger npm
// pre hooks, so without an explicit call there release builds
// would ship without the bundles.
//
// Cache by input paths/content and output content. Missing receipts rebuild once;
// deleting an input or restoring old timestamps cannot leave a stale bundle cached.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { bundleInputDigest, bundleInputsMatch, recordBundleInputs } from './remote-bundle-inputs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = resolve(here, '..');
const MONOREPO_ROOT = resolve(DESKTOP_ROOT, '..', '..');

// Each target: where the package lives, its esbuild output, and where forge
// expects to find it relative to apps/desktop/.
const TARGETS = [
  {
    pkgName: '@cindy/maker-cc-manager',
    pkgDir: resolve(MONOREPO_ROOT, 'packages', 'maker-cc-manager'),
    bundleFile: 'dist/cc-mgr.mjs',
    destDir: resolve(DESKTOP_ROOT, 'resources', 'cc-manager'),
    destFile: 'cc-mgr.mjs',
  },
  {
    pkgName: '@cindy/anthropic-compat-proxy',
    dependencyDirs: [resolve(MONOREPO_ROOT, 'packages', 'model-compat')],
    pkgDir: resolve(MONOREPO_ROOT, 'packages', 'anthropic-compat-proxy'),
    bundleFile: 'dist/proxy.mjs',
    destDir: resolve(DESKTOP_ROOT, 'resources', 'anthropic-compat-proxy'),
    destFile: 'proxy.mjs',
  },
  {
    pkgName: '@cindy/remote-file-service',
    pkgDir: resolve(MONOREPO_ROOT, 'packages', 'remote-file-service'),
    bundleFile: 'dist/file-service.mjs',
    destDir: resolve(DESKTOP_ROOT, 'resources', 'remote-file-service'),
    destFile: 'file-service.mjs',
  },
  {
    pkgName: '@cindy/maker-pi-manager',
    pkgDir: resolve(MONOREPO_ROOT, 'packages', 'maker-pi-manager'),
    bundleFile: 'dist/pi-manager.mjs',
    destDir: resolve(DESKTOP_ROOT, 'resources', 'pi-manager'),
    destFile: 'pi-manager.mjs',
  },
];

function bundleIfStale(target) {
  const bundleAbs = join(target.pkgDir, target.bundleFile);
  const inputDigest = bundleInputDigest(target.pkgDir, target.dependencyDirs);
  if (bundleInputsMatch(bundleAbs, inputDigest)) return false;
  console.log(`[remote-bundles] ${target.pkgName}: bundling (inputs or output changed)...`);
  // 直接 spawn 当前 node + 包的 build.mjs, 不走 pnpm 包装层:
  //  1. 跨平台干净 — pnpm 在 Windows 是 pnpm.cmd, fnm shim 又只暴露 pnpm 无后缀,
  //     spawn 时 EINVAL / not found 各种坑; 用 process.execPath 永远是当前 node
  //     绝对路径, 跨 OS / 跨 shell / 跨 node-version-manager 100% 可靠。
  //  2. 性能更好 — 跳过 pnpm cold-start (~200ms) 直接进 esbuild。
  //  3. 语义对等 — 两个包的 `pnpm bundle` 就是 `node build.mjs` (一字不差),
  //     不需要 pnpm 做 workspace 解析 / hoist 之类。
  const r = spawnSync(process.execPath, ['build.mjs'], {
    cwd: target.pkgDir,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error(
      `[remote-bundles] ${target.pkgName}: bundle failed (exit ${r.status}` +
        (r.error ? `, error: ${r.error.message}` : '') +
        `)`,
    );
    process.exit(r.status ?? 1);
  }
  recordBundleInputs(bundleAbs, inputDigest);
  return true;
}

function stageToResources(target) {
  const bundleAbs = join(target.pkgDir, target.bundleFile);
  if (!existsSync(bundleAbs)) {
    console.error(`[remote-bundles] ${target.pkgName}: bundle missing at ${bundleAbs}`);
    process.exit(1);
  }
  const destAbs = join(target.destDir, target.destFile);
  // Compare content too: a destination with a future mtime may still contain old code.
  if (existsSync(destAbs) && readFileSync(destAbs).equals(readFileSync(bundleAbs))) return false;
  mkdirSync(target.destDir, { recursive: true });
  copyFileSync(bundleAbs, destAbs);
  console.log(`[remote-bundles] ${target.pkgName}: staged → ${destAbs}`);
  return true;
}

let anyChange = false;
for (const target of TARGETS) {
  const bundled = bundleIfStale(target);
  const staged = stageToResources(target);
  if (bundled || staged) anyChange = true;
}
if (!anyChange) {
  console.log('[remote-bundles] all bundles up-to-date');
}
