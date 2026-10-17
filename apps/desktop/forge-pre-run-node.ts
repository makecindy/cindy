import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nodeRuntimeArtifact } from './src/main/managed-tools/nodeArtifact';
import { extractToolArchive } from './src/main/managed-tools/archive';
import { downloadToFileWithTimeout } from '../../tools/shared/fetch-with-timeout.mjs';
import { assertSha256, sha256File } from '../../tools/shared/verify-sha256.mjs';

/** Only prune the package's copy, never the shared multi-target source cache.
 * Validate the complete target before deleting stale generations/other hosts. */
export function prunePackagedPreRunNode(resources: string, platform: string, arch: string): void {
  const artifact = nodeRuntimeArtifact(platform, arch);
  if (!artifact) throw new Error('Unsupported packaged pre-run Node target: ' + platform + '-' + arch);
  const root = path.join(resources, 'tools', 'pre-run-node');
  const target = path.join(root, artifact.host);
  try {
    if (!lstatSync(root).isDirectory() || !lstatSync(target).isDirectory()) throw new Error('Target is not a directory');
    for (const file of [platform === 'win32' ? 'node.exe' : 'node', platform === 'win32' ? 'supervisor.exe' : 'supervisor', 'gate-client.cjs', 'NODE-LICENSE.txt', 'manifest.json']) {
      const stat = lstatSync(path.join(target, file));
      if (!stat.isFile() || stat.size === 0) throw new Error('Missing or empty ' + file);
    }
    const manifest = JSON.parse(readFileSync(path.join(target, 'manifest.json'), 'utf8'));
    if (manifest.host !== artifact.host || manifest.version !== artifact.version || manifest.archiveSha256 !== artifact.sha256) {
      throw new Error('Target manifest does not match the pinned artifact');
    }
  } catch (error) {
    throw new Error('Incomplete packaged pre-run Node: ' + artifact.host, { cause: error });
  }
  for (const entry of readdirSync(root)) {
    if (entry !== artifact.host) rmSync(path.join(root, entry), { recursive: true, force: true });
  }
}

/** Small native helper, no Cargo/npm install or runtime download. */
export function compilePreRunSupervisor(source: string, output: string, platform: string = process.platform, arch: string = process.arch): void {
  if (platform !== process.platform || (platform !== 'darwin' && arch !== process.arch)) {
    throw new Error('Pre-run supervisor requires a native target build');
  }
  mkdirSync(path.dirname(output), { recursive: true });
  if (platform === 'win32') {
    const object = output + '.obj';
    try {
      execFileSync('cl.exe', [
        '/nologo', '/std:c11', '/W4', '/O2', '/MT', '/Fo' + object, '/Fe' + output,
        source, '/link', 'advapi32.lib',
      ], { stdio: 'pipe', windowsHide: true });
    } finally { rmSync(object, { force: true }); }
  }
  else execFileSync('cc', [
    '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-pthread',
    ...(platform === 'darwin' ? ['-arch', arch === 'arm64' ? 'arm64' : 'x86_64'] : []),
    source, '-o', output,
  ], { stdio: 'pipe' });
}

/** Package-time preparation only. Verified publisher archive, isolated stage,
 * upstream full LICENSE, then a complete generation replaces the target. */
export async function stagePreRunNode(platform: string, arch: string, options: {
  desktopRoot?: string; outputRoot?: string; archive?: string; download?: boolean;
} = {}): Promise<void> {
  const artifact = nodeRuntimeArtifact(platform, arch);
  if (!artifact) throw new Error('Unsupported packaged pre-run Node target: ' + platform + '-' + arch);
  const desktop = options.desktopRoot ?? __dirname;
  const outputRoot = options.outputRoot ?? path.join(desktop, 'resources', 'tools', 'pre-run-node');
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'cindy-pre-run-build-'));
  const target = path.join(outputRoot, artifact.host);
  const staged = path.join(outputRoot, '.' + artifact.host + '-' + path.basename(scratch));
  const old = staged + '-old';
  let movedOld = false;
  try {
    mkdirSync(staged, { recursive: true });
    const archive = options.archive ?? path.join(scratch, 'node.' + artifact.format);
    if (!options.archive) {
      if (options.download === false) throw new Error('Verified Node archive required for offline preparation');
      await downloadToFileWithTimeout(artifact.url, archive, {}, { minThroughputBytesPerSec: 0 });
    }
    assertSha256({ actualHex: sha256File(archive), expected: artifact.sha256, label: artifact.host + ' Node archive' });
    const extracted = path.join(scratch, 'extracted'); mkdirSync(extracted);
    await extractToolArchive(archive, extracted, artifact, new AbortController().signal);
    const node = path.join(extracted, ...artifact.executable.split('/'));
    const executable = path.join(staged, platform === 'win32' ? 'node.exe' : 'node');
    copyFileSync(node, executable); chmodSync(executable, 0o755);
    copyFileSync(path.join(extracted, artifact.executable.split('/')[0], 'LICENSE'), path.join(staged, 'NODE-LICENSE.txt'));
    copyFileSync(path.join(desktop, 'native', 'pre-run-node', 'gate-client.cjs'), path.join(staged, 'gate-client.cjs'));
    compilePreRunSupervisor(path.join(desktop, 'native', 'pre-run-node', 'supervisor.c'), path.join(staged, platform === 'win32' ? 'supervisor.exe' : 'supervisor'), platform, arch);
    writeFileSync(path.join(staged, 'manifest.json'), JSON.stringify({ version: artifact.version, archiveSha256: artifact.sha256, host: artifact.host }) + '\n');
    // Never expose a partially built directory or destroy the prior good stage.
    try { renameSync(target, old); movedOld = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { renameSync(staged, target); } catch (error) { if (movedOld) renameSync(old, target); throw error; }
    if (movedOld) rmSync(old, { recursive: true, force: true });
  } finally {
    rmSync(staged, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true });
  }
}
