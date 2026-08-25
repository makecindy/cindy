import type { Provider } from '@cindy/model-providers';

import { decodeCatalogModelPin } from './catalogModelPin';

/** Main-owned model choices for short, host-generated auxiliary text. */
export interface AuxiliaryModelSettings {
  /** null = preserve the existing per-task/session automatic routing. */
  sessionTitleModel: string | null;
  /** null = preserve the existing prompt-recommendation automatic routing. */
  promptRecommendationModel: string | null;
}

export type AuxiliaryModelSettingsKey = keyof AuxiliaryModelSettings;
export type AuxiliaryModelSettingsPatch = Partial<AuxiliaryModelSettings>;

export const AUXILIARY_MODEL_SETTINGS_DEFAULTS: AuxiliaryModelSettings = {
  sessionTitleModel: null,
  promptRecommendationModel: null,
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

/** Disk normalization: invalid values restore the automatic/default route. */
export function normalizeAuxiliaryModelPin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > AUXILIARY_MODEL_PIN_MAX_LENGTH ||
    containsControlCharacter(trimmed) ||
    !decodeCatalogModelPin(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

/** IPC validation is strict: only null or a canonical, bounded catalog pin. */
export function isValidAuxiliaryModelPinInput(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  return normalizeAuxiliaryModelPin(value) === value;
}
