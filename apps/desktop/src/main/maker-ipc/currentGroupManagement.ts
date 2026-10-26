import { currentGroupMutation, type CurrentGroupRequest, type CurrentGroupResult } from '@cindy/mcps/group-management';
import { chatGroupRolePermissions } from '@cindy/maker-shared/botGroupPresentation';
import { z } from 'zod';

interface Member { id: string; kind: string; name: string; state: string; role: string; ownerActorId: string; ownerName?: string }
interface Plan {
  id: string; revision: number; status: string; kind?: string; current_step: number | null;
  steps: Array<{ position: number; botId: string; botName: string; task: string; status: string }>;
}
interface Room { id: string; kind?: string; name: string; topic: string; description: string; revision: number; archived: boolean; dissolved_at?: string | null }
interface Dependencies {
  botActorId: string; requesterId?: string;
  execution: { id: string; source_message_id: string; plan_id?: string | null; plan_step?: number | null };
  validate(): Promise<void>;
  assertCurrent(): void;
  snapshot(): Promise<{ room: Room; members: Member[] }>;
  /** Writes must disable automatic authentication replay. */
  api<T>(route: string, method?: string, data?: unknown, actorId?: string): Promise<T>;
  changed(): void;
  inviteToken(link: string): string;
  ownedBots(): Promise<Array<{ actorId: string; botId: string; name: string }>>;
  replacePlanIntent(): Promise<unknown>;
  executionStopped(executionId: string): Promise<void>;
  reconcileExecutions(): Promise<void>;
}

/** Current execution only. No account proxy actor selection, private Bot access, or caller-selected group. */
export function createCurrentGroupManagement(deps: Dependencies) {
  let tail: Promise<unknown> = Promise.resolve();
  let unknownResult = false;
  type Wire = { route: string; method: string; payload: Record<string, unknown> };
  const attempts = new Map<string, { fingerprint: string; result: CurrentGroupResult; wire?: Wire }>();
  const manager = (member: Member) => chatGroupRolePermissions(member.role).manager;
  async function context() {
    await deps.validate();
    const snapshot = await deps.snapshot();
    deps.assertCurrent();
    const bot = snapshot.members.find(m => m.id === deps.botActorId && m.kind === 'bot' && m.state === 'joined');
    const requester = snapshot.members.find(m => m.id === deps.requesterId && m.state === 'joined');
    if (!bot || !requester || snapshot.room.kind !== 'group') throw new Error('GROUP_AUTHORIZATION_REQUIRED');
    return { ...snapshot, bot, requester };
  }
  async function execute(request: CurrentGroupRequest, assertPermission: () => void): Promise<CurrentGroupResult> {
    try {
      let ctx = await context();
      assertPermission();
      // The human owner may direct THIS bot's role, as in the settings UI.
      // Another owned bot, or a member using someone else's bot, cannot proxy it.
      const ownerProxy = () => ctx.requester.kind === 'human' && ctx.requester.id === ctx.bot.ownerActorId;
      // Existing mutation contracts carry only X-Chat-Actor, not a requester/lease.
      // Until the server can authorize that requester atomically, only the bot's
      // human owner may direct it; guest admin status alone is insufficient.
      const bothManage = () => manager(ctx.bot) && ownerProxy();
      const bothOwn = () => ctx.bot.role === 'owner' && ownerProxy();
      const roomPath = `/conversations/${ctx.room.id}`;
      if (request.type === 'inspect') {
        const executions = await deps.api<Array<{ id: string; status: string; bot_id: string; requester_id?: string; source_message_id: string; plan_id?: string | null; plan_step?: number | null }>>(`${roomPath}/executions`);
        const plans = await deps.api<Plan[]>(`${roomPath}/plans`);
        // This account's non-member roster is private to its owner, even when a
        // guest has tools access to a bot. Recheck before projecting the result.
        const ownedBots = bothManage() ? await deps.ownedBots() : [];
        ctx = await context(); assertPermission();
        const active = !ctx.room.archived && !ctx.room.dissolved_at;
        const result: CurrentGroupResult = { ok: true, group: { id: ctx.room.id, name: ctx.room.name, topic: ctx.room.topic, description: ctx.room.description, revision: ctx.room.revision, archived: ctx.room.archived, dissolvedAt: ctx.room.dissolved_at ?? null },
          self: { actorId: ctx.bot.id, role: ctx.bot.role }, requester: { actorId: ctx.requester.id, role: ctx.requester.role, directsOwnBot: ownerProxy() },
          permissions: { update: active && bothManage(), members: active && bothManage(), memberRoles: active && bothOwn(), invitations: active && bothManage(), archive: !ctx.room.dissolved_at && bothManage(), queue: active && bothManage() },
          protectedActorIds: ctx.members.filter(m => (m.role === 'owner' && m.state === 'joined') || m.id === ctx.bot.id || m.id === ctx.requester.id).map(m => m.id),
          members: ctx.members.map(m => ({ actorId: m.id, kind: m.kind, name: m.name, role: m.role, state: m.state, ownerActorId: m.ownerActorId, ownerName: m.ownerName })),
          invitableBots: active && bothManage() ? ownedBots.filter(b => !ctx.members.some(m => m.id === b.actorId && m.state === 'joined')) : [],
          currentExecution: { id: deps.execution.id, sourceMessageId: deps.execution.source_message_id, planId: deps.execution.plan_id ?? null, planStep: deps.execution.plan_step ?? null },
          executions: executions.map(e => ({ id: e.id, status: e.status, botActorId: e.bot_id, requesterId: e.requester_id, sourceMessageId: e.source_message_id, planId: e.plan_id ?? null, planStep: e.plan_step ?? null })),
          plans: plans.map(p => ({ id: p.id, revision: p.revision, status: p.status, kind: p.kind, currentStep: p.current_step,
            steps: p.steps.map(s => ({ position: s.position, botActorId: s.botId, botName: s.botName, task: s.task, status: s.status })) })),
          scope: 'current-group', privateAccessUnchanged: true,
          ...(!ownerProxy() ? { managementUnavailableReason: 'GROUP_REQUESTER_AUTHORIZATION_UNSUPPORTED' } : {}) };
        unknownResult = false;
        return result;
      }
      const mutation = currentGroupMutation.parse(request.mutation);
      const { operationId, action } = mutation;
      const fingerprint = JSON.stringify(action);
      const previous = attempts.get(operationId);
      const replay = previous && !previous.result.ok && previous.result.errorCode === 'GROUP_RESULT_UNKNOWN' ? previous.wire : undefined;
      // Even cached receipts require current authorization; operation ids cannot change their payload.
      const checkAuthorization = () => {
        if (!ownerProxy()) throw new Error('GROUP_REQUESTER_AUTHORIZATION_UNSUPPORTED');
        if (!bothManage()) throw new Error('GROUP_ROLE_REQUIRED');
        if ((action.type === 'member' && action.action === 'role') && !bothOwn()) throw new Error('GROUP_OWNER_REQUIRED');
        deps.assertCurrent(); assertPermission();
      };
      const check = () => {
        checkAuthorization();
        if (ctx.room.dissolved_at || (ctx.room.archived && action.type !== 'archive')) throw new Error('GROUP_CLOSED');
        if (action.type === 'update' && Object.keys(action).length <= 2) throw new Error('INVALID_ACTION');
        if (action.type === 'plan' && ['remove', 'reassign'].includes(action.action)) {
          if (action.position === undefined) throw new Error('INVALID_ACTION');
          if (action.action === 'reassign' && !ctx.members.some(m => m.id === action.botId && m.kind === 'bot' && m.state === 'joined')) throw new Error('INVALID_MEMBER');
        }
        if (!replay && 'expectedRevision' in action && action.type !== 'plan' && action.expectedRevision !== ctx.room.revision) throw new Error('REVISION_CONFLICT');
        if (action.type === 'member') {
          const target = ctx.members.find(m => m.id === action.actorId);
          if (action.action === 'role' && (!action.role || !bothOwn())) throw new Error('GROUP_OWNER_REQUIRED');
          if (action.action !== 'invite' && !target) throw new Error('INVALID_MEMBER');
          if (target?.id === ctx.bot.id || target?.id === ctx.requester.id || (target?.role === 'owner' && target.state === 'joined')) throw new Error('MEMBER_PROTECTED');
        }
        deps.assertCurrent(); assertPermission();
      };
      checkAuthorization();
      if (previous && previous.fingerprint !== fingerprint) throw new Error('OPERATION_CONFLICT');
      if (unknownResult) throw new Error('GROUP_RESULT_UNKNOWN');
      if (previous?.result.ok) return previous.result;
      check();
      // Retire the old planner and release its deferred source before plan
      // reads/writes (including an identical retry), like the human controls.
      // The final context check below also covers revocation during cancellation.
      if (action.type === 'plan') await deps.replacePlanIntent();
      let route = roomPath; let method = 'POST'; let payload: Record<string, unknown>;
      if (replay) ({ route, method, payload } = replay);
      else switch (action.type) {
        case 'update': { const { type: _, ...fields } = action; method = 'PATCH'; payload = fields; break; }
        case 'archive': method = 'PATCH'; payload = { archived: action.archived, expectedRevision: action.expectedRevision }; break;
        case 'member': { const { type: _, ...fields } = action; route += '/members'; payload = fields; break; }
        case 'createInvite': route += '/invite-links'; payload = {}; break;
        case 'revokeInvite': {
          route += '/invite-links/revoke'; payload = { token: deps.inviteToken(action.link) }; break;
        }
        case 'execution': {
          const rows = await deps.api<Array<{ id: string }>>(`${roomPath}/executions`);
          if (!rows.some(e => e.id === action.executionId)) throw new Error('EXECUTION_NOT_FOUND');
          route += `/executions/${action.executionId}/control`; payload = { action: action.action }; break;
        }
        case 'plan': {
          const rows = await deps.api<Array<{ id: string; revision: number; status: string }>>(`${roomPath}/plans?ids=${action.planId}`);
          const plan = rows.find(p => p.id === action.planId && p.revision === action.expectedRevision);
          if (!plan) throw new Error('REVISION_CONFLICT');
          const { type: _, planId: __, ...fields } = action; route += `/plans/${action.planId}`;
          payload = { ...fields, action: action.action === 'dismiss' && plan.status === 'waiting' ? 'stop' : action.action }; break;
        }
      }
      // Reads may have waited. Recheck after them, immediately before HTTP.
      ctx = await context(); check();
      try {
        const response = await deps.api<Record<string, unknown>>(route, method, { operationId, ...payload }, deps.botActorId);
        if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('CHAT_RESPONSE_INVALID');
        let receipt = response;
        if (action.type === 'createInvite') {
          const invite = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: z.string().refine(value => Number.isFinite(Date.parse(value))).nullable(), reusable: z.boolean().optional() }).parse(response);
          if (invite.expiresAt === null && invite.reusable !== true) throw new Error('CHAT_RESPONSE_INVALID');
          receipt = { link: `cindy://chat-invite/${invite.token}`, expiresAt: invite.expiresAt, ...(invite.reusable !== undefined ? { reusable: invite.reusable } : {}) };
        }
        if (action.type === 'revokeInvite') z.object({ revoked: z.literal(true) }).parse(response);
        const result: CurrentGroupResult = { ok: true, operationId, action: action.type, receipt };
        attempts.set(operationId, { fingerprint, result });
        if (action.type === 'execution') await deps.executionStopped(action.executionId);
        await deps.reconcileExecutions();
        deps.changed();
        return result;
      } catch (error) {
        const status = (error as { status?: number }).status;
        // Only a definitive 4xx refusal proves this operation did not commit.
        if (typeof status !== 'number' || status >= 500 || status === 408) {
          unknownResult = true;
          const result: CurrentGroupResult = { ok: false, errorCode: 'GROUP_RESULT_UNKNOWN', message: 'The operation may have succeeded. Read get_current_group and reconcile its state before deciding whether to retry with the same operationId.' };
          attempts.set(operationId, { fingerprint, result, wire: { route, method, payload } }); return result;
        }
        throw error;
      }
    } catch (error) {
      const code = error instanceof z.ZodError ? 'INVALID_INPUT' : (error as { code?: string }).code ?? (error instanceof Error ? error.message : 'GROUP_MANAGEMENT_FAILED');
      // Error codes only: do not forward paths, response bodies or transport diagnostics.
      const errorCode = /^[A-Z][A-Z0-9_]+$/.test(code) ? code : 'GROUP_MANAGEMENT_FAILED';
      return { ok: false, errorCode, message: errorCode === 'GROUP_RESULT_UNKNOWN' ? 'Read get_current_group before deciding whether to retry.' : `Group operation refused (${errorCode}). Query current group state and permissions.` };
    }
  }
  return (request: CurrentGroupRequest, assertPermission: () => void = () => {}) => {
    const pending = tail.then(() => execute(request, assertPermission));
    tail = pending.catch(() => undefined);
    return pending;
  };
}
