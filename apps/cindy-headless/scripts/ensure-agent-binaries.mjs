import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, cp, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appDir, '..', '..');
const cacheDir = path.resolve(process.env.CINDY_HEADLESS_BINARY_CACHE ?? path.join(appDir, '.cache', 'bin', 'linux-x64'));
const metadataRoot = process.env.CINDY_HEADLESS_METADATA_ROOT ?? repoRoot;
const claudeMeta = JSON.parse(await readFile(path.join(metadataRoot, 'tools', 'claude', 'latest.json'), 'utf8'));
const codexMeta = JSON.parse(await readFile(path.join(metadataRoot, 'tools', 'codex', 'latest.json'), 'utf8'));
const piMeta = JSON.parse(await readFile(path.join(metadataRoot, 'tools', 'pi', 'latest.json'), 'utf8'));

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function download(url, output) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`download failed (${response.status}) for ${url}`);
  const temporary = `${output}.download`;
  await rm(temporary, { force: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
  await rename(temporary, output);
}

async function ensureClaude() {
  const asset = claudeMeta.runtimeAssets['linux-x64'];
  const output = path.join(cacheDir, 'claude');
  try { if ((await stat(output)).size === asset.size && await digest(output) === asset.sha256) return output; } catch { /* download */ }
  await download(asset.url, output);
  if (await digest(output) !== asset.sha256) throw new Error('downloaded Claude binary digest mismatch');
  await chmod(output, 0o755);
  return output;
}

async function ensureCodex() {
  const asset = codexMeta.runtimeAssets['linux-x64'];
  const archive = path.join(cacheDir, 'codex.tar.gz');
  const output = path.join(cacheDir, 'codex');
  if (!(await stat(archive).catch(() => null)) || await digest(archive) !== asset.sha256) {
    await download(asset.url, archive);
    if (await digest(archive) !== asset.sha256) throw new Error('downloaded Codex archive digest mismatch');
  }
  const extractDir = path.join(cacheDir, '.codex-extract');
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  await execFileAsync('tar', ['-xzf', path.basename(archive), '-C', path.basename(extractDir)], { cwd: cacheDir });
  const candidates = ['codex-x86_64-unknown-linux-musl', 'codex'];
  let source;
  for (const candidate of candidates) {
    const file = path.join(extractDir, candidate);
    if (await stat(file).catch(() => null)) { source = file; break; }
  }
  if (!source) throw new Error('Codex archive did not contain the expected binary');
  await rm(output, { force: true });
  await rename(source, output);
  await chmod(output, 0o755);
  await rm(extractDir, { recursive: true, force: true });
  return output;
}

async function ensurePi() {
  const asset = piMeta.runtimeAssets['linux-x64'];
  const archive = path.join(cacheDir, 'pi.tar.gz');
  const outputDir = path.join(cacheDir, 'pi');
  const output = path.join(outputDir, 'pi');
  // Pi is a directory distribution. Re-extract the pinned archive on every
  // preparation so a present executable cannot hide missing or modified
  // sibling themes/native assets.
  if (!(await stat(archive).catch(() => null)) || await digest(archive) !== asset.sha256) {
    await download(asset.url, archive);
    if (await digest(archive) !== asset.sha256) throw new Error('downloaded Pi archive digest mismatch');
  }
  const extractDir = path.join(cacheDir, '.pi-extract');
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  await execFileAsync('tar', ['-xzf', path.basename(archive), '-C', path.basename(extractDir)], { cwd: cacheDir });
  const nested = path.join(extractDir, 'pi');
  const source = (await stat(path.join(nested, 'pi')).catch(() => null)) ? nested : extractDir;
  await rm(outputDir, { recursive: true, force: true });
  await cp(source, outputDir, { recursive: true });
  await chmod(output, 0o755);
  await rm(extractDir, { recursive: true, force: true });
  return output;
}

await mkdir(cacheDir, { recursive: true });
const [claude, codex, pi] = await Promise.all([ensureClaude(), ensureCodex(), ensurePi()]);
console.log(JSON.stringify({ ok: true, cacheDir, claude, codex, pi, claudeVersion: claudeMeta.version, codexVersion: codexMeta.version, piVersion: piMeta.version }, null, 2));
