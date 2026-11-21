import { configureProjectIconRuntime } from '../../desktop/src/main/projectAutomaticIcon.js';
import { hostOutbound } from './outbound.mjs';

/**
 * Project automatic icons (`/api/project-info/auto-icon`) fetch websites through the Host outbound transport,
 * as the desktop binds its own (projectAutomaticIcon.desktop.ts, the desktop guardedOutboundFetch): the same
 * DNS pinning, redirect and private-address guard, with the Host's proxy decision (outbound-proxy.ts). Unbound,
 * the module falls back to a transport that reads proxy environment variables only. readRemote stays unset:
 * the desktop reads remote workdir icons through the remote file browser, and the Host refuses remote workdirs.
 * Called once by main.ts at startup.
 */
export function bindHostProjectIconRuntime(): void {
  configureProjectIconRuntime({ fetch: hostOutbound.guardedOutboundFetch });
}
