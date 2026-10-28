import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { MODEL_INTERFACE_CAPABILITIES } from '@cindy/model-providers';
import type { AgentKind, CatalogModel, ModelInterfaceSnapshot, ModelRegistry } from '@cindy/model-providers';

// Only non-secret interface metadata is pinned. Credentials and provider membership
// remain live. The owner-scoped root is supplied by the host, never by a request.
let storageRoot: () => string | null = () => null;
const cache = new Map<string, Pin>();
interface Pin { providerId: string; agent: AgentKind; modelId: string; selection: ModelInterfaceSnapshot }
export function configureSessionModelInterfaceStorage(root: () => string | null): void {
  storageRoot = root;
  cache.clear();
}
function location(sessionId: string, identity: string) {
  const root = storageRoot();
  const name = createHash('sha256').update(sessionId).digest('hex');
  const model = createHash('sha256').update(identity).digest('hex');
  return { key: `${root ?? 'memory'}:${name}:${model}`, file: root ? path.join(root, name, `${model}.json`) : null };
}
function readPin(key: string, file: string | null): Pin | undefined {
  if (cache.has(key)) return cache.get(key);
  if (!file || !fs.existsSync(file)) return;
  if (fs.statSync(file).size > 65536) throw new Error('MODEL_INTERFACE_SNAPSHOT_INVALID');
  const value: Pin = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value.providerId !== 'string' || typeof value.modelId !== 'string' ||
      !['claude-code', 'codex', 'pi'].includes(value.agent) || !value.selection ||
      typeof value.selection.profileId !== 'string' || typeof value.selection.route?.baseUrl !== 'string' ||
      !Array.isArray(value.selection.compatibility)) throw new Error('MODEL_INTERFACE_SNAPSHOT_INVALID');
  cache.set(key, value);
  return value;
}
export function assertModelInterfaceAvailable(selection: ModelInterfaceSnapshot, modelId: string, registry?: ModelRegistry): void {
  // An old-server compatibility response cannot revoke a previously accepted V6
  // snapshot. In V6, deletion/retirement is authoritative; bundled data cannot revive it.
  if (!registry || registry.schemaVersion < 6) return;
  const profile = registry.interfaceProfiles?.find(p => p.id === selection.profileId);
  const matches = registry.models.flatMap(entry => entry.routes
    .filter(r => r.providerId === selection.providerId && r.modelId === modelId).map(route => ({ entry, route })));
  const binding = matches[0]?.route.interfaces?.find(b => b.profileId === selection.profileId);
  if (!profile || (profile.requires ?? []).some(c => !(MODEL_INTERFACE_CAPABILITIES as readonly string[]).includes(c)) ||
      (binding?.requires ?? []).some(c => !(MODEL_INTERFACE_CAPABILITIES as readonly string[]).includes(c)) || profile.retired || profile.providerId !== selection.providerId ||
      profile.api !== selection.api || new URL(profile.baseUrl).origin !== new URL(selection.route.baseUrl).origin ||
      matches.length > 1 || matches[0]?.entry.status === 'retired' || binding?.retired ||
      (matches[0]?.route.interfaces && !binding) ||
      (!matches[0]?.route.interfaces && profile.modelIds && !profile.modelIds.includes(modelId))) throw new Error('MODEL_INTERFACE_RETIRED');
}

/** First dispatch captures a complete choice. Catalog refreshes and app restart
 * reuse it; an explicit provider/model change captures a new choice. No network retry. */
export function sessionModelInterface(
  sessionId: string, providerId: string, agent: AgentKind, model: CatalogModel,
  registry?: ModelRegistry, legacyWire?: string,
): ModelInterfaceSnapshot | undefined {
  const { key, file } = location(sessionId, JSON.stringify([providerId, agent, model.id]));
  const previous = readPin(key, file);
  if (previous?.providerId === providerId && previous.agent === agent && previous.modelId === model.id) {
    assertModelInterfaceAvailable(previous.selection, model.id, registry);
    return structuredClone(previous.selection);
  }
  if (model.interfaceUnavailable) throw new Error('MODEL_INTERFACE_UNAVAILABLE');
  let selection = model.selectedInterface;
  // A resumed pre-V6 task has no snapshot. Keep its saved transport on first migration.
  if (legacyWire && !model.userModelConfig?.interfaceId && !model.userModelConfig?.api && !model.userModelConfig?.piApi && !model.userModelConfig?.route) {
    const legacy = model.availableInterfaces?.find(p => p.route.wireProtocol === legacyWire);
    if (legacy) selection = { ...legacy, defaults: { ...selection?.defaults, ...legacy.defaults } };
  }
  if (!selection) return;
  assertModelInterfaceAvailable(selection, model.id, registry);
  const pin = { providerId, agent, modelId: model.id, selection: structuredClone(selection) };
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(pin), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  cache.set(key, pin);
  return structuredClone(selection);
}

export function removeSessionModelInterface(sessionId: string): void {
  const root = storageRoot();
  const name = createHash('sha256').update(sessionId).digest('hex');
  for (const key of cache.keys()) if (key.startsWith(`${root ?? 'memory'}:${name}:`)) cache.delete(key);
  if (root) fs.rmSync(path.join(root, name), { recursive: true, force: true });
}
