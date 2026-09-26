import { createHash } from 'node:crypto';
import {
  appendAutoReviewUserIntent,
  type AutoReviewRequest,
  type AutoReviewUserIntent,
} from '@cindy/maker-core';
import type { PluginTeamPlan, PluginTaskRoute } from '../../shared/pluginTasks.js';
import { readAutoReviewUserText, type AutoReviewHistoryMessage } from './autoReviewUserIntent.js';

export interface PluginReviewSnapshot {
  pluginId: string;
  authorized: boolean;
  revision: unknown;
  registeredRoute?: PluginTaskRoute;
  plan?: PluginTeamPlan;
  settledLabels?: string[];
  session: { workingDir: string; permissionMode: string; status: string; route: PluginTaskRoute };
  lead: { permissionMode: string; status: string };
  worker?: { label: string; activeTeam: boolean };
  history: AutoReviewHistoryMessage[];
  historyComplete: boolean;
}

/** Only Host-captured authored text counts. Missing legacy receipts never imply missing restrictions. */
export function pluginReviewUserIntent(snapshot: PluginReviewSnapshot): AutoReviewUserIntent {
  let intent: AutoReviewUserIntent = '';
  let omitted = !snapshot.historyComplete;
  const eventTime = (m: AutoReviewHistoryMessage): number => {
    const receipt = m.agentMeta?.autoReviewUserText;
    if ((m.role === 'ask_user' || m.role === 'plan_review') && receipt && typeof receipt === 'object'
      && 'acceptedAt' in receipt && typeof receipt.acceptedAt === 'number' && Number.isFinite(receipt.acceptedAt)) {
      return receipt.acceptedAt;
    }
    return m.createdAt ?? 0;
  };
  const times = new Set<number>();
  for (const m of [...snapshot.history].sort((a, b) => eventTime(a) - eventTime(b))) {
    const receipt = m.agentMeta?.autoReviewUserText;
    const text = typeof receipt === 'string' ? receipt
      : receipt && typeof receipt === 'object' && 'text' in receipt ? receipt.text : '';
    if (text) {
      const at = eventTime(m);
      if (!Number.isFinite(at) || at <= 0 || times.has(at)) omitted = true;
      times.add(at);
    }
    if (m.role === 'ask_user' || m.role === 'plan_review') {
      // A card answer can constrain the task, but an unanswered card grants nothing.
      if (
        receipt &&
        typeof receipt === 'object' &&
        'text' in receipt &&
        typeof receipt.text === 'string' &&
        'acceptedAt' in receipt && typeof receipt.acceptedAt === 'number' && Number.isFinite(receipt.acceptedAt)
      ) {
        intent = appendAutoReviewUserIntent(intent, receipt.text);
      } else {
        // Legacy/unverified cards may contain restrictions; absence is not consent.
        omitted = true;
      }
    } else if (m.role === 'user') {
      if (
        typeof receipt === 'string' &&
        ['turn', 'steer'].includes(String(m.agentMeta?.delivery))
      ) {
        if (readAutoReviewUserText(m.content) === null) intent = '';
        intent = appendAutoReviewUserIntent(intent, receipt);
      } else if (!(
        receipt &&
        typeof receipt === 'object' &&
        'kind' in receipt &&
        (receipt.kind === 'scheduled-continuation' || receipt.kind === 'delegated-continuation')
      )) {
        omitted = true;
      }
    }
  }
  if (!omitted) return intent;
  return typeof intent === 'string'
    ? { earlierUserMessages: [], currentUserMessage: intent, historyOmitted: true }
    : { ...intent, historyOmitted: true };
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
    const userIntent = pluginReviewUserIntent(snapshot);
    const denied = (reason: string): AutoReviewRequest => ({
      ...base,
      userIntent,
      authorizationError: reason,
    });
    if (
      !snapshot.authorized ||
      snapshot.session.permissionMode !== 'auto' ||
      snapshot.lead.permissionMode !== 'auto' ||
      snapshot.session.status !== 'active' ||
      snapshot.lead.status !== 'active'
    ) {
      return denied('Plugin or task Auto authorization is no longer active.');
    }
    const plan = snapshot.plan;
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
        item.workingDir !== snapshot.session.workingDir ||
        (Object.keys(item.route) as Array<keyof PluginTaskRoute>).some(
          (k) => item.route[k] !== snapshot.session.route[k],
        ))
    ) {
      return denied('Worker does not match the active registered plan.');
    }
    if (request.workspaceRoots[0] !== snapshot.session.workingDir)
      return denied('Task working directory changed.');
    if (!task) return { ...base, userIntent }; // Legacy plans keep existing review behavior, without an invented grant.
    if (task.length > 8000) return denied('Host-registered delegated task scope is invalid.');
    // Hash includes both scope and live ownership facts; cached decisions cannot cross a change.
    const authorizationRevision = createHash('sha256')
      .update(
        JSON.stringify([
          snapshot.revision,
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
