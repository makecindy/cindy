#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const [runtimeArg, outputArg, ...extra] = process.argv.slice(2);
if (!runtimeArg || !outputArg || extra.length) throw new Error('Usage: package-desktop-platform.mjs <standalone-runtime> <new-output>');
const runtime = path.resolve(runtimeArg), output = path.resolve(outputArg);
const manifest = JSON.parse(await readFile(path.join(runtime, 'runtime-manifest.json'), 'utf8'));
if (manifest.target !== `${process.platform}-${process.arch}`) throw new Error('Build the optional platform on its native target');
try { await access(output); throw new Error('Output already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../desktop');
const stagedRuntime = path.join(desktop, 'resources/terminal');
// Do not replace a concurrent build's inputs. This directory contains only a
// disposable copy of the artifact, never a user profile or account state.
await mkdir(stagedRuntime);
const stage = await mkdtemp(path.join(tmpdir(), 'cindy-platform-package-'));
let completed = false;
try {
  await cp(runtime, stagedRuntime, { recursive: true });
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(desktop, 'scripts/forge-cli.mjs'), 'package', '--platform', process.platform, '--arch', process.arch], {
      cwd: desktop, stdio: 'inherit', shell: false,
      env: { ...process.env, APP_VERSION: manifest.version, CINDY_TERMINAL_PLATFORM: '1', CINDY_TERMINAL_OUTPUT: stage },
    });
    child.once('error', reject);child.once('exit', resolve);
  });
  if (code !== 0) throw new Error('Optional platform packaging failed');
  const builds = (await readdir(stage, { withFileTypes: true })).filter(item => item.isDirectory() && item.name.endsWith(`-${process.platform}-${process.arch}`));
  if (builds.length !== 1) throw new Error('Expected one native platform package');
  const built = path.join(stage, builds[0].name);
  await cp(runtime, output, { recursive: true });
  await mkdir(path.join(output, 'platform'));
  let executable;
  if (process.platform === 'darwin') {
    const apps = (await readdir(built)).filter(name => name.endsWith('.app'));
    if (apps.length !== 1) throw new Error('Expected one signed-platform app layout');
    await cp(path.join(built, apps[0]), path.join(output, 'platform', apps[0]), { recursive: true });
    executable = `platform/${apps[0]}/Contents/MacOS/${apps[0].slice(0,-4)}`;
  } else {
    await cp(built, path.join(output, 'platform/host'), { recursive: true });
    executable = `platform/host/${builds[0].name.slice(0,-`-${process.platform}-${process.arch}`.length)}${process.platform==='win32'?'.exe':''}`;
  }
  await access(path.join(output, executable));
  await writeFile(path.join(output, 'app/dist/desktop-host.json'), JSON.stringify({ version:1, platform:process.platform, arch:process.arch, executable })+'\n');
  await writeFile(path.join(output, 'runtime-manifest.json'), JSON.stringify({ ...manifest, desktopPlatform: { executable, signing: 'release-pipeline-required' } },null,2)+'\n');
  completed = true;
  console.log(`Optional platform package: ${output}`);
  console.log('Use the existing platform signing/notarization pipeline before distribution. No signing checks or helper trust were relaxed.');
} finally {
  await rm(stagedRuntime, { recursive: true, force: true });
  await rm(stage, { recursive: true, force: true });
  if (!completed) await rm(output, { recursive: true, force: true });
}
