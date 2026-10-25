import { createMediaToolResultFallback } from '@cindy/app-runtime/mediaToolResultFallback';
import { createLogger } from '../logger.js';
export const { recordMediaToolResult, takeMediaToolResult, __resetMediaToolResultPoolForTesting } = createMediaToolResultFallback(createLogger('mediaToolResultFallback'));
