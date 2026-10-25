import { createAgentInputReferenceHydrator } from '@cindy/app-runtime/agentInputReferences';
import { getDbClient } from '../localDb/client/current.js';
export type * from '@cindy/app-runtime/agentInputReferences';
export const { hydrateQueuedAgentReferences } = createAgentInputReferenceHydrator(() => getDbClient());
