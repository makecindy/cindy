/** Remote confirmation projection shared by every Host transport. */
import { readBotAuthorizationCard } from '../../shared/botAuthorization.js';
import { isGhostSetupErrorCode } from '../../shared/ghost.js';
import type { GhostSetupInteractionSnapshot } from './ghostSetupInteractionBridge.js';
import { isDesktopOnlyConfirmationRequestId, projectDesktopOnlyConfirmationRequestId } from './desktopOnlyConfirmationProjection.js';

export function createInteractionProjection(supportsRemotePluginOauth: () => boolean) {
/** Persist only presentation fields, plus validated Desktop credential-page links. */
function sanitizeGhostSetupSnapshotForDesktop(
  snapshot: GhostSetupInteractionSnapshot,
): GhostSetupInteractionSnapshot {
  const safe = sanitizeGhostSetupSnapshotForRemote(snapshot);
  safe.steps.forEach((step, index) => {
    const source = snapshot.steps[index].action;
    if (step.action?.kind !== 'inline_form' || source?.kind !== 'inline_form') return;
    const url = source.form.fields[0].externalLink?.url;
    if (!url || url.length > 200) return;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password)
        step.action.form.fields[0].externalLink = { url };
    } catch { /* omit invalid credential-page links */ }
  });
  return safe;
}

/** Local durable cards retain Desktop helpers; every remote message path strips them. */
function sanitizeBotAuthorizationMetaForRemote(meta: Record<string, unknown>): Record<string, unknown> {
  if (!('botAuthorization' in meta)) return meta;
  const { botAuthorization: raw, ...rest } = meta;
  const card = readBotAuthorizationCard(raw);
  return card ? {
    ...rest,
    botAuthorization: { ...card, snapshot: sanitizeGhostSetupSnapshotForRemote(card.snapshot) },
  } : rest;
}

/**
 * Device-link only projection of a Host-owned setup snapshot.
 *
 * Desktop keeps richer presentation helpers (for example an external URL next
 * to a Secret field). Remote clients only receive the stable interaction
 * contract. Rebuilding every nested object from an allowlist also keeps future
 * Desktop-only helper metadata from crossing the device-link boundary.
 */
function sanitizeGhostSetupSnapshotForRemote(
  snapshot: GhostSetupInteractionSnapshot,
): GhostSetupInteractionSnapshot {
  return {
    kind: snapshot.kind,
    ...(supportsRemotePluginOauth() ? { remoteOauth: true as const } : {}),
    ...(supportsRemotePluginOauth() && snapshot.remoteSecret ? { remoteSecret: true as const } : {}),
    ...(supportsRemotePluginOauth() && snapshot.remoteConnection ? { remoteConnection: true as const } : {}),
    requestId: snapshot.requestId,
    revision: snapshot.revision,
    ...(snapshot.terminal ? { terminal: true as const } : {}),
    ghost: {
      id: snapshot.ghost.id,
      name: snapshot.ghost.name,
      ...(snapshot.ghost.iconDataUrl ? { iconDataUrl: snapshot.ghost.iconDataUrl } : {}),
    },
    ...(snapshot.intro !== undefined ? { intro: snapshot.intro } : {}),
    steps: snapshot.steps.map((step) => ({
      id: step.id,
      groupId: step.groupId,
      groupMode: step.groupMode,
      title: step.title,
      description: step.description,
      phase: step.phase,
      ...(isGhostSetupErrorCode(step.errorCode) ? { errorCode: step.errorCode } : {}),
      ...(step.action
        ? {
            action:
              step.action.kind === 'inline_form'
                ? {
                    id: step.action.id,
                    kind: step.action.kind,
                    form: {
                      fields: [
                        {
                          id: step.action.form.fields[0].id,
                          type: step.action.form.fields[0].type,
                          label: step.action.form.fields[0].label,
                          ...(step.action.form.fields[0].description !== undefined
                            ? { description: step.action.form.fields[0].description }
                            : {}),
                          ...(step.action.form.fields[0].placeholder !== undefined
                            ? { placeholder: step.action.form.fields[0].placeholder }
                            : {}),
                          required: step.action.form.fields[0].required,
                          maxLength: step.action.form.fields[0].maxLength,
                        },
                      ],
                    },
                  }
                : {
                    id: step.action.id,
                    kind: step.action.kind,
                  },
          }
        : {}),
    })),
  };
}

/**
 * Preserve non-plugin interactions by identity while projecting plugin setup
 * snapshots at a remote transport boundary.
 */
function sanitizeGhostSetupRequestForRemote<T>(request: T): T {
  if (
    !request ||
    typeof request !== 'object' ||
    (request as { kind?: unknown }).kind !== 'plugin_setup'
  ) {
    return request;
  }
  return sanitizeGhostSetupSnapshotForRemote(
    request as unknown as GhostSetupInteractionSnapshot,
  ) as T;
}

function isDesktopOnlyConfirmationRequest(request: unknown): boolean {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return false;
  const kind = (request as { kind?: unknown }).kind;
  return (
    kind === 'mcp_setup' || (kind === 'issue_confirm' && (request as Record<string, unknown>).remoteConfirmSupported !== true) || kind === 'rename_sessions_confirm' || kind === 'ghost_grant_confirm'
  );
}

// Device Link must not receive a host confirmation's real request id: it is the
// capability checked by the trusted Desktop resolver. A process-keyed HMAC
// keeps request/dismissal correlation stable without retaining source ids.

function projectDesktopOnlyConfirmation(request: Record<string, unknown>): Record<string, unknown> | null {
  const requestId = request.requestId;
  if (typeof requestId !== 'string' || requestId.length === 0) return null;
  // Preserve only the known kind so mobile can render its existing read-only
  // guidance. Drafts, file paths, previews, identities, and the real id stay
  // on the controlled Desktop.
  return { kind: request.kind === 'mcp_setup' ? 'ghost_grant_confirm' : request.kind, requestId: projectDesktopOnlyConfirmationRequestId(requestId) };
}

/**
 * Host-owned confirmations stay on the trusted Desktop. This keeps their
 * request ids and local payload details (for example file paths and previews)
 * out of Device Link while preserving the existing sanitized plugin-setup
 * projection used for remote status/cancellation.
 */
function projectInteractionRequestForRemote<T>(request: T): T | null {
  if (isDesktopOnlyConfirmationRequest(request)) {
    return projectDesktopOnlyConfirmation(request as Record<string, unknown>) as T | null;
  }
  return sanitizeGhostSetupRequestForRemote(request);
}


return { sanitizeGhostSetupSnapshotForDesktop, sanitizeBotAuthorizationMetaForRemote, sanitizeGhostSetupSnapshotForRemote, sanitizeGhostSetupRequestForRemote, projectInteractionRequestForRemote };
}

/** Rewrites a Host-only dismissal to the same opaque id exposed by its request projection. */
export function projectInteractionDismissedForRemote<T>(payload: T): T {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const requestId = (payload as { requestId?: unknown }).requestId;
  if (typeof requestId !== 'string') return payload;
  if (!isDesktopOnlyConfirmationRequestId(requestId)) return payload;
  return {
    ...(payload as Record<string, unknown>),
    requestId: projectDesktopOnlyConfirmationRequestId(requestId),
  } as T;
}

