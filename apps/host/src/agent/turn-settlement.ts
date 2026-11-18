// A profile hold spans two input runtimes. Keep acceptance evidence with the
// pending choice, outside either queue. The Host uses an in-process SQLite DB.
import { eq } from 'drizzle-orm';
import { getActiveAppSession } from '../../../desktop/src/main/appSessionState.ts';
import { getCurrentDbClientSnapshot } from '../../../desktop/src/main/localDb/client/current.ts';
import { sessions } from '../../../desktop/src/main/localDb/schema.ts';
import type { CredentialSettlementPermit, PendingCredentialSwitch, PendingCredentialSwitchService } from '../../../desktop/src/main/maker-ipc/pendingCredentialSwitch.ts';
import { cancelPendingSessionRuntimeMutation, getPendingSessionRuntimeMutation } from '../../../desktop/src/main/maker-ipc/sessionRuntimeControl.ts';

function readRoute(id: string) {
  // The desktop's runtime route key identifies the engine, model, provider and
  // device. Include the saved remote host as well when comparing the task row.
  const db = getCurrentDbClientSnapshot();
  return db?.client.drizzle.select({
    engine: sessions.agentKind, model: sessions.model, provider: sessions.providerId,
    device: sessions.agentDeviceId, host: sessions.remoteHostId,
  }).from(sessions).where(eq(sessions.id, id)).get();
}

function capture(id: string) {
  return { db: getCurrentDbClientSnapshot(), account: getActiveAppSession().generation, route: readRoute(id) };
}
type Acceptance = ReturnType<typeof capture>;
const sameOwner = (accepted: Acceptance | undefined) => !!accepted?.db &&
  accepted.db === getCurrentDbClientSnapshot() && accepted.account === getActiveAppSession().generation;
function sameRoute(id: string, accepted: Acceptance | undefined) {
  const then = accepted?.route;
  const now = readRoute(id);
  return !!now && !!then && now.engine === then.engine && now.model === then.model &&
    now.provider === then.provider && now.device === then.device && now.host === then.host;
}

interface Deferred {
  credential?: PendingCredentialSwitch;
  runtime?: number;
  staleRuntime?: boolean;
}

export function createHostTurnSettlement(ports: {
  open(): boolean;
  busy(id: string): boolean;
  retry(id: string): void;
  credentials(): PendingCredentialSwitchService;
  applyControl(id: string): Promise<void> | undefined;
}) {
  const credentialAcceptance = new WeakMap<PendingCredentialSwitch, Acceptance>();
  const controls = new Map<string, { generation: number; accepted: Acceptance }>();
  const deferred = new Map<string, Deferred>();
  const active = new Map<string, { admission?: Deferred; work: Promise<boolean> }>();
  const applyingControl = new Map<string, Acceptance>();
  const waitingForCredentials = new Set<string>();
  const retryScheduled = new Set<string>();

  function retryIfIdle(id: string) {
    if (active.has(id) || retryScheduled.has(id) || !ports.open()) return;
    retryScheduled.add(id);
    queueMicrotask(() => {
      retryScheduled.delete(id);
      if (ports.open() && !ports.busy(id)) ports.retry(id);
    });
  }

  const permit: CredentialSettlementPermit = {
    registered(id, target) {
      credentialAcceptance.set(target, capture(id));
      if (!ports.open()) deferred.set(id, {});
    },
    allows(id, target) {
      if (!ports.open()) return false;
      if (deferred.has(id) && ports.busy(id)) return false;
      if (deferred.has(id) && deferred.get(id)?.credential !== target) {
        // A retry after rebuild must pass the same ordered checks as the terminal.
        retryIfIdle(id);
        return false;
      }
      return sameOwner(credentialAcceptance.get(target));
    },
  };
  function observeControl(id: string) {
    const pending = getPendingSessionRuntimeMutation(id);
    if (!pending) { controls.delete(id); return; }
    if (controls.get(id)?.generation === pending.generation) return;
    controls.set(id, { generation: pending.generation, accepted: capture(id) });
    if (!ports.open()) deferred.set(id, {});
  }
  function hold() {
    // Revoke any in-flight admission before either the timer or a late DB read resumes.
    for (const id of new Set([...deferred.keys(), ...active.keys(), ...controls.keys()])) deferred.set(id, {});
    for (const [id] of ports.credentials().entries()) deferred.set(id, {});
  }
  const allowedControl = (id: string, generation: number) =>
    ports.open() && sameOwner(applyingControl.get(id)) && (!deferred.has(id) || (!ports.busy(id) && deferred.get(id)?.runtime === generation));

  async function run(id: string): Promise<boolean> {
    if (!ports.open()) { deferred.set(id, {}); return false; }
    const admission = deferred.get(id);
    const owner = getCurrentDbClientSnapshot();
    const account = getActiveAppSession().generation;
    const current = () => ports.open() && admission === deferred.get(id) && !ports.busy(id) &&
      owner === getCurrentDbClientSnapshot() && account === getActiveAppSession().generation;
    if (!current()) return false;
    const service = ports.credentials();
    const previous = service.waitForIdle(id);
    if (previous) await previous;
    if (!current()) return false;
    const credential = service.get(id);
    if (credential) {
      const accepted = credentialAcceptance.get(credential);
      const ownerCurrent = sameOwner(accepted);
      if (!ownerCurrent || (admission && !sameRoute(id, accepted))) {
        // The desktop owns its new route. Never restore the old row on invalidation.
        service.discard(id, credential, ownerCurrent);
      } else {
        if (admission) admission.credential = credential;
        waitingForCredentials.add(id);
        await service.onTurnSettled(id);
      }
    }
    if (!current() || service.has(id)) return false;
    waitingForCredentials.delete(id);
    const control = getPendingSessionRuntimeMutation(id);
    if (control) {
      const saved = controls.get(id);
      if (!saved || !sameOwner(saved.accepted)) {
        cancelPendingSessionRuntimeMutation(id, control.generation);
      } else {
        if (admission) {
          admission.runtime = control.generation;
          admission.staleRuntime = saved.generation !== control.generation || !sameRoute(id, saved.accepted);
        }
        applyingControl.set(id, saved.accepted);
        try { await ports.applyControl(id); }
        finally { applyingControl.delete(id); }
      }
    }
    if (!current() || getPendingSessionRuntimeMutation(id)) return false;
    deferred.delete(id);
    controls.delete(id);
    return true;
  }
  function settle(id: string): Promise<boolean> {
    const running = active.get(id);
    if (running) {
      // A terminal started before the hold. After its outstanding I/O drains,
      // the rebuilt runtime still owes a fresh comparison against the stored row.
      if (running.admission !== deferred.get(id) && ports.open()) return running.work.then(() => settle(id));
      return running.work;
    }
    const admission = deferred.get(id);
    const work = run(id).finally(() => active.delete(id));
    active.set(id, { admission, work });
    return work;
  }
  return {
    permit, hold, observeControl, settle, allowedControl,
    pendingIds: () => [...deferred.keys()],
    deferredDbKind(id: string) {
      // The rebuilt executor has no live history yet. The credential write must
      // still reconcile effort/window against the stored task's engine.
      if (!deferred.has(id)) return null;
      const kind = readRoute(id)?.engine;
      return kind === 'cc' || kind === 'pi' || kind === 'codex' ? kind : null;
    },
    credentialApplied(id: string) {
      if (waitingForCredentials.has(id)) retryIfIdle(id);
    },
    dispose() {
      for (const [id] of ports.credentials().entries()) ports.credentials().clear(id);
      deferred.clear();
      controls.clear();
      applyingControl.clear();
      waitingForCredentials.clear();
    },
    assertControl(id: string, generation: number) {
      if (!allowedControl(id, generation) || deferred.get(id)?.staleRuntime) throw new Error('pending runtime route changed or settlement deferred');
    },
  };
}
