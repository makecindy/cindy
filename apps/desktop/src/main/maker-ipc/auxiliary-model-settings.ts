/** Settings IPC for global auxiliary text model choices. */

import { ipcMain } from 'electron';
import type { Catalog, ModelDisableOverrides } from '@cindy/model-providers';

import {
  isValidAuxiliaryModelPinInput,
  type AuxiliaryModelOption,
  type AuxiliaryModelSettings,
  type AuxiliaryModelSettingsPatch,
  type AuxiliaryModelSettingsState,
} from '../../shared/auxiliaryModelSettings.js';
import { decodeCatalogModelPin } from '../../shared/catalogModelPin.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import { createLogger } from '../logger.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { readModelDisableOverrides } from '../maker-host/model-disable-store.js';
import { readProviderOrder } from '../maker-host/provider-order-store.js';
import {
  readAuxiliaryModelSettingsState,
  writeAuxiliaryModelSettingsPatch,
} from '../utility-model/auxiliary-model-settings-store.js';
import { hasOneshotProviderCredential } from '../utility-model/oneshotProviderUsability.js';
import {
  buildTextOneshotPinOptions,
  type OneshotCredentialProbe,
  type TextOneshotPinOption,
} from '../utility-model/textOneshotPinOptions.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE } from './channels.js';

const log = createLogger('maker-ipc/auxiliary-model-settings');

function toWireOption(option: TextOneshotPinOption, available: boolean): AuxiliaryModelOption {
  if (option.agentKind !== 'codex' && option.agentKind !== 'claude-code') {
    throw new Error(`unsupported auxiliary model agent: ${option.agentKind}`);
  }
  return {
    ...option,
    agentKind: option.agentKind,
    available,
  };
}

/**
 * Return currently usable choices plus any persisted-but-unavailable selections.
 * The latter remain visible and removable without becoming selectable elsewhere.
 */
export function buildAuxiliaryModelOptions(args: {
  settings: AuxiliaryModelSettings;
  catalog: Catalog;
  overrides: ModelDisableOverrides | undefined;
  providerOrder?: readonly string[];
  hasCredential?: OneshotCredentialProbe;
}): AuxiliaryModelOption[] {
  const available = buildTextOneshotPinOptions(
    args.catalog,
    args.overrides,
    args.providerOrder,
    args.hasCredential,
  );
  const availableIds = new Set(available.map((option) => option.id));
  const result = available.map((option) => toWireOption(option, true));

  const allRoutable = buildTextOneshotPinOptions(args.catalog, args.overrides, args.providerOrder);
  const allById = new Map(allRoutable.map((option) => [option.id, option]));
  const persistedPins = new Set(
    [args.settings.sessionTitleModel, args.settings.promptRecommendationModel].filter(
      (pin): pin is string => typeof pin === 'string',
    ),
  );
  for (const pin of persistedPins) {
    if (availableIds.has(pin)) continue;
    const known = allById.get(pin);
    if (known) {
      result.push(toWireOption(known, false));
      continue;
    }
    const decoded = decodeCatalogModelPin(pin);
    if (!decoded) continue;
    result.push({
      id: pin,
      label: `${decoded.agentKind === 'codex' ? 'Codex' : 'Claude Code'} · ${decoded.model} · ${decoded.providerId}`,
      group: decoded.providerId,
      providerId: decoded.providerId,
      agentKind: decoded.agentKind,
      modelId: decoded.model,
      modelName: decoded.model,
      budget: false,
      subscription: false,
      agentSuffix: decoded.agentKind === 'codex' ? 'Codex' : 'Claude Code',
      available: false,
    });
  }
  return result;
}

function settingsWire(): AuxiliaryModelSettingsState {
  const state = readAuxiliaryModelSettingsState();
  return {
    ...state.value,
    isCustomized: state.isCustomized,
    customizedKeys: state.customizedKeys,
    defaults: state.defaults,
    options: buildAuxiliaryModelOptions({
      settings: state.value,
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
): AuxiliaryModelSettingsPatch {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throwIpcError('INVALID_PARAMS', 'auxiliary model settings patch required');
  }
  const input = raw as Record<string, unknown>;
  const allowedKeys = new Set(['sessionTitleModel', 'promptRecommendationModel']);
  const keys = Object.keys(input);
  if (keys.length === 0 || keys.some((key) => !allowedKeys.has(key))) {
    throwIpcError('INVALID_PARAMS', 'auxiliary model settings patch has invalid keys');
  }

  const patch: AuxiliaryModelSettingsPatch = {};
  for (const key of keys) {
    const value = input[key];
    if (!isValidAuxiliaryModelPinInput(value)) {
      throwIpcError('INVALID_PARAMS', `${key} must be null or a canonical catalog model pin`);
    }
    if (value !== null && !allowedPins.has(value)) {
      throwIpcError('INVALID_PARAMS', `${key} is not a currently routable catalog model`);
    }
    patch[key as keyof AuxiliaryModelSettingsPatch] = value;
  }
  return patch;
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
      const patch = parseAuxiliaryModelSettingsPatch(rawPatch, allowedPins);
      await writeAuxiliaryModelSettingsPatch(patch);
      return settingsWire();
    } catch (error) {
      if (isIpcError(error)) throw error;
      log.warn('failed to write auxiliary model settings', { error });
      throwIpcError('INTERNAL', 'Failed to save auxiliary model settings');
    }
  });
}
