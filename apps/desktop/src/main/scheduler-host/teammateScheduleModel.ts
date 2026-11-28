import type { Schedule } from '@cindy/maker-scheduler';
import type { BotModelRoute } from '../../shared/botModelChain.js';
import { routeModelFields } from '../maker-ipc/botV2Carryover.js';

/** Only explicitly opted-in Bot project schedules inherit; saved model choices take precedence. */
export async function resolveTeammateScheduleModel(schedule: Schedule, deps: {
  isOwnProject: (workingDir: string) => Promise<boolean>;
  follows: (workingDir: string, id: string) => Promise<boolean>;
  primaryModel: (workingDir: string) => Promise<BotModelRoute>;
}): Promise<Partial<Schedule> | null> {
  if (schedule.source !== 'project' || !schedule.projectConfigId
    || !schedule.workingDir || schedule.model?.trim()) return null;
  if (!await deps.isOwnProject(schedule.workingDir)) return null;
  if (!await deps.follows(schedule.workingDir, schedule.projectConfigId)) return null;
  const route = await deps.primaryModel(schedule.workingDir);
  const fields = routeModelFields(route);
  if (!fields || !fields.model?.trim())
    throw new Error('schedule route unavailable: buddy primary model route is incomplete');
  // Explicit local location clears a persistent task's former remote location as well.
  return { agentKind: fields.agentKind, model: fields.model, modelAgentKind: fields.agentKind,
    modelAgentDeviceId: fields.agentDeviceId ?? '',
    agentDeviceId: fields.agentDeviceId, providerId: fields.providerId,
    effort: fields.effort, fastMode: fields.fastMode ?? false };
}
