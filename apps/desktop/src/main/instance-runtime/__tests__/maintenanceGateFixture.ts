import { connectInstanceMaintenance, type InstanceMaintenanceGate } from '../maintenance.js';

/** A maintenance gate that refuses new work once maintenance begins and counts what it runs. */
export function connectTestMaintenanceGate() {
  const state = { preparing: false, inFlight: 0 };
  const gate: InstanceMaintenanceGate = {
    admit() {
      if (state.preparing) throw Object.assign(new Error('CLOUD_MAINTENANCE_RETRY'), { code: 'CLOUD_MAINTENANCE_RETRY' });
    },
    run(kind, work) {
      gate.admit(kind);
      state.inFlight++;
      return work().finally(() => { state.inFlight--; });
    },
  };
  connectInstanceMaintenance(gate);
  return state;
}

/** Back to an ordinary desktop, which has no maintenance gate. */
export function disconnectTestMaintenanceGate(): void {
  connectInstanceMaintenance({ admit() {}, run: (_kind, work) => work() });
}
