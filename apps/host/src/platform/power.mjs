import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { preparePowerWorker } from './assets.mjs';

/** Private inherited stdio, not an unauthenticated OS-control HTTP service.
 * @param {{profileDir:string,binary?:string,script?:string,spawnImpl?:typeof spawn}} options
 */
export async function createHostPowerMonitor({ profileDir, binary, script, spawnImpl = spawn }) {
  const root = path.join(profileDir, 'platform-power');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const env = { ...process.env, CINDY_PLATFORM_PROFILE: root };
  for (const name of Object.keys(env)) if (/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|CINDY_PERSONAL_|XDT_PERSONAL_|CINDY_HOST_)/.test(name)) delete env[name];
  const assets = binary && script ? { binary, script, close: async () => {} } : await preparePowerWorker();
  let child;
  try { child = spawnImpl(assets.binary, [assets.script], {
    env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  }); } catch (error) { await assets.close(); throw error; }
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  let closing;
  const stop = () => closing ??= (async () => {
    // Only reap the exact worker created by this monitor. Never a driver or UI.
    child.stdin.end();
    const terminate = setTimeout(() => child.kill('SIGTERM'), 500);
    const kill = setTimeout(() => child.kill('SIGKILL'), 1500);
    try { await exited; } finally { clearTimeout(terminate); clearTimeout(kill); await assets.close(); }
  })();
  const events = new EventEmitter();
  let sequence = 0, epoch = 0, closed = false, sample = null;
  const requests = new Map();
  const lines = createInterface({ input: child.stdout });
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const fail = () => {
    closed = true; sample = null;
    const error = new Error('PLATFORM_MONITOR_UNAVAILABLE');
    rejectReady(error);
    for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(error); }
    requests.clear();
  };
  child.once('exit', fail); child.once('error', fail);
  child.stdin.on('error', fail);
  lines.on('line', line => {
    if (line.length > 8192) return;
    let value;
    try { value = JSON.parse(line); } catch { return; }
    if (value.ready === true && value.pid === child.pid) return resolveReady();
    if (['lock-screen', 'unlock-screen'].includes(value.event)) { epoch++; sample = null; events.emit(value.event); return; }
    const pending = requests.get(value.id); if (!pending) return;
    requests.delete(value.id); clearTimeout(pending.timer);
    if (value.error) pending.reject(new Error('PLATFORM_MONITOR_UNAVAILABLE'));
    else pending.resolve(value.result);
  });
  const startupTimer = setTimeout(() => rejectReady(new Error('PLATFORM_MONITOR_START_TIMEOUT')), 15_000);
  try { await ready; } catch (error) { await stop(); lines.close(); throw error; } finally { clearTimeout(startupTimer); }
  const read = () => {
    if (closed || !sample || Date.now() - sample.at > 1000) throw new Error('PLATFORM_MONITOR_STALE');
    return sample;
  };
  async function refresh() {
    if (closed) throw new Error('PLATFORM_MONITOR_UNAVAILABLE');
    sample = null;
    const id = ++sequence;
    const requestedEpoch = epoch;
    const value = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { requests.delete(id); reject(new Error('PLATFORM_MONITOR_TIMEOUT')); }, 3000);
      requests.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method: 'sample' })}\n`, error => { if (error) fail(); });
    });
    if (requestedEpoch !== epoch || id !== sequence) {
      sample = null; throw new Error('PLATFORM_MONITOR_STATE_CHANGED');
    }
    if (closed || value?.known !== true || !Number.isFinite(value.idle) || value.idle < 0 || !['active', 'idle', 'locked'].includes(value.state)) {
      sample = null; throw new Error('PLATFORM_MONITOR_STATE_UNKNOWN');
    }
    sample = { ...value, at: Date.now() };
  }
  return {
    refresh, pid: child.pid, assertAvailable: () => { read(); },
    getSystemIdleTime: () => read().idle,
    getSystemIdleState: () => read().state,
    on: (event, listener) => events.on(event, listener),
    removeListener: (event, listener) => events.removeListener(event, listener),
    async close() {
      fail();
      try { await stop(); } finally { lines.close(); events.removeAllListeners(); }
    },
  };
}
