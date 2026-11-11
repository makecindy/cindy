import { describe, expect, it } from 'vitest';
import { isManagedLocalCdpConnection } from '../shim/cdp-locality.js';

// Production CDP connection eligibility: the historical 2 GiB upload needs
// shared local paths, but a remote/attached/tunnel endpoint must not get them.
// Pure unit tier; existing upload tests do not cover connection locality.
describe('managed CDP shared filesystem eligibility', () => {
  const endpoint = 'http://127.0.0.1:18800';
  const ws = 'ws://127.0.0.1:18800/devtools/browser/test';
  const live = {
    profile: { cdpUrl: endpoint, cdpIsLoopback: true },
    running: { proc: { pid: 123, exitCode: null, signalCode: null } },
  };

  it('uses local paths for the live runtime-owned browser at the same endpoint', () => {
    expect(isManagedLocalCdpConnection(endpoint, ws, [live])).toBe(true);
  });
  it('does not treat loopback attachment or a tunnel as a managed process', () => {
    expect(isManagedLocalCdpConnection(endpoint, ws, [])).toBe(false);
    expect(isManagedLocalCdpConnection(endpoint, ws, [{ ...live, running: null }])).toBe(false);
  });
  it.each([
    { pid: 123, exitCode: 0, signalCode: null },
    { pid: 123, exitCode: null, signalCode: 'SIGTERM' },
    { pid: undefined, exitCode: null, signalCode: null },
  ])('does not grant local paths after process exit or failed launch: %j', (proc) => {
    expect(isManagedLocalCdpConnection(endpoint, ws, [{ ...live, running: { proc } }])).toBe(false);
  });
  it.each(['ws://127.0.0.1:18801/browser/test', 'ws://example.com:18800/browser/test', 'invalid'])('rejects a redirected or invalid endpoint: %s', (target) => {
    expect(isManagedLocalCdpConnection(endpoint, target, [live])).toBe(false);
  });
  it('keeps remote configured profiles remote even if there is a process record', () => {
    const remote = 'http://192.0.2.1:18800';
    expect(isManagedLocalCdpConnection(remote, remote, [{ ...live, profile: { cdpUrl: remote, cdpIsLoopback: false } }])).toBe(false);
  });
});
