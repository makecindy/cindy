import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('remote agent install endpoint generation contract', () => {
  const source = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf8').replace(/\r\n?/g, '\n');
  const start = source.indexOf('export async function ensureRemoteAgentInstalledOrInstall(');
  const end = source.indexOf('\nfunction canonicalizeSshConfigHost(', start);
  const body = source.slice(start, end);

  it('suppresses stale progress and fences both successful and failed install results', () => {
    const install = body.indexOf('const result = await installRemoteAgent(');
    const progressGuard = body.indexOf(
      'if (!isCurrentRemoteEndpointGeneration(hostId, generation)) return;',
      install,
    );
    const resultFence = body.indexOf(
      'assertCurrentRemoteEndpointGeneration(hostId, generation);',
      progressGuard,
    );
    const readyCheck = body.indexOf('if (!result.ready) {', resultFence);
    const staleCatch = body.indexOf('if (err instanceof StaleRemoteEndpointError)', readyCheck);
    const genericFailure = body.indexOf("broadcastSilentInstallStatus({ hostId, agentKind, phase: 'failed'", staleCatch);

    expect(install).toBeGreaterThan(-1);
    expect(progressGuard).toBeGreaterThan(install);
    expect(resultFence).toBeGreaterThan(progressGuard);
    expect(resultFence).toBeLessThan(readyCheck);
    expect(staleCatch).toBeGreaterThan(readyCheck);
    expect(staleCatch).toBeLessThan(genericFailure);
  });

  it('fences the manual IPC install path and its cc-manager piggy-back', () => {
    const handlerStart = source.indexOf("ipcMain.handle(REMOTE_SSH_INVOKE.INSTALL_AGENT");
    const handlerEnd = source.indexOf("ipcMain.handle(REMOTE_SSH_INVOKE.UNINSTALL_AGENT", handlerStart);
    const body = source.slice(handlerStart, handlerEnd);

    expect(body).toContain(
      'if (sender.isDestroyed() || !isCurrentRemoteEndpointGeneration(host.id, generation)) return;',
    );
    expect(body).toContain('assertCurrentRemoteEndpointGeneration(host.id, generation);');
    expect(body).toContain('if (err instanceof StaleRemoteEndpointError) throw err;');

    const joined = body.indexOf('const joined = await existing;');
    const joinedFence = body.indexOf(
      'assertCurrentRemoteEndpointGeneration(host.id, generation);',
      joined,
    );
    expect(joinedFence).toBeGreaterThan(joined);
  });
});
