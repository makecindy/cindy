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
// mtime check: skips rebuild when bundle is newer than every src file +
// build.mjs + package.json (the inputs that affect output). Cold clone runs
// esbuild for both packages (~1-2s total); subsequent runs with no source
// change are sub-100ms (just stat + copy if dest also needs refresh).

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

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

function newestMtime(rootDir, relPaths) {
  let newest = 0;
  for (const rel of relPaths) {
    const abs = join(rootDir, rel);
    if (!existsSync(abs)) continue;
    const st = statSync(abs);
    if (st.isDirectory()) {
      // Recursive walk; readdirSync({recursive:true}) is Node 20+ stable.
      const entries = readdirSync(abs, { recursive: true, withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile()) continue;
        const child = statSync(join(e.parentPath ?? abs, e.name));
        if (child.mtimeMs > newest) newest = child.mtimeMs;
      }
    } else {
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    }
  }
  return newest;
}

function bundleIfStale(target) {
  const bundleAbs = join(target.pkgDir, target.bundleFile);
  const bundleMtime = existsSync(bundleAbs) ? statSync(bundleAbs).mtimeMs : 0;
  // Inputs that affect bundle output: all .ts under src/, build.mjs,
  // package.json (deps could change). pnpm-lock.yaml is at monorepo root —
  // skipping it intentionally; an esbuild bump would touch package.json
  // either way via devDependencies.
  const srcMtime = newestMtime(target.pkgDir, ['src', 'build.mjs', 'package.json']);
  if (bundleMtime >= srcMtime && bundleMtime > 0) {
    return false; // up-to-date
  }
  console.log(`[remote-bundles] ${target.pkgName}: bundling (src newer than dist)...`);
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
  return true;
}

function stageToResources(target) {
  const bundleAbs = join(target.pkgDir, target.bundleFile);
  if (!existsSync(bundleAbs)) {
    console.error(`[remote-bundles] ${target.pkgName}: bundle missing at ${bundleAbs}`);
    process.exit(1);
  }
  const destAbs = join(target.destDir, target.destFile);
  // mtime check on the staged copy too — skip copy when dest is fresh.
  // Avoids touching the file every build, which would invalidate forge
  // content-addressed caches if any.
  const srcMtime = statSync(bundleAbs).mtimeMs;
  const destMtime = existsSync(destAbs) ? statSync(destAbs).mtimeMs : 0;
  if (destMtime >= srcMtime && destMtime > 0) {
    return false;
  }
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
