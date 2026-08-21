import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  probeRemoteAgent: vi.fn(),
  probePiManager: vi.fn(),
}));

vi.mock('@cindy/maker-remote-ssh', () => ({
  probeRemoteAgent: h.probeRemoteAgent,
  probePiManager: h.probePiManager,
}));
vi.mock('../pi-manager-client.js', () => ({
  piManagerEnsure: vi.fn(),
  piManagerKill: vi.fn(),
}));

import {
  advanceRemoteEndpointGeneration,
  StaleRemoteEndpointError,
} from '../../remote-ssh/endpoint-generation.js';
import {
  resolvePiManagerBinaryPaths,
  resolveRemotePiBinaryPath,
} from '../pi-remote-transport.js';

describe('remote Pi path endpoint generation', () => {
  it('does not cache a probe result that finishes after the HostRef moves endpoints', async () => {
    const hostId = 'ssh-config:generation-test';
    let resolveFirst!: (value: { binaryPath: string }) => void;
    h.probeRemoteAgent
      .mockImplementationOnce(async () => await new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ binaryPath: '/new/pi' });
    const host = { id: hostId } as Parameters<typeof resolveRemotePiBinaryPath>[0];

    const staleProbe = resolveRemotePiBinaryPath(host);
    advanceRemoteEndpointGeneration(hostId);
    resolveFirst({ binaryPath: '/old/pi' });

    await expect(staleProbe).rejects.toBeInstanceOf(StaleRemoteEndpointError);
    await expect(resolveRemotePiBinaryPath(host)).resolves.toBe('/new/pi');
    expect(h.probeRemoteAgent).toHaveBeenCalledTimes(2);
  });

  it('does not repopulate pi-manager paths from a stale endpoint probe', async () => {
    const hostId = 'ssh-config:pi-manager-generation-test';
    let resolveFirst!: (value: { nodeBinaryPath: string; piManagerBinaryPath: string }) => void;
    h.probePiManager
      .mockImplementationOnce(async () => await new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ nodeBinaryPath: '/new/node', piManagerBinaryPath: '/new/pi-manager' });
    const host = { id: hostId } as Parameters<typeof resolvePiManagerBinaryPaths>[0];
    const logger = {} as Parameters<typeof resolvePiManagerBinaryPaths>[1];

    const staleProbe = resolvePiManagerBinaryPaths(host, logger);
    advanceRemoteEndpointGeneration(hostId);
    resolveFirst({ nodeBinaryPath: '/old/node', piManagerBinaryPath: '/old/pi-manager' });

    await expect(staleProbe).rejects.toBeInstanceOf(StaleRemoteEndpointError);
    await expect(resolvePiManagerBinaryPaths(host, logger)).resolves.toEqual({
      nodeBinaryPath: '/new/node',
      piManagerBinaryPath: '/new/pi-manager',
    });
    expect(h.probePiManager).toHaveBeenCalledTimes(2);
  });
});
