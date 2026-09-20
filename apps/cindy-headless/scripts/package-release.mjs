import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appDir, '..', '..');
const bundleDir = path.join(appDir, 'bundle', 'linux-x64');
const releaseDir = path.resolve(process.env.CINDY_HEADLESS_RELEASE_DIR ?? path.join(appDir, 'release'));
const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length);
if (mode !== 'full' && mode !== 'public-runtime') {
  throw new Error('package-release.mjs requires explicit --mode=full or --mode=public-runtime');
}
const includesVendorBinaries = mode === 'full';
const packageJson = JSON.parse(await readFile(path.join(appDir, 'package.json'), 'utf8'));
const bundleManifest = JSON.parse(await readFile(path.join(bundleDir, 'bundle-manifest.json'), 'utf8'));
const version = packageJson.version;
if (bundleManifest.cindyHeadlessVersion !== version) throw new Error('bundle manifest version does not match package version; rebuild the bundle first');
if (bundleManifest.cindyUpstreamCommit !== packageJson.cindyUpstreamCommit) throw new Error('bundle manifest Cindy upstream commit does not match package metadata; rebuild the bundle first');
const bundleDist = await access(path.join(bundleDir, 'dist')).then(() => path.join(bundleDir, 'dist'), () => path.join(appDir, 'dist'));

async function sha(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function archive(name, staging) {
  const output = path.join(releaseDir, `${name}.tar.gz`);
  // Keep drive-letter paths out of tar arguments so both BSD tar and GNU tar
  // behave consistently on Windows.
  await execFileAsync('tar', ['-czf', path.basename(output), '-C', path.relative(releaseDir, staging), 'cindy-headless'], { cwd: releaseDir });
  return output;
}

await rm(releaseDir, { recursive: true, force: true });
await mkdir(releaseDir, { recursive: true });
const runtimeStage = path.join(releaseDir, '.runtime');
const runtimeRoot = path.join(runtimeStage, 'cindy-headless');
await mkdir(runtimeRoot, { recursive: true });
await cp(bundleDist, path.join(runtimeRoot, 'dist'), { recursive: true });
await mkdir(path.join(runtimeRoot, 'bin'), { recursive: true });
await cp(path.join(bundleDir, 'bin', 'node'), path.join(runtimeRoot, 'bin', 'node'));
for (const item of ['prompt.md', 'codex-prompt.md', 'pi-prompt.md', 'bundle-manifest.json', 'capability-registry.json']) await cp(path.join(bundleDir, item), path.join(runtimeRoot, item), { recursive: true });
await cp(path.join(appDir, 'profiles'), path.join(runtimeRoot, 'profiles'), { recursive: true });
await cp(path.join(appDir, 'README.md'), path.join(runtimeRoot, 'README.md'));
await cp(path.join(appDir, 'CINDY_FEATURE_PARITY.md'), path.join(runtimeRoot, 'CINDY_FEATURE_PARITY.md'));
await cp(path.join(appDir, 'UPDATE_AND_PACKAGE.zh-CN.md'), path.join(runtimeRoot, 'UPDATE_AND_PACKAGE.zh-CN.md'));
await cp(path.join(appDir, 'config.example.json'), path.join(runtimeRoot, 'config.example.json'));
await mkdir(path.join(runtimeRoot, 'scripts'), { recursive: true });
await cp(path.join(appDir, 'scripts', 'ensure-agent-binaries.mjs'), path.join(runtimeRoot, 'scripts', 'ensure-agent-binaries.mjs'));
await mkdir(path.join(runtimeRoot, 'tools', 'claude'), { recursive: true });
await mkdir(path.join(runtimeRoot, 'tools', 'codex'), { recursive: true });
await mkdir(path.join(runtimeRoot, 'tools', 'pi'), { recursive: true });
await cp(path.join(repoRoot, 'tools', 'claude', 'latest.json'), path.join(runtimeRoot, 'tools', 'claude', 'latest.json'));
await cp(path.join(repoRoot, 'tools', 'codex', 'latest.json'), path.join(runtimeRoot, 'tools', 'codex', 'latest.json'));
await cp(path.join(repoRoot, 'tools', 'pi', 'latest.json'), path.join(runtimeRoot, 'tools', 'pi', 'latest.json'));
await cp(path.join(appDir, 'harbor-compatibility.json'), path.join(runtimeRoot, 'harbor-compatibility.json'));
await writeFile(path.join(runtimeRoot, 'prepare-binaries.sh'), '#!/usr/bin/env sh\nset -eu\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nCINDY_HEADLESS_METADATA_ROOT="$ROOT" CINDY_HEADLESS_BINARY_CACHE="$ROOT/bin" "$ROOT/bin/node" "$ROOT/scripts/ensure-agent-binaries.mjs"\n');
await writeFile(path.join(runtimeRoot, 'prepare-binaries.ps1'), "$ErrorActionPreference = 'Stop'\n$root = $PSScriptRoot\n$env:CINDY_HEADLESS_METADATA_ROOT = $root\n$env:CINDY_HEADLESS_BINARY_CACHE = Join-Path $root 'bin'\nnode (Join-Path $root 'scripts\\ensure-agent-binaries.mjs')\n");
const files = [];

if (mode === 'public-runtime') {
  files.push(await archive(`cindy-headless-linux-x64-public-runtime-no-vendor-${version}`, runtimeStage));
} else {
  const fullStage = path.join(releaseDir, '.full');
  const fullRoot = path.join(fullStage, 'cindy-headless');
  await cp(runtimeRoot, fullRoot, { recursive: true });
  await cp(path.join(bundleDir, 'bin'), path.join(fullRoot, 'bin'), { recursive: true });
  await writeFile(path.join(fullRoot, 'VENDOR-BINARIES-NOTICE.txt'), 'This package contains separately licensed Claude Code, Codex, and Pi runtimes. Distribution requires explicit confirmation of their applicable license terms.\n');
  files.push(await archive(`cindy-headless-linux-x64-full-${version}`, fullStage));
}

const sums = [];
for (const file of files) sums.push(`${await sha(file)}  ${path.basename(file)}`);
await cp(path.join(bundleDir, 'bundle-manifest.json'), path.join(releaseDir, 'bundle-manifest.json'));
sums.push(`${await sha(path.join(releaseDir, 'bundle-manifest.json'))}  bundle-manifest.json`);
await writeFile(path.join(releaseDir, 'SHA256SUMS'), `${sums.join('\n')}\n`);
const { stdout: sourceCommit } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
await writeFile(path.join(releaseDir, 'release-manifest.json'), JSON.stringify({ schemaVersion: 1, product: 'cindy-headless', version, packageMode: mode, cindyUpstreamCommit: bundleManifest.cindyUpstreamCommit, platform: 'linux-x64', sourceCommit: sourceCommit.trim(), bundleCommit: bundleManifest.cindyCommit, includesVendorBinaries, assets: files.map((file) => path.basename(file)) }, null, 2) + '\n');
await rm(runtimeStage, { recursive: true, force: true });
await rm(path.join(releaseDir, '.full'), { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, releaseDir, packageMode: mode, assets: files.map((file) => path.basename(file)), includesVendorBinaries }, null, 2));
