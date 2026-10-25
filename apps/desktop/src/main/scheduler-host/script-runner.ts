import { createScriptScheduleRunner } from '@cindy/app-runtime/scheduleScriptRunner';
import { restoreScheduledTarget } from './restore-target';
export { buildScriptEnv } from '@cindy/app-runtime/scheduleScriptRunner';
export type {
  ScriptCapabilityCall,
  ScriptCapabilityBroker,
  ScriptScheduleRunnerDeps,
} from '@cindy/app-runtime/scheduleScriptRunner';
export const { ScriptScheduleRunner } = createScriptScheduleRunner((...args) =>
  restoreScheduledTarget(...args),
);
export type ScriptScheduleRunner = InstanceType<typeof ScriptScheduleRunner>;
