import { z } from 'zod';
import type { MobileGoalStatusPayload, MobileGoalLimitsInput } from '@cindy/maker-shared/device-link-contract';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';
import { parseQualifiedSessionId } from './send_to_session.js';

export type SessionGoalAction = 'get' | 'set' | 'update' | 'pause' | 'resume' | 'clear';
export interface SessionGoalRequest {
  callerSessionId: string;
  sessionId: string;
  deviceId?: string;
  action: SessionGoalAction;
  objective?: string;
  limits?: MobileGoalLimitsInput;
  patch?: Partial<MobileGoalLimitsInput & { objective: string }>;
}
export type SessionGoalCallback = (request: SessionGoalRequest) => Promise<
  ControlResult<{ goal: MobileGoalStatusPayload | null }, string>
>;

const targetShape = {
  session_id: z.string().trim().min(1).optional().describe(
    'Exact task ID; omitted means this task. Use deviceId::sessionId for an authorized remote computer, or local::sessionId for this computer.',
  ),
};
const limit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable();
const objective = z.string().trim().min(1).max(100_000);
const limitsShape = { maxTurns: limit, budgetTokens: limit, noProgressLimit: limit };
const scope = ' Runs on the task-owning computer without desktop input; a locked screen is supported while the host stays awake and running. Local by default; deviceId::sessionId uses the existing same-account remote-control authorization. Read back with get_session_goal; an active goal is not proof that its outcome is achieved.';

export function registerSessionGoalTools(registry: XdtHelperToolRegistry, deps: {
  getSessionContext(): LiziMcpSessionContext;
  execute: SessionGoalCallback;
}): void {
  async function execute(action: SessionGoalAction, sessionId: string | undefined, input: Partial<SessionGoalRequest> = {}) {
    const callerSessionId = deps.getSessionContext().sessionId;
    if (!callerSessionId) return errorPayload('NO_SESSION_CONTEXT', 'This goal operation needs a bound Cindy task.');
    const id = sessionId ?? callerSessionId;
    const qualified = parseQualifiedSessionId(id);
    if (id.includes('::') && (!qualified || qualified.sessionId.includes('::'))) {
      return errorPayload('INVALID_ARGS', 'Use one deviceId::sessionId prefix.');
    }
    const deviceId = qualified && qualified.deviceId !== 'local' ? qualified.deviceId : undefined;
    const target = qualified?.sessionId ?? id;
    const result = await deps.execute({ ...input, callerSessionId, sessionId: target, deviceId, action });
    if (!result.ok) return errorPayload(result.errorCode, result.message);
    return okPayload({
      scope: deviceId ? 'remote' : 'local', device_id: deviceId ?? 'local',
      session_id: deviceId ? `${deviceId}::${target}` : target,
      goal: result.goal,
    });
  }

  registry.register({
    name: 'get_session_goal', category: 'control',
    description: 'Read the saved goal and its status, counters and limits. Strictly observational: does not restore a dormant task, resume a goal or start an agent. A null goal means no saved binding, not completion.' + scope,
    inputShape: targetShape,
    handler: ({ session_id }) => execute('get', session_id),
  });
  registry.register({
    name: 'set_session_goal', category: 'control',
    description: 'Create and activate a goal for this or another assigned task. Read the existing goal first. Repeating the same objective preserves its state and counters; a different existing goal returns GOAL_EXISTS, so use update_session_goal for an intentional edit. Limits apply only on creation; omitted limits use host defaults, null means unlimited. Do not overwrite an unrelated goal.' + scope,
    inputShape: { ...targetShape, objective, limits: z.object(limitsShape).strict().optional() },
    handler: ({ session_id, objective, limits }) => execute('set', session_id, { objective, limits }),
  });
  registry.register({
    name: 'update_session_goal', category: 'control',
    description: 'Edit only the supplied fields of an existing goal without replacing its counters or interrupting the current turn. Changing an objective requires the assigned goal to allow it. Limits can change goal state when already exhausted or newly sufficient; inspect the returned state. Does not change global defaults.' + scope,
    inputShape: { ...targetShape, patch: z.object({ objective: objective.optional(),
      maxTurns: limit.optional(), budgetTokens: limit.optional(), noProgressLimit: limit.optional(),
    }).strict().refine(value => Object.keys(value).length > 0, 'Provide at least one changed field.') },
    handler: ({ session_id, patch }) => execute('update', session_id, { patch }),
  });
  for (const action of ['pause', 'resume', 'clear'] as const) {
    const descriptions = {
      pause: 'Pause goal continuation while preserving its objective and counters. This does not claim the current agent turn has stopped.',
      resume: 'Resume an existing paused, blocked or usage-limited goal after its prerequisite is resolved; preserves usage counters. A busy task may defer resume until its current turn ends: a paused readback is not verified activation. Never use this to override an intentional user pause.',
      clear: 'Remove this assignment\'s goal binding and stop goal continuation. Clearing is not evidence of completion. Use only when authorized or after verifying the assigned outcome.',
    };
    registry.register({
      name: `${action}_session_goal`, category: 'control', description: descriptions[action] + scope,
      inputShape: targetShape, handler: ({ session_id }) => execute(action, session_id),
    });
  }
}
