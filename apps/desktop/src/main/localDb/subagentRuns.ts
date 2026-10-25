import { createSubagentRunStore } from '@cindy/runtime-db/subagentRuns';
import { getDbClient } from './client/current.js';
export type * from '@cindy/runtime-db/subagentRuns';
export const { persistSubagentTaskUpdate, listVisibleSubagentObservationIdentities, listSubagentRuns, getSubagentRunDetail } = createSubagentRunStore(() => getDbClient());
