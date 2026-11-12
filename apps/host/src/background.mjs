import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readHostEndpoint, readHostProcessStatus } from './control.mjs';

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

/** Read-only attachment. An unreachable live Host must not be replaced: it may
 * still be executing a tool. The authenticated health result binds the address
 * to the endpoint's instance, rather than trusting a reused port or PID. */
export async function existingHost(profile, deps = {}) {
  const endpoint = (deps.readEndpoint ?? readHostEndpoint)(profile);
  if (!endpoint) return null;
  if (!(deps.processExists ?? processExists)(endpoint.pid)) return null;
  if (!endpoint.instanceId) throw new Error('Host has no instance identity; update it while tasks are idle');
  const status = await (deps.status ?? readHostProcessStatus)(profile);
  if (status.running !== true || status.instanceId !== endpoint.instanceId || status.pid !== endpoint.pid
    || status.baseUrl !== endpoint.baseUrl) {
    throw new Error('Existing Host could not be verified; no process was stopped or replaced');
  }
  if (status.clientProtocol !== 1) throw new Error('Host does not support pinned client attachment; update it while tasks are idle');
  return status;
}

/** Developer opt-in. The backend belongs to the profile, not to the desktop
 * child or its terminal. No signal/exit handler here stops a Host. On timeout
 * leave the process and its log available for diagnosis, never infer it is idle.
 * The Host's existing OS lease arbitrates simultaneous launchers. */
export async function ensureBackgroundHost({ profile, command, args, cwd, env = process.env,
  timeoutMs = 60_000 }, deps = {}) {
  const inspect = deps.existingHost ?? existingHost;
  const current = await inspect(profile);
  if (current) return { ...current, started: false };
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const log = path.join(profile, 'host-background.log');
  const output = fs.openSync(log, 'a', 0o600);
  const childEnv = { ...env, CINDY_HOST_DATA_DIR: profile };
  // Never become another writer of the launching Desktop's health heartbeat.
  for (const key of ['CINDY_PERSONAL_MONITOR_DIR', 'CINDY_PERSONAL_GENERATION', 'CINDY_HOST_API',
    'CINDY_HOST_INSTANCE', 'ELECTRON_RUN_AS_NODE', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE']) delete childEnv[key];
  let child, launchError;
  try {
    fs.fchmodSync(output, 0o600);
    child = (deps.spawn ?? spawn)(command, args, {
      cwd, env: childEnv, detached: true, windowsHide: true, stdio: ['ignore', output, output],
    });
    child.once('error', error => { launchError = error; });
    child.unref();
  } finally { fs.closeSync(output); }
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? delay;
  const deadline = now() + timeoutMs;
  do {
    const ready = await inspect(profile);
    if (ready) return { ...ready, started: ready.pid === child.pid, log };
    if (launchError) throw new Error(`Cannot start Host; inspect ${log}`, { cause: launchError });
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Host exited before readiness; inspect ${log}`);
    }
    await wait(100);
  } while (now() < deadline);
  throw new Error(`Host readiness timed out; process was not stopped. Inspect ${log}`);
}
