import { createCindyProxyMediaService as createService } from '@cindy/app-runtime/media/proxy/service';
import { isProviderModelRouteDisabled } from '../utility-model/oneShotCandidates.js';
import type { CindyProxyMediaServiceOptions } from './types.js';
export function createCindyProxyMediaService(opts: CindyProxyMediaServiceOptions) { return createService(opts, isProviderModelRouteDisabled); }
