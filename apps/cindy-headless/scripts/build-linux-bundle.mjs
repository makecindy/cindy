import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appDir, '..', '..');
const outputDir = path.join(appDir, 'bundle', 'linux-x64');
const binaryCache = path.resolve(process.env.CINDY_HEADLESS_BINARY_CACHE ?? path.join(appDir, '.cache', 'bin', 'linux-x64'));
const binary = process.env.CINDY_CLAUDE_BINARY ?? path.join(binaryCache, 'claude');
const codexBinary = process.env.CINDY_CODEX_BINARY ?? path.join(binaryCache, 'codex');
const piBinary = process.env.CINDY_PI_BINARY ?? path.join(binaryCache, 'pi', 'pi');
const piRuntimeDir = path.dirname(piBinary);
const nodeMetadata = JSON.parse(await readFile(path.join(appDir, 'runtime', 'node-linux-x64.json'), 'utf8'));
const nodeBinary = process.env.CINDY_NODE_BINARY ?? path.join(binaryCache, 'node');
const execFileAsync = promisify(execFile);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const { stdout: worktreeStatus } = await execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repoRoot });
const sourceDirty = Boolean(worktreeStatus.trim());
if (sourceDirty && process.env.CINDY_HEADLESS_ALLOW_DIRTY_BUNDLE !== '1') throw new Error('Refusing to build a scored bundle from a dirty worktree; commit the reviewed source first');

async function ensureNodeRuntime() {
  const existing = await stat(nodeBinary).catch(() => null);
  if (existing) {
    const { stdout } = await readBinaryVersion(nodeBinary);
    if (stdout.trim() === `v${nodeMetadata.version}`) return;
  }
  const archive = path.join(binaryCache, `node-v${nodeMetadata.version}-linux-x64.tar.xz`);
  const response = await fetch(nodeMetadata.url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Node runtime download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== nodeMetadata.sha256) throw new Error('Node runtime archive digest mismatch');
  await mkdir(binaryCache, { recursive: true });
  await writeFile(archive, bytes);
  const extractDir = path.join(binaryCache, '.node-extract');
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  await execFileAsync('tar', ['-xJf', path.basename(archive), '-C', path.basename(extractDir)], { cwd: binaryCache });
  await rm(nodeBinary, { force: true });
  await rename(path.join(extractDir, `node-v${nodeMetadata.version}-linux-x64`, 'bin', 'node'), nodeBinary);
  await rm(extractDir, { recursive: true, force: true });
}

async function readBinaryVersion(binaryPath) {
  try {
    return await execFileAsync(binaryPath, ['--version'], { timeout: 30_000 });
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    const { stdout: linuxPath } = await execFileAsync('wsl.exe', ['-e', 'wslpath', '-a', binaryPath], { timeout: 30_000 });
    return execFileAsync('wsl.exe', ['-e', linuxPath.trim(), '--version'], { timeout: 30_000 });
  }
}

const latest = JSON.parse(await readFile(path.resolve(appDir, '..', '..', 'tools', 'claude', 'latest.json'), 'utf8'));
const codexLatest = JSON.parse(await readFile(path.resolve(appDir, '..', '..', 'tools', 'codex', 'latest.json'), 'utf8'));
const piLatest = JSON.parse(await readFile(path.resolve(appDir, '..', '..', 'tools', 'pi', 'latest.json'), 'utf8'));
await ensureNodeRuntime();
const [{ stdout: claudeStdout, stderr: claudeStderr }, { stdout: codexStdout, stderr: codexStderr }, { stdout: piStdout, stderr: piStderr }] = await Promise.all([
  readBinaryVersion(binary),
  readBinaryVersion(codexBinary),
  readBinaryVersion(piBinary),
]);
const observedClaudeVersion = `${claudeStdout} ${claudeStderr}`.trim();
const observedCodexVersion = `${codexStdout} ${codexStderr}`.trim();
const observedPiVersion = `${piStdout} ${piStderr}`.trim();
if (!observedClaudeVersion.includes(latest.version)) throw new Error(`Claude binary version mismatch: expected ${latest.version}, observed ${observedClaudeVersion}`);
if (!observedCodexVersion.includes(codexLatest.version)) throw new Error(`Codex binary version mismatch: expected ${codexLatest.version}, observed ${observedCodexVersion}`);
if (!observedPiVersion.includes(piLatest.version)) throw new Error(`Pi binary version mismatch: expected ${piLatest.version}, observed ${observedPiVersion}`);

await rm(outputDir, { recursive: true, force: true });
await mkdir(path.join(outputDir, 'dist'), { recursive: true });
await mkdir(path.join(outputDir, 'bin'), { recursive: true });
await build({ entryPoints: { cli: path.join(appDir, 'src', 'cli.ts'), 'eval-cli': path.join(appDir, 'src', 'eval-cli.ts') }, outdir: path.join(outputDir, 'dist'), outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', target: 'node22', sourcemap: true, loader: { '.md': 'text' } });
await copyFile(binary, path.join(outputDir, 'bin', 'claude'));
await copyFile(codexBinary, path.join(outputDir, 'bin', 'codex'));
await cp(piRuntimeDir, path.join(outputDir, 'bin', 'pi'), { recursive: true });
await copyFile(nodeBinary, path.join(outputDir, 'bin', 'node'));
const desktopPromptDir = path.resolve(appDir, '..', 'desktop', 'src', 'main', 'maker-host');
const desktopHost = await readFile(path.join(desktopPromptDir, 'host-system-prompt.md'), 'utf8');
const desktopClaude = await readFile(path.join(desktopPromptDir, 'claude-system-prompt.md'), 'utf8');
const desktopCodex = await readFile(path.join(desktopPromptDir, 'codex-system-prompt.md'), 'utf8');
const desktopPi = await readFile(path.join(desktopPromptDir, 'pi-system-prompt.md'), 'utf8');
const composePrompt = (...parts) => parts
  .map((part) => part.replace(/\r\n?/g, '\n').trim())
  .filter(Boolean)
  .join('\n\n') + '\n';
const productionPrompt = composePrompt(desktopHost, desktopClaude);
const codexPrompt = composePrompt(desktopHost, desktopCodex);
const piPrompt = composePrompt(desktopHost, desktopPi);
await writeFile(path.join(outputDir, 'prompt.md'), productionPrompt, 'utf8');
await writeFile(path.join(outputDir, 'codex-prompt.md'), codexPrompt, 'utf8');
await writeFile(path.join(outputDir, 'pi-prompt.md'), piPrompt, 'utf8');
await cp(path.join(appDir, 'profiles'), path.join(outputDir, 'profiles'), { recursive: true });
const packageJson = JSON.parse(await readFile(path.join(appDir, 'package.json'), 'utf8'));
const capabilityRegistryBytes = await readFile(path.join(appDir, 'capability-registry.json'));
const capabilityRegistry = JSON.parse(capabilityRegistryBytes.toString('utf8'));
await writeFile(path.join(outputDir, 'capability-registry.json'), capabilityRegistryBytes);
if (!/^[0-9a-f]{40}$/.test(packageJson.cindyUpstreamCommit ?? '')) throw new Error('package.json must declare a full cindyUpstreamCommit');
async function digestTree(directory) {
  const hash = createHash('sha256');
  async function walk(current, prefix = '') {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(current, entry.name), relative);
      else if (entry.isFile()) { hash.update(relative); hash.update('\0'); hash.update(await readFile(path.join(current, entry.name))); hash.update('\0'); }
      else throw new Error(`unsupported Pi runtime entry: ${relative}`);
    }
  }
  await walk(directory);
  return hash.digest('hex');
}
const [{ stdout: commit }, { stdout: commitDate }, lockfile, cliBytes, evalCliBytes, binaryBytes, codexBinaryBytes, piBinaryBytes, nodeBinaryBytes, piRuntimeDigest, profilesDigest] = await Promise.all([
  execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }),
  execFileAsync('git', ['show', '-s', '--format=%cI', 'HEAD'], { cwd: repoRoot }),
  readFile(path.join(repoRoot, 'pnpm-lock.yaml')),
  readFile(path.join(outputDir, 'dist', 'cli.cjs')),
  readFile(path.join(outputDir, 'dist', 'eval-cli.cjs')),
  readFile(binary),
  readFile(codexBinary),
  readFile(piBinary),
  readFile(nodeBinary),
  digestTree(piRuntimeDir),
  digestTree(path.join(outputDir, 'profiles')),
]);
const supportedFeatures = Object.keys(capabilityRegistry.features);
const capabilityCatalog = {
  schemaVersion: capabilityRegistry.schemaVersion,
  contractVersion: capabilityRegistry.contractVersion,
  harnesses: Object.entries(capabilityRegistry.harnesses).map(([backend, definition]) => ({ ...definition, backend, adapterSupported: true })),
  features: capabilityRegistry.features,
  controls: capabilityRegistry.controls,
  defaultValues: Object.fromEntries(supportedFeatures.map((id) => [id, capabilityRegistry.features[id].default])),
  constraints: capabilityRegistry.constraints,
};
await writeFile(path.join(outputDir, 'bundle-manifest.json'), JSON.stringify({ schemaVersion: 5, headlessContractVersion: 1, bundleMode: sourceDirty ? 'development' : 'formal', capabilityCatalog, capabilityRegistryDigest: sha256(capabilityRegistryBytes), cindyHeadlessVersion: packageJson.version, cindyUpstreamCommit: packageJson.cindyUpstreamCommit, cindyCommit: commit.trim(), sourceDirty, lockfileDigest: sha256(lockfile), cliDigest: sha256(cliBytes), evalCliDigest: sha256(evalCliBytes), profilesDigest, systemPromptDigest: sha256(productionPrompt), codexSystemPromptDigest: sha256(codexPrompt), piSystemPromptDigest: sha256(piPrompt), nodeBinaryDigest: sha256(nodeBinaryBytes), nodeVersion: nodeMetadata.version, claudeBinaryDigest: sha256(binaryBytes), codexBinaryDigest: sha256(codexBinaryBytes), piBinaryDigest: sha256(piBinaryBytes), piRuntimeDigest, claudeCodeVersion: latest.version, codexVersion: codexLatest.version, piVersion: piLatest.version, observedClaudeVersion, observedCodexVersion, observedPiVersion, platform: 'linux-x64', generatedAt: commitDate.trim() }, null, 2) + '\n');
