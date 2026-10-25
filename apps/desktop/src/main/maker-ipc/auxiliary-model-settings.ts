import { createAuxiliaryModelOptions } from '@cindy/model-providers/utility-model/auxiliaryModelOptions';
/** Settings IPC for the shared auxiliary-model chain. */

import { ipcMain } from 'electron';

import {
  isValidAuxiliaryModelListInput,
  type AuxiliaryModelSettingsPatch,
  type AuxiliaryModelSettingsState,
} from '../../shared/auxiliaryModelSettings.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import {
  isUtilityModelProviderKind,
} from '../../shared/utilityModelProfiles.js';
import { createLogger } from '../logger.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { readModelDisableOverrides } from '../maker-host/model-disable-store.js';
import { readProviderOrder } from '../maker-host/provider-order-store.js';
import {
  readAuxiliaryModelSettings,
  readAuxiliaryModelSettingsState,
  writeAuxiliaryModelSettingsPatch,
} from '../utility-model/auxiliary-model-settings-store.js';
import { hasOneshotProviderCredential } from '../utility-model/oneshotProviderUsability.js';
import {
  buildTextOneshotPinOptions,
} from '../utility-model/textOneshotPinOptions.js';
import {
  isUtilityRouteDisabled,
  isUtilityRoutePaymentRequired,
} from '../utility-model/oneShotCandidates.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE } from './channels.js';

const log = createLogger('maker-ipc/auxiliary-model-settings');

export const buildAuxiliaryModelOptions = createAuxiliaryModelOptions({
  isUtilityRouteDisabled,
  isUtilityRoutePaymentRequired,
});

function settingsWire(): AuxiliaryModelSettingsState {
  const state = readAuxiliaryModelSettingsState();
  const models = Array.isArray(state.value.models) ? state.value.models : [];
  const settings = { models };
  return {
    models,
    isCustomized: state.isCustomized,
    customizedKeys: state.customizedKeys,
    defaults: state.defaults ?? { models: [] },
    options: buildAuxiliaryModelOptions({
      settings,
      catalog: getActiveCatalog(),
      overrides: readModelDisableOverrides(),
      providerOrder: readProviderOrder(),
      hasCredential: hasOneshotProviderCredential,
    }),
  };
}

export function parseAuxiliaryModelSettingsPatch(
  raw: unknown,
  allowedPins: ReadonlySet<string>,
  persistedPins: ReadonlySet<string> = new Set(),
): AuxiliaryModelSettingsPatch {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throwIpcError('INVALID_PARAMS', 'auxiliary model settings patch required');
  }
  const input = raw as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length === 0 || keys.some((key) => key !== 'models')) {
    throwIpcError('INVALID_PARAMS', 'auxiliary model settings patch has invalid keys');
  }
  if (!isValidAuxiliaryModelListInput(input.models)) {
    throwIpcError('INVALID_PARAMS', 'models must be a unique list of at most 3 auxiliary refs');
  }
  for (const entry of input.models) {
    if (isUtilityModelProviderKind(entry)) continue;
    if (allowedPins.has(entry) || persistedPins.has(entry)) continue;
    throwIpcError('INVALID_PARAMS', 'models contains a catalog pin that is not currently routable');
  }
  return { models: input.models };
}

export function registerAuxiliaryModelSettingsIpc(): void {
  ipcMain.handle(MAKER_INVOKE.AUXILIARY_MODEL_SETTINGS_GET, (event) => {
    assertTrustedAppRendererEvent(event);
    try {
      return settingsWire();
    } catch (error) {
      if (isIpcError(error)) throw error;
      log.warn('failed to read auxiliary model settings', { error });
      throwIpcError('INTERNAL', 'Failed to read auxiliary model settings');
    }
  });

  ipcMain.handle(MAKER_INVOKE.AUXILIARY_MODEL_SETTINGS_SET, async (event, rawPatch: unknown) => {
    assertTrustedAppRendererEvent(event);
    try {
      // Persisted intent ignores transient credential readiness, while execution
      // still validates credentials and fails closed immediately before dispatch.
      const allowedPins = new Set(
        buildTextOneshotPinOptions(
          getActiveCatalog(),
          readModelDisableOverrides(),
          readProviderOrder(),
        ).map((option) => option.id),
      );
      const patch = parseAuxiliaryModelSettingsPatch(
        rawPatch,
        allowedPins,
        new Set(readAuxiliaryModelSettings().models),
      );
      await writeAuxiliaryModelSettingsPatch(patch);
      return settingsWire();
    } catch (error) {
      if (isIpcError(error)) throw error;
      log.warn('failed to write auxiliary model settings', { error });
      throwIpcError('INTERNAL', 'Failed to save auxiliary model settings');
    }
  });
}
