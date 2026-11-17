import type { Maker } from '@cindy/maker-core';
import type { CodexAgent } from '@cindy/maker-core/agents/codex';
import { prepareLocalCodexCredentialModeSwitch, CodexCredentialModeSwitchBusyError } from './codex-credential-switch.js';

/** Refresh exactly one idle gateway host; native subscription hosts remain intact. */
export async function refreshCodexGatewayRuntime(options: {
  maker: Maker; agent: CodexAgent; targetHostKey: string;
  isCurrent(): boolean; stillValid(): Promise<boolean>; isSessionInTurn(sessionId: string): boolean;
}): Promise<void> {
  const { maker, agent, targetHostKey, isCurrent, stillValid, isSessionInTurn } = options;
  const guard = await agent.beginLocalHostCredentialChange('Cindy AI key changed', {
    allLocalHosts: true, credentialMode: 'gateway-key', targetHostKey,
    busyError: () => new CodexCredentialModeSwitchBusyError([]),
  });
  try {
    if (!await stillValid() || !isCurrent()) return;
    await prepareLocalCodexCredentialModeSwitch({
      maker, isSessionInTurn,
      hostKeys: guard.affectedHostKeys.filter(key => agent.getLocalHostKeysForCredentialMode('gateway-key').includes(key)),
    });
    if (!isCurrent()) return;
    guard.assertIdle();
    await guard.finalize();
  } finally { guard.release(); }
}
