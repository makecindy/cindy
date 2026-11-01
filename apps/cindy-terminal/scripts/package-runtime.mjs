#!/usr/bin/env node
/** Build on the target OS/architecture after `pnpm build`. The output has its
 * own official Node and complete external-module closure; it does not need
 * Electron, npm, a repository checkout, or a global Node installation. */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { access, chmod, cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import * as tar from 'tar';
import * as yauzl from 'yauzl';
import { runtimePackages, imRuntimePackages } from './runtime-externals.mjs';
import { READ_SHEET_RUNTIME_PACKAGES } from '../../../packages/lizi-mcps/src/cindy-docs/readSheetRuntimeDeps.ts';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(app, 'package.json'));
const { version, region } = JSON.parse(await readFile(path.join(app, 'dist/build-info.json'), 'utf8'));
if (!['global', 'cn'].includes(region)) throw new Error('Invalid build region; rebuild the terminal bundle.');
if (typeof version !== 'string' || require('semver').valid(version) !== version) throw new Error('Invalid build version; rebuild the terminal bundle.');
const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const target = value('--target') || `${process.platform}-${process.arch}`;
const outputArg = value('--out');
if (!outputArg || args.some((arg, index) => index % 2 === 0 && !['--target', '--out'].includes(arg))) throw new Error('Usage: node scripts/package-runtime.mjs --out <new-directory> [--target <platform-arch>]');
if (target !== `${process.platform}-${process.arch}`) throw new Error('Build on the target platform: native modules must be installed and tested on that OS and architecture.');
const nodeVersion = '22.22.0';
// SHA256 from https://nodejs.org/dist/v22.22.0/SHASUMS256.txt.
const runtimes = {
  'darwin-arm64': ['darwin-arm64.tar.gz', '5ed4db0fcf1eaf84d91ad12462631d73bf4576c1377e192d222e48026a902640'],
  'darwin-x64': ['darwin-x64.tar.gz', '5ea50c9d6dea3dfa3abb66b2656f7a4e1c8cef23432b558d45fb538c7b5dedce'],
  'linux-arm64': ['linux-arm64.tar.gz', '25ba95dfb96871fa2ef977f11f95ea90818c8fa15c0f2110771db08d4ba423be'],
  'linux-x64': ['linux-x64.tar.gz', 'c33c39ed9c80deddde77c960d00119918b9e352426fd604ba41638d6526a4744'],
  'win32-x64': ['win-x64.zip', 'c97fa376d2becdc8863fcd3ca2dd9a83a9f3468ee7ccf7a6d076ec66a645c77a'],
};
if (!runtimes[target]) throw new Error('Unsupported runtime target (Windows ARM64 also lacks the required native WebRTC artifact).');
const output = path.resolve(outputArg);
try { await access(output); throw new Error('Output already exists; select a new directory.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const stage = await mkdtemp(path.join(tmpdir(), 'cindy-terminal-package-'));
let published = false;
try {
  await mkdir(output, { recursive: true, mode: 0o755 });
  await mkdir(path.join(output, 'app'), { recursive: true });
  await cp(path.join(app, 'dist'), path.join(output, 'app/dist'), { recursive: true });
  const metadata = JSON.parse(await readFile(path.join(app, 'package.json'), 'utf8'));
  await writeFile(path.join(output, 'app/package.json'), JSON.stringify({ name: metadata.name, version, type: 'module', private: true }));

  const copied = new Map();
  const included = [];
  const packageRoot = async (name, from) => {
    const resolver = createRequire(path.join(from, 'package.json'));
    let entry;
    try { entry = resolver.resolve(`${name}/package.json`); }
    catch {
      // Type-only packages may export neither a runtime entry nor package.json.
      for (const candidate of resolver.resolve.paths(name) || []) {
        try {
          const file = path.join(candidate, name, 'package.json');
          if (JSON.parse(await readFile(file, 'utf8')).name === name) { entry = file; break; }
        } catch { /* Check the next normal Node resolution directory. */ }
      }
      if (!entry) entry = resolver.resolve(name);
    }
    let root = path.dirname(entry);
    for (;;) {
      try { if (JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).name === name) return realpath(root); } catch { /* Walk to the package root. */ }
      const parent = path.dirname(root); if (parent === root) throw new Error(`Cannot resolve package ${name}`); root = parent;
    }
  };
  const copyPackage = async (name, from, parentDestination, ancestors = []) => {
    if (name === 'electron' || name.startsWith('@cindy/')) throw new Error(`Unexpected runtime external ${name}`);
    const source = await packageRoot(name, from);
    for (const ancestor of [parentDestination, ...ancestors]) {
      const existing = path.join(ancestor, 'node_modules', name);
      if (copied.get(existing) === source) return;
    }
    const destination = path.join(parentDestination, 'node_modules', name);
    if (copied.has(destination)) throw new Error(`Dependency placement conflict: ${name}`);
    copied.set(destination, source);
    const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
    await cp(source, destination, { recursive: true, dereference: true, filter: item => !['node_modules', '.git', '.npmrc', '.env'].includes(path.basename(item)) });
    included.push({ name, version: pkg.version });
    for (const dependency of Object.keys(pkg.dependencies || {})) await copyPackage(dependency, source, destination, [parentDestination, ...ancestors]);
    for (const dependency of Object.keys(pkg.optionalDependencies || {})) {
      let dependencyRoot;
      try { dependencyRoot = await packageRoot(dependency, source); } catch { continue; }
      const optional = JSON.parse(await readFile(path.join(dependencyRoot, 'package.json'), 'utf8'));
      const matches = (list, actual) => !list || (!list.includes(`!${actual}`) && (!list.some(item => !item.startsWith('!')) || list.includes(actual)));
      if (matches(optional.os, process.platform) && matches(optional.cpu, process.arch)) await copyPackage(dependency, source, destination, [parentDestination, ...ancestors]);
    }
    for (const dependency of Object.keys(pkg.peerDependencies || {})) {
      if (dependency.startsWith('@types/') || pkg.peerDependenciesMeta?.[dependency]?.optional) continue;
      await copyPackage(dependency, source, destination, [parentDestination, ...ancestors]);
    }
  };
  // Install the renderer's singleton peer first. A nested React copied while
  // traversing Ink/reconciler would cause real TUI hooks to use another runtime.
  for (const name of runtimePackages) await copyPackage(name, app, path.join(output, 'app'));
  for (const name of imRuntimePackages) await copyPackage(name, path.join(app, '../../packages/lizi-im'), path.join(output, 'app'));
  for (const name of READ_SHEET_RUNTIME_PACKAGES) await copyPackage(name, path.join(app, '../../packages/lizi-mcps'), path.join(output, 'app'));

  // The published macOS node-pty prebuild can have mode 0644 even though
  // posix_spawn requires its spawn-helper to be executable. Fix the shipped
  // artifact, independently of npm lifecycle scripts on the build computer.
  if (process.platform === 'darwin') {
    let found = false;
    for (const relative of ['build/Release', 'build/Debug', `prebuilds/darwin-${process.arch}`]) {
      const helper = path.join(output, 'app/node_modules/node-pty', relative, 'spawn-helper');
      try { await access(helper); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      await chmod(helper, 0o755); found = true;
    }
    if (!found) throw new Error('Packaged node-pty spawn-helper is missing');
  }

  const [suffix, digest] = runtimes[target];
  const archiveName = `node-v${nodeVersion}-${suffix}`;
  const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${archiveName}`, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || Number(response.headers.get('content-length')) > 100 * 1024 ** 2) throw new Error('Cannot download official Node runtime');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 100 * 1024 ** 2 || createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Official Node runtime checksum mismatch');
  const archive = path.join(stage, archiveName);
  await writeFile(archive, bytes);
  const windows = process.platform === 'win32';
  const rootName = `node-v${nodeVersion}-${suffix.replace(/\.tar\.gz$|\.zip$/, '')}`;
  const nodeEntry = `${rootName}/${windows ? 'node.exe' : 'bin/node'}`;
  await mkdir(path.join(output, 'runtime'));
  if (!windows) {
    await tar.x({ file: archive, cwd: stage, strict: true, filter: name => name === nodeEntry || name === `${rootName}/LICENSE` });
    await cp(path.join(stage, ...nodeEntry.split('/')), path.join(output, 'runtime/node'));
    await cp(path.join(stage, rootName, 'LICENSE'), path.join(output, 'runtime/NODE-LICENSE'));
    await chmod(path.join(output, 'runtime/node'), 0o755);
    await writeFile(path.join(output, 'cindy'), '#!/bin/sh\nCINDY_RUNTIME_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$CINDY_RUNTIME_DIR/runtime/node" "$CINDY_RUNTIME_DIR/app/dist/cli.js" "$@"\n', { mode: 0o755 });
  } else {
    await new Promise((resolve, reject) => yauzl.open(archive, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) { reject(error || new Error('Invalid Node ZIP')); return; }
      zip.on('error', reject); zip.on('end', resolve);
      zip.on('entry', entry => {
        if (entry.fileName !== nodeEntry && entry.fileName !== `${rootName}/LICENSE`) { zip.readEntry(); return; }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) { reject(error || new Error('Invalid Node ZIP')); return; }
          const chunks = []; stream.on('data', chunk => chunks.push(chunk)); stream.on('error', reject);
          stream.on('end', () => { writeFile(path.join(output, 'runtime', entry.fileName === nodeEntry ? 'node.exe' : 'NODE-LICENSE'), Buffer.concat(chunks)).then(() => zip.readEntry(), reject); });
        });
      }); zip.readEntry();
    }));
    await writeFile(path.join(output, 'cindy.cmd'), '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0app\\dist\\cli.js" %*\r\n');
  }
  // Use the bundled Node, not the build machine's Node. Exercise actual native
  // modules; a cross-ABI SQLite or missing WebRTC artifact blocks publication.
  const node = path.join(output, 'runtime', windows ? 'node.exe' : 'node');
  const smoke = `const {createRequire}=require('node:module');const req=createRequire(${JSON.stringify(path.join(output, 'app/package.json'))});const inkReq=createRequire(req.resolve('ink'));const reconcilerReq=createRequire(inkReq.resolve('react-reconciler'));if(req('react')!==inkReq('react')||req('react')!==reconcilerReq('react'))throw Error('Duplicate React runtime');req('node-pty');req('ssh2');const db=new (req('better-sqlite3'))(':memory:');db.prepare('select 1').get();db.close();req('sharp');const p=new (req('@roamhq/wrtc').RTCPeerConnection)();p.close();`;
  const smokeHome = path.join(stage, 'home');
  await mkdir(smokeHome);
  for (const command of [['--input-type=commonjs', '-e', smoke], [path.join(output, 'app/dist/cli.js'), '--version'], [path.join(output, 'app/dist/cli.js'), '--help']]) {
    const check = spawnSync(node, command, { cwd: output, encoding: 'utf8', timeout: 30_000, env: { ...process.env, HOME: smokeHome, USERPROFILE: smokeHome, XDG_CONFIG_HOME: smokeHome, XDG_STATE_HOME: smokeHome, LOCALAPPDATA: smokeHome, NODE_PATH: '', NODE_OPTIONS: '' } });
    if (check.status !== 0) throw new Error(`Runtime smoke failed: ${check.error?.message || check.stderr || check.stdout}`);
    if (command[1] === '--version' && check.stdout.trim() !== version) throw new Error('Packaged CLI version does not match its build manifest');
  }
  await writeFile(path.join(output, 'runtime-manifest.json'), JSON.stringify({ version, region, target, node: { version: nodeVersion, sha256: digest }, packages: included }, null, 2));
  await tar.c({ file: `${output}.tar.gz`, gzip: true, cwd: path.dirname(output), portable: true }, [path.basename(output)]);
  const checksum = createHash('sha256');
  for await (const chunk of createReadStream(`${output}.tar.gz`)) checksum.update(chunk);
  await writeFile(`${output}.tar.gz.sha256`, `${checksum.digest('hex')}  ${path.basename(output)}.tar.gz\n`);
  published = true;
  console.log(`Standalone runtime: ${output}\nArchive: ${output}.tar.gz`);
} finally {
  await rm(stage, { recursive: true, force: true });
  if (!published) await rm(output, { recursive: true, force: true });
}
