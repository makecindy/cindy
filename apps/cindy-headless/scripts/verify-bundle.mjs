import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundleDir = path.join(appDir, 'bundle', 'linux-x64');
const manifest = JSON.parse(await readFile(path.join(bundleDir, 'bundle-manifest.json'), 'utf8'));
if (manifest.schemaVersion !== 5 || manifest.headlessContractVersion !== 1) throw new Error('unsupported bundle manifest schema or contract');
if (!Array.isArray(manifest.capabilityCatalog?.harnesses) || manifest.capabilityCatalog.harnesses.length !== 3) throw new Error('bundle manifest must declare all three harnesses');
if (new Set(manifest.capabilityCatalog.harnesses.map((item) => item.backend)).size !== 3 || !['claude-code', 'codex', 'pi'].every((backend) => manifest.capabilityCatalog.harnesses.some((item) => item.backend === backend))) throw new Error('bundle manifest harness identities are invalid');
if (!/^[0-9a-f]{40}$/.test(manifest.cindyUpstreamCommit ?? '')) throw new Error('bundle manifest must declare cindyUpstreamCommit');
const registryBytes = await readFile(path.join(bundleDir, 'capability-registry.json'));
if (!/^[a-f0-9]{64}$/.test(manifest.capabilityRegistryDigest ?? '') || createHash('sha256').update(registryBytes).digest('hex') !== manifest.capabilityRegistryDigest) throw new Error('capability registry digest mismatch');
for (const [relativePath, expected] of [
  ['dist/cli.cjs', manifest.cliDigest],
  ['dist/eval-cli.cjs', manifest.evalCliDigest],
  ['prompt.md', manifest.systemPromptDigest],
  ['codex-prompt.md', manifest.codexSystemPromptDigest],
  ['pi-prompt.md', manifest.piSystemPromptDigest],
  ['bin/node', manifest.nodeBinaryDigest],
  ['bin/claude', manifest.claudeBinaryDigest],
  ['bin/codex', manifest.codexBinaryDigest],
  ['bin/pi/pi', manifest.piBinaryDigest],
]) {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`missing or invalid digest for ${relativePath}`);
  const bytes = await readFile(path.join(bundleDir, relativePath));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`${relativePath} digest mismatch`);
}
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
if (await digestTree(path.join(bundleDir, 'bin', 'pi')) !== manifest.piRuntimeDigest) throw new Error('Pi runtime digest mismatch');
if (await digestTree(path.join(bundleDir, 'profiles')) !== manifest.profilesDigest) throw new Error('profiles digest mismatch');
const run = async (command, args) => execFileAsync(command, args, { cwd: bundleDir, timeout: 30_000 });
const runBundleBinary = async (name, args) => {
  if (process.platform !== 'win32') return execFileAsync(path.join(bundleDir, 'bin', name), args, { cwd: bundleDir, timeout: 30_000 });
  const { stdout: linuxBundle } = await execFileAsync('wsl.exe', ['-e', 'wslpath', '-a', bundleDir], { timeout: 30_000 });
  return execFileAsync('wsl.exe', ['--cd', linuxBundle.trim(), '-e', `./bin/${name}`, ...args], { timeout: 30_000 });
};
const version = await runBundleBinary('node', ['dist/cli.cjs', 'version']);
if (typeof manifest.cindyHeadlessVersion !== 'string' || !version.stdout.includes(manifest.cindyHeadlessVersion)) throw new Error('Cindy CLI version mismatch');
if (!version.stdout.includes(manifest.cindyUpstreamCommit)) throw new Error('Cindy upstream commit mismatch');
const capabilities = await runBundleBinary('node', ['dist/cli.cjs', 'capabilities', '--manifest', 'bundle-manifest.json']);
const discovered = JSON.parse(capabilities.stdout);
if (discovered.adapter?.detected?.some((item) => item.status !== 'SUPPORTED')) throw new Error('bundle contains capabilities unsupported by this Adapter');
if (discovered.harnesses?.some((item) => item.status !== 'SUPPORTED')) throw new Error('bundle contains a harness unsupported by this Adapter');
for (const harness of ['claude-code', 'codex', 'pi']) {
  const generated = `.verify/profile-${harness}.json`;
  await runBundleBinary('node', ['dist/cli.cjs', 'profile', 'generate', '--manifest', 'bundle-manifest.json', '--harness', harness, '--output', generated]);
  await runBundleBinary('node', ['dist/cli.cjs', 'profile', 'validate', '--profile', generated, '--bundle-dir', '.']);
  await runBundleBinary('node', ['dist/cli.cjs', 'compatibility-report', '--profile', generated, '--bundle-dir', '.']);
}
await rm(path.join(bundleDir, '.verify'), { recursive: true, force: true });
for (const profile of [
  'profiles/cindy-production-claude/profile.example.json',
  'profiles/cindy-production-codex/profile.example.json',
  'profiles/cindy-production-pi/profile.example.json',
]) {
  await runBundleBinary('node', ['dist/cli.cjs', 'profile', 'validate', '--profile', profile, '--bundle-dir', '.']);
}
await runBundleBinary('node', ['dist/eval-cli.cjs']).catch((error) => {
  if (error.code !== 2 && error.status !== 2) throw error;
});
const claudeVersion = await runBundleBinary('claude', ['--version']);
if (!claudeVersion.stdout.includes(manifest.claudeCodeVersion)) throw new Error('Claude bundle version mismatch');
const codexVersion = await runBundleBinary('codex', ['--version']);
if (!codexVersion.stdout.includes(manifest.codexVersion)) throw new Error('Codex bundle version mismatch');
await runBundleBinary('codex', ['app-server', '--help']);
const piVersion = await runBundleBinary('pi/pi', ['--version']);
if (!`${piVersion.stdout} ${piVersion.stderr}`.includes(manifest.piVersion)) throw new Error('Pi bundle version mismatch');
const nodeVersion = await runBundleBinary('node', ['--version']);
if (!nodeVersion.stdout.includes(manifest.nodeVersion)) throw new Error('Node bundle version mismatch');
console.log(JSON.stringify({ ok: true, manifestSchema: manifest.schemaVersion, headlessContractVersion: manifest.headlessContractVersion, cindyHeadlessVersion: manifest.cindyHeadlessVersion, cindyUpstreamCommit: manifest.cindyUpstreamCommit, nodeVersion: manifest.nodeVersion, claudeCodeVersion: manifest.claudeCodeVersion, codexVersion: manifest.codexVersion, piVersion: manifest.piVersion }, null, 2));
