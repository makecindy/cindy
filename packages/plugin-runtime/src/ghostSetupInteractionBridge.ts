import type { GhostSetupAllowedAction, GhostSetupErrorCode, GhostSetupStepPhase } from './shared/ghost.js';
import { GHOST_SECRET_VALUE_MAX_CHARS } from './shared/ghost.js';
import { notifyOauthCardClosed } from './authorization/context.js';

export interface GhostSetupInteractionStep {
  id: string;
  /** Host assessment group identity; Renderer uses it to present any-of choices together. */
  groupId: string;
  groupMode: 'any_of';
  title: string;
  description: string;
  phase: GhostSetupStepPhase;
  action?: GhostSetupAllowedAction;
  /** Stable cross-locale failure identity; Renderer owns user-facing copy. */
  errorCode?: GhostSetupErrorCode;
  /** Legacy controlled-Desktop compatibility only. New Main snapshots omit it. */
  errorMessage?: string;
}

export interface GhostSetupInteractionSnapshot {
  /** Presentation hint; only the dedicated Main bridge may execute OAuth remotely. */
  remoteOauth?: true;
  /** Only the ordinary Host-owned inline setup executor supports the signed input bridge. */
  remoteSecret?: true;
  /** Dedicated exact-host connection form; never generic remote settings access. */
  remoteConnection?: true;
  kind: 'plugin_setup';
  requestId: string;
  revision: number;
  /**
   * The call has settled. Renderer may retain this snapshot briefly for
   * terminal feedback, but it is no longer actionable or pending.
   */
  terminal?: true;
  ghost: {
    id: string;
    name: string;
    iconDataUrl?: string;
  };
  intro?: string;
  steps: GhostSetupInteractionStep[];
}

export type GhostSetupInteractionCommand =
  | {
      kind: 'plugin_setup';
      action: 'run_action';
      actionId: string;
      expectedRevision: number;
    }
  | {
      kind: 'plugin_setup';
      action: 'cancel';
      expectedRevision: number;
      /** Main-only lifecycle reason; never accepted from Renderer parsing. */
      cleanupReason?: 'session_closed' | 'session_aborted';
    };

export interface GhostSetupInlineSubmit {
  actionId: string;
  expectedRevision: number;
  value: string;
}

export interface GhostSetupInlineSubmitRequest extends GhostSetupInlineSubmit {
  requestId: string;
}

/**
 * Main-owned response destination captured from the trusted IPC sender.
 *
 * This stays separate from the parsed Renderer command so an untrusted
 * payload cannot nominate another window as the navigation target.
 */
export interface GhostSetupInteractionResponseTarget {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

export interface GhostSetupInteractionBridgeDeps {
  broadcast: (channel: string, payload: unknown) => void;
  channels: { request: string; dismissed: string };
  logger?: {
    warn: (message: string, context?: Record<string, unknown>) => void;
  };
}

interface PendingSetupInteraction {
  sessionId: string;
  snapshot: GhostSetupInteractionSnapshot;
  completed: boolean;
  onCommand: (
    command: GhostSetupInteractionCommand,
    responseTarget?: GhostSetupInteractionResponseTarget,
  ) => Promise<void> | void;
  onInlineSubmit?: (submit: GhostSetupInlineSubmit) => Promise<void> | void;
  onConnectionCommitted?: (actionId: string) => void;
  isTargetCurrent?: () => boolean;
}

export class GhostSetupInteractionBridge {
  private readonly pending = new Map<string, PendingSetupInteraction>();

  constructor(private readonly deps: GhostSetupInteractionBridgeDeps) {}

  open(
    sessionId: string,
    snapshot: GhostSetupInteractionSnapshot,
    onCommand: PendingSetupInteraction['onCommand'],
    onInlineSubmit?: PendingSetupInteraction['onInlineSubmit'],
    onConnectionCommitted?: PendingSetupInteraction['onConnectionCommitted'],
    isTargetCurrent?: PendingSetupInteraction['isTargetCurrent'],
  ): void {
    if (this.pending.has(snapshot.requestId)) {
      throw new Error(`plugin setup interaction already exists: ${snapshot.requestId}`);
    }
    this.pending.set(snapshot.requestId, {
      sessionId,
      snapshot,
      completed: false,
      onCommand,
      ...(onInlineSubmit ? { onInlineSubmit } : {}),
      ...(onConnectionCommitted ? { onConnectionCommitted } : {}),
      ...(isTargetCurrent ? { isTargetCurrent } : {}),
    });
    try {
      this.broadcastSnapshot(sessionId, snapshot);
    } catch (error) {
      this.pending.delete(snapshot.requestId);
      throw error;
    }
  }

  update(snapshot: GhostSetupInteractionSnapshot): boolean {
    const entry = this.pending.get(snapshot.requestId);
    if (!entry || entry.completed) return false;
    if (snapshot.revision < entry.snapshot.revision) return false;
    entry.snapshot = snapshot;
    this.broadcastSnapshot(entry.sessionId, snapshot);
    return true;
  }

  resolve(
    requestId: string,
    rawCommand: unknown,
    responseTarget?: GhostSetupInteractionResponseTarget,
  ): boolean {
    const entry = this.pending.get(requestId);
    if (!entry || entry.completed) return false;
    const command = parseGhostSetupInteractionCommand(rawCommand);
    if (!command) {
      this.deps.logger?.warn('plugin setup interaction received invalid command', { requestId });
      return false;
    }
    Promise.resolve(
      entry.onCommand(command, command.action === 'run_action' ? responseTarget : undefined),
    ).catch((error) => {
      this.deps.logger?.warn('plugin setup interaction command failed', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return true;
  }

  /**
   * Main-only Secret 提交入口。它不复用 resolve/InteractionDecision，避免
   * device-link 或其它远程 interaction transport 注入 Secret。
   */
  submitInline(requestId: string, rawSubmit: unknown): boolean {
    const entry = this.pending.get(requestId);
    if (!entry || entry.completed || entry.isTargetCurrent?.() === false) return false;
    const submit = parseGhostSetupInlineSubmit(rawSubmit);
    if (!submit || !entry.onInlineSubmit) {
      this.deps.logger?.warn('plugin setup interaction received invalid inline submission', {
        requestId,
      });
      return false;
    }
    Promise.resolve(entry.onInlineSubmit(submit)).catch((error) => {
      this.deps.logger?.warn('plugin setup interaction inline submission failed', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return true;
  }

  /** Main-only receipt after the exact connection card has committed its vault write. */
  connectionCommitted(requestId: string, actionId: string, expectedRevision: number): boolean {
    const entry = this.pending.get(requestId);
    if (!entry || entry.completed || entry.snapshot.terminal ||
        entry.snapshot.revision !== expectedRevision || !entry.onConnectionCommitted ||
        entry.isTargetCurrent?.() === false) return false;
    const step = entry.snapshot.steps.find(step => step.action?.id === actionId &&
      step.action.kind === 'manage_connection' && (step.phase === 'pending' || step.phase === 'failed'));
    if (!step) return false;
    // Main-only commit receipt. Never exposed through resolve or a Renderer command.
    entry.onConnectionCommitted(actionId);
    return true;
  }

  /** Retire a settled request while retaining its snapshot for delayed dismissal. */
  complete(requestId: string): boolean {
    const entry = this.pending.get(requestId);
    if (!entry || entry.completed) return false;
    entry.completed = true;
    notifyOauthCardClosed(requestId);
    return true;
  }

  close(requestId: string, reason: string): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    notifyOauthCardClosed(requestId);
    try {
      this.deps.broadcast(this.deps.channels.dismissed, {
        sessionId: entry.sessionId,
        requestId,
        reason,
      });
    } catch (error) {
      this.deps.logger?.warn('plugin setup interaction dismiss broadcast failed', {
        requestId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  cleanupForSession(sessionId: string, reason: 'session_closed' | 'session_aborted'): void {
    for (const [requestId, entry] of Array.from(this.pending.entries())) {
      if (entry.sessionId !== sessionId || entry.completed) continue;
      void Promise.resolve(
        entry.onCommand({
          kind: 'plugin_setup',
          action: 'cancel',
          expectedRevision: entry.snapshot.revision,
          cleanupReason: reason,
        }),
      ).catch((error) => {
        this.deps.logger?.warn('plugin setup session cleanup failed', {
          requestId,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  /** Account/data-owner boundary: cancel every actionable setup request before lease drain. */
  cleanupAll(reason: 'session_closed' | 'session_aborted'): void {
    for (const entry of Array.from(this.pending.values())) {
      if (entry.completed) continue;
      void Promise.resolve(
        entry.onCommand({
          kind: 'plugin_setup',
          action: 'cancel',
          expectedRevision: entry.snapshot.revision,
          cleanupReason: reason,
        }),
      ).catch((error) => {
        this.deps.logger?.warn('plugin setup account-boundary cleanup failed', {
          requestId: entry.snapshot.requestId,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  pendingSnapshots(sessionId?: string): Array<{
    sessionId: string;
    request: GhostSetupInteractionSnapshot;
  }> {
    return Array.from(this.pending.values())
      .filter(
        (entry) => !entry.completed && entry.isTargetCurrent?.() !== false &&
          (sessionId === undefined || entry.sessionId === sessionId),
      )
      .map((entry) => ({ sessionId: entry.sessionId, request: entry.snapshot }));
  }

  private broadcastSnapshot(sessionId: string, snapshot: GhostSetupInteractionSnapshot): void {
    this.deps.broadcast(this.deps.channels.request, {
      sessionId,
      request: snapshot,
    });
  }
}

export function parseGhostSetupInteractionCommand(
  raw: unknown,
): GhostSetupInteractionCommand | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (
    value.kind !== 'plugin_setup' ||
    !Number.isInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 0
  ) {
    return null;
  }
  if (value.action === 'cancel') {
    return {
      kind: 'plugin_setup',
      action: 'cancel',
      expectedRevision: value.expectedRevision as number,
    };
  }
  if (
    value.action === 'run_action' &&
    typeof value.actionId === 'string' &&
    value.actionId.length > 0 &&
    value.actionId.length <= 256
  ) {
    return {
      kind: 'plugin_setup',
      action: 'run_action',
      actionId: value.actionId,
      expectedRevision: value.expectedRevision as number,
    };
  }
  return null;
}

export function parseGhostSetupInlineSubmit(raw: unknown): GhostSetupInlineSubmit | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value);
  const trimmedValue = typeof value.value === 'string' ? value.value.trim() : null;
  if (
    keys.length !== 3 ||
    !keys.every((key) => ['actionId', 'expectedRevision', 'value'].includes(key)) ||
    typeof value.actionId !== 'string' ||
    value.actionId.length === 0 ||
    value.actionId.length > 256 ||
    !Number.isInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 0 ||
    trimmedValue === null ||
    trimmedValue.length === 0 ||
    trimmedValue.length > GHOST_SECRET_VALUE_MAX_CHARS
  ) {
    return null;
  }
  return {
    actionId: value.actionId,
    expectedRevision: value.expectedRevision as number,
    value: trimmedValue,
  };
}

export function parseGhostSetupInlineSubmitRequest(
  raw: unknown,
): GhostSetupInlineSubmitRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value);
  if (
    keys.length !== 4 ||
    !keys.every((key) => ['requestId', 'actionId', 'expectedRevision', 'value'].includes(key)) ||
    typeof value.requestId !== 'string' ||
    value.requestId.length === 0 ||
    value.requestId.length > 256
  ) {
    return null;
  }
  const submit = parseGhostSetupInlineSubmit({
    actionId: value.actionId,
    expectedRevision: value.expectedRevision,
    value: value.value,
  });
  return submit ? { requestId: value.requestId, ...submit } : null;
}

