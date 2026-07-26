import fs from 'node:fs/promises';
import path from 'node:path';
import type { CustomProviderConfig } from '@cindy/model-providers';
import type { HeadlessAgentKind, HeadlessEffort, HeadlessPermissionMode } from './session-types.js';

export interface HeadlessDefaults {
  agentKind: HeadlessAgentKind;
  providerId: string | null;
  model: string | null;
  effort: HeadlessEffort;
  permissionMode: HeadlessPermissionMode;
}

export interface HeadlessConfig {
  version: 1;
  remoteControlEnabled: boolean;
  /**
   * User-owned deviations from PRODUCT_HEADLESS_DEFAULTS.  Keeping this
   * sparse is important: a new product default must apply to people who have
   * not made an explicit choice.
   */
  defaults: Partial<HeadlessDefaults>;
  /** Per-workdir deviations, keyed by an absolute normalized workdir path. */
  projectDefaults?: Record<string, Partial<HeadlessDefaults>>;
  limits: { maxConcurrentTurns: number; maxConcurrentSchedulerRuns: number };
  /** Non-secret provider metadata. API keys and OAuth tokens never enter this file. */
  providerProfiles?: HeadlessProviderProfile[];
  /** Absolute project roots that a remote controller may use for new sessions. */
  workdirRoots?: string[];
  /** Optional manually imported Device Link token; token material stays in Secret Service. */
  deviceLink?: HeadlessDeviceLinkConfig;
  /** Friendly Device Link name for this Linux host; defaults to the system hostname. */
  deviceName?: string;
  /** Non-secret account routing state. Cindy login credentials stay only in daemon memory. */
  account?: HeadlessAccountConfig;
  /** Runtime-discovered Cindy AI gateway models; no credential material is stored here. */
  managedModels?: HeadlessManagedModel[];
  /** Per agent/provider/model controls restored when that model is selected again. */
  modelPreferences?: Record<string, HeadlessModelPreference>;
}

export interface HeadlessAccountConfig {
  deviceId: string;
  region: 'cn' | 'global';
}

export interface HeadlessManagedModel {
  id: string;
  name?: string;
  agents?: HeadlessAgentKind[];
  description?: string;
  contextWindow?: number;
  efforts?: HeadlessEffort[];
  defaultEffort?: HeadlessEffort;
  supportsFastMode?: boolean;
}

export interface HeadlessModelPreference {
  effort?: HeadlessEffort;
  fastMode?: boolean;
}

export interface HeadlessDeviceLinkConfig {
  deviceId: string;
  tokenRef: string;
  apiBaseUrl: string;
  deviceName?: string;
}

/** A provider's durable non-secret configuration and secure-store reference. */
export interface HeadlessProviderProfile {
  id: string;
  enabled: boolean;
  /** Key name in Secret Service; never the credential itself. */
  secretRef?: string;
  /** Generic OAuth device-code metadata for providers that advertise it. */
  deviceCode?: HeadlessDeviceCodeConfig;
  /** Present only for a user-defined provider. */
  custom?: CustomProviderConfig;
}

export interface HeadlessDeviceCodeConfig {
  deviceAuthorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes?: string;
}

export const DEFAULT_HEADLESS_CONFIG: HeadlessConfig = {
  version: 1,
  remoteControlEnabled: false,
  defaults: {},
  limits: { maxConcurrentTurns: 4, maxConcurrentSchedulerRuns: 2 },
  providerProfiles: [],
  workdirRoots: [],
};

/** Product-owned choices.  Config files store only the user/project deltas. */
export const PRODUCT_HEADLESS_DEFAULTS: HeadlessDefaults = {
  agentKind: 'codex', providerId: null, model: null, effort: 'high', permissionMode: 'ask',
};

export function resolveHeadlessDefaults(
  config: HeadlessConfig,
  workDir?: string,
): HeadlessDefaults {
  const project = workDir ? config.projectDefaults?.[workDir] : undefined;
  return { ...PRODUCT_HEADLESS_DEFAULTS, ...config.defaults, ...project };
}

function validateConfig(value: unknown): HeadlessConfig | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Partial<HeadlessConfig>;
  if (c.version !== 1 || !c.defaults || !c.limits) return null;
  if (!validDefaultsOverride(c.defaults)) return null;
  if (typeof c.remoteControlEnabled !== 'boolean') return null;
  if (!Number.isInteger(c.limits.maxConcurrentTurns) || c.limits.maxConcurrentTurns < 1) return null;
  if (!Number.isInteger(c.limits.maxConcurrentSchedulerRuns) || c.limits.maxConcurrentSchedulerRuns < 1) return null;
  if (c.providerProfiles !== undefined && !validProviderProfiles(c.providerProfiles)) return null;
  if (c.projectDefaults !== undefined && !validProjectDefaults(c.projectDefaults)) return null;
  if (c.workdirRoots !== undefined && (!Array.isArray(c.workdirRoots)
    || c.workdirRoots.some((root) => typeof root !== 'string' || !root.startsWith('/')))) return null;
  if (c.deviceLink !== undefined && !validDeviceLinkConfig(c.deviceLink)) return null;
  if (c.deviceName !== undefined && !validDeviceName(c.deviceName)) return null;
  if (c.account !== undefined && !validAccountConfig(c.account)) return null;
  if (c.managedModels !== undefined && !validManagedModels(c.managedModels)) return null;
  if (c.modelPreferences !== undefined && !validModelPreferences(c.modelPreferences)) return null;
  return c as HeadlessConfig;
}

function validAccountConfig(value: unknown): value is HeadlessAccountConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const account = value as Partial<HeadlessAccountConfig>;
  return typeof account.deviceId === 'string' && account.deviceId.trim().length > 0
    && (account.region === 'cn' || account.region === 'global');
}

function validManagedModels(value: unknown): value is HeadlessManagedModel[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  return value.every((model) => {
    if (!model || typeof model !== 'object') return false;
    const m = model as Partial<HeadlessManagedModel>;
    if (typeof m.id !== 'string' || !m.id.trim() || ids.has(m.id)) return false;
    ids.add(m.id);
    if (m.name !== undefined && typeof m.name !== 'string') return false;
    if (m.agents !== undefined && (!Array.isArray(m.agents) || m.agents.some((agent) => agent !== 'codex' && agent !== 'claude-code'))) return false;
    if (m.description !== undefined && typeof m.description !== 'string') return false;
    if (m.contextWindow !== undefined && (!Number.isInteger(m.contextWindow) || m.contextWindow < 1)) return false;
    if (m.efforts !== undefined && (!Array.isArray(m.efforts) || m.efforts.some((effort) => !isEffort(effort)))) return false;
    return (m.defaultEffort === undefined || isEffort(m.defaultEffort))
      && (m.supportsFastMode === undefined || typeof m.supportsFastMode === 'boolean');
  });
}

function validModelPreferences(value: unknown): value is Record<string, HeadlessModelPreference> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, preference]) => {
    if (!key || !preference || typeof preference !== 'object' || Array.isArray(preference)) return false;
    const p = preference as HeadlessModelPreference;
    return (p.effort === undefined || isEffort(p.effort))
      && (p.fastMode === undefined || typeof p.fastMode === 'boolean');
  });
}

function validDefaultsOverride(value: unknown): value is Partial<HeadlessDefaults> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const defaults = value as Partial<HeadlessDefaults>;
  return (defaults.agentKind === undefined || defaults.agentKind === 'claude-code' || defaults.agentKind === 'codex')
    && (defaults.providerId === undefined || typeof defaults.providerId === 'string' || defaults.providerId === null)
    && (defaults.model === undefined || typeof defaults.model === 'string' || defaults.model === null)
    && (defaults.effort === undefined || isEffort(defaults.effort))
    && (defaults.permissionMode === undefined || isPermissionMode(defaults.permissionMode));
}

function validProjectDefaults(value: unknown): value is Record<string, Partial<HeadlessDefaults>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([workDir, defaults]) => workDir.startsWith('/') && validDefaultsOverride(defaults));
}

function validDeviceLinkConfig(value: unknown): value is HeadlessDeviceLinkConfig {
  if (!value || typeof value !== 'object') return false;
  const config = value as Partial<HeadlessDeviceLinkConfig>;
  return typeof config.deviceId === 'string' && config.deviceId.trim().length > 0
    && typeof config.tokenRef === 'string' && isSlug(config.tokenRef)
    && isHttpUrl(config.apiBaseUrl)
    && (config.deviceName === undefined || (typeof config.deviceName === 'string' && config.deviceName.trim().length > 0));
}

function validDeviceName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 64;
}

function isEffort(value: unknown): value is HeadlessEffort {
  return typeof value === 'string' && ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value);
}

function isPermissionMode(value: unknown): value is HeadlessPermissionMode {
  return typeof value === 'string' && ['ask', 'default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'].includes(value);
}

function validProviderProfiles(value: unknown): value is HeadlessProviderProfile[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  return value.every((profile) => {
    if (!profile || typeof profile !== 'object') return false;
    const p = profile as Partial<HeadlessProviderProfile>;
    if (typeof p.id !== 'string' || !isSlug(p.id) || ids.has(p.id)) return false;
    ids.add(p.id);
    if (typeof p.enabled !== 'boolean') return false;
    if (p.secretRef !== undefined && (typeof p.secretRef !== 'string' || !isSlug(p.secretRef))) return false;
    if (p.deviceCode !== undefined && !validDeviceCodeConfig(p.deviceCode)) return false;
    return p.custom === undefined || validCustomProvider(p.custom, p.id);
  });
}

function validDeviceCodeConfig(value: unknown): value is HeadlessDeviceCodeConfig {
  if (!value || typeof value !== 'object') return false;
  const config = value as Partial<HeadlessDeviceCodeConfig>;
  return isHttpUrl(config.deviceAuthorizationUrl)
    && isHttpUrl(config.tokenUrl)
    && typeof config.clientId === 'string'
    && config.clientId.trim().length > 0
    && (config.scopes === undefined || typeof config.scopes === 'string');
}

function validCustomProvider(value: unknown, expectedId: string): value is CustomProviderConfig {
  if (!value || typeof value !== 'object') return false;
  const provider = value as Partial<CustomProviderConfig>;
  if (provider.id !== expectedId || typeof provider.name !== 'string' || !provider.name.trim()) return false;
  if (!provider.runtimes || typeof provider.runtimes !== 'object') return false;
  const entries = Object.entries(provider.runtimes);
  if (entries.length === 0) return false;
  return entries.every(([agent, runtime]) => {
    if (agent !== 'claude-code' && agent !== 'codex') return false;
    if (!runtime || typeof runtime !== 'object') return false;
    const r = runtime as { baseUrl?: unknown; models?: unknown; headers?: unknown };
    if (!isHttpUrl(r.baseUrl) || !Array.isArray(r.models) || r.models.length === 0) return false;
    if (r.headers !== undefined && (!r.headers || typeof r.headers !== 'object' || Array.isArray(r.headers)
      || Object.values(r.headers as Record<string, unknown>).some((header) => typeof header !== 'string'))) return false;
    return r.models.every((model) => model && typeof model === 'object'
      && typeof (model as { id?: unknown }).id === 'string'
      && typeof (model as { name?: unknown }).name === 'string');
  });
}

function isSlug(value: string): boolean {
  return /^[a-z0-9_-]+$/.test(value);
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Stores only non-secret host configuration; provider credentials stay in the host credential store. */
export class HeadlessConfigStore {
  constructor(private readonly configFile: string) {}

  async read(): Promise<HeadlessConfig> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.configFile, 'utf8'));
        return validateConfig(parsed) ?? defaultConfig();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return defaultConfig();
      }
      throw error;
    }
  }

  async write(config: HeadlessConfig): Promise<void> {
    if (!validateConfig(config)) throw new Error('Invalid headless configuration');
    await fs.mkdir(path.dirname(this.configFile), { recursive: true, mode: 0o700 });
    const temp = `${this.configFile}.${process.pid}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(temp, 0o600);
    await fs.rename(temp, this.configFile);
    await fs.chmod(this.configFile, 0o600);
  }
}

function defaultConfig(): HeadlessConfig {
  return {
    ...DEFAULT_HEADLESS_CONFIG,
    defaults: { ...DEFAULT_HEADLESS_CONFIG.defaults },
    limits: { ...DEFAULT_HEADLESS_CONFIG.limits },
    providerProfiles: [],
    projectDefaults: {},
    workdirRoots: [],
  };
}
