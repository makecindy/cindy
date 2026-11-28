import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createActivityReader, readSchedulerActivity } from './activity.mjs';

export { readSchedulerActivity };

let sourcesFactory;
let dependencies;
let currentSources;
let reader;

// Observes the sources passed to the trusted-renderer IPC; its checks are unchanged.
export function cloudActivitySources(factory) {
  sourcesFactory = factory;
  currentSources = null;
  reader?.stop(); reader = null;
  return factory;
}

export function configureCloudActivity(value) {
  dependencies = value;
  reader?.stop(); reader = null;
}

export function readCloudActivity() {
  if (!reader) reader = createActivityReader({
    ...dependencies,
    resolveSources() {
      if (!sourcesFactory || !dependencies) throw new Error('cloud activity not registered');
      // The factory contains live getters. Keep its identity stable for owner fencing.
      if (!currentSources) currentSources = sourcesFactory();
      return currentSources;
    },
  });
  return reader.read();
}

export async function readMaintenanceActivity() {
  const result = await readCloudActivity();
  return { ...result, inputCounts: dependencies.readInput() };
}

/** Separate health heartbeat from async collection; late writes cannot undo stopping. */
export function startCloudStatus({ config, read, onFailure, readOauthIdentity, readAuthRecovery = () => undefined, build,
  collect = readCloudActivity, now = Date.now, intervalMs = 5_000 }) {
  let stopped = false;
  let writing = false;
  let sequence = 0;
  const publish = (status) => {
    const temporary = `${config.statusFile}.${randomUUID()}`;
    try {
      fs.mkdirSync(path.dirname(config.statusFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporary, JSON.stringify(status), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, config.statusFile);
    } catch { onFailure(); }
    finally { fs.rmSync(temporary, { force: true }); }
  };
  const write = async () => {
    if (stopped || writing) return;
    writing = true;
    const generation = ++sequence;
    try {
      const activity = await collect();
      const oauthIdentity = await readOauthIdentity();
      if (stopped || generation !== sequence) return;
      const at = now();
      const status = build(config, read(), at, false, oauthIdentity, readAuthRecovery());
      if (status.phase === 'ready' && (activity.cloudActivity.state === 'unknown' || activity.isCurrent())) {
        status.idle = activity.idle;
        status.cloudActivity = activity.cloudActivity;
      }
      publish(status);
    } catch { if (!stopped) onFailure(); }
    finally { writing = false; }
  };
  void write();
  const timer = setInterval(() => { void write(); }, intervalMs);
  timer.unref();
  return () => {
    stopped = true; sequence++;
    clearInterval(timer);
    reader?.stop();
    try { publish(build(config, read(), now(), true, undefined, readAuthRecovery())); }
    catch { onFailure(); }
  };
}
