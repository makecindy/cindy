import { eq } from 'drizzle-orm';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { fastModeToStorage } from '@cindy/maker-shared';
import { sessions, orcaWorkers, orcaTeams } from '@cindy/runtime-db/schema';
import type { CurrentDbClientSnapshot } from '@cindy/runtime-db/client/current';
import { readPluginTaskPlanReceipt } from '@cindy/plugin-runtime/pluginTaskService';
import type { PluginReviewSnapshot } from '@cindy/plugin-runtime/pluginTaskReviewContext';
import { createPluginTaskStore } from './pluginTaskStore.js';

/** The original Desktop authorization read: one owner DB, its persisted intent
 * projection, and a final database/installation fence before returning a grant. */
export function createPluginTaskReviewContextReader(host: {
  getCurrentDbClientSnapshot(): CurrentDbClientSnapshot | null;
  drainPersistQueue(): Promise<void>;
  assertTaskOwnership(pluginId: string, taskId: string): Promise<unknown>;
  readPluginTaskConfig(pluginId: string): { permissionMode: string };
  pluginTaskAuthorizationRevision(pluginId: string): unknown | null;
  isPluginTaskAuthorized(pluginId: string): boolean;
}) {
  const { getCurrentDbClientSnapshot, drainPersistQueue, assertTaskOwnership,
    readPluginTaskConfig, pluginTaskAuthorizationRevision, isPluginTaskAuthorized } = host;
  return async (sessionId: string): Promise<PluginReviewSnapshot | null> => {
    const epoch = getCurrentDbClientSnapshot();
    if (!epoch) throw new Error('Task storage unavailable');
    const db = epoch.client.drizzle;
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session) throw new Error('Task unavailable');
    // Ordinary tasks do not depend on plugin receipt storage. Worker ownership
    // is checked through its lead before touching the plugin task store.
    if (session.source !== 'plugin' && session.orcaRole !== 'worker') {
      if (epoch !== getCurrentDbClientSnapshot()) throw new Error('Account changed');
      return null;
    }
    const [link] = await db.select({ label: orcaWorkers.label, leadId: orcaTeams.leadSessionId,
      teamId: orcaTeams.id, teamStatus: orcaTeams.status }).from(orcaWorkers)
      .innerJoin(orcaTeams, eq(orcaWorkers.teamId, orcaTeams.id))
      .where(eq(orcaWorkers.sessionId, sessionId)).limit(1);
    const leadId = link?.leadId ?? sessionId;
    const [lead] = await db.select().from(sessions).where(eq(sessions.id, leadId)).limit(1);
    if (!lead) throw new Error('Lead unavailable');
    if (lead.source !== 'plugin') {
      if (epoch !== getCurrentDbClientSnapshot()) throw new Error('Account changed');
      return null;
    }
    const store = createPluginTaskStore(epoch.client);
    const receipt = await store.get(leadId);
    if (!receipt || receipt.operation !== 'create') {
      if (epoch !== getCurrentDbClientSnapshot()) throw new Error('Account changed');
      return null;
    }
    if (!session || !lead || !session.workingDir) throw new Error('Delegated task unavailable');
    const agentKind = session.agentKind === 'cc' ? 'cc' : session.agentKind === 'pi' ? 'pi' : session.agentKind === 'codex' ? 'codex' : null;
    if (!agentKind) throw new Error('Delegated task route unavailable');
    const data = readPluginTaskPlanReceipt(receipt.payload);
    const item = link ? data.teamPlan?.items.find(item => item.label === link.label) : undefined;
    let directoryMatches = item?.workingDir === session.workingDir;
    if (item && !directoryMatches) {
      try {
        directoryMatches = path.normalize(await fsp.realpath(item.workingDir)) === path.normalize(session.workingDir);
      } catch {
        directoryMatches = false;
      }
    }
    // Resolve aliases before the live ownership/database/epoch fence. Returning
    // the checked snapshot must not await filesystem I/O after that fence.
    await drainPersistQueue();
    const projection = await epoch.client.tx('authorization.readProjection', { sessionId, leadId });
    // Reinstall must not revive the old Lead's delegated authority, including
    // requests that were already waiting for history/projection reads at uninstall.
    await assertTaskOwnership(receipt.pluginId, leadId);
    if (epoch !== getCurrentDbClientSnapshot()) throw new Error('Account changed');
    // The projection/ownership awaits must not return an old Worker grant.
    // One final SELECT compares every database fact used below at one read point;
    // a changed fact denies this review, while a query failure remains unavailable.
    const unchanged = await epoch.client.queryOne<{ unchanged: number }>(`
      SELECT 1 AS unchanged FROM sessions s
      JOIN sessions l ON l.id = ?
      LEFT JOIN orca_workers w ON w.session_id = s.id
      LEFT JOIN orca_teams t ON t.id = w.team_id
      JOIN plugin_task_requests r ON r.id = l.id
      JOIN auto_review_projections p ON p.session_id = s.id AND p.lead_id = l.id
      WHERE s.id = ?
        AND json_array(s.source,s.orca_role,s.working_dir,s.permission_mode,coalesce(s.plan_mode_enabled,0),s.status,
          s.agent_kind,s.provider_id,s.model,s.effort,coalesce(s.fast_mode,0)) = ?
        AND json_array(l.source,l.permission_mode,coalesce(l.plan_mode_enabled,0),l.status) = ?
        AND json_array(w.label,t.lead_session_id,t.id,t.status) = ?
        AND json_array(r.id,r.target_id,r.plugin_id,r.operation,r.payload,r.revision) = ?
        AND p.revision = ? AND p.projected_revision = p.revision AND p.version = 3
      LIMIT 1`, [leadId, sessionId,
      JSON.stringify([session.source,session.orcaRole,session.workingDir,session.permissionMode,Number(!!session.planModeEnabled),session.status,
        session.agentKind,session.providerId,session.model,session.effort,fastModeToStorage(session.fastMode)]),
      JSON.stringify([lead.source,lead.permissionMode,Number(!!lead.planModeEnabled),lead.status]),
      JSON.stringify([link?.label,link?.leadId,link?.teamId,link?.teamStatus]),
      JSON.stringify([receipt.id,receipt.targetId,receipt.pluginId,receipt.operation,receipt.payload,receipt.revision]),
      projection.revision,
    ]);
    if (epoch !== getCurrentDbClientSnapshot()) throw new Error('Account changed');
    const config = readPluginTaskConfig(receipt.pluginId);
    const approvalRevision = pluginTaskAuthorizationRevision(receipt.pluginId);
    return {
      pluginId: receipt.pluginId,
      authorized: !!unchanged && approvalRevision !== null && isPluginTaskAuthorized(receipt.pluginId) && config.permissionMode === 'auto',
      revision: [epoch.userId, epoch.clientEpoch, approvalRevision, config.permissionMode, link],
      plan: data.teamPlan, settledLabels: data.settledLabels,
      registeredRoute: data.route,
      session: { workingDir: session.workingDir, permissionMode: session.permissionMode, planModeEnabled: !!session.planModeEnabled, status: session.status,
        route: { agentKind, providerId: session.providerId ?? '', model: session.model,
          effort: session.effort, fastMode: (session.fastMode ?? false) } },
      lead: { permissionMode: lead.permissionMode, planModeEnabled: !!lead.planModeEnabled, status: lead.status },
      ...(link ? { worker: { label: link.label ?? '', activeTeam: link.teamStatus === 'active', directoryMatches } } : {}),
      projection,
      history: [],
      sessionHistory: [],
      historyComplete: true,
    };
  };
}
