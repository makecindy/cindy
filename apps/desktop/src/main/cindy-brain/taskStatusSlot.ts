import { randomUUID } from 'node:crypto';
import { ghostInstallApprovalToken, type InstalledGhost } from '../../shared/ghost.js';
import type { GhostTaskStatusReply, GhostTaskStatusRequest } from '../../shared/ghostTaskStatus.js';
import { sanitizeGhostNoticeText } from './notifySlot.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';
import type { GhostTaskStatus } from '../../shared/ghostTaskStatus.js';
import type { IpcMainInvokeEvent } from 'electron';
import { throwIpcError } from '../utils/ipcValidate.js';

interface TaskSnapshot {
  workingDir: string | null;
  remoteHostId?: string | null;
  agentDeviceId?: string | null;
  agentKind?: string | null;
  providerId?: string | null;
  model?: string | null;
}

/** Host-only projection. The adapter authenticates the caller before any work. */
export function createGhostTaskStatusHandler(deps: {
  authorize(event: IpcMainInvokeEvent): void;
  scope(): string | null;
  session(id: string): Promise<TaskSnapshot | null>;
  list(): InstalledGhost[];
  disabled(id: string, workdir: string | null): boolean;
  slot: GhostTaskStatusSlot;
}) {
  return async (event: IpcMainInvokeEvent, sessionId: unknown): Promise<GhostTaskStatus[]> => {
    deps.authorize(event);
    if (
      typeof sessionId !== 'string' ||
      !sessionId ||
      sessionId.length > 256 ||
      sessionId.includes(String.fromCharCode(0))
    )
      throwIpcError('INVALID_PARAMS', 'Invalid task id');
    const owner = deps.scope();
    if (owner === null) return [];
    const session = await deps.session(sessionId);
    const current = () => deps.scope() === owner;
    if (!session || session.remoteHostId || session.agentDeviceId || !current()) return [];
    const modelRoute: GhostTaskStatusRequest['modelRoute'] = {
      agentKind: session.agentKind ?? null,
      providerId: session.providerId ?? null,
      model: session.model ?? null,
    };
    const ghosts = deps.list();
    const tokens = new Map(
      ghosts.map((ghost) => [
        installedGhostStoragePart(ghost),
        ghostInstallApprovalToken(ghost.approval),
      ]),
    );
    const statuses = await Promise.all(
      ghosts.map(async (ghost): Promise<GhostTaskStatus | null> => {
        const id = installedGhostStoragePart(ghost);
        const allowed = () => current() && !deps.disabled(id, session.workingDir);
        if (!allowed()) return null;
        const result = await deps.slot.query(id, sessionId, allowed, modelRoute);
        if (!allowed() || !result) return null;
        return {
          instanceId: id,
          name: ghost.manifest.name,
          label: result.label,
          ...(result.tooltip ? { tooltip: result.tooltip } : {}),
        };
      }),
    );
    const latest = current() ? await deps.session(sessionId) : null;
    if (
      !current() ||
      !latest ||
      latest.workingDir !== session.workingDir ||
      latest.remoteHostId ||
      latest.agentDeviceId ||
      latest.agentKind !== session.agentKind ||
      latest.providerId !== session.providerId ||
      latest.model !== session.model
    )
      return [];
    const installed = new Map(
      deps.list().map((ghost) => [installedGhostStoragePart(ghost), ghost]),
    );
    return statuses.filter((status): status is GhostTaskStatus => {
      if (!status) return false;
      const ghost = installed.get(status.instanceId);
      return (
        ghost?.enabled === true &&
        ghost.approval?.state === 'approved' &&
        ghost.manifest.taskView?.statusBar === true &&
        !deps.disabled(status.instanceId, latest.workingDir) &&
        tokens.get(status.instanceId) === ghostInstallApprovalToken(ghost.approval)
      );
    });
  };
}

interface Deps {
  getGhost(id: string): InstalledGhost | null;
  ownerScope(): string;
  wake(ghost: InstalledGhost): Promise<boolean>;
  send(id: string, request: GhostTaskStatusRequest): boolean;
}

/** Replies are bound to the actual sandbox, owner and exact approved installation. */
export class GhostTaskStatusSlot {
  private pending = new Map<
    string,
    { id: string; current(): boolean; finish(value: GhostTaskStatusReply | null): void }
  >();
  private inFlight = new Map<string, Promise<GhostTaskStatusReply | null>>();
  constructor(private readonly deps: Deps) {}

  async query(
    id: string,
    sessionId: string,
    allowed: () => boolean = () => true,
    modelRoute: GhostTaskStatusRequest['modelRoute'] = {
      agentKind: null,
      providerId: null,
      model: null,
    },
  ): Promise<GhostTaskStatusReply | null> {
    const ghost = this.deps.getGhost(id);
    if (
      !allowed() ||
      !ghost?.enabled ||
      ghost.approval?.state !== 'approved' ||
      ghost.manifest.taskView?.statusBar !== true
    )
      return null;
    const owner = this.deps.ownerScope();
    const token = ghostInstallApprovalToken(ghost.approval);
    const current = () => {
      const latest = this.deps.getGhost(id);
      return (
        allowed() &&
        owner === this.deps.ownerScope() &&
        latest?.enabled === true &&
        latest.manifest.taskView?.statusBar === true &&
        latest.approval?.state === 'approved' &&
        token === ghostInstallApprovalToken(latest.approval)
      );
    };
    const key = JSON.stringify([owner, id, sessionId, token, modelRoute]);
    const existing = this.inFlight.get(key);
    if (existing) return existing.then((value) => (current() ? value : null));
    const requestId = randomUUID();
    let settle!: (value: GhostTaskStatusReply | null) => void;
    const result = new Promise<GhostTaskStatusReply | null>((resolve) => {
      settle = resolve;
    });
    const timer = setTimeout(() => finish(null), 8000);
    const finish = (value: GhostTaskStatusReply | null) => {
      if (!this.pending.delete(requestId)) return;
      clearTimeout(timer);
      this.inFlight.delete(key);
      settle(current() ? value : null);
    };
    this.pending.set(requestId, { id, current, finish });
    // Register the in-flight entry before waking. `wake()` may stop the sandbox
    // synchronously (e.g. the install identity changed), which cancels this
    // request through `onStateChanged` while the executor is still running; a
    // settled promise cached afterwards would keep every later poll at `null`.
    this.inFlight.set(key, result);
    void this.deps
      .wake(ghost)
      .then((ready) => {
        if (!this.pending.has(requestId)) return;
        if (
          !ready ||
          !current() ||
          !this.deps.send(id, { type: 'task-status', requestId, sessionId, modelRoute })
        )
          finish(null);
      })
      .catch(() => finish(null));
    return result;
  }

  cancel(id: string): void {
    for (const pending of this.pending.values()) if (pending.id === id) pending.finish(null);
  }

  reply(id: string, payload: unknown): { ok: boolean } {
    const p = payload as Partial<GhostTaskStatusReply> | null;
    const pending = typeof p?.requestId === 'string' ? this.pending.get(p.requestId) : undefined;
    if (!pending || pending.id !== id || !pending.current()) return { ok: false };
    if (
      typeof p?.label !== 'string' ||
      p.label.length > 80 ||
      (p.tooltip !== undefined && (typeof p.tooltip !== 'string' || p.tooltip.length > 2048))
    ) {
      pending.finish(null);
      return { ok: false };
    }
    pending.finish({
      requestId: p.requestId!,
      label: sanitizeGhostNoticeText(p.label).replace(/\s+/g, ' ').trim(),
      ...(p.tooltip ? { tooltip: sanitizeGhostNoticeText(p.tooltip) } : {}),
    });
    return { ok: true };
  }
}
