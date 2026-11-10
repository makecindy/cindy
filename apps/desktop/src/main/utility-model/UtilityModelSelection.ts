import { resolveCodexSubscriptionUtilityModel } from '@cindy/model-providers/subscription-utility';
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { createLogger } from '../logger.js';
import {
  DEFAULT_UTILITY_MODEL_PROVIDER_CHAIN,
  DEFAULT_UTILITY_MODEL_PROVIDER_KIND,
  getUtilityModelProfile,
  resolveUtilityModelProviderKindAlias,
  type UtilityModelProfile,
  type UtilityModelProviderKind,
} from '../../shared/utilityModelProfiles.js';

const log = createLogger('utility-model:selection');
const CONFIG_FILE_NAME = 'voice-input-models.json';

export type UtilityModelSelectionValues = {
  provider: UtilityModelProviderKind;
  model?: string;
  providerChain: UtilityModelProviderKind[];
};

export type UtilityModelSelection = UtilityModelSelectionValues & {
  configPath: string;
};

export type UtilityModelSelectionWarning = {
  field: 'provider' | 'providerChain';
  value: string;
  fallback: string;
};

type UtilityModelSelectionResolution = {
  values: UtilityModelSelectionValues;
  warnings: UtilityModelSelectionWarning[];
};

type RawUtilityModelSelectionFile = {
  utilityModelProvider?: unknown;
  utilityModel?: unknown;
  utilityModelProviderChain?: unknown;
  // Compatibility with the first implementation that only exposed this config
  // through voice input refinement.
  refinerProvider?: unknown;
  refinerModel?: unknown;
  refinerProviderChain?: unknown;
};

let cachedConfig: UtilityModelSelection | null = null;
let cachedMtimeMs = -1;

export function getUtilityModelSelectionConfigPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE_NAME);
}

export function resolveUtilityModelSelectionValues(
  raw: RawUtilityModelSelectionFile | null | undefined,
  env: NodeJS.ProcessEnv = readDefaultUtilityModelSelectionEnv(),
): UtilityModelSelectionResolution {
  const provider = resolveProvider(
    readConfigString(raw, 'utilityModelProvider')
      ?? env.XDT_UTILITY_MODEL_PROVIDER
      ?? readConfigString(raw, 'refinerProvider')
      ?? env.XDT_VOICE_INPUT_REFINER_PROVIDER
      ?? '',
  );
  const model = normalizeOptionalString(
    readConfigString(raw, 'utilityModel')
      ?? env.XDT_UTILITY_MODEL
      ?? readConfigString(raw, 'refinerModel')
      ?? env.XDT_VOICE_INPUT_REFINER_MODEL,
  );
  const chain = resolveProviderChain({
    rawEntries: readConfigStringList(raw, 'utilityModelProviderChain')
      ?? splitCommaList(env.XDT_UTILITY_MODEL_PROVIDER_CHAIN)
      ?? readConfigStringList(raw, 'refinerProviderChain')
      ?? splitCommaList(env.XDT_VOICE_INPUT_REFINER_PROVIDER_CHAIN),
    head: provider.value,
    defaultChain: DEFAULT_UTILITY_MODEL_PROVIDER_CHAIN,
  });

  return {
    values: {
      provider: provider.value,
      model,
      providerChain: chain.value,
    },
    warnings: [
      ...(provider.warning ? [provider.warning] : []),
      ...chain.warnings,
    ],
  };
}

export function getUtilityModelSelection(): UtilityModelSelection {
  ensureUtilityModelSelectionFile();
  const configPath = getUtilityModelSelectionConfigPath();
  const mtimeMs = readConfigMtimeMs(configPath);
  if (!cachedConfig || cachedMtimeMs !== mtimeMs) {
    cachedConfig = loadUtilityModelSelection(configPath, mtimeMs);
  }
  return cachedConfig;
}

export function reloadUtilityModelSelection(): UtilityModelSelection {
  cachedConfig = null;
  cachedMtimeMs = -1;
  return getUtilityModelSelection();
}

export function getUtilityModelChainProfiles(): UtilityModelProfile[] {
  const selection = getUtilityModelSelection();
  return selection.providerChain.map((kind) => {
    const profile = getUtilityModelProfile(kind);
    return kind === selection.provider && selection.model
      ? { ...profile, model: profile.transport === 'codex-responses' ? resolveCodexSubscriptionUtilityModel(selection.model) : selection.model }
      : profile;
  });
}

function resolveProvider(value: string): {
  value: UtilityModelProviderKind;
  warning?: UtilityModelSelectionWarning;
} {
  const normalized = value.trim();
  const resolved = resolveUtilityModelProviderKindAlias(normalized);
  if (resolved) return { value: resolved };
  return {
    value: DEFAULT_UTILITY_MODEL_PROVIDER_KIND,
    warning: {
      field: 'provider',
      value: normalized,
      fallback: DEFAULT_UTILITY_MODEL_PROVIDER_KIND,
    },
  };
}

function resolveProviderChain(input: {
  rawEntries: string[] | undefined;
  head: UtilityModelProviderKind;
  defaultChain: readonly UtilityModelProviderKind[];
}): { value: UtilityModelProviderKind[]; warnings: UtilityModelSelectionWarning[] } {
  const warnings: UtilityModelSelectionWarning[] = [];
  const tailSource: UtilityModelProviderKind[] = [];
  if (input.rawEntries && input.rawEntries.length > 0) {
    for (const entry of input.rawEntries) {
      const resolved = resolveUtilityModelProviderKindAlias(entry);
      if (resolved) {
        tailSource.push(resolved);
      } else {
        warnings.push({ field: 'providerChain', value: entry, fallback: '<dropped>' });
      }
    }
  }
  if (tailSource.length === 0) tailSource.push(...input.defaultChain);
  const chain: UtilityModelProviderKind[] = [input.head];
  for (const entry of tailSource) {
    if (!chain.includes(entry)) chain.push(entry);
  }
  return { value: chain, warnings };
}

function loadUtilityModelSelection(configPath: string, mtimeMs: number): UtilityModelSelection {
  const raw = readUtilityModelSelectionFile(configPath);
  const resolution = resolveUtilityModelSelectionValues(raw);
  for (const warning of resolution.warnings) {
    log.warn('unknown utility model selection value, falling back', warning);
  }
  const config: UtilityModelSelection = {
    ...resolution.values,
    configPath,
  };
  cachedMtimeMs = mtimeMs;
  log.info('utility model selection loaded', {
    path: configPath,
    provider: config.provider,
    model: config.model,
    providerChain: config.providerChain,
  });
  return config;
}

function readUtilityModelSelectionFile(configPath: string): RawUtilityModelSelectionFile | null {
  try {
    const text = fs.readFileSync(configPath, 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed)) {
      log.warn('utility model selection file is not an object, using defaults', { path: configPath });
      return null;
    }
    return parsed;
  } catch (error) {
    log.warn('utility model selection read failed, using defaults', {
      path: configPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function ensureUtilityModelSelectionFile(): void {
  const configPath = getUtilityModelSelectionConfigPath();
  if (fs.existsSync(configPath)) return;
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(defaultRuntimeConfigFile(), null, 2)}\n`, 'utf8');
    log.info('utility model selection file created', { path: configPath });
  } catch (error) {
    log.warn('utility model selection file create failed', {
      path: configPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function readConfigMtimeMs(configPath: string): number {
  try {
    return fs.statSync(configPath).mtimeMs;
  } catch {
    return 0;
  }
}

function defaultRuntimeConfigFile(): RawUtilityModelSelectionFile {
  return {
    refinerProvider: '',
    refinerModel: '',
    refinerProviderChain: [],
  };
}

function readDefaultUtilityModelSelectionEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    XDT_UTILITY_MODEL_PROVIDER: process.env.XDT_UTILITY_MODEL_PROVIDER,
    XDT_UTILITY_MODEL: process.env.XDT_UTILITY_MODEL,
    XDT_UTILITY_MODEL_PROVIDER_CHAIN: process.env.XDT_UTILITY_MODEL_PROVIDER_CHAIN,
    XDT_VOICE_INPUT_REFINER_PROVIDER: process.env.XDT_VOICE_INPUT_REFINER_PROVIDER,
    XDT_VOICE_INPUT_REFINER_MODEL: process.env.XDT_VOICE_INPUT_REFINER_MODEL,
    XDT_VOICE_INPUT_REFINER_PROVIDER_CHAIN: process.env.XDT_VOICE_INPUT_REFINER_PROVIDER_CHAIN,
  };
}

function readConfigString(raw: RawUtilityModelSelectionFile | null | undefined, key: keyof RawUtilityModelSelectionFile): string | undefined {
  if (!raw || !(key in raw)) return undefined;
  const value = raw[key];
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function readConfigStringList(
  raw: RawUtilityModelSelectionFile | null | undefined,
  key: 'utilityModelProviderChain' | 'refinerProviderChain',
): string[] | undefined {
  if (!raw || !(key in raw)) return undefined;
  const value = raw[key];
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

function splitCommaList(value: string | undefined): string[] | undefined {
  const entries = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
