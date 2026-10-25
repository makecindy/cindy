import { createModelContextLimitStore } from '@cindy/app-runtime/modelContextLimitStore';
export { modelContextLimitKey, type ModelContextLimitPrefs } from '@cindy/app-runtime/modelContextLimitStore';
import { desktopMakerLogger } from './logger-adapter.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
export const { readModelContextLimits, readModelContextLimit, isModelContextLimitCustomized, writeModelContextLimit, writeModelContextLimits, writeModelContextLimitsWithRefresh, resetModelContextLimits, __testing } = createModelContextLimitStore(() => ownerScopedUserDataPath('model-context-limit-prefs.json'), desktopMakerLogger.child('model-context-limit'));
