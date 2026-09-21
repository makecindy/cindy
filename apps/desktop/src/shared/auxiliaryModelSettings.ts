import type { Provider } from '@cindy/model-providers';

import {
  AUXILIARY_MODEL_CHAIN_MAX,
  isAuxiliaryModelRef,
  parseAuxiliaryModelRef,
} from './auxiliaryModelChain.js';
import { decodeCatalogModelPin } from './catalogModelPin.js';
import { isUtilityModelProviderKind } from './utilityModelProfiles.js';

/** Main-owned ordered model chain for short, host-generated auxiliary text. */
export interface AuxiliaryModelSettings {
  /**
   * Ordered custom models. Empty = follow the current version's automatic chain.
   * At most three unique refs (catalog pins or lightweight profile keys).
   */
  models: string[];
}

export type AuxiliaryModelSettingsPatch = Partial<AuxiliaryModelSettings>;

export const AUXILIARY_MODEL_SETTINGS_DEFAULTS: AuxiliaryModelSettings = {
  models: [],
};

export const AUXILIARY_MODEL_PIN_MAX_LENGTH = 768;

/** Credential-free model metadata safe to expose to the trusted app renderer. */
export interface AuxiliaryModelOption {
  id: string;
  label: string;
  group: string;
  providerId: string;
  agentKind: 'codex' | 'claude-code';
  modelId: string;
  modelName: string;
  /** Follow the same default visibility as the regular model selector. */
  defaultEnabled?: boolean;
  icon?: string;
  budget: boolean;
  subscription: boolean;
  routing?: Provider['routing'];
  /** Agent used by this exact auxiliary route. */
  agentSuffix: string;
  /** False only for a persisted selection that is no longer currently usable. */
  available: boolean;
}

export interface AuxiliaryModelSettingsState extends AuxiliaryModelSettings {
  isCustomized: boolean;
  customizedKeys: string[];
  defaults: AuxiliaryModelSettings;
  options: AuxiliaryModelOption[];
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

/** Disk normalization: invalid values are dropped; empty list restores automatic. */
export function normalizeAuxiliaryModelRef(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (
    !trimmed
    || trimmed.length > AUXILIARY_MODEL_PIN_MAX_LENGTH
    || containsControlCharacter(trimmed)
    || !isAuxiliaryModelRef(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

export function normalizeAuxiliaryModelList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const models: string[] = [];
  for (const entry of value) {
    const ref = normalizeAuxiliaryModelRef(entry);
    if (!ref || models.includes(ref)) continue;
    models.push(ref);
    if (models.length >= AUXILIARY_MODEL_CHAIN_MAX) break;
  }
  return models;
}

/**
 * Accept a persisted or IPC value as a canonical auxiliary ref.
 * Catalog pins must already be trimmed; profile keys must be exact ids.
 */
export function isValidAuxiliaryModelRefInput(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return normalizeAuxiliaryModelRef(value) === value;
}

export function isValidAuxiliaryModelListInput(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  if (value.length > AUXILIARY_MODEL_CHAIN_MAX) return false;
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isValidAuxiliaryModelRefInput(entry) || seen.has(entry)) return false;
    seen.add(entry);
  }
  return true;
}

/** True when the user has an explicit 1–3 model override. */
export function isCustomAuxiliaryModelList(models: readonly string[]): boolean {
  return models.length > 0;
}

export function describeAuxiliaryModelRef(ref: string): {
  providerId: string;
  agentKind: 'codex' | 'claude-code';
  model: string;
} | null {
  const parsed = parseAuxiliaryModelRef(ref);
  if (!parsed) return null;
  if (parsed.kind === 'catalog') return parsed.route;
  return {
    providerId: parsed.id.startsWith('codex-') ? 'openai' : 'xd',
    agentKind: 'codex',
    model: parsed.id,
  };
}

export function isCatalogAuxiliaryRef(value: string): boolean {
  return decodeCatalogModelPin(value) !== null;
}

export function isProfileAuxiliaryRef(value: string): boolean {
  return isUtilityModelProviderKind(value);
}
