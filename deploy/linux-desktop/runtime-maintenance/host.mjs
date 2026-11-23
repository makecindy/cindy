import fs from 'node:fs';
import { createMaintenanceGate, atomicJson, ingresses, shutdownEvidence, maintenanceActivitySample } from './gate.mjs';

const directory = '/run/cindy-maintenance';
const ledgerFile = '/var/lib/cindy/user-data/.cis-maintenance/ledger.json';
const receiptFile = '/var/lib/cindy/status/maintenance.json';
// Read by the stopped-volume backup Pod; next to the ledger, outside business data.
const shutdownFile = '/var/lib/cindy/user-data/.cis-maintenance/shutdown.json';
let gate, activity, polling = false;
// ConfigMap projections are symlinks, reopened each time; the PVC ledger is not.
const projected = name => {
  const p = `${directory}/${name}`;
  if (fs.statSync(p).size > 16384) throw new Error('MAINTENANCE_FILE_INVALID');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
};
if (process.platform === 'linux' && process.argv.includes('--cloud-instance')) {
  if (fs.existsSync(directory)) {
    const binding = projected('binding.json');
    if (binding.deviceId !== process.env.CINDY_POD_DEVICE_ID) throw new Error('MAINTENANCE_DEVICE_MISMATCH');
    const podUid = fs.readFileSync('/run/cindy-maintenance-identity/pod-uid', 'utf8').trim();
    const existed = fs.existsSync(ledgerFile);
    gate = createMaintenanceGate({ binding, podUid, ledgerFile, coverage: ingresses });
    // Loss of an active operation ledger is not permission to start work.
    if (!existed && projected('command.json') !== null) gate.hold();
  } else if (fs.existsSync(ledgerFile)) {
    throw new Error('MAINTENANCE_MOUNT_MISSING');
  }
}
export const cloudMaintenance = {
  run(kind, fn, existing = false) { return gate ? gate.run(kind, fn, existing) : fn(); },
  admit(kind, existing = false) { gate?.admit(kind, existing); },
  restoreScheduleWake(schedule, computed, at) { return gate ? gate.restoreScheduleWake(schedule, computed, at) : computed; },
  schedulerAllowed() { return !gate || gate.schedulerAllowed(); },
  scan(fn) { return gate ? gate.scan(fn) : fn(); },
};
let quitFaults = 0;
/** Wired into the desktop quit chain by the build overlay. */
export const cloudMaintenanceQuit = {
  fault() { quitFaults++; },
  completed(reason) {
    if (!gate) return;
    try {
      const evidence = shutdownEvidence(gate.receipt(), { reason, faults: quitFaults, now: Date.now() });
      // Last durable write of an orderly quit; app.exit follows synchronously.
      if (evidence) atomicJson(shutdownFile, evidence);
    } catch { /* no evidence: the backup refuses this volume */ }
  },
};
export function configureMaintenanceActivity(collect) { activity = collect; }
async function poll() {
  if (!gate || polling) return;
  polling = true;
  try {
    const revision = gate.revision();
    const observation = activity ? await activity() : null;
    gate.observe(maintenanceActivitySample(observation), revision);
    const command = projected('command.json');
    if (command !== null) {
      try { gate.accept(command); } catch { /* rejected/stale command never opens admission */ }
    }
    atomicJson(receiptFile, gate.receipt());
  } catch {
    // Never publish fabricated idle on a failed read; the control service expires the old receipt.
  } finally { polling = false; }
}
if (gate) {
  // The gate was restored synchronously before any entry can call run().
  void poll();
  const timer = setInterval(() => { void poll(); }, 2000); timer.unref();
}
