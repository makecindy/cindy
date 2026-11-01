import { net } from 'electron';

import { createLogger } from '../logger.js';
import type { CreditsSnapshot, RateLimitSnapshot, RateLimitWindow } from '../usageBroadcaster.js';
import {createCodexWebUsage} from '@cindy/app-runtime/codexWebUsage';
export const {CodexWebUsageUnauthorizedError,codexWebUsageResponseToSnapshot,fetchCodexWebUsageSnapshot}=createCodexWebUsage({createLogger,fetch:(url,init)=>net.fetch(url instanceof URL ? url.toString() : url,init)});
