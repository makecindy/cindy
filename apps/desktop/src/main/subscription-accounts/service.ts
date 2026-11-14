import { isProviderDisabled } from '@cindy/model-providers';
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
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { readModelDisableOverrides } from '../maker-host/model-disable-store.js';
import {
  isNativeProviderAuthBound,
  isNativeProviderAuthSharedSystemCredential,
} from '../maker-host/nativeProviderAuthBinding.js';
import { publishSubscriptionPoolProviders } from '../maker-host/createDesktopProviderService.js';
import { migrateLegacyCodexAccounts, readAccountBinding, readLegacyCodexAccountId } from './store.js';
import { placeSubscriptionAccount, resolveSubscriptionPoolProvider } from './placement.js';

/**
 * A legacy Codex connection the user merges, or merges into, joins the OpenAI pool first as an
 * account that still belongs to itself (subscription-account-pools.md 合并与拿出由用户决定). Only
 * metadata changes: its login, directory, permissions and old tasks stay as they are.
 */
async function registerLegacyCodexConnection(providerId: string | null, assertCurrent: () => void): Promise<void> {
  assertCurrent();
  if (!providerId || resolveSubscriptionPoolProvider(providerId)) return;
  const connection = getActiveCatalog().providers.find((provider) =>
    provider.id === providerId && provider.source === 'user' && provider.auth.native === 'codex');
  if (!connection) return;
  const nativeDefault = isNativeProviderAuthBound('openai');
  await migrateLegacyCodexAccounts(
    [{ providerId, paused: isProviderDisabled(readModelDisableOverrides(), providerId) }],
    { preserveDefault: nativeDefault, legacyDefault: nativeDefault && !isNativeProviderAuthSharedSystemCredential('openai') },
  );
  assertCurrent();
  const accountId = readLegacyCodexAccountId(providerId);
  if (!accountId) throw new Error('Too many subscription accounts');
  await placeSubscriptionAccount('openai', accountId, providerId);
  assertCurrent();
}

/** Shared by the owner UI and helper, after their ordinary authorization checks. */
export async function executeSubscriptionAccountCommand(command: SubscriptionAccountCommand) {
  const owner = activeOwnerScopeKey();
  const assertCurrent = () => {
    if (owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) throw new Error('Subscription accounts changed');
  };
  // Adding a new account into a legacy connection (the add wizard offers connected ones) registers
  // that connection the same way first; otherwise it is not yet a provider of the pool.
  if (command.action === 'merge' || command.action === 'place' || command.action === 'add') {
    await registerLegacyCodexConnection(command.action === 'place' ? null : command.providerId, assertCurrent);
    if (command.action !== 'add') await registerLegacyCodexConnection(command.target, assertCurrent);
    if (owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending())
      throw new Error('Subscription accounts changed');
  }
  const result = await runSubscriptionAccountCommand(command);
  const kind = result.kind ?? resolveSubscriptionPoolProvider(command.providerId)?.kind;
  if (
    command.action === 'read' &&
    command.taskId &&
    result.configured &&
    result.boundAccountId === null &&
    kind
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
        (kind === 'openai' || meta.agentKind === 'claude-code'))
    ) {
      result.boundAccountId = meta?.sdkSessionId
        ? readAccountBinding(`native:${meta.sdkSessionId}`, kind)?.accountId
        : undefined;
    }
  }
  if (command.action === 'add' || command.action === 'connect' || command.action === 'login' || command.action === 'create') {
    if (kind === 'anthropic') requestAnthropicModelProbe();
    else
      void getMaker()
        .refreshAgentLocalModels('codex', { credentialMode: 'oauth-bearer' })
        .catch(() => {});
  }
  if (command.action !== 'read' && command.action !== 'preview' && command.action !== 'cancel') {
    if (owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending())
      throw new Error('Subscription accounts changed');
    // Created, merged and taken-out providers appear in (or leave) the catalog right away.
    publishSubscriptionPoolProviders();
    refreshSelectableModelsAndBroadcast({ providerId: command.providerId });
  }
  return result;
}
