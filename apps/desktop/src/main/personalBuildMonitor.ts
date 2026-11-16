import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './utils/atomicWriteFile.js';

/** Consume launcher-only routing before Main can spawn agents or other dev apps. */
export function consumePersonalMonitorEnvironment(env: NodeJS.ProcessEnv) {
  const directory = env.CINDY_PERSONAL_MONITOR_DIR;
  const generation = env.CINDY_PERSONAL_GENERATION;
  delete env.CINDY_PERSONAL_MONITOR_DIR;
  delete env.CINDY_PERSONAL_GENERATION;
  return directory && generation ? { directory, generation } : null;
}
export const personalMonitorEnvironment = consumePersonalMonitorEnvironment(process.env);
let monitorOwned = false;
export function ownsPersonalBuildMonitor() { return monitorOwned; }

export interface PersonalBuildMonitorDeps {
  directory: string;
  generation: string;
  pid: number;
  now(): number;
  ready(): boolean;
  remoteReady(): boolean;
  idle(): boolean;
  busy(): Promise<boolean>;
  quitting(): boolean;
  quit(): void;
  updateLocalPlugins?(): Promise<unknown>;
}

/** Explicit developer launcher only. This is a local, generation-bound graceful-quit handoff;
 * Local plugin updates use the Host's existing installer only after supervisor promotion. */
export function createPersonalBuildMonitor(d: PersonalBuildMonitorDeps) {
  if (!path.isAbsolute(d.directory) || !/^[a-f0-9-]{36}$/.test(d.generation))
    throw new Error('Invalid personal build monitor identity');
  const st = fs.lstatSync(d.directory);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) !== 0)
    throw new Error('Personal build monitor needs a private directory');
  // A pre-owner-file host may already be writing here. Do not adopt its generation either.
  if (fs.existsSync(path.join(d.directory, 'heartbeat.json'))) return async () => {};
  // A generation is single-use. Never reclaim it, even when its original PID has exited.
  // Older hosts can still leak routing to a child; that child must not overwrite health evidence.
  try {
    fs.writeFileSync(path.join(d.directory, 'host-owner.json'), JSON.stringify({ pid: d.pid, generation: d.generation }),
      { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return async () => {};
    throw error;
  }
  monitorOwned = true;
  let active = false;
  const heartbeat = path.join(d.directory, 'heartbeat.json');
  const request = path.join(d.directory, 'request.json');
  return async function tick() {
    if (active || d.quitting()) return;
    active = true;
    try {
      let busy = true;
      try { busy = await d.busy(); } catch { /* Unknown activity is busy. */ }
      const ready = d.ready(), remoteReady = d.remoteReady(), idle = d.idle();
      atomicWriteFileSync(heartbeat, JSON.stringify({ protocol: 1, generation: d.generation,
        pid: d.pid, at: d.now(), ready, remoteReady, busy, idle }));
      if (!ready || busy || !idle || d.quitting()) return;
      type Request = { action?: string; generation?: string; pid?: number; expiresAt?: number; requireRemote?: boolean };
      const read = (file: string): Request => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
      const pluginRequest = path.join(d.directory, 'plugins-request.json');
      const quitRequest = read(request);
      const r = quitRequest.action === 'quit' ? quitRequest : read(pluginRequest);
      if ((r.action !== 'quit' && (r.action !== 'update-local-plugins' || !d.updateLocalPlugins)) || r.generation !== d.generation || r.pid !== d.pid ||
        !Number.isFinite(r.expiresAt) || r.expiresAt! < d.now() || r.expiresAt! > d.now() + 30_000) return;
      // Refresh all gates after the asynchronous activity query, immediately before normal quit.
      if (await d.busy() || !d.ready() || !d.idle() || d.quitting()
        || d.now() > r.expiresAt! || r.requireRemote === true && !d.remoteReady()) return;
      if (r.action === 'quit') { fs.unlinkSync(request); d.quit(); return; }
      const resultFile = path.join(d.directory, 'plugins-result.json');
      // Persist started before consumption; a crash is visible and never causes
      // an automatic repeat of a mutation whose outcome is unknown.
      const result = { generation: d.generation, pid: d.pid, at: d.now() };
      atomicWriteFileSync(resultFile, JSON.stringify({ ...result, phase: 'applying' }));
      fs.unlinkSync(pluginRequest);
      try {
        const report = await d.updateLocalPlugins!();
        atomicWriteFileSync(resultFile, JSON.stringify({ ...result, at: d.now(), phase: 'completed', report }));
      } catch (error) {
        atomicWriteFileSync(resultFile, JSON.stringify({ ...result, at: d.now(), phase: 'failed', error: error instanceof Error ? error.message : String(error) }));
      }
    } finally { active = false; }
  };
}
