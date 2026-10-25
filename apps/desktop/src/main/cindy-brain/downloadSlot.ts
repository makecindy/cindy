import { PluginDownloadSlot as CoreSlot, type PluginDownloadDeps as CoreDeps } from '@cindy/plugin-runtime/downloadSlot';
import { guardedOutboundFetch } from '../maker-host/outbound-fetch.js';
export type PluginDownloadDeps = Omit<CoreDeps, 'guardedFetch'>;
export class PluginDownloadSlot extends CoreSlot {
  constructor(deps: PluginDownloadDeps) { super({ ...deps, guardedFetch: guardedOutboundFetch }); }
}
