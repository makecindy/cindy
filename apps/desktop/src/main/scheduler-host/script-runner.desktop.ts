import { isManagedScheduledTarget, restoreScheduledTarget } from './restore-target.desktop.js';
import { ScriptScheduleRunner as SharedScriptRunner, type ScriptScheduleRunnerDeps } from './script-runner.js';

export * from './script-runner.js';

export class ScriptScheduleRunner extends SharedScriptRunner {
  constructor(deps: ScriptScheduleRunnerDeps) {
    super(deps, {
      isManagedScheduledTarget: (...args) => isManagedScheduledTarget(...args),
      restoreScheduledTarget: (...args) => restoreScheduledTarget(...args),
    });
  }
}
