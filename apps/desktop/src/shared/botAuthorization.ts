import type { GhostSetupAllowedAction, GhostSetupStepPhase, GhostSetupErrorCode } from './ghost.js';
export interface AuthorizationSnapshot {
  reopenActionId?: string;
  kind: 'plugin_setup';
  requestId: string;
  revision: number;
  terminal?: true;
  ghost: { id: string; name: string; iconDataUrl?: string };
  intro?: string;
  steps: Array<{
    id: string;
    groupId: string;
    groupMode: 'any_of';
    title: string;
    description: string;
    phase: GhostSetupStepPhase;
    action?: GhostSetupAllowedAction;
    errorCode?: GhostSetupErrorCode;
  }>;
}

/** Stored presentation and opaque target only; never store an OAuth URL or a credential. */
export type BotAuthorizationTarget =
  | { kind: 'plugin'; id: string; reauthorize?: boolean }
  | { kind: 'host'; id: 'grok'; reauthorize?: boolean };
export interface BotAuthorizationCard {
  v: 1;
  /** Authorization was verified; continuation has not been durably finalized yet. */
  completionPending?: true;
  sessionId: string;
  target: BotAuthorizationTarget;
  snapshot: AuthorizationSnapshot;
  createdAt: number;
}
export function readBotAuthorizationCard(value: unknown): BotAuthorizationCard | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<BotAuthorizationCard>;
  if (
    v.v !== 1 ||
    typeof v.sessionId !== 'string' ||
    typeof v.createdAt !== 'number' ||
    !v.target ||
    !['plugin', 'host'].includes(v.target.kind) ||
    typeof v.target.id !== 'string' ||
    (v.target.kind === 'host' && v.target.id !== 'grok') ||
    !v.snapshot ||
    v.snapshot.kind !== 'plugin_setup' ||
    typeof v.snapshot.requestId !== 'string' ||
    !Number.isInteger(v.snapshot.revision) ||
    !v.snapshot.ghost ||
    typeof v.snapshot.ghost.name !== 'string' ||
    !Array.isArray(v.snapshot.steps)
  )
    return null;
  if (
    typeof v.snapshot.ghost.id !== 'string' ||
    v.snapshot.revision < 0 ||
    v.snapshot.steps.length > 88
  )
    return null;
  for (const step of v.snapshot.steps) {
    if (
      !step ||
      typeof step !== 'object' ||
      typeof step.id !== 'string' ||
      typeof step.groupId !== 'string' ||
      step.groupMode !== 'any_of' ||
      typeof step.title !== 'string' ||
      typeof step.description !== 'string' ||
      ![
        'pending',
        'action_running',
        'waiting_external',
        'verifying',
        'satisfied',
        'failed',
        'cancelled',
      ].includes(step.phase)
    )
      return null;
    const action = step.action;
    if (!action) continue;
    if (
      typeof action.id !== 'string' ||
      ![
        'oauth_connect',
        'open_plugin_settings',
        'manage_connection',
        'open_client_settings',
        'inline_form',
      ].includes(action.kind)
    )
      return null;
    if (action.kind === 'inline_form') {
      const field = action.form?.fields?.[0];
      if (
        !field ||
        action.form.fields.length !== 1 ||
        field.type !== 'secret' ||
        typeof field.label !== 'string' ||
        typeof field.id !== 'string' ||
        !Number.isInteger(field.maxLength) ||
        field.maxLength < 1
      )
        return null;
    }
  }
  return v as BotAuthorizationCard;
}
