import { MODEL_NATIVE_APIS } from './modelAccessBean.js';
import type { ModelRegistry } from './modelAccessBean.js';
import { validModelMetadata } from './modelMetadataLayers.js';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 2048;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 4096 && v.every(text) && new Set(v).size === v.length;
const agents = ['claude-code', 'codex', 'pi'];
function requestPath(value: unknown): boolean {
  if (!text(value) || !/^\/[A-Za-z0-9\-._~%!$&()*+,;=:@/]*$/.test(value) || value.startsWith('//') ||
      /%(?![0-9A-Fa-f]{2})/.test(value) || /%(?:2f|5c)/i.test(value)) return false;
  return !value.split('/').some(segment => ['.', '..'].includes(segment.replace(/%2e/gi, '.')));
}
function endpoint(v: unknown): URL | undefined {
  if (!text(v)) return;
  try {
    const url = new URL(v);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return;
    return url;
  } catch { return; }
}
function bindingError(v: Record<string, unknown>): boolean {
  return (v.defaults !== undefined && (!validModelMetadata(v.defaults) || 'contextWindowMax' in v.defaults)) ||
    (v.requires !== undefined && !strings(v.requires)) ||
    (v.compatibility !== undefined && !strings(v.compatibility)) ||
    (v.retired !== undefined && typeof v.retired !== 'boolean');
}

/** Keep this wire validator mirrored in Server. Unknown APIs/requirements are
 * valid data; execution excludes them. Broken references reject the whole snapshot. */
export function modelInterfacesError(value: Record<string, unknown>): string | null {
  if (value.schemaVersion !== 6) return null;
  const profiles = value.interfaceProfiles ?? [];
  if (!Array.isArray(profiles) || profiles.length > 4096) return 'interfaceProfiles must be an array';
  const ids = new Map<string, Record<string, unknown>>();
  for (const profile of profiles) {
    if (!object(profile) || !text(profile.id) || profile.id.length > 256 || !text(profile.providerId) || !text(profile.api) ||
        !strings(profile.inputBaseUrls) || !profile.inputBaseUrls.length || bindingError(profile)) return 'invalid interface profile';
    const url = endpoint(profile.baseUrl);
    if (!url || profile.inputBaseUrls.some(input => endpoint(input)?.origin !== url.origin)) return 'interface profile crosses credential origin';
    if (profile.requestPath !== undefined && !requestPath(profile.requestPath)) return 'invalid interface requestPath';
    if (profile.legacyApis !== undefined && !strings(profile.legacyApis)) return 'invalid legacyApis';
    if (profile.modelIds !== undefined && !strings(profile.modelIds)) return 'invalid interface modelIds';
    if (profile.defaultFor !== undefined && (!strings(profile.defaultFor) || profile.defaultFor.some(a => !agents.includes(a)))) return 'invalid interface defaultFor';
    if (ids.has(profile.id)) return 'duplicate interface profile';
    ids.set(profile.id, profile);
  }
  for (const entry of (Array.isArray(value.models) ? value.models : []) as Record<string, unknown>[]) {
    if (!object(entry)) continue; // ordinary registry validator owns entry shape
    if (entry.nativeApis !== undefined && entry.nativeApis !== null &&
        (!strings(entry.nativeApis) || !entry.nativeApis.length || entry.nativeApis.some(api => !(MODEL_NATIVE_APIS as readonly string[]).includes(api)))) return 'invalid nativeApis';
    if (!Array.isArray(entry.routes)) continue;
    for (const route of entry.routes) {
      if (!object(route)) continue;
      if (route.interfaces !== undefined && !Array.isArray(route.interfaces)) return 'invalid interfaces';
      const bound = new Set<string>();
      for (const binding of (route.interfaces ?? []) as unknown[]) {
        if (!object(binding) || !text(binding.profileId) || bindingError(binding) ||
            (binding.wireModelId !== undefined && !text(binding.wireModelId))) return 'invalid interface binding';
        const profile = ids.get(binding.profileId);
        if (!profile || profile.providerId !== route.providerId || bound.has(binding.profileId)) return 'invalid interface reference or product';
        bound.add(binding.profileId);
      }
      if (route.preferredInterfaces !== undefined) {
        if (!object(route.preferredInterfaces)) return 'invalid preferredInterfaces';
        for (const [agent, order] of Object.entries(route.preferredInterfaces)) {
          if (!agents.includes(agent) || !strings(order) || order.some(id => !bound.has(id))) return 'preferredInterfaces must reference bindings';
        }
      }
    }
  }
  return null;
}

/** Exact legacy contract: no new fields, defaults or priority changes leak into V5. */
export function projectRegistryV5(registry: ModelRegistry): ModelRegistry {
  if (registry.schemaVersion < 6) return registry;
  const { interfaceProfiles: _profiles, ...legacy } = registry;
  return { ...legacy, schemaVersion: 5, models: registry.models.map(({ nativeApis: _apis, ...entry }) => ({
    ...entry, routes: entry.routes.map(({ interfaces: _interfaces, preferredInterfaces: _preferred, ...route }) => route),
  })) };
}
