#!/usr/bin/env node
/**
 * Run the desktop against a cindy-host.
 *
 * This explicit developer entry reads host-endpoint.json and sets CINDY_HOST_API
 * for its desktop child. Normal desktop startup does not discover a host.
 * The wrapper starts a host when needed and reuses an existing one as-is.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHostDataDir } from '../apps/host/src/profile-path.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const userDataDir = resolveHostDataDir();
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
  const build = spawn(process.execPath, [process.env.npm_execpath, '--filter', 'desktop', 'exec', 'vite', 'build', '--config', 'vite.renderer.config.ts'], {
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

const desktop = spawn(process.execPath, [process.env.npm_execpath, '--filter', 'desktop', 'dev', ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, XDT_USER_DATA_DIR: userDataDir, CINDY_HOST_API: runningEndpoint().baseUrl },
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
