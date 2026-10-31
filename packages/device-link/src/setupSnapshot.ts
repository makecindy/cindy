/**
 * New-computer setup (docs/product-rules/new-device-setup-migration.md): a computer that the
 * user is setting up reads a **non-secret** configuration snapshot from another computer on
 * the same account, then rebuilds that configuration through its own installers and stores.
 *
 * The channel is read-only (`caps` / `snapshot`). It never carries API keys, OAuth tokens,
 * IM bot credentials, plugin vault entries, Claude/Codex logins or OS permission grants;
 * those stay on their computer and become a one-time checklist on the new computer.
 * Absolute paths, hardware-derived values and machine-generated keys are not exported either.
 *
 * Older Desktops do not list the channel → CHANNEL_NOT_ALLOWED, and the new computer asks
 * the user to update that computer. The target re-validates everything it applies; this
 * parser only bounds shape and size so a malformed or oversized reply cannot be applied.
 */
export const SETUP_SNAPSHOT_CHANNEL = 'maker:setup-snapshot';
export const SETUP_SNAPSHOT_VERSION = 1;
/** Reading plugins, skills and a renderer reply on the source can take several seconds. */
export const SETUP_SNAPSHOT_TIMEOUT_MS = 60_000;
/** Serialized snapshot budget, kept well below the 2 MiB relay frame. */
export const SETUP_SNAPSHOT_MAX_BYTES = 1_500_000;

export const SETUP_SNAPSHOT_LIMITS = {
  settingsGroups: 64,
  settingsGroupBytes: 64 * 1024,
  rendererPrefs: 128,
  rendererPrefBytes: 64 * 1024,
  plugins: 300,
  pluginSources: 32,
  skills: 500,
  mcpServers: 100,
  providers: 64,
  providerBytes: 128 * 1024,
  builtinTools: 64,
  hints: 64,
  sshHosts: 200,
} as const;

export type SetupSnapshotRequest = { action: 'caps' } | { action: 'snapshot' };

export interface SetupSnapshotCaps {
  setupSnapshot: number;
}

/** One settings store: only the values the user changed on the source computer. */
export interface SetupSnapshotSettingsGroup {
  id: string;
  values: Record<string, unknown>;
}

export type SetupSnapshotPluginSource =
  | 'market'
  | 'custom-market'
  | 'default-install'
  | 'manual'
  | 'builtin';

export interface SetupSnapshotPlugin {
  ghostId: string;
  name: string;
  version: string;
  /** null = root namespace; a string is the organization slug. */
  namespace: string | null;
  /**
   * Marketplace id (`custom:<market>/<ghostId>` for custom markets). Required for market and
   * custom-market installs, optional for server default installs, null for manual/built-in.
   */
  pluginId: string | null;
  source: SetupSnapshotPluginSource;
  marketName: string | null;
  enabled: boolean;
  /** Whether its accounts/keys were set up on the source; null when unknown. */
  setupReady: boolean | null;
}

/** Custom Git marketplaces. Local-folder markets are machine paths and are not exported. */
export interface SetupSnapshotMarketSource {
  name: string;
  url: string;
  ref: string | null;
  sparsePaths: string[];
}

export type SetupSnapshotSkillOrigin = 'installed' | 'published' | 'learned' | 'imported';

export interface SetupSnapshotSkill {
  name: string;
  version: string | null;
  catalogScope: 'market' | 'team' | null;
  origin: SetupSnapshotSkillOrigin | null;
  enabled: boolean;
}

export interface SetupSnapshotMcpServer {
  id: string;
  name: string;
  transport: 'http' | 'sse';
  url: string;
  /**
   * Request headers can carry credentials, so sources leave this empty; kept for the shape the
   * target applies.
   */
  headers: Record<string, string>;
  /** Credentials (token, request headers, URL user or query) must be entered again on the target. */
  hasToken: boolean;
}

export type SetupSnapshotProviderAuth = 'apiKey' | 'oauth' | 'native' | 'none';

export interface SetupSnapshotProvider {
  id: string;
  name: string;
  /** Non-secret custom provider configuration; the target validates it with its own rules. */
  config: Record<string, unknown>;
  auth: SetupSnapshotProviderAuth;
  /** The source removed credential-bearing URL parts (user, query, fragment); re-enter them. */
  urlSecretsRemoved?: true;
}

export interface SetupSnapshotBuiltinTool {
  id: string;
  enabled: boolean;
}

export interface SetupSnapshotAccess {
  remoteControlEnabled: boolean;
  remoteDesktopEnabled: boolean;
  keepAwake: boolean;
}

/**
 * One SSH server the source computer shows in Cindy. Only how to reach it: no key paths, no
 * proxy commands. `hostKey` is the fingerprint that computer already trusts, so the new one can
 * check the server on its first connection instead of trusting whatever answers.
 */
export interface SetupSnapshotSshHost {
  id: string;
  displayName: string;
  hostname: string;
  port: number;
  user: string;
  hostKey: string | null;
}

/** Presence-only facts used to build the one-time checklist. Never key material. */
export interface SetupSnapshotHints {
  /** Built-in provider secret ids configured on the source (e.g. `brave`, `tavily`). */
  builtinKeys: string[];
  /** Personal IM channels connected on the source (e.g. `telegram`, `feishu`). */
  imChannels: string[];
  /** Hosts in the source's SSH configuration that Cindy shows. */
  sshHostCount: number;
}

export type SetupSnapshotSection =
  | 'settings'
  | 'rendererPrefs'
  | 'plugins'
  | 'skills'
  | 'mcpServers'
  | 'providers'
  | 'builtinTools'
  | 'access'
  | 'hints'
  | 'sshHosts';

export interface SetupSnapshot {
  version: typeof SETUP_SNAPSHOT_VERSION;
  createdAt: number;
  /** `process.platform` of the source computer. */
  platform: string;
  settings: SetupSnapshotSettingsGroup[];
  /** Whitelisted interface preferences; null when the source window could not answer. */
  rendererPrefs: Record<string, string> | null;
  plugins: SetupSnapshotPlugin[];
  marketSources: SetupSnapshotMarketSource[];
  skills: SetupSnapshotSkill[];
  mcpServers: SetupSnapshotMcpServer[];
  providers: SetupSnapshotProvider[];
  builtinTools: SetupSnapshotBuiltinTool[];
  access: SetupSnapshotAccess;
  hints: SetupSnapshotHints;
  /** Servers for the SSH step; empty from sources that predate it. */
  sshHosts: SetupSnapshotSshHost[];
  /** `setupTransfer` version the source answers (keys and SSH, see setupTransfer.ts); 0 = none. */
  transfer: number;
  /** Sections the source could not read this time. */
  unavailable: SetupSnapshotSection[];
}

// Custom market plugin ids are URI-encoded (`custom:<market>/<ghostId>`).
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@%+~-]{0,255}$/;
const SECTIONS: readonly SetupSnapshotSection[] = [
  'settings',
  'rendererPrefs',
  'plugins',
  'skills',
  'mcpServers',
  'providers',
  'builtinTools',
  'access',
  'hints',
  'sshHosts',
];

export function parseSetupSnapshotRequest(value: unknown): SetupSnapshotRequest {
  const action = isRecord(value) ? value.action : undefined;
  if (action === 'caps' || action === 'snapshot') return { action };
  throw new Error('SETUP_SNAPSHOT_INVALID');
}

/** Declared protocol version, or 0 when the reply is not a caps record. */
export function setupSnapshotCapsVersion(value: unknown): number {
  if (!isRecord(value)) return 0;
  const version = value.setupSnapshot;
  return typeof version === 'number' && Number.isInteger(version) && version > 0 ? version : 0;
}

export function serializedSetupSnapshotBytes(snapshot: SetupSnapshot): number {
  return new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
}

/**
 * Bounds a snapshot reply. Malformed entries are dropped rather than failing the whole
 * snapshot, so a newer source with extra fields still yields everything this version knows.
 */
export function parseSetupSnapshot(value: unknown): SetupSnapshot {
  if (!isRecord(value) || value.version !== SETUP_SNAPSHOT_VERSION) {
    throw new Error('SETUP_SNAPSHOT_INVALID');
  }
  const accessRaw = isRecord(value.access) ? value.access : {};
  const hintsRaw = isRecord(value.hints) ? value.hints : {};
  return {
    version: SETUP_SNAPSHOT_VERSION,
    createdAt: finiteNumber(value.createdAt) ?? 0,
    platform: boundedString(value.platform, 32) ?? '',
    settings: list(value.settings, SETUP_SNAPSHOT_LIMITS.settingsGroups, parseSettingsGroup),
    rendererPrefs: parseRendererPrefs(value.rendererPrefs),
    plugins: list(value.plugins, SETUP_SNAPSHOT_LIMITS.plugins, parsePlugin),
    marketSources: list(value.marketSources, SETUP_SNAPSHOT_LIMITS.pluginSources, parseMarketSource),
    skills: list(value.skills, SETUP_SNAPSHOT_LIMITS.skills, parseSkill),
    mcpServers: list(value.mcpServers, SETUP_SNAPSHOT_LIMITS.mcpServers, parseMcpServer),
    providers: list(value.providers, SETUP_SNAPSHOT_LIMITS.providers, parseProvider),
    builtinTools: list(value.builtinTools, SETUP_SNAPSHOT_LIMITS.builtinTools, parseBuiltinTool),
    access: {
      remoteControlEnabled: accessRaw.remoteControlEnabled === true,
      remoteDesktopEnabled: accessRaw.remoteDesktopEnabled === true,
      keepAwake: accessRaw.keepAwake === true,
    },
    hints: {
      builtinKeys: stringList(hintsRaw.builtinKeys, SETUP_SNAPSHOT_LIMITS.hints, 64),
      imChannels: stringList(hintsRaw.imChannels, SETUP_SNAPSHOT_LIMITS.hints, 64),
      sshHostCount: Math.max(0, Math.min(10_000, Math.floor(finiteNumber(hintsRaw.sshHostCount) ?? 0))),
    },
    sshHosts: list(value.sshHosts, SETUP_SNAPSHOT_LIMITS.sshHosts, parseSshHost),
    transfer:
      typeof value.transfer === 'number' && Number.isInteger(value.transfer) && value.transfer > 0
        ? Math.min(value.transfer, 1_000)
        : 0,
    unavailable: Array.isArray(value.unavailable)
      ? [...new Set(value.unavailable.filter((s): s is SetupSnapshotSection =>
          SECTIONS.includes(s as SetupSnapshotSection)))]
      : [],
  };
}

function parseSettingsGroup(value: unknown): SetupSnapshotSettingsGroup | null {
  if (!isRecord(value) || !isId(value.id) || !isRecord(value.values)) return null;
  if (!isJsonValue(value.values, 0) || jsonBytes(value.values) > SETUP_SNAPSHOT_LIMITS.settingsGroupBytes) {
    return null;
  }
  return { id: value.id, values: value.values };
}

function parseRendererPrefs(value: unknown): Record<string, string> | null {
  if (value === null || !isRecord(value)) return null;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (count >= SETUP_SNAPSHOT_LIMITS.rendererPrefs) break;
    if (!isId(key) || typeof raw !== 'string') continue;
    if (new TextEncoder().encode(raw).byteLength > SETUP_SNAPSHOT_LIMITS.rendererPrefBytes) continue;
    out[key] = raw;
    count += 1;
  }
  return out;
}

function parsePlugin(value: unknown): SetupSnapshotPlugin | null {
  if (!isRecord(value) || !isId(value.ghostId)) return null;
  const source = value.source;
  if (
    source !== 'market' &&
    source !== 'custom-market' &&
    source !== 'default-install' &&
    source !== 'manual' &&
    source !== 'builtin'
  ) {
    return null;
  }
  const pluginId = value.pluginId === null ? null : isId(value.pluginId) ? value.pluginId : undefined;
  if (pluginId === undefined) return null;
  // Market installs must carry their market id; manual and built-in installs never claim one.
  if ((source === 'market' || source === 'custom-market') && pluginId === null) return null;
  if ((source === 'manual' || source === 'builtin') && pluginId !== null) return null;
  const namespace = value.namespace === null ? null : isId(value.namespace) ? value.namespace : undefined;
  if (namespace === undefined) return null;
  return {
    ghostId: value.ghostId,
    name: boundedString(value.name, 200) ?? value.ghostId,
    version: boundedString(value.version, 64) ?? '',
    namespace,
    pluginId,
    source,
    marketName: boundedString(value.marketName, 200) ?? null,
    enabled: value.enabled !== false,
    setupReady: typeof value.setupReady === 'boolean' ? value.setupReady : null,
  };
}

function parseMarketSource(value: unknown): SetupSnapshotMarketSource | null {
  if (!isRecord(value)) return null;
  const name = boundedString(value.name, 200);
  const url = boundedString(value.url, 2048);
  if (!name || !url || !isPortableGitUrl(url)) return null;
  return {
    name,
    url,
    ref: boundedString(value.ref, 256) ?? null,
    sparsePaths: stringList(value.sparsePaths, 64, 512),
  };
}

function parseSkill(value: unknown): SetupSnapshotSkill | null {
  if (!isRecord(value) || !isId(value.name)) return null;
  const origin = value.origin;
  return {
    name: value.name,
    version: boundedString(value.version, 128) ?? null,
    catalogScope: value.catalogScope === 'market' || value.catalogScope === 'team' ? value.catalogScope : null,
    origin:
      origin === 'installed' || origin === 'published' || origin === 'learned' || origin === 'imported'
        ? origin
        : null,
    enabled: value.enabled !== false,
  };
}

function parseMcpServer(value: unknown): SetupSnapshotMcpServer | null {
  if (!isRecord(value) || !isId(value.id)) return null;
  const transport = value.transport;
  const url = boundedString(value.url, 2048);
  if ((transport !== 'http' && transport !== 'sse') || !url || !/^https?:\/\//i.test(url)) return null;
  const headers: Record<string, string> = {};
  if (isRecord(value.headers)) {
    for (const [key, raw] of Object.entries(value.headers).slice(0, 64)) {
      if (typeof raw === 'string' && key.length > 0 && key.length <= 256 && raw.length <= 4096) {
        headers[key] = raw;
      }
    }
  }
  return {
    id: value.id,
    name: boundedString(value.name, 200) ?? value.id,
    transport,
    url,
    headers,
    hasToken: value.hasToken === true,
  };
}

function parseProvider(value: unknown): SetupSnapshotProvider | null {
  if (!isRecord(value) || !isId(value.id) || !isRecord(value.config)) return null;
  if (!isJsonValue(value.config, 0) || jsonBytes(value.config) > SETUP_SNAPSHOT_LIMITS.providerBytes) return null;
  if (value.config.id !== value.id) return null;
  const auth = value.auth;
  if (auth !== 'apiKey' && auth !== 'oauth' && auth !== 'native' && auth !== 'none') return null;
  return {
    id: value.id,
    name: boundedString(value.name, 200) ?? value.id,
    config: value.config,
    auth,
    ...(value.urlSecretsRemoved === true ? { urlSecretsRemoved: true as const } : {}),
  };
}

const SSH_ALIAS_RE = /^[A-Za-z0-9._@:+-]{1,255}$/;
const SSH_HOSTNAME_RE = /^[A-Za-z0-9._:%[\]-]{1,255}$/;
const SSH_USER_RE = /^[A-Za-z0-9._@+-]{1,128}$/;

function parseSshHost(value: unknown): SetupSnapshotSshHost | null {
  if (!isRecord(value)) return null;
  const { id, hostname, user, port } = value;
  if (typeof id !== 'string' || !SSH_ALIAS_RE.test(id)) return null;
  if (typeof hostname !== 'string' || !SSH_HOSTNAME_RE.test(hostname)) return null;
  if (typeof user !== 'string' || !SSH_USER_RE.test(user)) return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const hostKey =
    typeof value.hostKey === 'string' && /^SHA256:[A-Za-z0-9+/]{43}$/.test(value.hostKey) ? value.hostKey : null;
  return { id, displayName: boundedString(value.displayName, 200) ?? id, hostname, port, user, hostKey };
}

function parseBuiltinTool(value: unknown): SetupSnapshotBuiltinTool | null {
  if (!isRecord(value) || !isId(value.id) || typeof value.enabled !== 'boolean') return null;
  return { id: value.id, enabled: value.enabled };
}

/** Git sources only: plain https / ssh remotes without embedded credentials. */
export function isPortableGitUrl(url: string): boolean {
  if (/^git@[A-Za-z0-9.-]+:[^\s]+$/.test(url)) return true;
  try {
    const parsed = new URL(url);
    if (parsed.password !== '') return false;
    // An https user part is usually a token (`https://<token>@host/...`); ssh users are account names.
    if (parsed.protocol === 'https:') return parsed.username === '';
    return parsed.protocol === 'ssh:';
  } catch {
    return false;
  }
}

function list<T>(value: unknown, max: number, parse: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const item of value) {
    if (out.length >= max) break;
    const parsed = parse(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

function stringList(value: unknown, max: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= maxLength),
    ),
  ].slice(0, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** Plain JSON data only (no prototypes, functions, NaN) and bounded nesting. */
function isJsonValue(value: unknown, depth: number): boolean {
  if (depth > 16) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (isRecord(value)) {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    return Object.entries(value).every(
      ([key, item]) => key !== '__proto__' && isJsonValue(item, depth + 1),
    );
  }
  return false;
}
