import type { SubscriptionAccountCommand } from '../../shared/subscriptionAccounts.js';
import { runSubscriptionAccountCommand } from './runtime.js';
import { getMaker, refreshSelectableModelsAndBroadcast } from '../maker-host/index.js';
import { requestAnthropicModelProbe } from '../maker-host/model-discovery/anthropic.js';

/** Shared by the owner UI and helper, after their ordinary authorization checks. */
export async function executeSubscriptionAccountCommand(command: SubscriptionAccountCommand) {
  const result = await runSubscriptionAccountCommand(command);
  if (command.action === 'add' || command.action === 'connect' || command.action === 'login') {
    if (command.providerId === 'anthropic') requestAnthropicModelProbe();
    else
      void getMaker()
        .refreshAgentLocalModels('codex', { credentialMode: 'oauth-bearer' })
        .catch(() => {});
  }
  if (command.action !== 'read' && command.action !== 'preview' && command.action !== 'cancel')
    refreshSelectableModelsAndBroadcast({ providerId: command.providerId });
  return result;
}
