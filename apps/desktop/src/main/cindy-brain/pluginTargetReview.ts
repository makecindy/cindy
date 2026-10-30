import { fastModeFromStorage } from '@cindy/maker-shared';
import type { CurrentDbClientSnapshot } from '../localDb/client/current.js';
import type { PluginReviewSnapshot } from '../maker-ipc/pluginTaskReviewContext.js';
import { isPluginTaskPermissionAllowed } from '../maker-ipc/pluginTaskService.js';
import type { GhostErrandPermissionMode } from '../../shared/ghost.js';
import type { PluginTargetReceipt } from './pluginTargetSlot.js';

/** Runtime facts captured by Main, never supplied by a plugin or the model. */
export interface TargetReviewInput {
  clientId: string;
  generation: number;
  instanceId: string;
  turnGeneration: number;
}
interface TargetReviewDeps {
  owner(): CurrentDbClientSnapshot | null;
  activeInput(sessionId: string): TargetReviewInput | null;
  drain(): Promise<void>;
  assertDelivery(sessionId: string, clientId: string): Promise<void>;
  approvalRevision(pluginId: string): string | null;
  permissionCeiling(pluginId: string): GhostErrandPermissionMode | undefined;
}
interface ReviewRow {
  pluginId: string;
  requestKey: string;
  fingerprint: string;
  payload: string;
  revision: number;
  agentMeta: string;
  workingDir: string;
  permissionMode: string;
  planModeEnabled: number;
  status: string;
  agentKind: 'cc' | 'codex' | 'pi';
  providerId: string | null;
  model: string;
  effort: string;
  fastMode: number;
}

/** Adapt a live target receipt to the existing Auto review scope projection.
 * No team, task, owner request or permission override is created. Ordinary
 * messages (including legacy plugin sends) continue through their old resolver.
 */
export function createPluginTargetReviewLoader(deps: TargetReviewDeps) {
  return async (sessionId: string): Promise<PluginReviewSnapshot | null> => {
    const input = deps.activeInput(sessionId);
    if (!input?.clientId.startsWith('plugin-target:')) return null;
    const owner = deps.owner();
    if (!owner) throw new Error('Delegated task storage unavailable');
    const current = () => {
      if (deps.owner() !== owner || JSON.stringify(deps.activeInput(sessionId)) !== JSON.stringify(input))
        throw new Error('Delegated task input changed');
    };
    const initial = await owner.client.queryOne<{ scope: string | null }>(
      "SELECT json_extract(payload,'$.delegation.task') AS scope FROM plugin_task_requests WHERE id = ? AND operation = 'target'",
      [input.clientId]);
    current();
    if (initial?.scope == null) return null;
    await deps.drain();
    current();
    await deps.assertDelivery(sessionId, input.clientId);
    current();
    const projection = await owner.client.tx('authorization.readProjection', { sessionId, leadId: sessionId });
    current();
    // A single final read fences transcript provenance, receipt, canonical bot,
    // runtime settings and the exact owner-instruction projection together.
    const row = await owner.client.queryOne<ReviewRow>(`
      SELECT r.plugin_id AS pluginId, r.request_key AS requestKey, r.fingerprint, r.payload, r.revision,
        m.agent_meta AS agentMeta, s.working_dir AS workingDir, s.permission_mode AS permissionMode,
        coalesce(s.plan_mode_enabled,0) AS planModeEnabled, s.status, s.agent_kind AS agentKind,
        s.provider_id AS providerId, s.model, s.effort, coalesce(s.fast_mode,0) AS fastMode
      FROM sessions s
      JOIN plugin_task_requests r ON r.id = ? AND r.operation = 'target'
      JOIN messages m ON m.session_id = s.id AND m.client_id = r.id AND m.role = 'user'
        AND m.rewind_at IS NULL AND (s.cleared_at IS NULL OR m.created_at > s.cleared_at)
      JOIN bot_session_links b ON b.session_id = s.id AND b.role = 'canonical' AND b.archived_at IS NULL
      JOIN bot_profiles bot ON bot.id = b.bot_id AND bot.status = 'active' AND bot.hidden_at IS NULL
      JOIN auto_review_projections p ON p.session_id = s.id AND p.lead_id = s.id
      WHERE s.id = ? AND s.status = 'active' AND s.remote_host_id IS NULL AND s.agent_device_id IS NULL
        AND json_extract(r.payload,'$.taskId') = s.id
        AND json_extract(r.payload,'$.target.kind') = 'bot'
        AND json_extract(r.payload,'$.target.id') = bot.id
        AND p.revision = ? AND p.projected_revision = p.revision AND p.version = 3
      LIMIT 1`, [input.clientId, sessionId, projection.revision]);
    current();
    if (!row) throw new Error('Delegated task evidence is not current');
    const receipt = JSON.parse(row.payload) as PluginTargetReceipt;
    // Legacy target inputs have no delegated execution scope.
    if (!receipt.delegation) throw new Error('Delegated task scope was removed');
    const meta = JSON.parse(row.agentMeta);
    const approvalRevision = deps.approvalRevision(row.pluginId);
    if (receipt.id !== input.clientId || receipt.pluginId !== row.pluginId ||
        receipt.requestKey !== row.requestKey || receipt.hash !== row.fingerprint || !receipt.hash ||
        !['pending', 'accepted'].includes(receipt.status) ||
        receipt.approvalRevision !== approvalRevision || !approvalRevision ||
        receipt.delegation.version !== 1 || typeof receipt.delegation.task !== 'string' ||
        !receipt.delegation.task.trim() || receipt.delegation.task.length > 8000 || receipt.delegation.task.includes('\0') ||
        meta?.sourcePlugin?.pluginId !== row.pluginId || meta.sharedTaskAuthor ||
        meta.delivery !== 'turn' || meta.autoReviewUserText?.kind !== 'delegated-continuation' ||
        meta.autoReviewUserText?.request || !row.workingDir || !['cc', 'codex', 'pi'].includes(row.agentKind))
      throw new Error('Delegated task authorization is no longer valid');
    const route = { agentKind: row.agentKind, providerId: row.providerId ?? '', model: row.model,
      effort: row.effort, fastMode: fastModeFromStorage(row.fastMode) };
    const ceiling = deps.permissionCeiling(row.pluginId);
    return {
      pluginId: row.pluginId, authorized: ceiling === undefined || isPluginTaskPermissionAllowed('auto', ceiling),
      revision: [owner.userId, owner.clientEpoch, approvalRevision, input, row.revision, row.fingerprint, ceiling],
      // Existing reviewer consumes plan.task as a scope; no team is registered.
      plan: { task: receipt.delegation.task, concurrency: 1, items: [] },
      registeredRoute: route,
      session: { workingDir: row.workingDir, permissionMode: row.permissionMode,
        planModeEnabled: !!row.planModeEnabled, status: row.status, route },
      lead: { permissionMode: row.permissionMode, planModeEnabled: !!row.planModeEnabled, status: row.status },
      projection, history: [], sessionHistory: [], historyComplete: true,
    };
  };
}
