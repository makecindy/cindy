/** Route only the four Worker bridge tools, using persisted links on both computers. */
import {
  ORCA_REMOTE_WORKER_BRIDGE_CHANNEL,
  parseOrcaRemoteWorkerBridgeRequest,
  isOrcaRemoteWorkerSessionId,
  type InvokeResultPayload,
} from '@cindy/device-link';
import type { McpProviderContext } from '@cindy/maker-core';
import { authorizeSendToLeadCaller } from '@cindy/orca-workflow/mcp';
import type { OrcaToolResult } from '@cindy/orca-workflow';
import type { OrcaRemoteLead } from '../../shared/orcaRemoteWorker.js';
import type { OrcaWorkerRecord } from '../localDb/orcaTeamStore.js';
import { throwIpcError } from '../utils/ipcValidate.js';

export interface OrcaRemoteWorkerBridgeDeps {
  getOwnerToken(): unknown;
  readSession(
    sessionId: string,
  ): Promise<{ status: string; orcaRemoteLead: OrcaRemoteLead | null } | null>;
  listWorkers(leadSessionId: string): Promise<OrcaWorkerRecord[]>;
  activeTeamId(leadSessionId: string): Promise<string | null>;
  invokeTool(
    ctx: McpProviderContext,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<OrcaToolResult>;
  remoteInvoke(deviceId: string, channel: string, args: unknown[]): Promise<InvokeResultPayload>;
  getActiveInputClientIds?(sessionId: string): readonly string[];
  /** Host-owned accepted input; cumulative reply IDs alone survive human steering. */
  getAcceptedInputProvenance?(sessionId: string): { originKind?: string } | null;
  captureReportSettlement?(proxySessionId: string, reportedInputClientIds: readonly string[]): () => Promise<void>;
}

const toolError = (error: string, code: string): OrcaToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({ error, code }) }],
  isError: true,
});

export function createOrcaRemoteWorkerBridge(deps: OrcaRemoteWorkerBridgeDeps) {
  const assertOwner = (owner: unknown) => {
    if (owner !== deps.getOwnerToken())
      throwIpcError('PERMISSION_DENIED', 'worker account changed');
  };
  return {
    async forwardTool(
      ctx: McpProviderContext,
      tool: string,
      args: Record<string, unknown>,
    ): Promise<OrcaToolResult | null> {
      if (!ctx.sessionId) return null;
      // Local Workers keep their existing path, including its latency and DB reads.
      if (ctx.vendorOptions?.orcaRole === 'worker' || ctx.vendorOptions?.orcaRole === 'lead')
        return null;
      // Freeze before any await: another input can be queued or start during the round trip.
      // These IDs come from the execution host, never from model-supplied tool arguments.
      const leadAssignedTurn = tool === 'send_to_lead'
        && deps.getAcceptedInputProvenance?.(ctx.sessionId)?.originKind === 'orca';
      const reportedInputClientIds = tool === 'send_to_lead'
        ? [...(deps.getActiveInputClientIds?.(ctx.sessionId) ?? [])]
          .filter(isOrcaRemoteWorkerSessionId).slice(-64)
        : undefined;
      const owner = deps.getOwnerToken();
      const row = await deps.readSession(ctx.sessionId);
      assertOwner(owner);
      const lead = row?.orcaRemoteLead;
      if (!lead) return null;
      if (row.status !== 'active' || lead.releasedAt !== undefined) {
        return toolError('remote worker collaboration has ended', 'NOT_FOUND');
      }
      // Provenance is checked on the execution device before crossing the device boundary.
      if (tool === 'send_to_lead') {
        const auth = authorizeSendToLeadCaller(ctx);
        if (!auth.ok)
          return { content: [{ type: 'text', text: JSON.stringify(auth.error) }], isError: true };
        if (!leadAssignedTurn || !reportedInputClientIds?.length) {
          return toolError(
            'This turn was not assigned by the Lead. Reply in the execution-device task instead.',
            'NOT_LEAD_ASSIGNED_TURN',
          );
        }
      }
      const request = parseOrcaRemoteWorkerBridgeRequest({
        sessionId: ctx.sessionId,
        leadSessionId: lead.leadSessionId,
        tool,
        args,
        ...(reportedInputClientIds ? { reportedInputClientIds } : {}),
      });
      try {
        const response = await deps.remoteInvoke(
          lead.leadDeviceId,
          ORCA_REMOTE_WORKER_BRIDGE_CHANNEL,
          [request],
        );
        assertOwner(owner);
        if (response.ok) {
          const result = response.result as Partial<OrcaToolResult> | null;
          if (
            !result ||
            !Array.isArray(result.content) ||
            typeof result.isError !== 'boolean' ||
            result.content.some((item) => item?.type !== 'text' || typeof item.text !== 'string')
          ) {
            return toolError('invalid Lead bridge response', 'REMOTE_BRIDGE_UNAVAILABLE');
          }
          return result as OrcaToolResult;
        }
        return toolError(
          'Lead bridge unavailable; finish with a final reply for automatic reporting.',
          response.error.code,
        );
      } catch {
        assertOwner(owner);
        // A timed-out report may already be queued. Never automatically replay a write.
        return toolError(
          'Lead bridge result unknown; do not resend. Finish with a final reply for automatic reporting.',
          'REMOTE_BRIDGE_UNAVAILABLE',
        );
      }
    },

    async handle(
      raw: unknown,
      caller: { controllerDeviceId: string; sharedTask?: unknown } | null,
    ): Promise<OrcaToolResult> {
      if (!caller?.controllerDeviceId || caller.sharedTask) {
        throwIpcError(
          'PERMISSION_DENIED',
          'worker bridge requires a same-account execution device',
        );
      }
      const request = parseOrcaRemoteWorkerBridgeRequest(raw);
      const owner = deps.getOwnerToken();
      const teamId = await deps.activeTeamId(request.leadSessionId);
      assertOwner(owner);
      const workers = await deps.listWorkers(request.leadSessionId);
      assertOwner(owner);
      const worker = workers.find(
        (w) =>
          w.teamId === teamId &&
          w.leadSessionId === request.leadSessionId &&
          w.executionDevice?.deviceId === caller.controllerDeviceId &&
          w.executionDevice?.remoteSessionId === request.sessionId,
      );
      if (
        !worker ||
        worker.session.id !== worker.sessionId ||
        request.args.worker_id !== worker.id
      ) {
        throwIpcError('PERMISSION_DENIED', 'remote worker does not belong to this active team');
      }
      // The model cannot supply a local context or select an arbitrary Lead. Reuse local
      // schemas, sender labels, dispatch/queue semantics and manual-report settlement.
      const settle =
        request.tool === 'send_to_lead'
          ? deps.captureReportSettlement?.(worker.sessionId, request.reportedInputClientIds ?? [])
          : undefined;
      if ((await deps.activeTeamId(request.leadSessionId)) !== teamId) {
        throwIpcError('PERMISSION_DENIED', 'worker team has ended');
      }
      assertOwner(owner);
      const result = await deps.invokeTool(
        {
          sessionId: worker.sessionId,
          agentKind: worker.session.agentKind,
          workingDir: '',
          mcpCallerAttested: true,
          mcpCallerKind: 'root',
          vendorOptions: {
            orcaRole: 'worker',
            orcaWorkerId: worker.id,
            orcaWorkerSessionId: worker.sessionId,
            orcaLeadSessionId: request.leadSessionId,
          },
        },
        request.tool,
        request.args,
      );
      assertOwner(owner);
      if (!result.isError) await settle?.();
      return result;
    },
  };
}
