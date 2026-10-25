import {createHiddenSessionRegistry} from '@cindy/runtime-db/hiddenSessionRegistry';
export type * from '@cindy/runtime-db/hiddenSessionRegistry';
import * as currentDb from './client/current.js';
import {createLogger} from '../logger.js';
export const {ensureHiddenSessionRegistryLoaded, isSessionHiddenSync, noteSessionHidden, resetHiddenSessionRegistryForTesting}=createHiddenSessionRegistry({currentDb,logger:createLogger('hidden-session-registry')});
