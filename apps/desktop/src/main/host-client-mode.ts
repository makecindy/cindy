/**
 * Set when this Electron process runs as a client of `cindy-host`.
 *
 * In client mode the host owns the profile: it holds the runtime lease (and the
 * schema writer lease), runs the agents and serves every runtime channel. Any
 * local database open from this process would be a second writer on the same
 * profile, so `localDb.ensureReady` refuses instead of racing the host.
 *
 * Client mode: the host runs the profile's agents and owns its database; this
 * process keeps only UI and system integration.
 */

let clientMode = false;

export function setHostClientMode(enabled: boolean): void {
  clientMode = enabled;
}

export function isHostClientMode(): boolean {
  return clientMode;
}
