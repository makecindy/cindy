import type {RemoteResourceRegistry} from '@cindy/device-link';
import type {TerminalCompanionCloud} from './cloud.js';
import type {TerminalCompanionHost} from './host.js';
import {registerCompanionModelResources} from './model-resources.js';

/** The GUI, Mobile and TUI controllers see the original host resources. */
export async function registerCompanionResources(registry:RemoteResourceRegistry,host:TerminalCompanionHost,_cloud?:TerminalCompanionCloud) {
  await host.ready;
  registerCompanionModelResources(registry,host);
  host.services.registerResources(registry,host.routines);
}
