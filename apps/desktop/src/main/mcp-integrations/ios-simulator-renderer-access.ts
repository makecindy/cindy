import type {
  IOSSimulatorFocusRequest,
  IOSSimulatorPublicRouteStatus,
} from '../../shared/iosSimulatorIpc.js';
import { IOS_SIMULATOR_ROUTE_STATUS_CHANNEL } from '../../shared/iosSimulatorIpc.js';

const IOS_SIMULATOR_FOCUS_REQUEST_CHANNEL = 'maker:ios-simulator:focus-request';

export interface IOSSimulatorRendererWebContents {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
  once(event: 'destroyed', listener: () => void): unknown;
}

export interface IOSSimulatorRendererTargetSet {
  /** Exact WebContents allowed to use the session-scoped Simulator IPC surface. */
  grantTargets: readonly IOSSimulatorRendererWebContents[];
  /** One target receives the panel-focus command; companions only receive route status. */
  focusTarget: IOSSimulatorRendererWebContents | null;
}

export type IOSSimulatorRendererTargetResolver = (
  preferredTarget?: IOSSimulatorRendererWebContents,
) => IOSSimulatorRendererTargetSet | null;

export type IOSSimulatorRendererAccessConfirmation = (
  target: IOSSimulatorRendererWebContents,
  sessionId: string,
) => Promise<boolean>;

export type IOSSimulatorAgentControlConfirmation = (
  target: IOSSimulatorRendererWebContents,
  sessionId: string,
  instanceId: string,
) => Promise<boolean>;

export interface IOSSimulatorAgentControlApproval {
  readonly sessionId: string;
  readonly instanceId: string;
  readonly grantGeneration: number;
  readonly lifecycleEpoch: number;
  readonly elevationEpoch: number;
}

export type IOSSimulatorRendererGrant = {
  sessionId: string;
  generation: number;
  target: IOSSimulatorRendererWebContents;
};

export type IOSSimulatorRendererAccessSnapshot = Pick<
  IOSSimulatorRendererGrant,
  'sessionId' | 'generation'
>;

export type IOSSimulatorRendererAccessRevocationObserver = (
  grants: readonly IOSSimulatorRendererGrant[],
) => void;

/**
 * Main-owned capability registry for the privileged Simulator renderer surface.
 *
 * A renderer URL, route hash, or renderer-reported sidebar context is never an
 * authorization source. Grants are minted only by an authoritative Host flow
 * that already owns the sessionId, and one WebContents can hold only one live
 * session grant at a time.
 */
export class IOSSimulatorRendererAccessRegistry {
  private readonly grants = new Map<number, IOSSimulatorRendererGrant>();
  private readonly trackedTargets = new Map<number, IOSSimulatorRendererWebContents>();
  private readonly targetEpochs = new Map<number, number>();
  private readonly sessionEpochs = new Map<string, number>();
  private readonly pendingAccess = new Map<
    number,
    { sessionId: string; promise: Promise<boolean> }
  >();
  private readonly pendingAgentControl = new Map<
    string,
    {
      sessionId: string;
      instanceId: string;
      promise: Promise<IOSSimulatorAgentControlApproval | null>;
    }
  >();
  private readonly agentControlEpochs = new Map<string, number>();
  private readonly accessCooldownUntil = new Map<number, number>();
  private resolver: IOSSimulatorRendererTargetResolver | null = null;
  private confirmation: IOSSimulatorRendererAccessConfirmation | null = null;
  private agentControlConfirmation: IOSSimulatorAgentControlConfirmation | null = null;
  private revocationObserver: IOSSimulatorRendererAccessRevocationObserver | null = null;
  private nextGeneration = 0;
  private lifecycleEpoch = 0;

  private static readonly ACCESS_REQUEST_COOLDOWN_MS = 2_000;

  configureResolver(resolver: IOSSimulatorRendererTargetResolver | null): void {
    this.resolver = resolver;
  }

  configureConfirmation(confirmation: IOSSimulatorRendererAccessConfirmation | null): void {
    this.confirmation = confirmation;
  }

  configureAgentControlConfirmation(
    confirmation: IOSSimulatorAgentControlConfirmation | null,
  ): void {
    this.agentControlConfirmation = confirmation;
  }

  configureRevocationObserver(observer: IOSSimulatorRendererAccessRevocationObserver | null): void {
    this.revocationObserver = observer;
  }

  hasAccess(target: IOSSimulatorRendererWebContents, sessionId: string): boolean {
    const grant = this.grants.get(target.id);
    if (
      !grant ||
      grant.target !== target ||
      grant.sessionId !== sessionId ||
      grant.target.isDestroyed()
    ) {
      if (grant?.target.isDestroyed()) this.revokeGrant(target.id, grant);
      return false;
    }
    return true;
  }

  /** Exact Main-owned binding for this live WebContents, never a route hint. */
  accessSnapshot(
    target: IOSSimulatorRendererWebContents,
  ): IOSSimulatorRendererAccessSnapshot | null {
    const grant = this.grants.get(target.id);
    if (!grant || grant.target !== target || grant.target.isDestroyed()) {
      if (grant?.target.isDestroyed()) this.revokeGrant(target.id, grant);
      return null;
    }
    return { sessionId: grant.sessionId, generation: grant.generation };
  }

  grantAndFocus(
    sessionId: string,
    instanceId?: string,
    preferredTarget?: IOSSimulatorRendererWebContents,
  ): boolean {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return false;
    const resolved = this.resolveTargets(preferredTarget);
    if (!resolved?.focusTarget) return false;
    const { focusTarget, targets } = resolved;
    if (targets.get(focusTarget.id) !== focusTarget) return false;

    const generation = this.grantTargets(normalizedSessionId, targets.values());

    const request: IOSSimulatorFocusRequest = {
      sessionId: normalizedSessionId,
      ...(instanceId?.trim() ? { instanceId: instanceId.trim() } : {}),
      userInitiated: false,
    };
    try {
      focusTarget.send(IOS_SIMULATOR_FOCUS_REQUEST_CHANNEL, request);
      return true;
    } catch {
      this.revokeGeneration(generation);
      return false;
    }
  }

  requestAccess(sessionId: string, target: IOSSimulatorRendererWebContents): Promise<boolean> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId || target.isDestroyed()) return Promise.resolve(false);
    if (this.hasAccess(target, normalizedSessionId)) return Promise.resolve(true);
    if (!this.confirmation || Date.now() < (this.accessCooldownUntil.get(target.id) ?? 0)) {
      return Promise.resolve(false);
    }
    const current = this.pendingAccess.get(target.id);
    if (current) {
      return current.sessionId === normalizedSessionId ? current.promise : Promise.resolve(false);
    }

    const promise = this.performAccessRequest(normalizedSessionId, target).finally(() => {
      const pending = this.pendingAccess.get(target.id);
      if (pending?.promise === promise) this.pendingAccess.delete(target.id);
    });
    this.pendingAccess.set(target.id, { sessionId: normalizedSessionId, promise });
    return promise;
  }

  /**
   * Ask Main-owned native UI to approve a profile-wide Agent-control elevation.
   * The Renderer can request this flow, but it never supplies the approval.
   */
  requestAgentControlElevation(
    sessionId: string,
    instanceId: string,
    target: IOSSimulatorRendererWebContents,
  ): Promise<IOSSimulatorAgentControlApproval | null> {
    const normalizedSessionId = sessionId.trim();
    const normalizedInstanceId = instanceId.trim();
    const grant = this.grants.get(target.id);
    if (
      !normalizedSessionId ||
      !normalizedInstanceId ||
      !this.agentControlConfirmation ||
      !grant ||
      grant.target !== target ||
      grant.sessionId !== normalizedSessionId ||
      target.isDestroyed()
    ) {
      return Promise.resolve(null);
    }
    const key = this.agentControlKey(normalizedSessionId, normalizedInstanceId);
    for (const [pendingKey, pending] of this.pendingAgentControl) {
      if (pending.sessionId === normalizedSessionId && pendingKey !== key) {
        return Promise.resolve(null);
      }
    }
    let pending = this.pendingAgentControl.get(key);
    if (!pending) {
      const promise = this.performAgentControlElevation(
        normalizedSessionId,
        normalizedInstanceId,
        target,
        grant.generation,
      ).finally(() => {
        const current = this.pendingAgentControl.get(key);
        if (current?.promise === promise) this.pendingAgentControl.delete(key);
      });
      pending = {
        sessionId: normalizedSessionId,
        instanceId: normalizedInstanceId,
        promise,
      };
      this.pendingAgentControl.set(key, pending);
    }
    return pending.promise.then((approval) =>
      approval && this.isAgentControlApprovalCurrent(target, approval) ? approval : null,
    );
  }

  invalidateAgentControlElevation(sessionId: string, instanceId: string): void {
    const key = this.agentControlKey(sessionId.trim(), instanceId.trim());
    this.agentControlEpochs.set(key, (this.agentControlEpochs.get(key) ?? 0) + 1);
  }

  isAgentControlApprovalCurrent(
    target: IOSSimulatorRendererWebContents,
    approval: IOSSimulatorAgentControlApproval,
  ): boolean {
    const current = this.grants.get(target.id);
    return Boolean(
      !target.isDestroyed() &&
      this.lifecycleEpoch === approval.lifecycleEpoch &&
      (this.agentControlEpochs.get(this.agentControlKey(approval.sessionId, approval.instanceId)) ??
        0) === approval.elevationEpoch &&
      current?.target === target &&
      current.sessionId === approval.sessionId &&
      current.generation === approval.grantGeneration,
    );
  }

  pushRouteStatus(status: IOSSimulatorPublicRouteStatus): number {
    let delivered = 0;
    for (const [webContentsId, grant] of this.grants) {
      if (grant.sessionId !== status.sessionId) continue;
      if (grant.target.isDestroyed()) {
        this.revokeGrant(webContentsId, grant);
        continue;
      }
      try {
        grant.target.send(IOS_SIMULATOR_ROUTE_STATUS_CHANNEL, status);
        delivered += 1;
      } catch {
        this.revokeGrant(webContentsId, grant);
      }
    }
    return delivered;
  }

  /** Copy an existing Main-window grant when its detached sidebar WebContents is created. */
  inheritAccess(
    sourceTarget: IOSSimulatorRendererWebContents,
    target: IOSSimulatorRendererWebContents,
  ): boolean {
    const source = this.grants.get(sourceTarget.id);
    if (
      !source ||
      source.target !== sourceTarget ||
      source.target.isDestroyed() ||
      !Number.isSafeInteger(target.id) ||
      target.id <= 0 ||
      target.isDestroyed()
    ) {
      return false;
    }
    const existing = this.grants.get(target.id);
    if (existing?.target === target && existing.generation === source.generation) return true;
    // Inheritance is an authoritative Host decision just like grantTargets.
    // Invalidate a manual confirmation that started before this detached
    // target was bound, including its first inherited grant.
    this.bumpTargetEpoch(target.id);
    const revoked = existing ? this.removeGeneration(existing.generation) : [];
    this.grants.set(target.id, {
      sessionId: source.sessionId,
      generation: source.generation,
      target,
    });
    this.trackDestroyed(target);
    this.notifyRevoked(
      revoked.filter((grant) => {
        const current = this.grants.get(grant.target.id);
        return current?.target !== grant.target || current.sessionId !== grant.sessionId;
      }),
    );
    return true;
  }

  revokeForSessionChange(
    preferredTarget: IOSSimulatorRendererWebContents,
    sessionId: string | null,
  ): number {
    const normalizedSessionId = sessionId?.trim() || null;
    const targets =
      this.resolveTargets(preferredTarget)?.targets ??
      new Map([[preferredTarget.id, preferredTarget]]);
    const generations = new Set<number>();
    for (const target of targets.values()) {
      const grant = this.grants.get(target.id);
      if (
        grant?.target === target &&
        (!normalizedSessionId || grant.sessionId !== normalizedSessionId)
      ) {
        generations.add(grant.generation);
      }
      const pending = this.pendingAccess.get(target.id);
      if (pending && (!normalizedSessionId || pending.sessionId !== normalizedSessionId)) {
        this.bumpTargetEpoch(target.id);
      }
    }
    let revoked = 0;
    for (const generation of generations) revoked += this.revokeGeneration(generation);
    return revoked;
  }

  revokeSession(sessionId: string): void {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return;
    this.sessionEpochs.set(
      normalizedSessionId,
      (this.sessionEpochs.get(normalizedSessionId) ?? 0) + 1,
    );
    const generations = new Set<number>();
    for (const grant of this.grants.values()) {
      if (grant.sessionId === normalizedSessionId) generations.add(grant.generation);
    }
    for (const generation of generations) this.revokeGeneration(generation);
  }

  clear(): void {
    this.lifecycleEpoch += 1;
    const revoked = [...this.grants.values()];
    for (const grant of revoked) this.bumpTargetEpoch(grant.target.id);
    this.grants.clear();
    this.notifyRevoked(revoked);
  }

  private async performAccessRequest(
    sessionId: string,
    target: IOSSimulatorRendererWebContents,
  ): Promise<boolean> {
    const lifecycleEpoch = this.lifecycleEpoch;
    const targetEpoch = this.targetEpochs.get(target.id) ?? 0;
    const sessionEpoch = this.sessionEpochs.get(sessionId) ?? 0;
    const initialTargets = this.resolveTargets(target)?.targets;
    if (!initialTargets || initialTargets.get(target.id) !== target) return false;

    let confirmed = false;
    try {
      confirmed = (await this.confirmation?.(target, sessionId)) === true;
    } catch {
      confirmed = false;
    }
    if (!confirmed) {
      const alreadyGranted = this.hasAccess(target, sessionId);
      if (!alreadyGranted) {
        this.accessCooldownUntil.set(
          target.id,
          Date.now() + IOSSimulatorRendererAccessRegistry.ACCESS_REQUEST_COOLDOWN_MS,
        );
      }
      return alreadyGranted;
    }
    if (
      target.isDestroyed() ||
      this.lifecycleEpoch !== lifecycleEpoch ||
      (this.targetEpochs.get(target.id) ?? 0) !== targetEpoch ||
      (this.sessionEpochs.get(sessionId) ?? 0) !== sessionEpoch
    ) {
      return this.hasAccess(target, sessionId);
    }
    const currentTargets = this.resolveTargets(target)?.targets;
    if (!currentTargets || currentTargets.get(target.id) !== target) {
      return this.hasAccess(target, sessionId);
    }
    this.grantTargets(sessionId, currentTargets.values());
    return this.hasAccess(target, sessionId);
  }

  private async performAgentControlElevation(
    sessionId: string,
    instanceId: string,
    target: IOSSimulatorRendererWebContents,
    grantGeneration: number,
  ): Promise<IOSSimulatorAgentControlApproval | null> {
    const lifecycleEpoch = this.lifecycleEpoch;
    const targetEpoch = this.targetEpochs.get(target.id) ?? 0;
    const sessionEpoch = this.sessionEpochs.get(sessionId) ?? 0;
    const key = this.agentControlKey(sessionId, instanceId);
    const elevationEpoch = this.agentControlEpochs.get(key) ?? 0;
    let confirmed = false;
    try {
      confirmed = (await this.agentControlConfirmation?.(target, sessionId, instanceId)) === true;
    } catch {
      confirmed = false;
    }
    if (!confirmed || target.isDestroyed()) return null;
    const current = this.grants.get(target.id);
    if (
      this.lifecycleEpoch === lifecycleEpoch &&
      (this.targetEpochs.get(target.id) ?? 0) === targetEpoch &&
      (this.sessionEpochs.get(sessionId) ?? 0) === sessionEpoch &&
      (this.agentControlEpochs.get(key) ?? 0) === elevationEpoch &&
      current?.target === target &&
      current.sessionId === sessionId &&
      current.generation === grantGeneration
    ) {
      return {
        sessionId,
        instanceId,
        grantGeneration,
        lifecycleEpoch,
        elevationEpoch,
      };
    }
    return null;
  }

  private agentControlKey(sessionId: string, instanceId: string): string {
    return `${sessionId}\u0000${instanceId}`;
  }

  private resolveTargets(preferredTarget?: IOSSimulatorRendererWebContents): {
    targets: Map<number, IOSSimulatorRendererWebContents>;
    focusTarget: IOSSimulatorRendererWebContents | null;
  } | null {
    const resolved = this.resolver?.(preferredTarget);
    if (!resolved) return null;
    const targets = new Map<number, IOSSimulatorRendererWebContents>();
    for (const target of [
      ...resolved.grantTargets,
      ...(resolved.focusTarget ? [resolved.focusTarget] : []),
    ]) {
      if (!Number.isSafeInteger(target.id) || target.id <= 0 || target.isDestroyed()) continue;
      targets.set(target.id, target);
    }
    if (targets.size === 0) return null;
    return { targets, focusTarget: resolved.focusTarget };
  }

  private grantTargets(
    sessionId: string,
    candidates: Iterable<IOSSimulatorRendererWebContents>,
  ): number {
    const targets = [...candidates];
    // Every authoritative grant is also an authorization-generation change.
    // Invalidate any manual confirmation that started before this decision,
    // including the first grant for a previously ungranted WebContents.
    for (const target of targets) this.bumpTargetEpoch(target.id);
    const previousGenerations = new Set<number>();
    for (const target of targets) {
      const existing = this.grants.get(target.id);
      if (existing) previousGenerations.add(existing.generation);
    }
    const revoked: IOSSimulatorRendererGrant[] = [];
    for (const generation of previousGenerations) {
      revoked.push(...this.removeGeneration(generation));
    }

    const generation = ++this.nextGeneration;
    for (const target of targets) {
      this.grants.set(target.id, { sessionId, generation, target });
      this.trackDestroyed(target);
    }
    this.notifyRevoked(
      revoked.filter((grant) => {
        const current = this.grants.get(grant.target.id);
        return current?.target !== grant.target || current.sessionId !== grant.sessionId;
      }),
    );
    return generation;
  }

  private trackDestroyed(target: IOSSimulatorRendererWebContents): void {
    if (this.trackedTargets.get(target.id) === target) return;
    this.trackedTargets.set(target.id, target);
    target.once('destroyed', () => {
      if (this.trackedTargets.get(target.id) !== target) return;
      this.trackedTargets.delete(target.id);
      this.bumpTargetEpoch(target.id);
      const grant = this.grants.get(target.id);
      if (grant?.target === target) this.revokeGrant(target.id, grant);
    });
  }

  private revokeGeneration(generation: number): number {
    const revoked = this.removeGeneration(generation);
    this.notifyRevoked(revoked);
    return revoked.length;
  }

  private removeGeneration(generation: number): IOSSimulatorRendererGrant[] {
    const revoked: IOSSimulatorRendererGrant[] = [];
    for (const [webContentsId, grant] of this.grants) {
      if (grant.generation !== generation) continue;
      this.grants.delete(webContentsId);
      this.bumpTargetEpoch(webContentsId);
      revoked.push(grant);
    }
    return revoked;
  }

  private revokeGrant(webContentsId: number, expected: IOSSimulatorRendererGrant): void {
    if (this.grants.get(webContentsId) !== expected) return;
    this.grants.delete(webContentsId);
    this.bumpTargetEpoch(webContentsId);
    this.notifyRevoked([expected]);
  }

  private notifyRevoked(grants: readonly IOSSimulatorRendererGrant[]): void {
    if (grants.length === 0 || !this.revocationObserver) return;
    try {
      this.revocationObserver(grants);
    } catch {
      // Authorization removal is authoritative even if resource cleanup fails.
    }
  }

  private bumpTargetEpoch(webContentsId: number): void {
    this.targetEpochs.set(webContentsId, (this.targetEpochs.get(webContentsId) ?? 0) + 1);
  }
}

const rendererAccessRegistry = new IOSSimulatorRendererAccessRegistry();

export function configureIOSSimulatorRendererTargets(
  resolver: IOSSimulatorRendererTargetResolver | null,
): void {
  rendererAccessRegistry.configureResolver(resolver);
}

export function configureIOSSimulatorRendererAccessConfirmation(
  confirmation: IOSSimulatorRendererAccessConfirmation | null,
): void {
  rendererAccessRegistry.configureConfirmation(confirmation);
}

export function configureIOSSimulatorAgentControlConfirmation(
  confirmation: IOSSimulatorAgentControlConfirmation | null,
): void {
  rendererAccessRegistry.configureAgentControlConfirmation(confirmation);
}

export function configureIOSSimulatorRendererAccessRevocationObserver(
  observer: IOSSimulatorRendererAccessRevocationObserver | null,
): void {
  rendererAccessRegistry.configureRevocationObserver(observer);
}

export function focusIOSSimulatorRendererSession(
  sessionId: string,
  instanceId?: string,
  preferredTarget?: IOSSimulatorRendererWebContents,
): boolean {
  return rendererAccessRegistry.grantAndFocus(sessionId, instanceId, preferredTarget);
}

export function getIOSSimulatorRendererSessionAccess(
  target: IOSSimulatorRendererWebContents,
): IOSSimulatorRendererAccessSnapshot | null {
  return rendererAccessRegistry.accessSnapshot(target);
}

export function hasIOSSimulatorRendererSessionAccess(
  target: IOSSimulatorRendererWebContents,
  sessionId: string,
): boolean {
  return rendererAccessRegistry.hasAccess(target, sessionId);
}

export function requestIOSSimulatorRendererSessionAccess(
  target: IOSSimulatorRendererWebContents,
  sessionId: string,
): Promise<boolean> {
  return rendererAccessRegistry.requestAccess(sessionId, target);
}

export function requestIOSSimulatorAgentControlElevation(
  target: IOSSimulatorRendererWebContents,
  sessionId: string,
  instanceId: string,
): Promise<IOSSimulatorAgentControlApproval | null> {
  return rendererAccessRegistry.requestAgentControlElevation(sessionId, instanceId, target);
}

export function invalidateIOSSimulatorAgentControlElevation(
  sessionId: string,
  instanceId: string,
): void {
  rendererAccessRegistry.invalidateAgentControlElevation(sessionId, instanceId);
}

export function isIOSSimulatorAgentControlApprovalCurrent(
  target: IOSSimulatorRendererWebContents,
  approval: IOSSimulatorAgentControlApproval,
): boolean {
  return rendererAccessRegistry.isAgentControlApprovalCurrent(target, approval);
}

export function pushIOSSimulatorRouteStatusToGrantedRenderers(
  status: IOSSimulatorPublicRouteStatus,
): number {
  return rendererAccessRegistry.pushRouteStatus(status);
}

export function inheritIOSSimulatorRendererSessionAccess(
  sourceTarget: IOSSimulatorRendererWebContents,
  target: IOSSimulatorRendererWebContents,
): boolean {
  return rendererAccessRegistry.inheritAccess(sourceTarget, target);
}

export function revokeIOSSimulatorRendererAccessForSessionChange(
  target: IOSSimulatorRendererWebContents,
  sessionId: string | null,
): number {
  return rendererAccessRegistry.revokeForSessionChange(target, sessionId);
}

export function revokeIOSSimulatorRendererSession(sessionId: string): void {
  rendererAccessRegistry.revokeSession(sessionId);
}

export function clearIOSSimulatorRendererAccess(): void {
  rendererAccessRegistry.clear();
}
