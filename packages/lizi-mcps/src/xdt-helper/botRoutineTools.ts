import { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { registerRoutineTools } from '../scheduler/routines.js';
import type { RoutineToolService } from '../types.js';

export interface BotRoutineCallbacks {
  resolveBotId(callerSessionId: string): Promise<string>;
  service: RoutineToolService;
}

/** Same native service/schema as automation, scoped to the calling companion. */
export function registerBotRoutineTools(
  registry: XdtHelperToolRegistry,
  callbacks: BotRoutineCallbacks,
  getSessionId: () => string | undefined,
): void {
  const routines = new SchedulerToolRegistry();
  registerRoutineTools(routines, { routines: callbacks.service });
  for (const summary of routines.list()) {
    const definition = routines.get(summary.name)!;
    const { botId: _botId, ...inputShape } = definition.inputShape;
    registry.register({
      ...definition,
      category: 'bots',
      inputShape,
      handler: async (args) => {
        try {
          const sessionId = getSessionId();
          if (!sessionId) throw new Error('当前调用未绑定伙伴主任务');
          const botId = await callbacks.resolveBotId(sessionId);
          return definition.handler({ ...args, botId });
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
