interface ManagedProfile {
  profile: { cdpUrl: string; cdpIsLoopback: boolean };
  running: { proc: { pid?: number; exitCode: number | null; signalCode: string | null } } | null;
}

/** A loopback URL alone may be a tunnel. Require our live managed process too. */
export function isManagedLocalCdpConnection(
  configuredEndpoint: string,
  connectedEndpoint: string,
  profiles: Iterable<ManagedProfile>,
): boolean {
  const address = (value: string) => {
    const url = new URL(value);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return null;
    if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) return null;
    return `${url.hostname}:${url.port || (['https:', 'wss:'].includes(url.protocol) ? '443' : '80')}`;
  };
  try {
    const expected = address(configuredEndpoint);
    if (!expected || address(connectedEndpoint) !== expected) return false;
    for (const { profile, running } of profiles) {
      const proc = running?.proc;
      if (profile.cdpIsLoopback && address(profile.cdpUrl) === expected
        && proc?.pid && proc.exitCode === null && proc.signalCode === null) return true;
    }
  } catch { /* An unknown endpoint never gets shared-filesystem privileges. */ }
  return false;
}
