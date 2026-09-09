/** Settings IPC for the shared auxiliary-model chain. */

import { ipcMain } from 'electron';
import type { Catalog, ModelDisableOverrides } from '@cindy/model-providers';

import {
  isValidAuxiliaryModelListInput,
  type AuxiliaryModelOption,
  type AuxiliaryModelSettings,
  type AuxiliaryModelSettingsPatch,
  type AuxiliaryModelSettingsState,
} from '../../shared/auxiliaryModelSettings.js';
import { decodeCatalogModelPin } from '../../shared/catalogModelPin.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import {
  getUtilityModelProfile,
  isUtilityModelProviderKind,
  utilityTransportLabel,
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
  type OneshotCredentialProbe,
  type TextOneshotPinOption,
} from '../utility-model/textOneshotPinOptions.js';
import {
  isUtilityRouteDisabled,
  isUtilityRoutePaymentRequired,
} from '../utility-model/oneShotCandidates.js';
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

function syntheticProfileOption(
  id: string,
  args: {
    catalog: Catalog;
    hasCredential?: OneshotCredentialProbe;
  },
): AuxiliaryModelOption {
  const profile = getUtilityModelProfile(id as Parameters<typeof getUtilityModelProfile>[0]);
  const providerId = profile.transport === 'codex-responses' ? 'openai' : 'xd';
  const provider = args.catalog.providers.find((item) => item.id === providerId);
  const available = Boolean(
    provider
      && args.hasCredential?.(provider, 'codex')
      && !isUtilityRouteDisabled(profile)
      && !isUtilityRoutePaymentRequired(profile),
  );
  return {
    id,
    label: `${profile.model} · ${utilityTransportLabel(profile.transport)}`,
    group: providerId,
    providerId,
    agentKind: 'codex',
    modelId: profile.model,
    modelName: profile.model,
    budget: false,
    subscription: profile.transport === 'codex-responses',
    agentSuffix: 'Codex',
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
  for (const pin of args.settings.models) {
    if (availableIds.has(pin)) continue;
    const known = allById.get(pin);
    if (known) {
      result.push(toWireOption(known, false));
      continue;
    }
    if (isUtilityModelProviderKind(pin)) {
      result.push(syntheticProfileOption(pin, {
        catalog: args.catalog,
        hasCredential: args.hasCredential,
      }));
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
