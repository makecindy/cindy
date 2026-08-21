import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('cc-manager install source contract', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/main/remote-ssh/cc-manager-install.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('checks the managed Claude Code pin before taking the cc-manager fast path', () => {
    const start = source.indexOf(
      'export async function ensureCcManagerInstalledOrInstall(',
    );
    const end = source.indexOf(
      '\nexport function clearCcManagerInstallCache',
      start,
    );
    const body = source.slice(start, end);

    const agentProbe = body.indexOf(
      "await probeRemoteAgent(host, 'claude-code')",
    );
    const guardedFastPath = body.indexOf(
      'if (!forceReinstall && claudeRuntimeReady) {',
    );
    const ccManagerProbe = body.indexOf('await probeCcManager(host)');
    const runtimeInstall = body.indexOf(
      "await installRemoteAgent(host, 'claude-code'",
    );

    expect(agentProbe).toBeGreaterThan(-1);
    expect(agentProbe).toBeLessThan(guardedFastPath);
    expect(guardedFastPath).toBeLessThan(ccManagerProbe);
    expect(ccManagerProbe).toBeLessThan(runtimeInstall);
  });

  it('fences every early cache/probe return and never swallows stale endpoint errors', () => {
    const start = source.indexOf('export async function ensureCcManagerInstalledOrInstall(');
    const end = source.indexOf('\nexport function clearCcManagerInstallCache', start);
    const body = source.slice(start, end);

    const cachedStat = body.indexOf("label: 'cc-mgr-bundle-stat'");
    const cachedReturn = body.indexOf("if (r.stdout.includes('OK')) return;", cachedStat);
    const cachedFence = body.lastIndexOf(
      'assertCurrentRemoteEndpointGeneration(hostId, generation);',
      cachedReturn,
    );
    expect(cachedFence).toBeGreaterThan(cachedStat);
    expect(body.match(/if \(err instanceof StaleRemoteEndpointError\) throw err;/g)?.length ?? 0)
      .toBeGreaterThanOrEqual(4);

    const pending = body.indexOf('setPending({ hostId, currentVersion: remoteVer');
    const pendingFence = body.lastIndexOf(
      'assertCurrentRemoteEndpointGeneration(hostId, generation);',
      pending,
    );
    expect(pendingFence).toBeGreaterThan(-1);
    expect(pendingFence).toBeLessThan(pending);

    expect(
      body.match(/if \(!isCurrentRemoteEndpointGeneration\(hostId, generation\)\) return;/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(2);
  });

  it('fences a user-triggered force upgrade before reusing the stable HostRef', () => {
    const start = source.indexOf('export async function runCcMgrUpgrade(');
    const body = source.slice(start);
    const kill = body.indexOf("label: 'cc-mgr-upgrade-kill'");
    const reinstall = body.indexOf('await ensureCcManagerInstalledOrInstall({ host, forceReinstall: true });');
    const clear = body.indexOf('clearPending(hostId);', reinstall);
    const fenceAfterKill = body.indexOf(
      'assertCurrentRemoteEndpointGeneration(hostId, generation);',
      kill,
    );
    const fenceAfterInstall = body.indexOf(
      'assertCurrentRemoteEndpointGeneration(hostId, generation);',
      reinstall,
    );

    expect(kill).toBeGreaterThan(-1);
    expect(fenceAfterKill).toBeGreaterThan(kill);
    expect(fenceAfterKill).toBeLessThan(reinstall);
    expect(fenceAfterInstall).toBeGreaterThan(reinstall);
    expect(fenceAfterInstall).toBeLessThan(clear);
  });
});
