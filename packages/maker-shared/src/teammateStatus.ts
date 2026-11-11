/** Shared roster geometry and state precedence for Desktop, iOS and Android. */
// Keep touch targets independent of the portrait; the inset also holds corner dots and selection rings.
export const TEAMMATE_AVATAR = { strip: 36, stripTarget: 48, row: 44, dot: 10, border: 2, gap: 8 } as const;
export type TeammateStatus = 'awaiting' | 'error' | 'running' | 'done' | 'unread' | 'idle';
export interface TeammateActivity { phase: string }
export const TEAMMATE_STATUS_ORDER: readonly TeammateStatus[] = ['awaiting', 'error', 'running', 'done', 'unread', 'idle'];

export function aggregateTeammateStatus(states: readonly TeammateStatus[]): TeammateStatus {
  return TEAMMATE_STATUS_ORDER.find(state => states.includes(state)) ?? 'idle';
}

/** Read state only acknowledges a delivered result; it never dismisses a pending decision. */
export function resolveTeammateStatus(input: {
  activities?: readonly (TeammateActivity | null | undefined)[];
  waiting?: boolean; failed?: boolean; working?: boolean; unread?: boolean;
  online?: boolean | null; quietOffline?: boolean;
}): TeammateStatus {
  const phases = input.activities?.map(activity => activity?.phase) ?? [];
  if (input.online !== false) {
    if (input.waiting || phases.includes('needs-interaction')) return 'awaiting';
    if (input.failed || phases.includes('error')) return 'error';
    if (input.working || phases.includes('running')) return 'running';
  } else if (!input.quietOffline) return 'error';
  if (input.unread && phases.includes('completed')) return 'done';
  return input.unread ? 'unread' : 'idle';
}

/** Group plans remain actionable until the owner answers, including between steps. */
export function teammateGroupActivity(group: {
  teammateActivity?: TeammateActivity;
  archived?: boolean;
  speakingBotIds: readonly string[];
  planningBotId?: string | null;
  openPlan?: { status: string; currentStepStatus?: string | null } | null;
  lastMessage?: { authorKind: string } | null;
}): TeammateActivity {
  if (group.archived) return { phase: 'idle' };
  if (group.teammateActivity) return group.teammateActivity;
  const plan = group.openPlan;
  if (plan?.status === 'proposed' || plan?.status === 'waiting') return { phase: 'needs-interaction' };
  if (plan?.currentStepStatus === 'failed') return { phase: 'error' };
  if (group.speakingBotIds.length || group.planningBotId || plan?.status === 'running') return { phase: 'running' };
  return { phase: group.lastMessage?.authorKind === 'bot' ? 'completed' : 'idle' };
}

/** Server groups use the same execution and plan states on desktop and mobile. */
export function teammateChatActivity(input: {
  executions: readonly { status: string; updated_at?: string }[];
  plans: readonly { status: string }[];
  lastMessageAt?: number;
  planning?: boolean;
  archived?: boolean;
}): TeammateActivity {
  if (input.archived) return { phase: 'idle' };
  if (input.executions.some(row => row.status === 'needs_input')
    || input.plans.some(plan => plan.status === 'proposed' || plan.status === 'waiting')) return { phase: 'needs-interaction' };
  const recent = input.executions.filter(row => row.updated_at && Number.isFinite(Date.parse(row.updated_at))
    && Date.parse(row.updated_at) >= (input.lastMessageAt ?? 0));
  if (recent.some(row => row.status === 'failed')) return { phase: 'error' };
  if (input.planning || input.executions.some(row => ['queued', 'running', 'stopping'].includes(row.status))
    || input.plans.some(plan => plan.status === 'running')) return { phase: 'running' };
  if (recent.some(row => row.status === 'succeeded')) return { phase: 'completed' };
  return { phase: 'idle' };
}
