import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const ipcSource = readFileSync(new URL('../git-context/ipc.ts', import.meta.url), 'utf8');

describe('git-context remote IPC security contract', () => {
  it('guards local SSH probes before any session lookup or host connection', () => {
    const guard = ipcSource.indexOf('assertTrustedAppRendererEvent(event);');
    const remoteLookup = ipcSource.indexOf('if (deviceLinkInvoke || requestedRemoteHostId)');

    expect(ipcSource).toContain('if (requestedRemoteHostId !== null && !deviceLinkInvoke)');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(remoteLookup).toBeGreaterThan(guard);
  });

  it('keeps device-link invokes on their async-context authorization path', () => {
    expect(ipcSource).toContain('if (requestedRemoteHostId !== null && !deviceLinkInvoke)');
    expect(ipcSource).toContain('const deviceLinkInvoke = isDeviceLinkInvoke();');
  });

  it('keeps find-linked-worktree local-only, sender-guarded, and sessionId-validated', () => {
    const handler = ipcSource.indexOf('GIT_CONTEXT_INVOKE.FIND_LINKED_WORKTREE');
    const deviceNull = ipcSource.indexOf('if (isDeviceLinkInvoke()) return null;', handler);
    const guard = ipcSource.indexOf('assertTrustedAppRendererEvent(event);', handler);
    const requireId = ipcSource.indexOf("requireString(obj?.sessionId, 'sessionId')", handler);
    expect(ipcSource).toContain("FIND_LINKED_WORKTREE: 'git-context:find-linked-worktree'");
    expect(handler).toBeGreaterThanOrEqual(0);
    expect(deviceNull).toBeGreaterThan(handler);
    expect(guard).toBeGreaterThan(deviceNull);
    expect(requireId).toBeGreaterThan(guard);
  });

  it('fails closed when device-link PR refs lookup is unavailable', () => {
    const lookup = ipcSource.indexOf('const refs = await listPrRefs(remoteSessionId);');
    const clear = ipcSource.indexOf('return [];', lookup);
    const statusQuery = ipcSource.indexOf(
      'return prStatusService!.getStatuses(parsed, { remote: remoteSessionId !== null });',
    );

    expect(ipcSource).toContain("log.warn('remote PR refs lookup failed (fail closed)'");
    expect(lookup).toBeGreaterThanOrEqual(0);
    expect(clear).toBeGreaterThan(lookup);
    expect(statusQuery).toBeGreaterThan(clear);
  });
});
