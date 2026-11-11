/** Build a relocatable, platform-specific Host from this checkout's locked inputs.
 * No install scripts, network downloads, profile reads or global application writes.
 */
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const host = path.join(repo, 'apps/host');
const desktop = path.join(repo, 'apps/desktop');
const { values } = parseArgs({ options: {
  output: { type: 'string' }, 'web-dir': { type: 'string' },
} });
if (!values.output) throw new Error('Usage: pnpm --filter @cindy/host build --output <new-directory> [--web-dir <renderer-build>]');
const output = path.resolve(values.output);
if (syncFs.existsSync(output)) throw new Error(`Output already exists; choose a new directory: ${output}`);
await fs.mkdir(path.dirname(output), { recursive: true });
const staging = await fs.mkdtemp(path.join(path.dirname(output), '.cindy-host-build-'));
const hostRequire = createRequire(path.join(host, 'package.json'));
const desktopRequire = createRequire(path.join(desktop, 'package.json'));
const platformKey = `${process.platform}-${process.arch}`;
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const packageName = specifier => specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
const packages = new Map();
const copying = new Map();
const dependencyRecords = new Map();
// This package deliberately uses createRequire for runtime implementations.
// Keep its package boundary so its pinned undici version cannot be replaced by
// a different workspace's version when everything is flattened into one file.
const separateWorkspaces = new Set(['@cindy/browser-control-runtime']);

function packageRoot(name, require, specifier = name) {
  // Some ESM packages export only named subpaths and hide package.json. Locate
  // their installed manifest through Node's search paths without importing it.
  for (const parent of require.resolve.paths(name) ?? []) {
    const candidate = path.join(parent, name, 'package.json');
    if (syncFs.existsSync(candidate)) return path.dirname(syncFs.realpathSync(candidate));
  }
  let resolved;
  try { resolved = require.resolve(`${name}/package.json`); }
  catch { resolved = require.resolve(specifier); }
  let dir = path.dirname(syncFs.realpathSync(resolved));
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (syncFs.existsSync(manifest) && JSON.parse(syncFs.readFileSync(manifest, 'utf8')).name === name) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Cannot locate runtime package ${name}`);
    dir = parent;
  }
}

// Preserve the lockfile's actual dependency graph. Nested versions stay nested,
// cycles resolve through their ancestor, and the artifact has no checkout links.
async function copyPackage(source, parent, ancestors = new Map()) {
  const manifest = await readJson(path.join(source, 'package.json'));
  if (ancestors.get(manifest.name) === source) return;
  const destination = path.join(parent, 'node_modules', manifest.name);
  if (copying.has(destination)) {
    if (copying.get(destination) !== source) throw new Error(`Conflicting runtime dependency at ${destination}`);
    return;
  }
  copying.set(destination, source);
  if (separateWorkspaces.has(manifest.name)) {
    const entries = {};
    const exports = {};
    for (const [key, value] of Object.entries(manifest.exports)) {
      if (typeof value !== 'string') throw new Error(`Unsupported Host workspace export: ${manifest.name} ${key}`);
      const entry = key === '.' ? 'index' : key.slice(2);
      entries[entry] = path.resolve(source, value);
      exports[key] = `./dist/${entry}.js`;
    }
    await fs.mkdir(destination, { recursive: true });
    await build({ entryPoints: entries, outdir: path.join(destination, 'dist'), bundle: true,
      splitting: true, format: 'esm', platform: 'node', target: 'node22',
      plugins: createNodePlugins(new Map()),
      banner: { js: 'import { createRequire as hostCreateRequire } from "node:module"; const require = hostCreateRequire(import.meta.url);' },
    });
    await fs.writeFile(path.join(destination, 'package.json'), JSON.stringify({ ...manifest,
      exports, main: './dist/index.js', scripts: undefined, devDependencies: undefined,
    }, null, 2) + '\n');
    for (const name of ['LICENSE', 'NOTICE']) {
      if (syncFs.existsSync(path.join(source, name))) await fs.copyFile(path.join(source, name), path.join(destination, name));
    }
  } else {
    await fs.cp(source, destination, { recursive: true, dereference: true,
      filter: file => file !== path.join(source, 'node_modules'),
    });
  }
  dependencyRecords.set(path.relative(staging, destination), { name: manifest.name, version: manifest.version });
  const nextAncestors = new Map(ancestors).set(manifest.name, source);
  const require = createRequire(path.join(source, 'package.json'));
  const required = new Set(Object.keys(manifest.dependencies ?? {}));
  const optional = new Set(Object.keys(manifest.optionalDependencies ?? {}));
  const peers = new Set(Object.keys(manifest.peerDependencies ?? {}));
  for (const name of new Set([...required, ...optional, ...peers])) {
    let dependency;
    try { dependency = packageRoot(name, require); }
    catch (error) {
      if (optional.has(name) || (peers.has(name) && manifest.peerDependenciesMeta?.[name]?.optional)) continue;
      throw new Error(`Missing locked dependency ${manifest.name} -> ${name}`, { cause: error });
    }
    const target = await readJson(path.join(dependency, 'package.json'));
    const matches = (list, value) => !Array.isArray(list) || (
      !list.includes(`!${value}`) && (!list.some(item => !item.startsWith('!')) || list.includes(value))
    );
    if (!matches(target.os, process.platform) || !matches(target.cpu, process.arch)) {
      if (optional.has(name)) continue;
      throw new Error(`Required runtime dependency does not support ${platformKey}: ${name}`);
    }
    await copyPackage(dependency, destination, nextAncestors);
  }
}

function createNodePlugins(dependencies) { return [
  { name: 'runtime-dependencies', setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, args => {
      // Raw browser assets must be resolved and embedded at build time, never
      // externalized as a Node package subpath containing Vite's query suffix.
      if (args.path.endsWith('?raw') || args.pluginData?.hostRawAsset) return;
      if (isBuiltin(args.path)) return { path: args.path, external: true };
      if (args.path === 'electron' || args.path.startsWith('electron/')) {
        throw new Error(`Node runtime imports Electron: ${path.relative(repo, args.importer)}`);
      }
      const name = packageName(args.path);
      if ((args.path.startsWith('@cindy/') && !separateWorkspaces.has(name)) || args.path.startsWith('#')) return;
      // Source-only development path; installed servers read the bundled shim.
      if (name === 'esbuild') return { path: args.path, external: true };
      const source = packageRoot(name, createRequire(args.importer || path.join(host, 'package.json')), args.path);
      if (!separateWorkspaces.has(name) && source.startsWith(path.join(repo, 'packages') + path.sep)
          && !source.split(path.sep).includes('node_modules')) return;
      if (dependencies.has(name) && dependencies.get(name) !== source) throw new Error(`Multiple entry versions of ${name}`);
      dependencies.set(name, source);
      return { path: args.path, external: true };
    });
  } },
  { name: 'raw-assets', setup(builder) {
    builder.onResolve({ filter: /\?raw$/ }, async args => {
      const bare = args.path.slice(0, -4);
      const resolved = bare.startsWith('.') || path.isAbsolute(bare)
        ? { path: path.resolve(args.resolveDir, bare) }
        : await builder.resolve(bare, { resolveDir: args.resolveDir, kind: args.kind,
          pluginData: { hostRawAsset: true } });
      return { ...resolved, namespace: 'raw' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'raw' }, async args => ({ contents: await fs.readFile(args.path, 'utf8'), loader: 'text' }));
  } },
]; }
const nodePlugins = createNodePlugins(packages);

try {
  const web = values['web-dir'] ? path.resolve(values['web-dir']) : path.join(desktop, '.vite/renderer/main_window');
  await fs.access(path.join(web, 'index.html'));
  const metadata = {
    version: (await readJson(path.join(desktop, 'package.json'))).version,
    platform: process.platform, arch: process.arch, modules: process.versions.modules,
    nodeVersion: process.versions.node,
  };
  const resources = path.join(staging, 'resources');
  const bin = path.join(staging, 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(resources);
  await fs.cp(web, path.join(resources, 'web'), { recursive: true, dereference: true });
  await fs.cp(path.join(desktop, 'drizzle'), path.join(resources, 'drizzle'), {
    recursive: true, filter: file => !/[/\\]meta[/\\]\d+_snapshot\.json$/.test(file),
  });
  // Migration companion scripts remain byte-for-byte identical CommonJS, even
  // with .ts extensions. This must not change their frozen runtime hashes.
  await fs.mkdir(path.join(resources, 'config'));
  for (const file of ['endpoint.json', 'endpoint.global.json']) {
    await fs.copyFile(path.join(repo, 'config', file), path.join(resources, 'config', file));
  }
  const vec = process.platform === 'win32' ? 'vec0.dll' : process.platform === 'darwin' ? 'vec0.dylib' : 'vec0.so';
  await fs.mkdir(path.join(resources, 'native'));
  await fs.copyFile(path.join(desktop, 'native', 'sqlite-vec', platformKey, vec), path.join(resources, 'native', vec));

  // Copy the verified checkout runtimes with their own support files. A missing
  // harness is a build error, never a release claiming an unavailable agent.
  for (const name of ['claude-code-bin', 'codex-package-bin', 'pi-bin', 'ripgrep-bin']) {
    await fs.cp(path.join(repo, 'apps', name, platformKey), path.join(resources, 'harnesses', name, platformKey), {
      recursive: true, dereference: true,
    });
  }
  if (process.platform === 'win32') {
    const target = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : process.arch === 'x64' ? 'x86_64-pc-windows-msvc' : null;
    if (!target) throw new Error(`Unsupported Windows atomic rename architecture: ${process.arch}`);
    const rustc = path.join(os.homedir(), '.cargo', 'bin', 'rustc.exe');
    const helperRoot = path.join(resources, 'tools', 'windows-atomic-rename');
    await fs.mkdir(helperRoot, { recursive: true });
    execFileSync(syncFs.existsSync(rustc) ? rustc : 'rustc', [
      path.join(desktop, 'native', 'windows-atomic-rename', 'main.rs'), '--edition=2021',
      '-C', 'opt-level=s', '-C', 'panic=abort', '--target', target,
      '-o', path.join(helperRoot, 'cindy-windows-atomic-rename.exe'),
    ], { timeout: 180_000, windowsHide: true, stdio: 'inherit' });
  }
  const browserExecutable = chromium.executablePath();
  const browserRoot = process.platform === 'darwin'
    ? path.resolve(browserExecutable, '../../../..') : path.dirname(browserExecutable);
  await fs.access(browserExecutable, syncFs.constants.X_OK);
  await fs.cp(browserRoot, path.join(resources, 'chromium'), { recursive: true, dereference: true });
  metadata.chromiumExecutable = path.join('resources', 'chromium', path.relative(browserRoot, browserExecutable));
  if (process.platform === 'darwin' || process.platform === 'win32') {
    const executable = desktopRequire('electron');
    const electronRoot = process.platform === 'darwin' ? path.resolve(executable, '../../../..') : path.dirname(executable);
    await fs.cp(electronRoot, path.join(resources, 'credential-runtime'), { recursive: true, dereference: true });
    metadata.electronBinary = path.join('resources', 'credential-runtime', path.relative(electronRoot, executable));
    await fs.copyFile(path.join(host, 'src/credentials/electron-codec.cjs'), path.join(bin, 'electron-codec.cjs'));
  }
  const common = { absWorkingDir: repo, bundle: true, platform: 'node', target: 'node22',
    plugins: nodePlugins, define: { __CINDY_HOST_RELEASE__: JSON.stringify(metadata) }, logLevel: 'warning' };
  await build({ ...common, entryPoints: ['apps/host/src/main.ts'], outfile: path.join(bin, 'host.mjs'), format: 'esm',
    banner: { js: 'import { createRequire as hostCreateRequire } from "node:module"; const require = hostCreateRequire(import.meta.url);' },
  });
  for (const [entry, name] of [
    ['apps/host/src/plugins/node-worker.ts', 'node-worker.cjs'],
    ['apps/desktop/src/main/cindy-brain/libraryDbWorker.ts', 'library-worker.mjs'],
    ['apps/desktop/src/main/cindy-brain/ghostSnapshotWorkerProcess.ts', 'snapshot-worker.cjs'],
  ]) await build({ ...common, entryPoints: [entry], outfile: path.join(bin, name), format: name.endsWith('.mjs') ? 'esm' : 'cjs' });
  await build({ absWorkingDir: repo, entryPoints: ['apps/web/shim.js'], outfile: path.join(resources, 'web/shim.js'),
    bundle: true, platform: 'browser', format: 'iife', target: 'es2022', nodePaths: [path.join(host, 'node_modules')] });
  await build({ absWorkingDir: repo, entryPoints: ['apps/desktop/src/shared/ghostPageBridge.ts'],
    outfile: path.join(resources, 'plugin-bridge.js'), bundle: true, platform: 'browser',
    format: 'iife', globalName: 'CindyPluginBridge', target: 'es2022' });
  // The machine ID module is loaded through createRequire in both login paths.
  packages.set('node-machine-id', packageRoot('node-machine-id', hostRequire));
  packages.set('sharp', packageRoot('sharp', desktopRequire));
  packages.set('playwright-core', packageRoot('playwright-core', hostRequire));
  for (const [name, source] of packages) {
    const ancestors = new Map(packages);
    ancestors.delete(name);
    await copyPackage(source, staging, ancestors);
  }
  await fs.copyFile(process.execPath, path.join(bin, process.platform === 'win32' ? 'node.exe' : 'node'));
  await fs.copyFile(path.join(repo, 'LICENSE'), path.join(staging, 'LICENSE'));
  await fs.writeFile(path.join(staging, 'package.json'), JSON.stringify({ name: '@cindy/host-release', version: metadata.version, private: true, type: 'commonjs' }, null, 2) + '\n');
  const launcher = process.platform === 'win32'
    ? '@echo off\r\n"%~dp0bin\\node.exe" "%~dp0bin\\host.mjs" %*\r\n'
    : '#!/bin/sh\nset -eu\nHOST_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$HOST_ROOT/bin/node" "$HOST_ROOT/bin/host.mjs" "$@"\n';
  await fs.writeFile(path.join(staging, process.platform === 'win32' ? 'cindy-host.cmd' : 'cindy-host'), launcher, { mode: 0o755 });
  await fs.writeFile(path.join(staging, 'runtime-dependencies.json'), JSON.stringify(Object.fromEntries(dependencyRecords), null, 2) + '\n');
  await fs.writeFile(path.join(staging, 'release.json'), JSON.stringify(metadata, null, 2) + '\n');
  // A checksum inventory supports verification after copying or distributing;
  // signing and publishing remain separate explicit release operations.
  const checksums = {};
  async function inventory(dir) {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) await inventory(file);
      else if (item.isFile()) checksums[path.relative(staging, file).split(path.sep).join('/')] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
      else throw new Error(`Unexpected link or special file in release: ${file}`);
    }
  }
  await inventory(staging);
  await fs.writeFile(path.join(staging, 'SHA256SUMS.json'), JSON.stringify(checksums, null, 2) + '\n');
  await fs.rename(staging, output);
  console.log(`Built Cindy Host ${metadata.version} for ${platformKey}: ${output}`);
} catch (error) {
  // Only this invocation's unpublished staging directory is removed.
  await fs.rm(staging, { recursive: true, force: true });
  throw error;
}
