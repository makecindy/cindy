import { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { registerRoutineTools } from '../scheduler/routines.js';
import { registerScheduleNotifyCurrentRunTool } from '../scheduler/notifyCurrentRun.js';
import { registerScheduleSetPreRunHookTool } from '../scheduler/setPreRunHook.js';
import type { SchedulerMcpDeps, RoutineToolService, LiziMcpSessionContext } from '../types.js';

export interface BotRoutineCallbacks {
  resolveBotId(callerSessionId: string): Promise<string>;
  service: RoutineToolService;
  scheduler?: SchedulerMcpDeps;
}

/** Same native service/schema as automation, scoped to the calling companion. */
export function registerBotRoutineTools(
  registry: XdtHelperToolRegistry,
  callbacks: BotRoutineCallbacks,
  getSessionId: () => string | undefined,
  getSessionContext?: () => LiziMcpSessionContext,
): void {
  const routines = new SchedulerToolRegistry();
  registerRoutineTools(routines, { routines: callbacks.service });
  if (callbacks.scheduler) {
    registerScheduleNotifyCurrentRunTool(routines, callbacks.scheduler, getSessionContext ?? (() => ({ sessionId: getSessionId(), agentKind: '', workingDir: '' })));
    registerScheduleSetPreRunHookTool(routines, callbacks.scheduler);
  }
  for (const summary of routines.list()) {
    const definition = routines.get(summary.name)!;
    const inputShape = { ...definition.inputShape };
    delete inputShape.botId;
    // Teammates may install a check for routine_save, never mutate arbitrary
    // schedules or choose a directory outside their canonical session root.
    if (summary.name === 'schedule_set_pre_run_hook') {
      delete inputShape.scheduleId;
      delete inputShape.workingDir;
    }
    if (summary.name === 'schedule_notify_current_run') delete inputShape.runId;
    registry.register({
      ...definition,
      category: 'bots',
      inputShape,
      ...(summary.name === 'schedule_set_pre_run_hook' ? { description: definition.description + ' In a teammate, this installs and tests a script only; attach the returned command using routine_save.preRunHook and verify with routine_list. No scheduleId is accepted.' } : {}),
      handler: async (args) => {
        try {
          const sessionId = getSessionId();
          if (!sessionId) throw new Error('当前调用未绑定伙伴主任务');
          const botId = await callbacks.resolveBotId(sessionId);
          const scopedArgs: Record<string, unknown> = { ...args, botId };
          if (summary.name === 'schedule_notify_current_run') delete scopedArgs.runId;
          if (summary.name === 'schedule_set_pre_run_hook') {
            delete scopedArgs.scheduleId;
            const workingDir = await callbacks.scheduler?.hookScript?.resolveSessionWorkDir?.(sessionId);
            if (!workingDir?.trim()) throw new Error('无法确定伙伴任务的工作目录');
            scopedArgs.workingDir = workingDir;
          }
          return definition.handler(scopedArgs);
        } catch (error) {
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({
              ok: false, message: error instanceof Error ? error.message : String(error),
            }) }],
          };
        }
      },
    });
  }
}
