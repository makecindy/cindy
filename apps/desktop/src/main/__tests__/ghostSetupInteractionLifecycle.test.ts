import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const registerSource = readFileSync(
  resolve(__dirname, '..', 'maker-ipc', 'register.ts'),
  'utf8',
).replace(/\r\n/g, '\n');

describe('host-owned interaction lifecycle contract', () => {
  it('includes every Host-owned snapshot in recovery and queue busy checks', () => {
    const snapshotHelperStart = registerSource.indexOf(
      'function getPendingInteractionsForSession(',
    );
    const snapshotHelperEnd = registerSource.indexOf('\n}\n', snapshotHelperStart) + 2;
    const snapshotHelper = registerSource.slice(snapshotHelperStart, snapshotHelperEnd);
    const helperStart = registerSource.indexOf(
      'function hasPendingInteractionForSession(sessionId: string): boolean',
    );
    const helperEnd = registerSource.indexOf('\n}\n', helperStart) + 2;
    const helper = registerSource.slice(helperStart, helperEnd);

    for (const bridgeName of [
      'issueConfirmBridge',
      'renameSessionsConfirmBridge',
      'ghostGrantConfirmBridge',
      'ghostSetupInteractionBridge',
    ]) {
      expect(snapshotHelper).toMatch(
        new RegExp(`${bridgeName}\\s*\\.pendingSnapshots\\(sessionId\\)`),
      );
      expect(helper).toMatch(
        new RegExp(`${bridgeName}\\s*\\.pendingSnapshots\\(sessionId\\)\\.length > 0`),
      );
    }
    expect(registerSource).toContain(
      'const hadZombieInteraction = hasPendingInteractionForSession(sessionId);',
    );
    expect(registerSource).toContain('hasPendingInteraction: hasPendingInteractionForSession,');
    expect(registerSource).toContain(
      "cleanupPendingInteractionsForSession(sessionId, 'turn_idle_reconcile');",
    );
  });

  it('applies the Agent Island session policy before forwarding Setup snapshots', () => {
    const bridgeStart = registerSource.indexOf(
      'const ghostSetupInteractionBridge = initGhostSetupInteractionBridge({',
    );
    const bridgeEnd = registerSource.indexOf('\n});', bridgeStart);
    const bridgeSource = registerSource.slice(bridgeStart, bridgeEnd);
    const policyIndex = bridgeSource.indexOf(
      'if (!shouldNotifyAgentIslandForSession(value.sessionId)) return;',
    );
    const forwardIndex = bridgeSource.indexOf(
      'getAgentIslandService()?.handlePluginSetupInteraction(',
    );

    expect(policyIndex).toBeGreaterThanOrEqual(0);
    expect(forwardIndex).toBeGreaterThan(policyIndex);
  });
});
