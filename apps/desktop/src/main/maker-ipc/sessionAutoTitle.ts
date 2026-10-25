import { createSessionAutoTitle } from '@cindy/app-runtime/sessionAutoTitle';
import { getOverwritableAutoTitle, isUntitledSessionAwaitingAutoTitle, persistSessionTitleIfStillDraft, setOnUserSessionTitleWritten } from '../localDb/ipc/sessions.js';
import { createLogger } from '../logger.js';
import { generateMakerSessionTitle } from './title.js';
export type * from '@cindy/app-runtime/sessionAutoTitle';
export const { registerSessionAutoTitleHooks, __resetSessionAutoTitleStateForTest, isSessionAutoTitleEligible, runSessionAutoTitle, scheduleSessionAutoTitle } = createSessionAutoTitle({
 getOverwritableAutoTitle: (...args) => getOverwritableAutoTitle(...args),
 isUntitledSessionAwaitingAutoTitle: (...args) => isUntitledSessionAwaitingAutoTitle(...args),
 persistSessionTitleIfStillDraft: (...args) => persistSessionTitleIfStillDraft(...args),
 setOnUserSessionTitleWritten: (...args) => setOnUserSessionTitleWritten(...args),
 generateMakerSessionTitle: (...args) => generateMakerSessionTitle(...args), logger: createLogger('maker-ipc/session-auto-title'),
});
