import { randomUUID } from 'node:crypto';
import { annotatePermissionRequestForUnavailableReview, resolveAutoReviewDecision, type AutoReviewDecision, type InteractionDecision, type InteractionRequest } from '@cindy/maker-core';
import { getMakerIfReady, reviewAutoPermissionAction } from '../maker-host/index.js';
import { desktopSessionStorage } from '../maker-host/session-storage.js';
import { HOST_CONFIRM_TIMEOUT_MS } from '../maker-ipc/hostConfirmTiming.js';

type ConfirmProbe = (sessionId: string, request: InteractionRequest, signal: AbortSignal) => Promise<InteractionDecision>;
let confirmProbe: ConfirmProbe | undefined;

/** The IPC owner supplies its existing Desktop/Mobile interaction route. */
export function setImportProbeConfirmation(confirm: ConfirmProbe): void { confirmProbe = confirm; }

export interface ImportProbeAction {
  connection: string;
  endpoint: string;
  tool: string;
  arguments: Record<string, unknown>;
  /** Server-controlled evidence, never authorization. All fields are redacted. */
  untrustedToolDescription?: string;
}

/** Importing a connection does not authorize a model-planned call. Keep each
 * probe on the normal Auto / Ask / Full Access boundary, including fresh
 * companions whose canonical task has no running harness yet. */
export async function withAuthorizedImportProbe<T>(
  sessionId: string, action: ImportProbeAction, assertOwner: () => void,
  run: (signal: AbortSignal, assertCurrent: () => Promise<void>) => Promise<T>,
): Promise<T> {
  assertOwner();
  const maker = getMakerIfReady();
  if (!maker) throw new Error('IMPORT_PROBE_AUTHORIZATION_UNAVAILABLE');
  const readScope = async () => {
    assertOwner();
    if (getMakerIfReady() !== maker) throw new Error('IMPORT_PROBE_AUTHORIZATION_CHANGED');
    const meta = await maker.getSessionMeta(sessionId);
    const status = await desktopSessionStorage.getStatus(sessionId);
    assertOwner();
    if (getMakerIfReady() !== maker) throw new Error('IMPORT_PROBE_AUTHORIZATION_CHANGED');
    const live = maker.getSession(sessionId);
    const permission = live?.stablePermissionModeState;
    const plan = live?.stablePlanModeState;
    if (!meta || status !== 'active' || live && (!permission || !plan || plan.enabled)) throw new Error('IMPORT_PROBE_AUTHORIZATION_UNAVAILABLE');
    const mode = live ? permission!.mode : meta.permissionMode;
    if (mode === 'plan') throw new Error('IMPORT_PROBE_AUTHORIZATION_UNAVAILABLE');
    return { meta, mode, live, liveKey: JSON.stringify([permission, plan]) };
  };
  const scope = await readScope();
  let live = scope.live;
  let liveKey = scope.liveKey;
  const controller = new AbortController();
  const assertCurrent = async () => {
    controller.signal.throwIfAborted();
    const current = await readScope();
    if (current.meta.workDir !== scope.meta.workDir || current.meta.permissionMode !== scope.meta.permissionMode || current.mode !== scope.mode
      || live && (current.live !== live || current.liveKey !== liveKey)) throw new Error('IMPORT_PROBE_AUTHORIZATION_CHANGED');
    // Opening the new companion to answer a card may start its first harness.
    // Admit that same-policy instance, then fence its permission generations.
    if (!live && current.live) { live = current.live; liveKey = current.liveKey; }
    controller.signal.throwIfAborted();
  };
  // Ownership and permission changes also cancel a pending confirmation or MCP.
  let checking = false;
  const fence = setInterval(() => {
    if (checking) return;
    checking = true;
    void assertCurrent().catch(() => controller.abort()).finally(() => { checking = false; });
  }, 250);
  fence.unref();
  try {
    const input = structuredClone(action);
    const decision: AutoReviewDecision = scope.mode === 'bypassPermissions' ? { verdict: 'allow' as const }
      : scope.mode !== 'auto' ? { verdict: 'ask' as const }
        : await resolveAutoReviewDecision({
          sessionId, agentKind: scope.meta.agentKind, model: scope.meta.model,
          // This authority comes from the accepted takeover selection, not the
          // imported personality, job prompt, tool description or planner output.
          userIntent: 'Import the selected agent and take over the selected automations after verifying their existing data access. Perform read-only checks; this request does not authorize modifying or deleting external data or sending messages during verification.',
          authorizationContext: { requesterAuthority: 'owner', source: 'direct' },
          action: { kind: 'other', requireConsent: true, description: JSON.stringify(input) },
          workspaceRoots: [scope.meta.workDir], writableRoots: [], platform: process.platform,
        }, reviewAutoPermissionAction);
    await assertCurrent();
    if (decision.verdict === 'block') throw new Error('IMPORT_PROBE_NOT_AUTHORIZED');
    if (decision.verdict === 'ask') {
      if (!confirmProbe) throw new Error('IMPORT_PROBE_AUTHORIZATION_UNAVAILABLE');
      const request: Extract<InteractionRequest, { kind: 'permission' }> = {
        kind: 'permission', requestId: randomUUID(), toolName: `mcp__companion_connections__${action.tool}`, input: { ...input },
        suggestions: [],
      };
      const answer = await confirmProbe(sessionId, decision.unavailable
        ? annotatePermissionRequestForUnavailableReview(request) : request,
      AbortSignal.any([controller.signal, AbortSignal.timeout(HOST_CONFIRM_TIMEOUT_MS)]));
      await assertCurrent();
      // Ignore updatedInput and remembered grants: this decision belongs only
      // to the exact captured connection/tool/arguments for this invocation.
      if (answer.kind !== 'permission' || answer.behavior !== 'allow') throw new Error('IMPORT_PROBE_NOT_AUTHORIZED');
    }
    return await run(controller.signal, assertCurrent);
  } finally { clearInterval(fence); controller.abort(); }
}
