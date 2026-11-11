import type { SubscriptionAccountCommand } from '../../shared/subscriptionAccounts.js';
import { runSubscriptionAccountCommand } from './runtime.js';
import {
  getMaker,
  getMakerIfReady,
  refreshSelectableModelsAndBroadcast,
} from '../maker-host/index.js';
import { requestAnthropicModelProbe } from '../maker-host/model-discovery/anthropic.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getSessionProvider } from '../maker-host/session-provider-store.js';
import { readAccountBinding } from './store.js';

/** Shared by the owner UI and helper, after their ordinary authorization checks. */
export async function executeSubscriptionAccountCommand(command: SubscriptionAccountCommand) {
  const owner = activeOwnerScopeKey();
  const result = await runSubscriptionAccountCommand(command);
  if (
    command.action === 'read' &&
    command.taskId &&
    result.configured &&
    result.boundAccountId === null
  ) {
    const maker = getMakerIfReady();
    const meta = await maker?.getSessionMeta(command.taskId);
    if (owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending())
      throw new Error('Subscription accounts changed');
    const providerId = getSessionProvider(command.taskId);
    // Older tasks can resume a native session without a task binding. They are
    // not new allocations: prefer its recorded native binding, otherwise leave
    // the account unknown rather than previewing a different eligible account.
    if (
      !maker ||
      (meta?.sdkSessionId &&
        !meta.remoteHostId &&
        !meta.agentDeviceId &&
        (!providerId || providerId === command.providerId) &&
        (command.providerId === 'openai' || meta.agentKind === 'claude-code'))
    ) {
      result.boundAccountId = meta?.sdkSessionId
        ? readAccountBinding(`native:${meta.sdkSessionId}`, command.providerId)?.accountId
        : undefined;
    }
  }
  if (command.action === 'add' || command.action === 'connect' || command.action === 'login') {
    if (command.providerId === 'anthropic') requestAnthropicModelProbe();
    else
      void getMaker()
        .refreshAgentLocalModels('codex', { credentialMode: 'oauth-bearer' })
        .catch(() => {});
  }
  if (command.action !== 'read' && command.action !== 'preview' && command.action !== 'cancel') {
    if (owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending())
      throw new Error('Subscription accounts changed');
    refreshSelectableModelsAndBroadcast({ providerId: command.providerId });
  }
  return result;
}
