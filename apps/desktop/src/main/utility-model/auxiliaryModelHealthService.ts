/** Desktop instance of the auxiliary-model health tracker and its Settings IPC. */

import { ipcMain } from 'electron';

import { AUXILIARY_MODEL_HEALTH_SECTION, type AuxiliaryModelHealth } from '../../shared/auxiliaryModelHealth.js';
import { notifyAppSettingsChanged } from '../app-settings/changes.js';
import { activeOwnerScopeKey } from '../appSessionState.js';
import { getCindyAiProviderName } from '../cindyAiProviderName.js';
import { createLogger } from '../logger.js';
import { isXdGatewayPaymentRequiredRoute } from '../maker-host/active-catalog.js';
import { getDesktopSelectableCatalog } from '../maker-host/createDesktopProviderService.js';
import { readModelDisableOverrides } from '../maker-host/model-disable-store.js';
import { readProviderOrder } from '../maker-host/provider-order-store.js';
import { MAKER_INVOKE } from '../maker-ipc/channels.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { evaluateAuxiliaryChainAvailability } from './auxiliaryChainAvailability.js';
import { setAuxiliaryChainOutcomeListener, type AuxiliaryChainOutcome } from './auxiliaryChainOutcomeSink.js';
import { createAuxiliaryModelHealthTracker } from './auxiliaryModelHealth.js';
import { hasOneshotProviderCredential } from './oneshotProviderUsability.js';
import { getEffectiveAuxiliaryModelRefs } from './resolveAuxiliaryModelChain.js';

const log = createLogger('utility-model/auxiliary-model-health');

const tracker = createAuxiliaryModelHealthTracker({
  evaluate: () => evaluateAuxiliaryChainAvailability({
    refs: getEffectiveAuxiliaryModelRefs(),
    catalog: getDesktopSelectableCatalog(),
    overrides: readModelDisableOverrides(),
    providerOrder: readProviderOrder(),
    hasCredential: hasOneshotProviderCredential,
    isCindyAiPaymentRequired: (model, agentKind) => isXdGatewayPaymentRequiredRoute(model, agentKind),
    cindyAiName: getCindyAiProviderName(),
  }),
  notify: () => notifyAppSettingsChanged(AUXILIARY_MODEL_HEALTH_SECTION),
  now: () => Date.now(),
  ownerKey: () => activeOwnerScopeKey(),
});

/** Never let health bookkeeping break the request that reported it. */
function guarded(label: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    log.warn(`auxiliary model health ${label} failed`, { error });
  }
}

function reportAuxiliaryChainOutcome(outcome: AuxiliaryChainOutcome): void {
  guarded('report', () => tracker.reportChainOutcome(outcome));
}

/** Display name of one route, e.g. "GPT-6.2 Astra · OpenAI"; falls back to the ids. */
function describeRoute(route: { agentKind: string; providerId: string; model: string }): string {
  const provider = getDesktopSelectableCatalog().providers.find((item) => item.id === route.providerId);
  const agent = (route.agentKind === 'cc' ? 'claude-code' : route.agentKind) as keyof NonNullable<typeof provider>['models'];
  const name = provider?.models[agent]?.find((model) => model.id === route.model)?.name ?? route.model;
  const providerName = route.providerId === 'xd' ? getCindyAiProviderName() : provider?.name ?? route.providerId;
  return `${name} · ${providerName}`;
}

/** Plugin tasks fell back to `route` because no auxiliary candidate could run them; null once they can again. */
export function reportPluginTaskAuxiliaryFallback(
  route: { agentKind: string; providerId: string; model: string } | null,
): void {
  guarded('fallback', () => tracker.reportPluginFallback(route ? describeRoute(route) : null));
}

/** Re-evaluate an observed configuration problem when the auxiliary chain is saved. */
export function refreshAuxiliaryModelHealth(): void {
  guarded('refresh', () => { tracker.get(); });
}

export function readAuxiliaryModelHealth(): AuxiliaryModelHealth {
  return tracker.get();
}

export function registerAuxiliaryModelHealthIpc(): void {
  setAuxiliaryChainOutcomeListener(reportAuxiliaryChainOutcome);
  ipcMain.handle(MAKER_INVOKE.AUXILIARY_MODEL_HEALTH_GET, (event) => {
    assertTrustedAppRendererEvent(event);
    try {
      return readAuxiliaryModelHealth();
    } catch (error) {
      log.warn('failed to read auxiliary model health', { error });
      throwIpcError('INTERNAL', 'Failed to read auxiliary model health');
    }
  });
}
