import { createAutoReviewIntentProjection } from '@cindy/maker-shared/auto-review-intent';
import { createHash } from 'node:crypto';
import {
  normalizeAutoReviewUserIntent,
  type AutoReviewRequest,
  type AutoReviewUserIntent,
} from '@cindy/maker-core';
import type { PluginTeamPlan, PluginTaskRoute } from '../../shared/pluginTasks.js';
import { isPluginTeamPlanWithinBudget } from '../../shared/pluginTasks.js';
import type { StoredAutoReviewProjection } from '../localDb/autoReviewProjection.js';
import { restoreAutoReviewUserIntent, type AutoReviewHistoryMessage } from './autoReviewUserIntent.js';

export interface PluginReviewSnapshot {
  pluginId: string;
  authorized: boolean;
  revision: unknown;
  registeredRoute?: PluginTaskRoute;
  plan?: PluginTeamPlan;
  settledLabels?: string[];
  session: { workingDir: string; permissionMode: string; planModeEnabled?: boolean; status: string; route: PluginTaskRoute };
  lead: { permissionMode: string; planModeEnabled?: boolean; status: string };
  worker?: { label: string; activeTeam: boolean; directoryMatches: boolean };
  history: AutoReviewHistoryMessage[];
  sessionHistory: AutoReviewHistoryMessage[];
  historyComplete: boolean;
  projection?: StoredAutoReviewProjection;
}

/** Only Host-captured authored text counts. Missing legacy receipts never imply missing restrictions. */
const intentProjection = createAutoReviewIntentProjection();
export function pluginReviewUserIntent(snapshot: PluginReviewSnapshot): AutoReviewUserIntent {
  return intentProjection.review(snapshot.history, snapshot.historyComplete);
}

/** Scope comes from the authenticated plugin receipt, never Lead/Worker prose or tool arguments. */
export function createPluginTaskReviewResolver(
  load: (sessionId: string) => Promise<PluginReviewSnapshot | null>,
) {
  return async (request: AutoReviewRequest): Promise<AutoReviewRequest> => {
    const { delegatedTask: _discard, authorizationError: _error, ...base } = request;
    if (!request.sessionId) return base;
    const snapshot = await load(request.sessionId);
    if (!snapshot) return base;
    const userIntent = snapshot.projection?.reviewIntent ?? pluginReviewUserIntent(snapshot);
    const denied = (reason: string): AutoReviewRequest => ({
      ...base,
      userIntent,
      authorizationError: reason,
    });
    // Accepted steer can precede (or outlive failure of) its transcript write.
    // Compare the same session projection used by dispatch, before merging Lead
    // restrictions. Preserve order/repetition and empty resource resets; text
    // membership cannot distinguish a repeated revocation from an older grant.
    if (JSON.stringify(normalizeAutoReviewUserIntent(request.userIntent)) !==
      JSON.stringify(snapshot.projection?.sessionIntent ?? restoreAutoReviewUserIntent(snapshot.sessionHistory))) {
      return denied('Current user instructions are not synchronized with task history; automatic authorization is blocked.');
    }
    if (
      !snapshot.authorized ||
      snapshot.session.planModeEnabled || snapshot.lead.planModeEnabled ||
      snapshot.session.permissionMode !== 'auto' ||
      snapshot.lead.permissionMode !== 'auto' ||
      snapshot.session.status !== 'active' ||
      snapshot.lead.status !== 'active'
    ) {
      return denied('Plugin or task Auto authorization is no longer active.');
    }
    const plan = snapshot.plan;
    if (plan && !isPluginTeamPlanWithinBudget(plan)) return denied('Team plan exceeds the supported size; automatic authorization is blocked.');
    const item = snapshot.worker
      ? plan?.items.find((x) => x.label === snapshot.worker!.label)
      : undefined;
    const task = snapshot.worker ? item?.task : plan?.task;
    if (!snapshot.worker && task && (!snapshot.registeredRoute ||
      (['agentKind', 'providerId', 'model', 'effort', 'fastMode'] as const).some(
        k => snapshot.registeredRoute![k] !== snapshot.session.route[k],
      ))) return denied('Coordinator does not match its registered route.');
    if (
      snapshot.worker &&
      (!snapshot.worker.activeTeam ||
        !item ||
        snapshot.settledLabels?.includes(snapshot.worker.label) ||
        !snapshot.worker.directoryMatches ||
        (Object.keys(item.route) as Array<keyof PluginTaskRoute>).some(
          (k) => item.route[k] !== snapshot.session.route[k],
        ))
    ) {
      return denied('Worker does not match the active registered plan.');
    }
    if (request.workspaceRoots[0] !== snapshot.session.workingDir)
      return denied('Task working directory changed.');
    // Missing scope does not turn a recognized plugin task into an ordinary task.
    if (typeof task !== 'string' || !task.trim() || task.length > 8000)
      return denied('Host-registered delegated task scope is missing or invalid.');
    // Hash includes both scope and live ownership facts; cached decisions cannot cross a change.
    const authorizationRevision = createHash('sha256')
      .update(
        JSON.stringify([
          snapshot.revision,
          snapshot.projection?.revision,
          snapshot.pluginId,
          snapshot.session,
          snapshot.lead,
          snapshot.worker,
          task,
          userIntent,
        ]),
      )
      .digest('hex');
    return {
      ...base,
      userIntent,
      delegatedTask: {
        source: 'approved-plugin',
        pluginId: snapshot.pluginId,
        role: snapshot.worker ? 'worker' : 'coordinator',
        task,
        workingDir: snapshot.session.workingDir,
        authorizationRevision,
      },
    };
  };
}
