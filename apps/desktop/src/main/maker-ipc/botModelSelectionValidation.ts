import { effectiveSourceIdForModel, findCatalogModel, type ProviderView } from '@cindy/model-providers';
import type { BotModelRoute } from '../../shared/botModelChain.js';
import { t } from '../i18n.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { isSupportedRuntimeEffort } from './runtimeSelectionAxes.js';
import { resolveSessionRuntimeAxes } from './sessionRuntimeControl.js';

/** Validate the saved choice without substituting a task value, default, or another route. */
export function assertBotModelSelections(routes: readonly BotModelRoute[], providers: ProviderView[]): void {
  for (const route of routes) {
    const agentKind = route.harness === 'claude' ? 'claude-code' : route.harness;
    const providerId = route.providerId ?? effectiveSourceIdForModel(providers, null, route.model, agentKind);
    const model = findCatalogModel(providers.find(provider => provider.id === providerId), route.model, agentKind, { exact: true });
    // Route admission still owns absent/disabled models. Missing metadata does
    // not prove adjustable effort support; never borrow another provider's copy.
    if (!model) continue;
    const effort = route.effort || null;
    const axes = effort === null || isSupportedRuntimeEffort(effort) ? resolveSessionRuntimeAxes({
      model, effort,
      fastMode: route.fastMode, effortExplicit: true, fastExplicit: true, requireEffort: true,
    }) : null;
    if (!axes?.ok) {
      const key = axes?.reason === 'fast-unavailable' ? 'fastUnavailable' : 'effortUnavailable';
      throwIpcError('INVALID_PARAMS', t(`bots.modelConfiguration.${key}`).replace('{{model}}', () => route.model));
    }
  }
}

/** Read the execution host's current directory for profile saves and queued sends. */
export async function validateBotModelSelections(routes: readonly BotModelRoute[]): Promise<void> {
  if (routes.length === 0) return;
  const providers = await getDesktopProviderService().listProviders({ allowSideEffects: false });
  assertBotModelSelections(routes, providers);
}
