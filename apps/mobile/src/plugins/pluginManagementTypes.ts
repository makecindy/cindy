/** Mobile projection of the existing Host management contract. Never contains saved settings. */
export interface ManagedPluginManifest {
  [key: string]: unknown;
  schemaVersion: 2 | 3;
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
}
export type PluginApproval =
  | { state: 'approved'; revision: string }
  | { state: 'legacy-unapproved' | 'invalid' };
export interface ManagedPlugin {
  instanceKey: string;
  namespace?: string | null;
  namespaceState?: 'confirmed' | 'unconfirmed' | 'pending';
  manifest: ManagedPluginManifest;
  enabled: boolean;
  approval: PluginApproval;
  iconDataUrl?: string;
  builtin?: boolean;
}
export interface ManagedMarketItem {
  pluginId: string;
  ghostId: string;
  namespace?: string | null;
  name: string;
  description: string | null;
  author: string | null;
  scope: 'public' | 'organization' | 'personal';
  organizationId: string | null;
  defaultInstall: boolean;
  releaseId: string;
  version: string;
  publishedAt: string;
  icon: { mimeType: string; sha256: string; sizeBytes: number; url: string; expiresAt: string } | null;
  installState: 'not-installed' | 'installed' | 'update-available' | 'conflict';
  enabled: boolean | null;
  sourceType: 'server' | 'git-market' | 'local-market';
  sourceMarketName: string | null;
  updateRequiresConsent?: true;
}
export interface ManagedMarketDetail extends ManagedMarketItem {
  /** Keep the complete Host manifest for custom-market expectedManifest checks. */
  manifest: ManagedPluginManifest;
}
export interface PluginManagementSnapshot {
  version: 1;
  ghosts: ManagedPlugin[];
  market: {
    items: ManagedMarketItem[];
    unavailableReason: string | null;
    customSourceNames: string[];
    unavailableCustomSourceNames: string[];
    organizationAccessError?: string | null;
  };
  settingsPage?: true;
}
export interface PluginPermissionItem {
  key: string;
  kind: string;
  labelKey: string;
  labelArgs?: Record<string, string>;
  detail?: string;
  detailKey?: string;
  detailArgs?: Record<string, string>;
}
export type PluginConsentFacts = {
  ghostId: string; name: string; version: string;
} & (
  | { kind: 'install'; permissions: PluginPermissionItem[] }
  | { kind: 'update'; previousVersion: string; added: PluginPermissionItem[];
      removed: PluginPermissionItem[]; unchangedCount: number; builtinOauthClientChanged: boolean }
);
export interface PluginManagementReceipt {
  operationId: string;
  phase: 'running' | 'confirmation' | 'succeeded' | 'cancelled' | 'failed';
  errorCode?: string;
  consent?: {
    requestId: string;
    initiator: 'user' | 'agent';
    origin: 'market' | 'custom-market' | 'local-file' | 'forge';
    originLabel?: string;
    purpose?: 'task-capability';
    facts: PluginConsentFacts;
  };
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = 1024): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0');
const nullableString = (v: unknown): boolean => v === null || (typeof v === 'string' && v.length <= 32768);
const oneOf = (v: unknown, values: string[]): boolean => typeof v === 'string' && values.includes(v);
const optionalString = (v: unknown): boolean => v === undefined || typeof v === 'string';

/** Bound foreign declarations before traversal; poison keys and non-JSON objects never reach consumers. */
export function isBoundedPluginResponse(value: unknown): boolean {
  let nodes = 50_000, chars = 8_000_000;
  const visit = (v: unknown, depth: number): boolean => {
    if (--nodes < 0 || depth > 24) return false;
    if (typeof v === 'string') return (chars -= v.length) >= 0;
    if (v === null || typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (!v || typeof v !== 'object') return false;
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return false;
    return Object.entries(v).every(([key, child]) => {
      chars -= key.length;
      return chars >= 0 && !['__proto__', 'constructor', 'prototype'].includes(key) && visit(child, depth + 1);
    });
  };
  return visit(value, 0);
}
function invalid(): never { throw new Error('INVALID_RESPONSE'); }
function manifest(v: unknown): v is ManagedPluginManifest {
  return record(v) && (v.schemaVersion === 2 || v.schemaVersion === 3) && str(v.id) && str(v.name) && str(v.version)
    && optionalString(v.description) && optionalString(v.author);
}
function namespace(v: Record<string, unknown>): boolean {
  return v.namespace === undefined || v.namespace === null || str(v.namespace);
}
const revision = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
function installed(v: unknown): v is ManagedPlugin {
  return record(v) && str(v.instanceKey) && namespace(v) && manifest(v.manifest) && typeof v.enabled === 'boolean'
    && (v.namespaceState === undefined || oneOf(v.namespaceState, ['confirmed', 'unconfirmed', 'pending']))
    && record(v.approval) && (v.approval.state === 'approved' ? revision(v.approval.revision) : oneOf(v.approval.state, ['legacy-unapproved', 'invalid']))
    && optionalString(v.iconDataUrl) && (v.builtin === undefined || typeof v.builtin === 'boolean');
}
function marketItem(v: unknown): v is ManagedMarketItem {
  if (!record(v) || !str(v.pluginId) || !str(v.ghostId) || !str(v.releaseId) || !str(v.name) || !str(v.version)
    || !namespace(v) || !nullableString(v.description) || !nullableString(v.author) || !nullableString(v.organizationId)
    || !oneOf(v.scope, ['public', 'organization', 'personal']) || typeof v.defaultInstall !== 'boolean'
    || typeof v.publishedAt !== 'string' || !oneOf(v.installState, ['not-installed', 'installed', 'update-available', 'conflict'])
    || (v.enabled !== null && typeof v.enabled !== 'boolean') || !oneOf(v.sourceType, ['server', 'git-market', 'local-market'])
    || !nullableString(v.sourceMarketName) || (v.updateRequiresConsent !== undefined && v.updateRequiresConsent !== true)) return false;
  const icon = v.icon;
  return icon === null || (record(icon) && str(icon.mimeType) && str(icon.sha256) && Number.isSafeInteger(icon.sizeBytes)
    && (icon.sizeBytes as number) > 0 && str(icon.url, 32768) && str(icon.expiresAt));
}
function strings(v: unknown): v is string[] { return Array.isArray(v) && v.every((item) => str(item)); }
function safeMarketItem<T extends ManagedMarketItem>(v: T): T {
  // This target-local icon lookup key must never resolve against the controller's filesystem.
  const safe = { ...v } as T & { customIconKey?: unknown };
  delete safe.customIconKey;
  return safe;
}
export function parsePluginManagementSnapshot(value: unknown): PluginManagementSnapshot {
  if (!isBoundedPluginResponse(value) || !record(value) || value.version !== 1 || !Array.isArray(value.ghosts)
    || !value.ghosts.every(installed) || !record(value.market) || !Array.isArray(value.market.items)
    || !value.market.items.every(marketItem) || !nullableString(value.market.unavailableReason)
    || !strings(value.market.customSourceNames) || !strings(value.market.unavailableCustomSourceNames)
    || (value.market.organizationAccessError !== undefined && !nullableString(value.market.organizationAccessError))
    || (value.settingsPage !== undefined && value.settingsPage !== true)
    || new Set(value.ghosts.map((g) => g.instanceKey)).size !== value.ghosts.length) return invalid();
  const data = value as unknown as PluginManagementSnapshot;
  return { version: 1, ghosts: data.ghosts.map((g) => ({ ...g })), market: { ...data.market, items: data.market.items.map(safeMarketItem) },
    ...(data.settingsPage ? { settingsPage: true } : {}) };
}
export function parsePluginManagementDetail(value: unknown): ManagedMarketDetail {
  if (!isBoundedPluginResponse(value) || !marketItem(value) || !manifest((value as ManagedMarketDetail).manifest)) return invalid();
  const detail = value as ManagedMarketDetail;
  if (detail.manifest.id !== detail.ghostId || detail.manifest.version !== detail.version) return invalid();
  return safeMarketItem(detail);
}
function permission(v: unknown): boolean {
  if (!record(v) || !str(v.key) || !str(v.kind) || !str(v.labelKey) || !optionalString(v.detail) || !optionalString(v.detailKey)) return false;
  return [v.labelArgs, v.detailArgs].every((args) => args === undefined || (record(args) && Object.values(args).every((value) => typeof value === 'string')));
}
export function parsePluginManagementReceipt(value: unknown, operationId: string): PluginManagementReceipt {
  if (!isBoundedPluginResponse(value) || !record(value) || value.operationId !== operationId
    || !oneOf(value.phase, ['running', 'confirmation', 'succeeded', 'cancelled', 'failed']) || !optionalString(value.errorCode)) return invalid();
  if (value.consent !== undefined) {
    const c = value.consent;
    if (!record(c) || !str(c.requestId) || !oneOf(c.initiator, ['user', 'agent']) || !oneOf(c.origin, ['market', 'custom-market', 'local-file', 'forge'])
      || !optionalString(c.originLabel) || (c.purpose !== undefined && c.purpose !== 'task-capability') || !record(c.facts)) return invalid();
    const f = c.facts;
    const permissions = (v: unknown) => Array.isArray(v) && v.every(permission);
    if (!str(f.ghostId) || !str(f.name) || !str(f.version) || (f.kind === 'install' ? !permissions(f.permissions)
      : f.kind !== 'update' || !str(f.previousVersion) || !permissions(f.added) || !permissions(f.removed)
      || !Number.isSafeInteger(f.unchangedCount) || (f.unchangedCount as number) < 0 || typeof f.builtinOauthClientChanged !== 'boolean')) return invalid();
  }
  if (value.phase === 'confirmation' && !value.consent) return invalid();
  return value as unknown as PluginManagementReceipt;
}
export function pluginApprovalToken(plugin: ManagedPlugin): string {
  return plugin.approval.state === 'approved' ? `approved:${plugin.approval.revision}` : plugin.approval.state;
}
/** Never infer a namespace from a name/prefix. Legacy wire falls back only to the exact physical key. */
export function marketItemMatchesPlugin(item: ManagedMarketItem, plugin: ManagedPlugin): boolean {
  return item.ghostId === plugin.manifest.id && (item.namespace !== undefined && plugin.namespace !== undefined
    ? item.namespace === plugin.namespace : plugin.instanceKey === item.ghostId);
}
