/** Shared roster geometry and state precedence for Desktop, iOS and Android. */
// Keep this module dependency-free so lightweight tooling (e.g. ES2022 scripts/device-link)
// can import it without pulling in heavier group-chat modules.
// Keep touch targets independent of the portrait; the inset also holds corner dots and selection rings.
export const TEAMMATE_AVATAR = { strip: 36, stripTarget: 48, row: 44, dot: 10, border: 2, gap: 8 } as const;
export type TeammateStatus = 'awaiting' | 'error' | 'running' | 'done' | 'unread' | 'idle';
export interface TeammateActivity { phase: string }
export const TEAMMATE_STATUS_ORDER: readonly TeammateStatus[] = ['awaiting', 'error', 'running', 'done', 'unread', 'idle'];

/** Whether a group member's work belongs to this account (owned companion or self-requested group Cindy). */
export function isOwnBotGroupWork(
  member: { assistant?: boolean; isOwned?: boolean } | undefined,
  isSelfRequested: boolean,
): boolean {
  return !!member && (member.assistant === true ? isSelfRequested : member.isOwned === true);
}

/** Whether a group speaker/execution belongs to this account's own agent (owned companion or self-requested group Cindy). */
export function isOwnBotGroupSpeaker(
  group: { serverBacked?: boolean; members: readonly { botId: string; assistant?: boolean; isOwned?: boolean }[] },
  speaker: { botId: string; executionId?: string; isSelfRequested?: boolean; activity: string },
): boolean {
  if (!group.serverBacked) return true;
  if (speaker.activity === 'planning' && !speaker.executionId) return speaker.isSelfRequested === true;
  return isOwnBotGroupWork(group.members.find(member => member.botId === speaker.botId), speaker.isSelfRequested === true);
}

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

/** Group plans remain actionable until the owner answers, including between steps.
 *  In-progress group executions stay inside the chat and do not project a running state outside. */
export function teammateGroupActivity(group: {
  teammateActivity?: TeammateActivity;
  archived?: boolean;
  serverBacked?: boolean;
  members?: readonly { botId: string; assistant?: boolean; isOwned?: boolean }[];
  round?: { speakers: readonly { botId: string; executionId?: string; isSelfRequested?: boolean; activity: string }[] };
  speakingBotIds: readonly string[];
  planningBotId?: string | null;
  openPlan?: { status: string; currentStepStatus?: string | null } | null;
  lastMessage?: { authorKind: string } | null;
}): TeammateActivity {
  if (group.archived) return { phase: 'idle' };
  if (group.teammateActivity) {
    return group.teammateActivity.phase === 'running'
      ? { phase: group.lastMessage?.authorKind === 'bot' ? 'completed' : 'idle' }
      : group.teammateActivity;
  }
  const plan = group.openPlan;
  if (plan?.status === 'proposed' || plan?.status === 'waiting') return { phase: 'needs-interaction' };
  if (plan?.currentStepStatus === 'failed') return { phase: 'error' };
  return { phase: group.lastMessage?.authorKind === 'bot' ? 'completed' : 'idle' };
}

/** Server groups use the same actionable and completion states on desktop and mobile;
 *  in-progress executions stay inside the group chat. */
export function teammateChatActivity(input: {
  executions: readonly {
    status: string;
    updated_at?: string;
    plan_id?: string | null;
    bot_id?: string;
    requester_id?: string;
    mask_owner_id?: string;
  }[];
  plans: readonly {
    id?: string;
    status: string;
    creator_id?: string;
    current_step?: number | null;
    steps?: readonly { position: number; botId: string; status: string }[];
  }[];
  lastMessageAt?: number;
  planning?: boolean;
  archived?: boolean;
}): TeammateActivity {
  if (input.archived) return { phase: 'idle' };
  if (input.executions.some(row => row.status === 'needs_input')
    || input.plans.some(plan => plan.status === 'proposed' || plan.status === 'waiting')) return { phase: 'needs-interaction' };
  const recent = input.executions.filter(row => row.updated_at && Number.isFinite(Date.parse(row.updated_at))
    && Date.parse(row.updated_at) >= (input.lastMessageAt ?? 0));
  // Ending an arrangement retires its alert, not its failed-step history. Require
  // a matching terminal plan: an absent plan or a failure in another lane is not
  // evidence of disposal. Pending decisions above remain independently actionable.
  const closedPlans = new Set(input.plans.filter(plan => plan.id
    && ['done', 'stopped', 'dismissed', 'superseded'].includes(plan.status)).map(plan => plan.id));
  if (recent.some(row => row.status === 'failed' && (!row.plan_id || !closedPlans.has(row.plan_id)))) return { phase: 'error' };
  if (recent.some(row => row.status === 'succeeded')) return { phase: 'completed' };
  return { phase: 'idle' };
}
