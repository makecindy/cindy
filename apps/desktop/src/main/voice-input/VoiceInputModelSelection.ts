import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { createLogger } from '../logger.js';
import { getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';
import {
  DEFAULT_VOICE_INPUT_ASR_PROVIDER_CHAIN,
  DEFAULT_VOICE_INPUT_PROVIDER_KIND,
  resolveVoiceInputProviderKindAlias,
  type VoiceInputProviderKind,
} from './voiceInputAsrConfig.js';
import {
  DEFAULT_VOICE_INPUT_REFINER_PROVIDER_KIND,
  resolveVoiceInputRefinerProviderKindAlias,
  type VoiceInputRefinerProviderKind,
} from '../../shared/voiceInputRefinerProfiles.js';
import {
  validateVoiceInputCustomAsrConfig,
  type VoiceInputCustomAsrConfig,
} from '../../shared/voiceInputCustomAsr.js';

export {
  validateVoiceInputCustomAsrConfig,
  type VoiceInputCustomAsrConfig,
  type VoiceInputCustomAsrProtocol,
} from '../../shared/voiceInputCustomAsr.js';

const EMPTY_REFINER_DEFAULT_CHAIN: readonly VoiceInputRefinerProviderKind[] = [];

const log = createLogger('voice-input:model-selection');
const CONFIG_FILE_NAME = 'voice-input-models.json';

export type VoiceInputProviderChainSource = 'default' | 'configured';

/**
 * Which credential plane powers voice dictation.
 * - 'cindy': the managed Cindy voice service (login-token → one-shot tickets).
 * - 'byok': the user's own credentials (gateway key / Codex login / env keys),
 *   restoring the pre-managed-migration direct-dial behavior.
 * The persisted file keeps '' for "follow the product default" (currently
 * 'cindy') so future default changes reach users who never customized it.
 */
export type VoiceInputServiceMode = 'cindy' | 'byok';

export const DEFAULT_VOICE_INPUT_SERVICE_MODE: VoiceInputServiceMode = 'cindy';

/**
 * Account-free sessions must always use the user's own credential plane.
 * Keep the persisted preference untouched so returning to a cloud account
 * restores the user's previous managed/BYOK choice.
 */
export function effectiveVoiceInputServiceMode(
  configuredMode: VoiceInputServiceMode,
  canUseCindyAccountServices: boolean,
): VoiceInputServiceMode {
  return canUseCindyAccountServices ? configuredMode : 'byok';
}

export function voiceInputAsrChainForServiceMode(
  selection: Pick<
    VoiceInputModelSelectionValues,
    'serviceMode' | 'asrProvider' | 'asrProviderChain' | 'asrProviderChainSource'
  >,
): VoiceInputProviderKind[] {
  return selection.serviceMode === 'byok' && selection.asrProviderChainSource === 'default'
    ? [selection.asrProvider]
    : [...selection.asrProviderChain];
}

export type VoiceInputModelSelectionValues = {
  serviceMode: VoiceInputServiceMode;
  /** True when serviceMode came from an explicit file/env override (vs the product default). */
  serviceModeConfigured: boolean;
  asrProvider: VoiceInputProviderKind;
  refinerProvider: VoiceInputRefinerProviderKind;
  refinerModel?: string;
  /**
   * Effective ASR fallback chain, highest priority first, deduped, always
   * starting with `asrProvider`. Built from the explicit chain config
   * (`asrProviderChain` file field / XDT_VOICE_INPUT_ASR_PROVIDER_CHAIN env,
   * comma separated) when present, otherwise from the built-in default chain.
   */
  asrProviderChain: VoiceInputProviderKind[];
  asrProviderChainSource: VoiceInputProviderChainSource;
  /** User-owned realtime ASR transport metadata. The API key is never stored here. */
  customAsr?: VoiceInputCustomAsrConfig;
  /** Effective refiner fallback chain; same resolution rules as asrProviderChain. */
  refinerProviderChain: VoiceInputRefinerProviderKind[];
  refinerProviderChainSource: VoiceInputProviderChainSource;
};

export type VoiceInputModelSelection = VoiceInputModelSelectionValues & {
  configPath: string;
};

export type VoiceInputModelSelectionPatch = {
  serviceMode?: VoiceInputServiceMode | null;
  asrProvider?: VoiceInputProviderKind | null;
  customAsr?: VoiceInputCustomAsrConfig | null;
  refinerProvider?: VoiceInputRefinerProviderKind | null;
  refinerModel?: string | null;
  /**
   * Explicit BYOK refiner fallback tail (providers tried after the primary).
   * `null` clears the override — with no configured tail the primary runs
   * alone. Managed mode ignores this entirely (server-side failover).
   */
  refinerProviderChain?: VoiceInputRefinerProviderKind[] | null;
};

export type VoiceInputModelSelectionWarning = {
  field: 'serviceMode' | 'asrProvider' | 'refinerProvider' | 'asrProviderChain' | 'refinerProviderChain' | 'customAsr';
  value: string;
  fallback: string;
};

type VoiceInputModelSelectionResolution = {
  values: VoiceInputModelSelectionValues;
  warnings: VoiceInputModelSelectionWarning[];
};

type RawVoiceInputModelSelectionFile = {
  serviceMode?: unknown;
  asrProvider?: unknown;
  utilityModelProvider?: unknown;
  utilityModel?: unknown;
  utilityModelProviderChain?: unknown;
  refinerProvider?: unknown;
  refinerModel?: unknown;
  asrProviderChain?: unknown;
  refinerProviderChain?: unknown;
  customAsr?: unknown;
};

let cachedConfig: VoiceInputModelSelection | null = null;
let cachedMtimeMs = -1;

export function getVoiceInputModelSelectionConfigPath(): string {
  const ownerId = getActiveAppSession().dataOwnerId;
  return ownerId ? ownerScopedUserDataPath(CONFIG_FILE_NAME) : path.join(app.getPath('userData'), CONFIG_FILE_NAME);
}

export function resolveVoiceInputModelSelectionValues(
  raw: RawVoiceInputModelSelectionFile | null | undefined,
  env: NodeJS.ProcessEnv = readDefaultVoiceInputModelSelectionEnv(),
): VoiceInputModelSelectionResolution {
  warnIgnoredLegacyAsrProviderEnv(env);
  const serviceMode = resolveServiceMode(
    readConfigString(raw, 'serviceMode') ?? env.XDT_VOICE_INPUT_SERVICE_MODE ?? '',
  );
  const asrProvider = resolveAsrProvider(readConfigString(raw, 'asrProvider') ?? env.XDT_VOICE_INPUT_ASR_PROVIDER ?? '');
  const refinerProvider = resolveRefinerProvider(
    readConfigString(raw, 'utilityModelProvider')
      ?? readConfigString(raw, 'refinerProvider')
      ?? env.XDT_UTILITY_MODEL_PROVIDER
      ?? env.XDT_VOICE_INPUT_REFINER_PROVIDER
      ?? '',
  );
  const refinerModel = normalizeOptionalString(
    readConfigString(raw, 'utilityModel')
      ?? readConfigString(raw, 'refinerModel')
      ?? env.XDT_UTILITY_MODEL
      ?? env.XDT_VOICE_INPUT_REFINER_MODEL,
  );
  const asrChain = resolveProviderChain({
    field: 'asrProviderChain',
    rawEntries: readConfigStringList(raw, 'asrProviderChain')
      ?? splitCommaList(env.XDT_VOICE_INPUT_ASR_PROVIDER_CHAIN),
    head: asrProvider.value,
    defaultChain: DEFAULT_VOICE_INPUT_ASR_PROVIDER_CHAIN,
    resolveAlias: resolveVoiceInputProviderKindAlias,
  });
  const customAsr = resolveVoiceInputCustomAsrConfig(raw?.customAsr);
  const refinerChain = resolveProviderChain({
    field: 'refinerProviderChain',
    rawEntries: readConfigStringList(raw, 'utilityModelProviderChain')
      ?? readConfigStringList(raw, 'refinerProviderChain')
      ?? splitCommaList(env.XDT_UTILITY_MODEL_PROVIDER_CHAIN)
      ?? splitCommaList(env.XDT_VOICE_INPUT_REFINER_PROVIDER_CHAIN),
    head: refinerProvider.value,
    // BYOK refiner fallback is explicit opt-in (product decision 2026-07-23):
    // without a configured chain the head runs alone, mirroring the reality
    // that most BYOK users hold a single credential plane. Managed mode does
    // not read this chain at all — voice-server owns model failover there.
    defaultChain: EMPTY_REFINER_DEFAULT_CHAIN,
    resolveAlias: resolveVoiceInputRefinerProviderKindAlias,
  });
  return {
    values: {
      serviceMode: serviceMode.value,
      serviceModeConfigured: serviceMode.configured,
      asrProvider: asrProvider.value,
      refinerProvider: refinerProvider.value,
      refinerModel,
      asrProviderChain: asrChain.value,
      asrProviderChainSource: asrChain.source,
      ...(customAsr.value ? { customAsr: customAsr.value } : {}),
      refinerProviderChain: refinerChain.value,
      refinerProviderChainSource: refinerChain.source,
    },
    warnings: [
      ...(serviceMode.warning ? [serviceMode.warning] : []),
      ...(asrProvider.warning ? [asrProvider.warning] : []),
      ...(refinerProvider.warning ? [refinerProvider.warning] : []),
      ...asrChain.warnings,
      ...(customAsr.warning ? [customAsr.warning] : []),
      ...refinerChain.warnings,
    ],
  };
}

/**
 * Builds the effective fallback chain: the user-selected primary provider is
 * always the head; the rest comes from the explicit chain config when present,
 * otherwise from the built-in default chain. Unknown entries are dropped with
 * a warning instead of failing the whole selection.
 */
function resolveProviderChain<K extends string>(input: {
  field: 'asrProviderChain' | 'refinerProviderChain';
  rawEntries: string[] | undefined;
  head: K;
  defaultChain: readonly K[];
  resolveAlias: (value: string) => K | null;
}): { value: K[]; source: VoiceInputProviderChainSource; warnings: VoiceInputModelSelectionWarning[] } {
  const warnings: VoiceInputModelSelectionWarning[] = [];
  const tailSource: K[] = [];
  if (input.rawEntries && input.rawEntries.length > 0) {
    for (const entry of input.rawEntries) {
      const resolved = input.resolveAlias(entry);
      if (resolved) {
        tailSource.push(resolved);
      } else {
        warnings.push({ field: input.field, value: entry, fallback: '<dropped>' });
      }
    }
  }
  const source: VoiceInputProviderChainSource = tailSource.length > 0 ? 'configured' : 'default';
  if (tailSource.length === 0) tailSource.push(...input.defaultChain);
  const chain: K[] = [input.head];
  for (const entry of tailSource) {
    if (!chain.includes(entry)) chain.push(entry);
  }
  return { value: chain, source, warnings };
}

function readDefaultVoiceInputModelSelectionEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Electron main is bundled by Vite. vite.main.config.ts injects XDT_*
    // values by replacing direct process.env.XDT_* reads, so keep these
    // explicit instead of only passing the process.env object through.
    XDT_VOICE_INPUT_SERVICE_MODE: process.env.XDT_VOICE_INPUT_SERVICE_MODE,
    XDT_VOICE_INPUT_ASR_PROVIDER: process.env.XDT_VOICE_INPUT_ASR_PROVIDER,
    XDT_UTILITY_MODEL_PROVIDER: process.env.XDT_UTILITY_MODEL_PROVIDER,
    XDT_UTILITY_MODEL: process.env.XDT_UTILITY_MODEL,
    XDT_UTILITY_MODEL_PROVIDER_CHAIN: process.env.XDT_UTILITY_MODEL_PROVIDER_CHAIN,
    XDT_VOICE_INPUT_REFINER_PROVIDER: process.env.XDT_VOICE_INPUT_REFINER_PROVIDER,
    XDT_VOICE_INPUT_REFINER_MODEL: process.env.XDT_VOICE_INPUT_REFINER_MODEL,
    XDT_VOICE_INPUT_ASR_PROVIDER_CHAIN: process.env.XDT_VOICE_INPUT_ASR_PROVIDER_CHAIN,
    XDT_VOICE_INPUT_REFINER_PROVIDER_CHAIN: process.env.XDT_VOICE_INPUT_REFINER_PROVIDER_CHAIN,
  };
}

export function getVoiceInputModelSelection(): VoiceInputModelSelection {
  ensureVoiceInputModelSelectionFile();
  const configPath = getVoiceInputModelSelectionConfigPath();
  const mtimeMs = readConfigMtimeMs(configPath);
  if (!cachedConfig || cachedConfig.configPath !== configPath || cachedMtimeMs !== mtimeMs) {
    cachedConfig = loadVoiceInputModelSelection(configPath, mtimeMs);
  }
  return cachedConfig;
}

export function reloadVoiceInputModelSelection(): VoiceInputModelSelection {
  cachedConfig = null;
  cachedMtimeMs = -1;
  return getVoiceInputModelSelection();
}

export function setVoiceInputModelSelection(patch: VoiceInputModelSelectionPatch): VoiceInputModelSelection {
  ensureVoiceInputModelSelectionFile();
  const configPath = getVoiceInputModelSelectionConfigPath();
  const current = readVoiceInputModelSelectionFile(configPath) ?? defaultRuntimeConfigFile();
  const next: RawVoiceInputModelSelectionFile = { ...current };
  if ('serviceMode' in patch) next.serviceMode = patch.serviceMode ?? '';
  if ('asrProvider' in patch) next.asrProvider = patch.asrProvider ?? '';
  if ('customAsr' in patch) next.customAsr = patch.customAsr ?? undefined;
  if ('refinerProvider' in patch) next.refinerProvider = patch.refinerProvider ?? '';
  if ('refinerModel' in patch) next.refinerModel = patch.refinerModel?.trim() ?? '';
  if ('refinerProviderChain' in patch) next.refinerProviderChain = patch.refinerProviderChain ?? [];
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  log.info('voice input model selection written', {
    path: configPath,
    serviceMode: next.serviceMode,
    asrProvider: next.asrProvider,
    customAsrConfigured: Boolean(next.customAsr),
    refinerProvider: next.refinerProvider,
    refinerModel: next.refinerModel,
    refinerProviderChain: next.refinerProviderChain,
  });
  return reloadVoiceInputModelSelection();
}

export function voiceInputModelSelectionSignature(config: VoiceInputModelSelectionValues): string {
  return JSON.stringify({
    serviceMode: config.serviceMode,
    asrProvider: config.asrProvider,
    refinerProvider: config.refinerProvider,
    refinerModel: config.refinerModel ?? '',
    asrProviderChain: config.asrProviderChain,
    asrProviderChainSource: config.asrProviderChainSource,
    customAsr: config.customAsr ?? null,
    refinerProviderChain: config.refinerProviderChain,
    refinerProviderChainSource: config.refinerProviderChainSource,
  });
}

// '' (or absent) means "follow the product default"; unknown non-empty values
// fall back to the default with a warning instead of failing the selection.
function resolveServiceMode(value: string): {
  value: VoiceInputServiceMode;
  configured: boolean;
  warning?: VoiceInputModelSelectionWarning;
} {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return { value: DEFAULT_VOICE_INPUT_SERVICE_MODE, configured: false };
  if (normalized === 'cindy' || normalized === 'byok') {
    return { value: normalized, configured: true };
  }
  return {
    value: DEFAULT_VOICE_INPUT_SERVICE_MODE,
    configured: false,
    warning: {
      field: 'serviceMode',
      value: normalized,
      fallback: DEFAULT_VOICE_INPUT_SERVICE_MODE,
    },
  };
}

function resolveAsrProvider(value: string): {
  value: VoiceInputProviderKind;
  warning?: VoiceInputModelSelectionWarning;
} {
  const normalized = value.trim();
  const resolved = resolveVoiceInputProviderKindAlias(normalized);
  if (resolved) return { value: resolved };
  return {
    value: DEFAULT_VOICE_INPUT_PROVIDER_KIND,
    warning: {
      field: 'asrProvider',
      value: normalized,
      fallback: DEFAULT_VOICE_INPUT_PROVIDER_KIND,
    },
  };
}

function resolveRefinerProvider(value: string): {
  value: VoiceInputRefinerProviderKind;
  warning?: VoiceInputModelSelectionWarning;
} {
  const normalized = value.trim();
  const resolved = resolveVoiceInputRefinerProviderKindAlias(normalized);
  if (resolved) return { value: resolved };
  return {
    value: DEFAULT_VOICE_INPUT_REFINER_PROVIDER_KIND,
    warning: {
      field: 'refinerProvider',
      value: normalized,
      fallback: DEFAULT_VOICE_INPUT_REFINER_PROVIDER_KIND,
    },
  };
}

function loadVoiceInputModelSelection(configPath: string, mtimeMs: number): VoiceInputModelSelection {
  const raw = readVoiceInputModelSelectionFile(configPath);
  const resolution = resolveVoiceInputModelSelectionValues(raw);
  for (const warning of resolution.warnings) {
    log.warn('unknown voice input model selection value, falling back', warning);
  }
  const config: VoiceInputModelSelection = {
    ...resolution.values,
    configPath,
  };
  cachedMtimeMs = mtimeMs;
  log.info('voice input model selection loaded', {
    path: configPath,
    serviceMode: config.serviceMode,
    asrProvider: config.asrProvider,
    refinerProvider: config.refinerProvider,
    refinerModel: config.refinerModel,
    asrProviderChain: config.asrProviderChain,
    refinerProviderChain: config.refinerProviderChain,
    refinerProviderChainSource: config.refinerProviderChainSource,
  });
  return config;
}

function readVoiceInputModelSelectionFile(configPath: string): RawVoiceInputModelSelectionFile | null {
  try {
    const text = fs.readFileSync(configPath, 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed)) {
      log.warn('voice input model selection file is not an object, using defaults', { path: configPath });
      return null;
    }
    return parsed;
  } catch (error) {
    log.warn('voice input model selection read failed, using defaults', {
      path: configPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function ensureVoiceInputModelSelectionFile(): void {
  const configPath = getVoiceInputModelSelectionConfigPath();
  if (fs.existsSync(configPath)) return;
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(defaultRuntimeConfigFile(), null, 2)}\n`, 'utf8');
    log.info('voice input model selection file created', { path: configPath });
  } catch (error) {
    log.warn('voice input model selection file create failed', {
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

function defaultRuntimeConfigFile(): RawVoiceInputModelSelectionFile {
  // Empty strings / arrays intentionally mean "use the app default / env
  // fallback". Keeping the generated file sparse avoids freezing future
  // default model changes for users who never explicitly customize voice
  // input models.
  return {
    serviceMode: '',
    asrProvider: '',
    refinerProvider: '',
    refinerModel: '',
    asrProviderChain: [],
    refinerProviderChain: [],
  };
}

function resolveVoiceInputCustomAsrConfig(
  value: unknown,
): { value?: VoiceInputCustomAsrConfig; warning?: VoiceInputModelSelectionWarning } {
  if (value === undefined || value === null) return {};
  const validated = validateVoiceInputCustomAsrConfig(value);
  if (validated.ok) return { value: validated.value };
  return {
    warning: {
      field: 'customAsr',
      value: '<invalid>',
      fallback: '<unset>',
    },
  };
}

function readConfigString(raw: RawVoiceInputModelSelectionFile | null | undefined, key: keyof RawVoiceInputModelSelectionFile): string | undefined {
  if (!raw || !(key in raw)) return undefined;
  const value = raw[key];
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

// Chain fields accept a JSON string array; an empty / missing array means
// "use the built-in default chain". Non-string entries are dropped here and
// unknown provider names are dropped (with a warning) during resolution.
function readConfigStringList(
  raw: RawVoiceInputModelSelectionFile | null | undefined,
  key: 'asrProviderChain' | 'refinerProviderChain' | 'utilityModelProviderChain',
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

function warnIgnoredLegacyAsrProviderEnv(env: NodeJS.ProcessEnv): void {
  const legacyEnvEntries: Array<[string, string | undefined]> = [
    ['XDT_VOICE_INPUT_PROVIDER', env.XDT_VOICE_INPUT_PROVIDER],
    ['VOICE_INPUT_PROVIDER', env.VOICE_INPUT_PROVIDER],
  ];
  const legacyEnvVars = legacyEnvEntries
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0)
    .map(([name]) => name);
  if (legacyEnvVars.length === 0) return;
  log.warn('legacy voice input ASR provider env ignored', {
    legacyEnvVars,
    replacementEnvVar: 'XDT_VOICE_INPUT_ASR_PROVIDER',
    runtimeConfigFile: CONFIG_FILE_NAME,
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
