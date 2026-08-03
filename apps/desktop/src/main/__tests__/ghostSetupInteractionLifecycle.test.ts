import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const registerSource = readFileSync(
  resolve(__dirname, '..', 'maker-ipc', 'register.ts'),
  'utf8',
).replace(/\r\n/g, '\n');

describe('host-owned interaction lifecycle contract', () => {
  it('recovers every Host-owned snapshot without treating Desktop confirms as Agent busy state', () => {
    const snapshotHelperStart = registerSource.indexOf(
      'function getPendingInteractionsForSession(',
    );
    const snapshotHelperEnd = registerSource.indexOf('\n}\n', snapshotHelperStart) + 2;
    const snapshotHelper = registerSource.slice(snapshotHelperStart, snapshotHelperEnd);
    const helperStart = registerSource.indexOf(
      'function hasPendingAgentInteractionForSession(sessionId: string): boolean',
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
    }
    expect(helper).toMatch(
      /ghostSetupInteractionBridge\s*\.pendingSnapshots\(sessionId\)\.length > 0/,
    );
    for (const bridgeName of [
      'issueConfirmBridge',
      'renameSessionsConfirmBridge',
      'ghostGrantConfirmBridge',
    ]) {
      expect(helper).not.toContain(bridgeName);
    }
    expect(registerSource).toContain(
      'const hadZombieInteraction = hasPendingAgentInteractionForSession(sessionId);',
    );
    expect(registerSource).toContain(
      'hasPendingInteraction: hasPendingAgentInteractionForSession,',
    );
    expect(registerSource).toContain(
      "cleanupPendingAgentInteractionsForSession(sessionId, 'turn_idle_reconcile');",
    );
    expect(registerSource).not.toContain(
      "cleanupPendingInteractionsForSession(sessionId, 'turn_idle_reconcile');",
    );

    const ownershipHelperStart = registerSource.indexOf(
      'function isPendingDesktopOnlyConfirmation(requestId: string): boolean',
    );
    const ownershipHelperEnd = registerSource.indexOf('\n}\n', ownershipHelperStart) + 2;
    const ownershipHelper = registerSource.slice(ownershipHelperStart, ownershipHelperEnd);
    for (const bridgeName of [
      'issueConfirmBridge',
      'renameSessionsConfirmBridge',
      'ghostGrantConfirmBridge',
    ]) {
      expect(ownershipHelper).toContain(bridgeName);
    }
    expect(registerSource).toMatch(
      /assertResolveInteractionOrigin\(\s*decision,\s*isPendingDesktopOnlyConfirmation\(requestId\),?\s*\);/,
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
