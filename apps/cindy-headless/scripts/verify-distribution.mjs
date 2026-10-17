import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'cindy-headless-distribution-'));
try {
  const bundleManifest = JSON.parse(await readFile(path.join(repoRoot, 'apps', 'cindy-headless', 'bundle', 'linux-x64', 'bundle-manifest.json'), 'utf8'));
  const packageScript = path.join(repoRoot, 'apps', 'cindy-headless', 'scripts', 'package-release.mjs');
  await assert.rejects(
    execFileAsync('node', [packageScript], { env: { ...process.env, CINDY_HEADLESS_RELEASE_DIR: path.join(temporary, 'implicit-release') } }),
    /requires explicit --mode=full or --mode=public-runtime/,
  );
  await execFileAsync('node', [packageScript, '--mode=public-runtime'], { env: { ...process.env, CINDY_HEADLESS_RELEASE_DIR: path.join(temporary, 'release') } });
  const release = JSON.parse(await readFile(path.join(temporary, 'release', 'release-manifest.json'), 'utf8'));
  assert.equal(release.product, 'cindy-headless');
  assert.equal(release.packageMode, 'public-runtime');
  assert.equal(release.cindyUpstreamCommit, bundleManifest.cindyUpstreamCommit);
  assert.equal(release.includesVendorBinaries, false);
  assert.equal(release.assets.length, 1);
  const sums = await readFile(path.join(temporary, 'release', 'SHA256SUMS'), 'utf8');
  assert.match(sums, /cindy-headless-linux-x64-public-runtime-no-vendor-/);
  assert.doesNotMatch(sums, /cindy-headless-linux-x64-full-/);
  assert.doesNotMatch(sums, /codex\.tar|bin\/claude/);
  const archive = path.join(temporary, 'release', release.assets[0]);
  await execFileAsync('tar', ['-xzf', path.relative(temporary, archive)], { cwd: temporary });
  const releaseRoot = path.join(temporary, 'cindy-headless');
  await readFile(path.join(releaseRoot, 'dist', 'cli.cjs'));
  await readFile(path.join(releaseRoot, 'harbor-compatibility.json'));
  await assert.rejects(readFile(path.join(releaseRoot, 'cindy_harbor', 'cindy_headless_agent.py')));
  await readFile(path.join(releaseRoot, 'prepare-binaries.sh'));
  await assert.rejects(readFile(path.join(releaseRoot, 'bin', 'claude')));
  const readme = await readFile(path.join(releaseRoot, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /sk-[A-Za-z0-9_-]{12,}|github_pat_|gho_/);
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
  await scan(releaseRoot);
  const compatibility = JSON.parse(await readFile(path.join(releaseRoot, 'harbor-compatibility.json'), 'utf8'));
  assert.equal(typeof compatibility.harborCommit, 'string');
  assert.equal(compatibility.cindyUpstreamCommit, bundleManifest.cindyUpstreamCommit);
  console.log(JSON.stringify({ ok: true }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
