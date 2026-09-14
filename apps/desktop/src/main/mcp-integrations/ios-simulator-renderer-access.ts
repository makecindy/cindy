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
 * authorization source. Viewer grants are minted only by an authoritative Host
 * flow that already owns the sessionId and may be retained for multiple
 * session-scoped sidebar buckets. A separate active grant selects the only
 * session allowed to invoke mutation/control IPC from a WebContents family.
 */
export class IOSSimulatorRendererAccessRegistry {
  private readonly viewerGrants = new Map<number, Map<string, IOSSimulatorRendererGrant>>();
  private readonly activeGrants = new Map<number, IOSSimulatorRendererGrant>();
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
    const grant = this.viewerGrants.get(target.id)?.get(sessionId);
    if (
      !grant ||
      grant.target !== target ||
      grant.sessionId !== sessionId ||
      grant.target.isDestroyed()
    ) {
      if (grant?.target.isDestroyed()) this.revokeTarget(target.id, grant.target);
      return false;
    }
    return true;
  }

  viewerAccessSnapshot(
    target: IOSSimulatorRendererWebContents,
    sessionId: string,
  ): IOSSimulatorRendererAccessSnapshot | null {
    const grant = this.viewerGrants.get(target.id)?.get(sessionId);
    if (!grant || grant.target !== target || grant.target.isDestroyed()) {
      if (grant?.target.isDestroyed()) this.revokeTarget(target.id, grant.target);
      return null;
    }
    return { sessionId: grant.sessionId, generation: grant.generation };
  }

  /** Exact Main-owned binding for this live WebContents, never a route hint. */
  accessSnapshot(
    target: IOSSimulatorRendererWebContents,
  ): IOSSimulatorRendererAccessSnapshot | null {
    const grant = this.activeGrants.get(target.id);
    if (!grant || grant.target !== target || grant.target.isDestroyed()) {
      if (grant?.target.isDestroyed()) this.revokeTarget(target.id, grant.target);
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

    const request: IOSSimulatorFocusRequest = {
      sessionId: normalizedSessionId,
      ...(instanceId?.trim() ? { instanceId: instanceId.trim() } : {}),
      userInitiated: false,
    };
    try {
      // Electron delivers webContents.send asynchronously. Queue the focus
      // request first so a synchronous delivery failure leaves the existing
      // Viewer and active grants untouched, then mint the Host grant before
      // the Renderer can process the queued message.
      focusTarget.send(IOS_SIMULATOR_FOCUS_REQUEST_CHANNEL, request);
    } catch {
      return false;
    }
    this.grantTargets(normalizedSessionId, targets.values());
    return true;
  }

  requestAccess(sessionId: string, target: IOSSimulatorRendererWebContents): Promise<boolean> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId || target.isDestroyed()) return Promise.resolve(false);
    if (this.hasActiveAccess(target, normalizedSessionId)) return Promise.resolve(true);
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
    const grant = this.activeGrants.get(target.id);
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
    const current = this.activeGrants.get(target.id);
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
    for (const [webContentsId, grants] of this.viewerGrants) {
      const grant = grants.get(status.sessionId);
      if (!grant) continue;
      if (grant.target.isDestroyed()) {
        this.revokeTarget(webContentsId, grant.target);
        continue;
      }
      try {
        grant.target.send(IOS_SIMULATOR_ROUTE_STATUS_CHANNEL, status);
        delivered += 1;
      } catch {
        this.revokeTarget(webContentsId, grant.target);
      }
    }
    return delivered;
  }

  /** Copy an existing Main-window grant when its detached sidebar WebContents is created. */
  inheritAccess(
    sourceTarget: IOSSimulatorRendererWebContents,
    target: IOSSimulatorRendererWebContents,
  ): boolean {
    const sourceViewerGrants = this.viewerGrants.get(sourceTarget.id);
    if (
      !sourceViewerGrants ||
      sourceViewerGrants.size === 0 ||
      [...sourceViewerGrants.values()].some((grant) => grant.target !== sourceTarget) ||
      sourceTarget.isDestroyed() ||
      !Number.isSafeInteger(target.id) ||
      target.id <= 0 ||
      target.isDestroyed()
    ) {
      return false;
    }
    const sourceActive = this.activeGrants.get(sourceTarget.id);
    const existingViewerGrants = this.viewerGrants.get(target.id);
    const existingActive = this.activeGrants.get(target.id);
    const alreadyInherited =
      existingViewerGrants?.size === sourceViewerGrants.size &&
      [...sourceViewerGrants].every(
        ([sessionId, grant]) =>
          existingViewerGrants.get(sessionId)?.target === target &&
          existingViewerGrants.get(sessionId)?.generation === grant.generation,
      ) &&
      (sourceActive
        ? existingActive?.target === target &&
          existingActive.sessionId === sourceActive.sessionId &&
          existingActive.generation === sourceActive.generation
        : !existingActive);
    if (alreadyInherited) return true;
    // Inheritance is an authoritative Host decision just like grantTargets.
    // Invalidate a manual confirmation that started before this detached
    // target was bound, including its first inherited grant.
    this.bumpTargetEpoch(target.id);
    const existingTargetsMatch =
      !existingViewerGrants ||
      [...existingViewerGrants.values()].every((grant) => grant.target === target);
    const revoked = existingViewerGrants
      ? [...existingViewerGrants.values()].filter(
          (grant) => !existingTargetsMatch || !sourceViewerGrants.has(grant.sessionId),
        )
      : [];
    const inheritedViewerGrants = new Map<string, IOSSimulatorRendererGrant>();
    for (const [sessionId, grant] of sourceViewerGrants) {
      inheritedViewerGrants.set(sessionId, {
        sessionId,
        generation: grant.generation,
        target,
      });
    }
    this.viewerGrants.set(target.id, inheritedViewerGrants);
    if (sourceActive) {
      const inheritedActive = inheritedViewerGrants.get(sourceActive.sessionId);
      if (inheritedActive) this.activeGrants.set(target.id, inheritedActive);
    } else {
      this.activeGrants.delete(target.id);
    }
    this.trackDestroyed(target);
    this.notifyRevoked(revoked);
    return true;
  }

  syncForSessionChange(
    preferredTarget: IOSSimulatorRendererWebContents,
    sessionId: string | null,
  ): number {
    const normalizedSessionId = sessionId?.trim() || null;
    const resolved = this.resolveTargets(preferredTarget);
    const targets = resolved?.targets ?? new Map([[preferredTarget.id, preferredTarget]]);
    let changed = 0;
    for (const target of targets.values()) {
      const pending = this.pendingAccess.get(target.id);
      if (pending && (!normalizedSessionId || pending.sessionId !== normalizedSessionId)) {
        this.bumpTargetEpoch(target.id);
      }
      const current = this.activeGrants.get(target.id);
      if (current?.target !== target) continue;
      if (normalizedSessionId && current.sessionId === normalizedSessionId) continue;

      // Renderer route reports are revocation-only. A renderer-controlled
      // sessionId may pause a stale active mutation grant, but it must never
      // promote any retained Viewer grant. Only Main/Host confirmation and
      // focus flows may select the active grant again.
      this.bumpTargetEpoch(target.id);
      this.activeGrants.delete(target.id);
      changed += 1;
    }
    return changed;
  }

  revokeSession(sessionId: string): void {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return;
    this.sessionEpochs.set(
      normalizedSessionId,
      (this.sessionEpochs.get(normalizedSessionId) ?? 0) + 1,
    );
    const revoked: IOSSimulatorRendererGrant[] = [];
    for (const [webContentsId, grants] of this.viewerGrants) {
      const grant = grants.get(normalizedSessionId);
      if (!grant) continue;
      grants.delete(normalizedSessionId);
      if (grants.size === 0) this.viewerGrants.delete(webContentsId);
      if (this.activeGrants.get(webContentsId) === grant) {
        this.activeGrants.delete(webContentsId);
      }
      this.bumpTargetEpoch(webContentsId);
      revoked.push(grant);
    }
    this.notifyRevoked(revoked);
  }

  clear(): void {
    this.lifecycleEpoch += 1;
    const revoked = [...this.viewerGrants.values()].flatMap((grants) => [...grants.values()]);
    for (const grant of revoked) this.bumpTargetEpoch(grant.target.id);
    this.viewerGrants.clear();
    this.activeGrants.clear();
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
      const alreadyGranted = this.hasActiveAccess(target, sessionId);
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
      return this.hasActiveAccess(target, sessionId);
    }
    const currentTargets = this.resolveTargets(target)?.targets;
    if (!currentTargets || currentTargets.get(target.id) !== target) {
      return this.hasActiveAccess(target, sessionId);
    }
    this.grantTargets(sessionId, currentTargets.values());
    return this.hasActiveAccess(target, sessionId);
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
    const current = this.activeGrants.get(target.id);
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

  private hasActiveAccess(target: IOSSimulatorRendererWebContents, sessionId: string): boolean {
    return this.accessSnapshot(target)?.sessionId === sessionId;
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
    const generation = ++this.nextGeneration;
    for (const target of targets) {
      const grant = { sessionId, generation, target };
      let grants = this.viewerGrants.get(target.id);
      let revoked: IOSSimulatorRendererGrant[] = [];
      if (!grants || [...grants.values()].some((existing) => existing.target !== target)) {
        revoked = grants ? [...grants.values()] : [];
        grants = new Map<string, IOSSimulatorRendererGrant>();
        this.viewerGrants.set(target.id, grants);
      }
      grants.set(sessionId, grant);
      this.activeGrants.set(target.id, grant);
      this.trackDestroyed(target);
      // Notify after the replacement target is fully installed. The observer
      // is keyed by session/WebContents id, so notifyRevoked suppresses cleanup
      // when that logical Viewer authorization still exists on a reused id.
      this.notifyRevoked(revoked);
    }
    return generation;
  }

  private trackDestroyed(target: IOSSimulatorRendererWebContents): void {
    if (this.trackedTargets.get(target.id) === target) return;
    this.trackedTargets.set(target.id, target);
    target.once('destroyed', () => {
      if (this.trackedTargets.get(target.id) !== target) return;
      this.trackedTargets.delete(target.id);
      this.bumpTargetEpoch(target.id);
      this.revokeTarget(target.id, target);
    });
  }

  private revokeGeneration(generation: number): number {
    const revoked = this.removeGeneration(generation);
    this.notifyRevoked(revoked);
    return revoked.length;
  }

  private removeGeneration(generation: number): IOSSimulatorRendererGrant[] {
    const revoked: IOSSimulatorRendererGrant[] = [];
    for (const [webContentsId, grants] of this.viewerGrants) {
      for (const [sessionId, grant] of grants) {
        if (grant.generation !== generation) continue;
        grants.delete(sessionId);
        if (this.activeGrants.get(webContentsId) === grant) {
          this.activeGrants.delete(webContentsId);
        }
        this.bumpTargetEpoch(webContentsId);
        revoked.push(grant);
      }
      if (grants.size === 0) this.viewerGrants.delete(webContentsId);
    }
    return revoked;
  }

  private revokeTarget(
    webContentsId: number,
    expectedTarget: IOSSimulatorRendererWebContents,
  ): void {
    const grants = this.viewerGrants.get(webContentsId);
    if (!grants || [...grants.values()].some((grant) => grant.target !== expectedTarget)) return;
    this.viewerGrants.delete(webContentsId);
    if (this.activeGrants.get(webContentsId)?.target === expectedTarget) {
      this.activeGrants.delete(webContentsId);
    }
    this.bumpTargetEpoch(webContentsId);
    this.notifyRevoked([...grants.values()]);
  }

  private notifyRevoked(grants: readonly IOSSimulatorRendererGrant[]): void {
    if (grants.length === 0 || !this.revocationObserver) return;
    const actuallyRevoked = grants.filter(
      (grant) => !this.viewerGrants.get(grant.target.id)?.has(grant.sessionId),
    );
    if (actuallyRevoked.length === 0) return;
    try {
      this.revocationObserver(actuallyRevoked);
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

export function getIOSSimulatorRendererViewerAccess(
  target: IOSSimulatorRendererWebContents,
  sessionId: string,
): IOSSimulatorRendererAccessSnapshot | null {
  return rendererAccessRegistry.viewerAccessSnapshot(target, sessionId);
}

export function hasIOSSimulatorRendererViewerAccess(
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

export function syncIOSSimulatorRendererAccessForSessionChange(
  target: IOSSimulatorRendererWebContents,
  sessionId: string | null,
): number {
  return rendererAccessRegistry.syncForSessionChange(target, sessionId);
}

export function revokeIOSSimulatorRendererSession(sessionId: string): void {
  rendererAccessRegistry.revokeSession(sessionId);
}

export function clearIOSSimulatorRendererAccess(): void {
  rendererAccessRegistry.clear();
}
