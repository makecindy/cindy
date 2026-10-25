import type { Catalog } from '../types.js';
import type { ModelDisableOverrides } from '../disableOverrides.js';
import type {
  AuxiliaryModelOption,
  AuxiliaryModelSettings,
} from '../auxiliaryModelSettings.js';
import { decodeCatalogModelPin } from '../catalogModelPin.js';
import {
  getUtilityModelProfile,
  isUtilityModelProviderKind,
  utilityTransportLabel,
  type UtilityModelProfile,
} from '../utilityModelProfiles.js';
import {
  buildTextOneshotPinOptions,
  type OneshotCredentialProbe,
  type TextOneshotPinOption,
} from './textOneshotPinOptions.js';
export function createAuxiliaryModelOptions(checks: {
  isUtilityRouteDisabled(profile: UtilityModelProfile): boolean;
  isUtilityRoutePaymentRequired(profile: UtilityModelProfile): boolean;
}) {
  const { isUtilityRouteDisabled, isUtilityRoutePaymentRequired } = checks;
  function toWireOption(
    option: TextOneshotPinOption,
    available: boolean,
  ): AuxiliaryModelOption {
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
    const profile = getUtilityModelProfile(
      id as Parameters<typeof getUtilityModelProfile>[0],
    );
    const providerId =
      profile.transport === 'codex-responses' ? 'openai' : 'xd';
    const provider = args.catalog.providers.find(
      (item) => item.id === providerId,
    );
    const available = Boolean(
      provider &&
      args.hasCredential?.(provider, 'codex') &&
      !isUtilityRouteDisabled(profile) &&
      !isUtilityRoutePaymentRequired(profile),
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
  function buildAuxiliaryModelOptions(args: {
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

    const allRoutable = buildTextOneshotPinOptions(
      args.catalog,
      args.overrides,
      args.providerOrder,
    );
    const allById = new Map(allRoutable.map((option) => [option.id, option]));
    for (const pin of args.settings.models) {
      if (availableIds.has(pin)) continue;
      const known = allById.get(pin);
      if (known) {
        result.push(toWireOption(known, false));
        continue;
      }
      if (isUtilityModelProviderKind(pin)) {
        result.push(
          syntheticProfileOption(pin, {
            catalog: args.catalog,
            hasCredential: args.hasCredential,
          }),
        );
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

  return buildAuxiliaryModelOptions;
}
