#!/usr/bin/env node
/**
 * Run the desktop against a cindy-host.
 *
 * The desktop joins a running host automatically (it reads host-endpoint.json);
 * this wrapper makes sure one exists, so `pnpm dev:host` never falls back to the
 * embedded runtime. When a host is already running it is reused as-is.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const userDataDir = process.env.CINDY_HOST_DATA_DIR?.trim()
  || process.env.XDT_USER_DATA_DIR?.trim()
  || path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME ?? '', '.config'), 'CindyGlobal');
const endpointFile = path.join(userDataDir, 'host-endpoint.json');

function runningEndpoint() {
  try {
    const parsed = JSON.parse(fs.readFileSync(endpointFile, 'utf-8'));
    if (typeof parsed?.pid !== 'number' || typeof parsed?.baseUrl !== 'string') return null;
    process.kill(parsed.pid, 0);
    return parsed;
  } catch {
    return null;
  }
}

async function waitForEndpoint(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const endpoint = runningEndpoint();
    if (endpoint) return endpoint;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

/**
 * The host serves the real renderer bundle, and a desktop build wipes it. Build
 * it first so `pnpm dev:host` never serves a 404 to the browser client.
 */
async function ensureRendererBundle() {
  const entry = path.join(repoRoot, 'apps/desktop/.vite/renderer/main_window/index.html');
  if (fs.existsSync(entry)) return;
  console.log('[dev:host] building the renderer bundle');
  const build = spawn('pnpm', ['--filter', 'desktop', 'exec', 'vite', 'build', '--config', 'vite.renderer.config.ts'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  const code = await new Promise((resolve) => build.on('exit', resolve));
  if (code !== 0) {
    console.error('[dev:host] renderer build failed');
    process.exit(code ?? 1);
  }
}

let host = null;
await ensureRendererBundle();
if (!runningEndpoint()) {
  console.log(`[dev:host] starting cindy-host for ${userDataDir}`);
  host = spawn(
    process.execPath,
    ['--import', 'tsx', '--import', './apps/host/src/loaders/register-raw.mjs', 'apps/host/src/main.ts'],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, CINDY_HOST_DATA_DIR: userDataDir },
    },
  );
  const endpoint = await waitForEndpoint(15_000);
  if (!endpoint) {
    console.error('[dev:host] cindy-host did not publish an endpoint; stopping');
    host.kill('SIGTERM');
    process.exit(1);
  }
  console.log(`[dev:host] cindy-host ready at ${endpoint.baseUrl}`);
}

const desktop = spawn('pnpm', ['--filter', 'desktop', 'dev', ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, XDT_USER_DATA_DIR: userDataDir },
});

const shutdown = (signal) => {
  host?.kill(signal);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

desktop.on('exit', (code) => {
  shutdown('SIGTERM');
  process.exit(code ?? 0);
});
