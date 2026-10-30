import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appDir, '..', '..');
const checks = [];
async function command(name, args = ['--version']) {
  try { const result = await execFileAsync(name, args, { timeout: 30_000 }); checks.push({ name, ok: true, detail: `${result.stdout} ${result.stderr}`.trim().split('\n')[0] }); }
  catch { checks.push({ name, ok: false, detail: 'not available' }); }
}
await command('node');
await command('pnpm');
await command('docker');
await command(process.env.HARBOR_BIN ?? 'harbor');
try {
  const manifest = JSON.parse(await readFile(path.join(appDir, 'bundle', 'linux-x64', 'bundle-manifest.json'), 'utf8'));
  const harnesses = manifest.capabilityCatalog?.harnesses?.map((item) => item.backend) ?? [];
  checks.push({ name: 'bundle', ok: manifest.schemaVersion === 5 && manifest.headlessContractVersion === 1 && ['claude-code', 'codex', 'pi'].every((backend) => harnesses.includes(backend)) && /^[0-9a-f]{40}$/.test(manifest.cindyUpstreamCommit ?? '') && Boolean(manifest.cliDigest && manifest.evalCliDigest && manifest.profilesDigest && manifest.nodeBinaryDigest && manifest.nodeVersion && manifest.piRuntimeDigest), detail: `${manifest.cindyHeadlessVersion ?? 'unknown'} / ${manifest.cindyUpstreamCommit ?? 'unknown'}` });
} catch { checks.push({ name: 'bundle', ok: false, detail: 'missing or invalid manifest' }); }
const configCandidates = [path.join(appDir, 'config.local.json'), process.env.CINDY_HEADLESS_CONFIG_FILE].filter(Boolean);
let configured = Boolean(process.env.CINDY_HEADLESS_API_KEY && process.env.CINDY_HEADLESS_BASE_URL);
for (const file of configCandidates) { try { await access(file); configured = true; break; } catch { /* continue */ } }
checks.push({ name: 'gateway', ok: configured, detail: configured ? 'configured (secret not read)' : 'missing' });
const failed = checks.filter((check) => !check.ok);
console.log(JSON.stringify({ status: failed.length ? 'MISSING_DEPENDENCY' : 'READY', repoRoot, checks }, null, 2));
if (failed.length) process.exitCode = 1;
