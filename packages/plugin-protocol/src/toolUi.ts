import { isSafeGhostRelativePath } from './internal/ghostPath.js';
import { validateCspDomains } from './appCsp.js';
/** First release with plugin pages; authoring floor, never a client install gate. */
export const PLUGIN_UI_MIN_CINDY_VERSION = '0.1.122-beta';
export interface GhostUiResource {
  uri: string;
  file: string;
  csp?: { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[]; baseUriDomains?: string[] };
  prefersBorder?: boolean;
  domain?: string;
  permissions?: { camera?: Record<string, never>; microphone?: Record<string, never>; geolocation?: Record<string, never>; clipboardWrite?: Record<string, never> };
}
export interface GhostUiTool { resourceUri?: string; visibility?: ('model' | 'app')[]; [key: string]: unknown }
export interface GhostUiNeeds { resources: GhostUiResource[]; tools: Record<string, GhostUiTool> }
export interface GhostMcpApps { ui?: GhostUiNeeds; [key: string]: unknown }
type UiManifest = { schemaVersion?: unknown; mcpApps?: unknown; tools?: unknown; network?: unknown };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const safeKey = (key: string) => /^[a-z][a-z0-9_-]{0,63}$/.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key);
const cspKeys = ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'] as const;
/** Cindy manifest envelope; unknown extensions remain data, never grant authority. */
export function parseGhostMcpApps(raw: unknown, tools: readonly { name: string }[], hosts: readonly string[], safePath: (value: unknown) => boolean): GhostMcpApps | null {
  if (!object(raw)) return null;
  if (raw.ui !== undefined && !parseGhostUi(raw.ui, tools, hosts, safePath)) return null;
  return raw as GhostMcpApps;
}
export function parseGhostUi(raw: unknown, tools: readonly { name: string }[], hosts: readonly string[], safePath: (value: unknown) => boolean): GhostUiNeeds | null {
  if (!object(raw) || !Array.isArray(raw.resources) || !object(raw.tools) || !Object.keys(raw.tools).length ||
      raw.resources.length > 16 || Object.keys(raw.tools).length > 16) return null;
  const uris = new Set<string>();
  for (const resource of raw.resources) {
    if (!object(resource) || typeof resource.uri !== 'string' || !resource.uri.startsWith('ui://') ||
        resource.uri.length <= 5 || /[\s\x00-\x1f\x7f]/.test(resource.uri) || uris.has(resource.uri) ||
        !safePath(resource.file) || typeof resource.file !== 'string' || !/\.html?$/i.test(resource.file) ||
        (resource.prefersBorder !== undefined && typeof resource.prefersBorder !== 'boolean') ||
        (resource.domain !== undefined && typeof resource.domain !== 'string')) return null;
    uris.add(resource.uri);
    if (resource.permissions !== undefined && (!object(resource.permissions) ||
        Object.entries(resource.permissions).some(([key, value]) =>
          !['camera', 'microphone', 'geolocation', 'clipboardWrite'].includes(key) || !object(value) || Object.keys(value).length))) return null;
    if (resource.csp !== undefined) {
      if (!object(resource.csp)) return null;
      for (const key of cspKeys) {
        const domains = resource.csp[key];
        if (domains !== undefined && (!Array.isArray(domains) || domains.some(value => typeof value !== 'string'))) return null;
        try {
          const origins = validateCspDomains(resource.csp[key] as string[] | undefined);
          for (const origin of origins) {
            const hostname = new URL(origin.replace(/:\*(\/?)$/, ':443$1')).hostname.toLowerCase();
            if (!hosts.some(pattern => hostname === pattern || (pattern.startsWith('*.') && hostname.endsWith(pattern.slice(1)) && hostname.length > pattern.length - 1))) return null;
          }
        } catch { return null; }
      }
    }
  }
  const names = new Set(tools.map(tool => tool.name));
  for (const [name, link] of Object.entries(raw.tools)) {
    if (!safeKey(name) || !names.has(name) || !object(link) ||
        (link.resourceUri !== undefined && (typeof link.resourceUri !== 'string' || !uris.has(link.resourceUri))) ||
        (link.visibility !== undefined && (!Array.isArray(link.visibility) || !link.visibility.length || link.visibility.some(v => v !== 'model' && v !== 'app')))) return null;
  }
  return raw as unknown as GhostUiNeeds;
}
/** Only valid declarations grant page authority, including on historical read paths. */
export function getPluginToolUi(manifest: UiManifest): GhostUiNeeds | undefined {
  if ((manifest.schemaVersion !== undefined && manifest.schemaVersion !== 3) || !object(manifest.mcpApps)) return;
  const tools = manifest.tools ?? [];
  const hosts = object(manifest.network) ? manifest.network.hosts ?? [] : [];
  if (!Array.isArray(tools) || tools.some(tool => !object(tool) || typeof tool.name !== 'string') ||
      !Array.isArray(hosts) || hosts.some(host => typeof host !== 'string')) return;
  return parseGhostUi(manifest.mcpApps.ui, tools, hosts, isSafeGhostRelativePath) ?? undefined;
}

/** Preserve only historical mcpApps data; every other validation rule still applies. */
export function validateWithStoredMcpApps<R extends { ok: boolean; manifest?: { mcpApps?: unknown } }>(
  value: unknown, validate: (value: unknown) => R,
): R {
  const strict = validate(value);
  if (strict.ok || !object(value) || !Object.prototype.hasOwnProperty.call(value, 'mcpApps')) return strict;
  const rest = { ...value };
  delete rest.mcpApps;
  const compatible = validate(rest);
  if (!compatible.ok) return compatible;
  return { ...compatible, manifest: { ...compatible.manifest, mcpApps: value.mcpApps } };
}
export function pluginHasToolUi(manifest: UiManifest): boolean { return !!getPluginToolUi(manifest); }
export function pluginToolVisible(manifest: UiManifest, name: string, audience: 'model' | 'app'): boolean {
  const link = getPluginToolUi(manifest)?.tools[name];
  return link ? !link.visibility || link.visibility.includes(audience) : audience === 'model';
}
export function pluginUiDomains(manifest: UiManifest): string[] {
  return [...new Set((getPluginToolUi(manifest)?.resources ?? []).flatMap(resource => cspKeys.flatMap(key => resource.csp?.[key] ?? [])))];
}
export function pluginUiPermissionsExpand(previous: UiManifest, next: UiManifest): boolean {
  const previousUi = getPluginToolUi(previous), nextUi = getPluginToolUi(next);
  const remaining = [...(previousUi?.resources ?? [])];
  // URI is an author's identifier, not a permission. A rename with the same file
  // retains its baseline; each old resource can cover only one new resource.
  for (const resource of [...(nextUi?.resources ?? [])].sort((a, b) =>
    Number(previousUi?.resources.some(old => old.uri === b.uri)) - Number(previousUi?.resources.some(old => old.uri === a.uri)))) {
    let index = remaining.findIndex(old => old.uri === resource.uri);
    if (index < 0) index = remaining.findIndex(old => old.file === resource.file);
    const before = remaining[index];
    if (!before || cspKeys.some(key => resource.csp?.[key]?.some(domain => !before.csp?.[key]?.includes(domain)))) return true;
    remaining.splice(index, 1);
  }
  return Object.keys(nextUi?.tools ?? {}).some(name => pluginToolVisible(next, name, 'app') && !pluginToolVisible(previous, name, 'app'));
}
