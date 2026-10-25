import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('cc-manager install source contract', () => {
  const source = readFileSync(
    resolve(process.cwd(), '../../packages/app-runtime/src/cc-manager-install.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('checks the managed Claude Code pin before taking the cc-manager fast path', () => {
    const start = source.indexOf(
      'async function ensureCcManagerInstalledOrInstall(',
    );
    const end = source.indexOf(
      'function clearCcManagerInstallCache',
      start,
    );
    const body = source.slice(start, end);

    const agentProbe = body.indexOf(
      'await probeRemoteAgent(host, "claude-code")',
    );
    const guardedFastPath = body.indexOf(
      'if (!forceReinstall && claudeRuntimeReady) {',
    );
    const ccManagerProbe = body.indexOf('await probeCcManager(host)');
    const runtimeInstall = body.search(/await\s+installRemoteAgent\(\s*host,\s*["']claude-code["']/);

    expect(agentProbe).toBeGreaterThan(-1);
    expect(agentProbe).toBeLessThan(guardedFastPath);
    expect(guardedFastPath).toBeLessThan(ccManagerProbe);
    expect(ccManagerProbe).toBeLessThan(runtimeInstall);
  });
});
