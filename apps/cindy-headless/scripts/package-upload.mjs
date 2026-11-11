import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appDir, '..', '..');
const manifestPath = path.join(appDir, 'bundle', 'linux-x64', 'bundle-manifest.json');
const manifestRelativePath = 'apps/cindy-headless/bundle/linux-x64/bundle-manifest.json';
const appRelativePrefix = 'apps/cindy-headless/';

async function capture(command, args, options = {}) {
  console.log(`> ${command} ${args.join(' ')}`);
  return execFileAsync(command, args, { cwd: repoRoot, maxBuffer: 20 * 1024 * 1024, ...options });
}

async function runPnpm(args) {
  const pnpmScript = process.env.npm_execpath;
  const scriptEntrypoint = pnpmScript && /\.(?:cjs|mjs|js)$/i.test(pnpmScript);
  const command = scriptEntrypoint ? process.execPath : (pnpmScript || (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'));
  const commandArgs = scriptEntrypoint ? [pnpmScript, ...args] : args;
  console.log(`> pnpm ${args.join(' ')}`);
  await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: repoRoot, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`pnpm ${args.join(' ')} failed with ${signal ?? `exit code ${code}`}`));
    });
  });
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

let { stdout: headOutput } = await capture('git', ['rev-parse', 'HEAD']);
let head = headOutput.trim();
const { stdout: statusOutput } = await capture('git', ['status', '--porcelain=v1', '--untracked-files=all']);
const changed = statusOutput.split(/\r?\n/).filter(Boolean);
let reuseExistingFormalBundle = false;

const sourceChanges = changed.filter((line) => line.slice(3).replaceAll('\\', '/') !== manifestRelativePath);
if (sourceChanges.length > 0) {
  const outsideHeadless = sourceChanges
    .map((line) => line.slice(3).replaceAll('\\', '/'))
    .filter((file) => !file.startsWith(appRelativePrefix));
  if (outsideHeadless.length > 0) {
    throw new Error(`cannot create an automatic Headless checkpoint while other Cindy paths are dirty:\n${outsideHeadless.join('\n')}`);
  }

  let previousManifest;
  try { previousManifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch { previousManifest = undefined; }
  const packagePath = path.join(appDir, 'package.json');
  const packageMetadata = JSON.parse(await readFile(packagePath, 'utf8'));
  if (previousManifest?.cindyHeadlessVersion === packageMetadata.version) {
    const parts = packageMetadata.version.split('.').map(Number);
    if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
      throw new Error(`cannot automatically increment non-semver Headless version: ${packageMetadata.version}`);
    }
    const oldVersion = packageMetadata.version;
    const newVersion = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
    packageMetadata.version = newVersion;
    await writeFile(packagePath, `${JSON.stringify(packageMetadata, null, 2)}\n`);
    const replacements = [
      ['harbor-compatibility.json', `"cindyHeadlessVersion": "${oldVersion}"`, `"cindyHeadlessVersion": "${newVersion}"`],
      ['src/compatibility.ts', `CINDY_HEADLESS_VERSION = '${oldVersion}'`, `CINDY_HEADLESS_VERSION = '${newVersion}'`],
      ['README.md', `Version \`${oldVersion}\``, `Version \`${newVersion}\``],
      ['CINDY_FEATURE_PARITY.md', `Cindy Headless \`${oldVersion}\``, `Cindy Headless \`${newVersion}\``],
    ];
    for (const [relative, expected, replacement] of replacements) {
      const file = path.join(appDir, relative);
      const content = await readFile(file, 'utf8');
      if (!content.includes(expected)) throw new Error(`version reference is not synchronized in ${relative}`);
      await writeFile(file, content.replace(expected, replacement));
    }
    console.log(`Automatically incremented Cindy Headless ${oldVersion} -> ${newVersion}.`);
  }

  const { stdout: trackedManifest } = await capture('git', ['ls-files', '--', manifestRelativePath]);
  if (trackedManifest.trim()) await capture('git', ['restore', '--', manifestRelativePath]);
  await capture('git', ['add', '--', appRelativePrefix]);
  const refreshedPackage = JSON.parse(await readFile(packagePath, 'utf8'));
  await capture('git', ['commit', '-s', '-m', `chore(headless): prepare upload bundle ${refreshedPackage.version}`]);
  ({ stdout: headOutput } = await capture('git', ['rev-parse', 'HEAD']));
  head = headOutput.trim();
  console.log(`Created local Headless packaging checkpoint ${head}.`);
} else if (changed.length > 0) {
  const onlyGeneratedManifestChanged = changed.length === 1
    && changed[0].slice(3).replaceAll('\\', '/') === manifestRelativePath;
  if (!onlyGeneratedManifestChanged) throw new Error('unexpected dirty worktree state');

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.bundleMode !== 'formal' || manifest.sourceDirty !== false || manifest.cindyCommit !== head) {
    throw new Error('the only changed file is a stale or development bundle manifest; commit or restore it before packaging');
  }
  reuseExistingFormalBundle = true;
  console.log('Reusing the verified formal bundle already generated from the current HEAD.');
}

if (!reuseExistingFormalBundle) {
  await runPnpm(['--filter', 'cindy-headless', 'bundle:linux']);
}
await runPnpm(['--filter', 'cindy-headless', 'verify:bundle']);
await runPnpm(['--filter', 'cindy-headless', 'package:full']);
await runPnpm(['--filter', 'cindy-headless', 'verify:distribution:full']);

const releaseManifest = JSON.parse(await readFile(path.join(appDir, 'release', 'release-manifest.json'), 'utf8'));
const fullAsset = releaseManifest.assets.find((asset) => /-full-/.test(asset));
if (!fullAsset) throw new Error('full upload asset was not produced');
const uploadPath = path.join(appDir, 'release', fullAsset);
await access(uploadPath);
const bundleManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (bundleManifest.bundleMode !== 'formal' || bundleManifest.sourceDirty !== false || bundleManifest.cindyCommit !== head) {
  throw new Error('refusing upload: bundle identity is not a clean formal build of current HEAD');
}

console.log(JSON.stringify({
  ok: true,
  uploadPath,
  sha256: await sha256(uploadPath),
  sourceCommit: head,
  bundleMode: bundleManifest.bundleMode,
  sourceDirty: bundleManifest.sourceDirty,
}, null, 2));
