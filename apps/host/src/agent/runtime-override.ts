import { getSessionRuntimeControlSnapshot } from '../../../desktop/src/main/maker-ipc/sessionRuntimeControl.ts';

/** The start options a task runtime is created with (the fields the runtime override sets). */
export interface RuntimeOverrideStart {
  id?: string;
  agentKind?: string;
  model?: string;
  providerId?: string | null;
  effort?: string;
  fastMode?: boolean | 'ultrafast';
}

/**
 * The accepted, not deferred runtime mutation of a task (an automatic route fallback, a model or
 * source change applied to a live runtime) wins over the stored route when its runtime starts, as
 * the desktop's bootstrapSession applies it (register.ts, `runtimeOverride` after
 * waitForAccountProviderModelsReady, before the start admission). Without it, a runtime rebuilt
 * after an automatic route fallback started on the failing route again: the options reconciler
 * reads the task row, which a fallback does not write.
 *
 * Copied from register.ts, where it is inline in bootstrapSession; the desktop's provider-group
 * clause is left out because the Host refuses provider-group tasks at admission (send-preflight.ts),
 * so a provider group never decides the source here. A source text guard keeps the copy with the
 * desktop (hostDesktopSourceContracts.guard.test.ts).
 */
export function applyRuntimeOverrideForStart(o: RuntimeOverrideStart): void {
  const runtimeOverride =
    typeof o.id === 'string' ? getSessionRuntimeControlSnapshot(o.id).effectiveOverride : null;
  if (runtimeOverride && runtimeOverride.agentKind === o.agentKind) {
    o.model = runtimeOverride.model;
    o.providerId = runtimeOverride.providerId;
    o.effort = runtimeOverride.effort ?? undefined;
    o.fastMode = runtimeOverride.fastMode;
  }
}
