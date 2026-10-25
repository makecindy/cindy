import { z } from 'zod';
import type { OrcaLifecycleService } from '@cindy/orca-workflow/host/orcaLifecycleService';
import type { OrcaTeamService } from '@cindy/orca-workflow/host/orcaTeamService';
import { createOrcaUiAssignmentDispatchClaims, createOrcaUiAssignmentHistoryGate } from '@cindy/orca-workflow/host/orcaUiAssignmentHistoryGate';
import { buildUiAssignmentInitialTask } from '@cindy/orca-workflow/host/orcaUiAssignment';
import type { OrcaMcpDeps } from '../../../../packages/lizi-mcps/src/orca/server.js';
import type { TerminalOrcaStore } from './orca-store.js';
import { TerminalRemoteError } from '../remote/types.js';

export const ORCA_CONTROL_CHANNELS = [
  'maker:session:enable-orca', 'maker:session:disable-orca', 'maker:team:end',
  'maker:worker:create', 'maker:worker:list', 'maker:worker:switch-focus', 'maker:worker:idle',
  'maker:worker:acknowledge-done', 'maker:worker:archive', 'maker:worker:dispatch-ui-assignment',
  'maker:collaboration-settings:get', 'maker:collaboration-settings:set', 'maker:collaboration-settings:reset',
] as const;
const id = z.string().min(1).max(128);
const workerOptions = z.object({
  role: z.string().min(1).max(32).optional(), label: z.string().min(1).optional(), model: z.string().min(1).optional(),
  providerId: z.string().nullish(), effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(),
  fast: z.union([z.boolean(), z.literal('ultrafast')]).optional(), workerPermissionMode: z.enum(['auto', 'bypassPermissions']).optional(),
  executionDeviceId: id.optional(), agentDeviceId: id.nullish(), workingDir: z.string().min(1).optional(),
  worktree: z.object({ sourceBranch: z.string().min(1).optional() }).optional(),
});
const unwrap = <T extends { ok: boolean; errorCode?: string; message?: string }>(result: T): Extract<T, { ok: true }> => {
  // Preserve the public protocol code without forwarding internal paths or
  // provider details that may occur in a lifecycle failure's message.
  if (!result.ok) throw new TerminalRemoteError(result.errorCode ?? 'INTERNAL', 'Orca operation failed');
  return result as Extract<T, { ok: true }>;
};
export function createTerminalOrcaIpc(deps: {
  store: TerminalOrcaStore; lifecycle: OrcaLifecycleService; team: OrcaTeamService; api: OrcaMcpDeps;
  authority(id: string): Promise<{ assertCurrent(): Promise<void> }>;
  remote(id: string): boolean;
  hasUserMessageSince(id: string, timestamp: number): Promise<boolean>;
}) {
  const history = createOrcaUiAssignmentHistoryGate({ hasUserMessageSince: deps.hasUserMessageSince });
  const claims = createOrcaUiAssignmentDispatchClaims();
  const settings = () => deps.store.settingsWire();
  return { history, async invoke(channel: string, args: unknown[]) {
    switch (channel) {
      case 'maker:session:enable-orca': {
        const input = workerOptions.extend({ workerAgent: z.enum(['claude-code', 'codex', 'pi']).default('claude-code'),
          delegateTask: z.string().optional(), deferDelegateTask: z.boolean().optional() }).parse(args[1] ?? {});
        return unwrap(await deps.lifecycle.enableTeam({ ...input, leadSessionId: id.parse(args[0]) }));
      }
      case 'maker:session:disable-orca': case 'maker:team:end': return unwrap(await deps.api.endTeam({ leadSessionId: id.parse(args[0]) }));
      case 'maker:worker:create': {
        const input = workerOptions.extend({ leadSessionId: id, role: z.string().min(1).max(32), label: z.string().min(1),
          agent: z.enum(['claude-code', 'codex', 'pi']).default('claude-code'), initialTask: z.string().optional() }).parse(args[0]);
        return unwrap(await deps.lifecycle.createWorker(input));
      }
      case 'maker:worker:list': return deps.store.listWorkersByLead(id.parse(args[0]));
      case 'maker:worker:switch-focus': return unwrap(await deps.api.switchFocus(z.object({ leadSessionId: id, workerIdOrLabel: id }).parse(args[0])));
      case 'maker:worker:idle': case 'maker:worker:acknowledge-done': case 'maker:worker:archive': {
        const input = z.object({ leadSessionId: id, workerId: id, expectedStatus: z.literal('done').optional() }).parse(args[0]);
        const params = { callerLeadSessionId: input.leadSessionId, workerId: input.workerId };
        return channel === 'maker:worker:archive' ? unwrap(await deps.team.archiveWorker(params))
          : unwrap(await deps.team.idleWorker({ ...params, ...(channel === 'maker:worker:acknowledge-done' ? { expectedStatus: 'done' as const } : input.expectedStatus ? { expectedStatus: input.expectedStatus } : {}) }));
      }
      case 'maker:worker:dispatch-ui-assignment': {
        const [leadSessionId, workerSessionId, initialTask, snapshotBeforeMs, waitForHistory] = z.tuple([id, id, z.string().trim().min(1), z.number().finite().nonnegative(), z.boolean()]).parse(args);
        const authority = await deps.authority(leadSessionId);
        if (waitForHistory && !await history.waitUntilQueryable(leadSessionId, snapshotBeforeMs)) throw new Error('[PRECONDITION_FAILED] Lead input is not queryable');
        await authority.assertCurrent();
        return claims.runOnce({ leadSessionId, workerSessionId, snapshotBeforeMs }, async () => unwrap(await deps.team.sendToWorker({
          callerLeadSessionId: leadSessionId, targetSessionId: workerSessionId,
          message: deps.remote(workerSessionId) ? initialTask : buildUiAssignmentInitialTask({ leadSessionId, initialTask, snapshotBeforeMs }),
        }, authority.assertCurrent)));
      }
      case 'maker:collaboration-settings:get': return settings();
      case 'maker:collaboration-settings:set': {
        const input = z.object({ key: z.enum(['workerSoftLimit', 'workerHardLimit', 'workerIdleReleaseMinutes']), value: z.number().int().finite() }).parse(args[0]);
        await deps.store.updateSettings({ [input.key]: input.value }); return settings();
      }
      case 'maker:collaboration-settings:reset': return deps.store.resetSettings();
      default: throw new Error('CHANNEL_NOT_ALLOWED');
    }
  } };
}
