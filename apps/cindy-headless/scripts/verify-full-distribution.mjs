import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.resolve(process.env.CINDY_HEADLESS_RELEASE_DIR ?? path.join(appDir, 'release'));

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
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

const release = JSON.parse(await readFile(path.join(releaseDir, 'release-manifest.json'), 'utf8'));
assert.equal(release.product, 'cindy-headless');
assert.equal(release.packageMode, 'full');
assert.match(release.cindyUpstreamCommit, /^[0-9a-f]{40}$/);
assert.equal(release.includesVendorBinaries, true, 'release manifest must identify the vendor binaries');
const fullAsset = release.assets.find((asset) => /-full-/.test(asset));
assert.ok(fullAsset, 'release manifest does not list a full package');
assert.deepEqual(release.assets, [fullAsset], 'full release directory must contain only the upload-ready full package');

const sums = new Map();
for (const line of (await readFile(path.join(releaseDir, 'SHA256SUMS'), 'utf8')).trim().split('\n')) {
  const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
  assert.ok(match, `invalid SHA256SUMS line: ${line}`);
  sums.set(match[2], match[1]);
}
for (const asset of [...release.assets, 'bundle-manifest.json']) {
  assert.equal(await digest(path.join(releaseDir, asset)), sums.get(asset), `${asset} checksum mismatch`);
}

const temporary = await mkdtemp(path.join(releaseDir, '.verify-full-'));
try {
  await execFileAsync('tar', ['-xzf', fullAsset, '-C', path.basename(temporary)], { cwd: releaseDir });
  const root = path.join(temporary, 'cindy-headless');
  const bundle = JSON.parse(await readFile(path.join(root, 'bundle-manifest.json'), 'utf8'));
  assert.equal(await digest(path.join(root, 'dist', 'cli.cjs')), bundle.cliDigest, 'CLI digest mismatch');
  assert.equal(await digest(path.join(root, 'dist', 'eval-cli.cjs')), bundle.evalCliDigest, 'Eval CLI digest mismatch');
  assert.equal(await digest(path.join(root, 'bin', 'node')), bundle.nodeBinaryDigest, 'Node binary digest mismatch');
  assert.equal(await digest(path.join(root, 'bin', 'claude')), bundle.claudeBinaryDigest, 'Claude binary digest mismatch');
  assert.equal(await digest(path.join(root, 'bin', 'codex')), bundle.codexBinaryDigest, 'Codex binary digest mismatch');
  assert.equal(await digest(path.join(root, 'bin', 'pi', 'pi')), bundle.piBinaryDigest, 'Pi binary digest mismatch');
  assert.equal(await digestTree(path.join(root, 'bin', 'pi')), bundle.piRuntimeDigest, 'Pi runtime digest mismatch');
  assert.equal(await digestTree(path.join(root, 'profiles')), bundle.profilesDigest, 'profiles digest mismatch');
  assert.ok((await stat(path.join(root, 'bin', 'claude'))).size > 0);
  assert.ok((await stat(path.join(root, 'bin', 'codex'))).size > 0);
  assert.ok((await stat(path.join(root, 'bin', 'pi', 'pi'))).size > 0);
  assert.ok((await stat(path.join(root, 'bin', 'node'))).size > 0);
  await readFile(path.join(root, 'VENDOR-BINARIES-NOTICE.txt'));
  await readFile(path.join(root, 'UPDATE_AND_PACKAGE.zh-CN.md'));
  await readFile(path.join(root, 'prepare-binaries.sh'));
  let cliPath = path.join(root, 'dist', 'cli.cjs');
  if (process.platform === 'win32') {
    const { stdout: linuxRoot } = await execFileAsync('wsl.exe', ['-e', 'wslpath', '-a', root], { timeout: 30_000 });
    cliPath = path.posix.join(linuxRoot.trim(), 'dist/cli.cjs');
  }
  const { stdout } = await runBinary('node', [cliPath, 'version']);
  const version = JSON.parse(stdout);
  assert.equal(version.name, 'cindy-headless');
  assert.equal(version.version, release.version);
  assert.equal(version.cindyUpstreamCommit, release.cindyUpstreamCommit);
  assert.equal(bundle.cindyUpstreamCommit, release.cindyUpstreamCommit);
  async function runBinary(name, args) {
    if (process.platform !== 'win32') return execFileAsync(path.join(root, 'bin', name), args, { timeout: 30_000 });
    const { stdout: linuxRoot } = await execFileAsync('wsl.exe', ['-e', 'wslpath', '-a', root], { timeout: 30_000 });
    return execFileAsync('wsl.exe', ['-e', path.posix.join(linuxRoot.trim(), `bin/${name}`), ...args], { timeout: 30_000 });
  }
  const nodeVersion = await runBinary('node', ['--version']);
  const claudeVersion = await runBinary('claude', ['--version']);
  const codexVersion = await runBinary('codex', ['--version']);
  const piVersion = await runBinary('pi/pi', ['--version']);
  assert.match(`${claudeVersion.stdout} ${claudeVersion.stderr}`, new RegExp(bundle.claudeCodeVersion.replaceAll('.', '\\.')));
  assert.match(`${codexVersion.stdout} ${codexVersion.stderr}`, new RegExp(bundle.codexVersion.replaceAll('.', '\\.')));
  assert.match(`${piVersion.stdout} ${piVersion.stderr}`, new RegExp(bundle.piVersion.replaceAll('.', '\\.')));
  assert.match(`${nodeVersion.stdout} ${nodeVersion.stderr}`, new RegExp(bundle.nodeVersion.replaceAll('.', '\\.')));
  await runBinary('codex', ['app-server', '--help']);

  async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { await scan(file); continue; }
      assert.doesNotMatch(entry.name, /auth\.json|config\.local\.json/i);
      if (/\.(?:json|md|mjs|py|ps1|sh|toml|txt)$/.test(entry.name)) {
        assert.doesNotMatch(await readFile(file, 'utf8'), /sk-[A-Za-z0-9_-]{12,}|github_pat_|gho_/);
      }
    }
  }
  await scan(root);
  console.log(JSON.stringify({ ok: true, version: release.version, asset: fullAsset, claudeCodeVersion: bundle.claudeCodeVersion, codexVersion: bundle.codexVersion, piVersion: bundle.piVersion }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
