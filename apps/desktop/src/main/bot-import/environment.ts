import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import { fingerprint } from './files.js';
import { encodeEnvironment, decodeEnvironment, decodeEnvironmentDiscovery, projectEnvironmentDiscovery } from './environmentJson.js';
import { CompanionImportError, type ImportedMcpServer } from './types.js';

/** Never returned over IPC, included in profile JSON, or passed to a language model. */
export interface CompanionEnvironment {
  version: 1;
  /** Source routing for handing automation ownership back on companion deletion. */
  source?: import('./types.js').ImportSource;
  env: Record<string, string>;
  mcp: ImportedMcpServer[];
  credentials: Array<{ id: string; format: string; value: unknown }>;
  /** Source script assets. Legacy imports may also contain memory attachments; execution filters by the scripts/ namespace. */
  files?: Record<string, string>;
  /** Captured script execute bits, keyed like files; absent legacy flags remain non-executable. */
  fileExecutables?: Record<string, boolean>;
  /** Non-media memory originals (including empty markers); never execution assets. Media originals live in the media ledger. */
  memoryFiles?: Record<string, string>;
  /** Originals behind redacted skill projections; only materialized for authorized host commands. */
  skillFiles?: Record<string, Array<{ name: string; bytes: string; executable: boolean; interpreterLink?: string }>>;
  /** Original selected documents; model-readable profile/memory copies redact known credentials. */
  documents?: Record<string, string>;
  /** Redaction only: known values embedded in selected originals, never injected into processes. */
  contentRedactions?: Record<string, string>;
  sourceAutomations?: Array<{ entryId: string; kind: 'hermes' | 'openclaw'; original: Record<string, unknown> }>;
  /** Selected content only; encrypted restart checkpoint, removed after successful completion. */
  pendingImport?: { selection: import('@cindy/maker-shared/companion-import').CompanionImportSelection; snapshotJson: string };
  /** Only selected automation definitions; may contain source URLs/tokens, so remain encrypted. */
  automations?: Record<string, { kind: 'hermes' | 'openclaw'; original: Record<string, unknown>; sourceRoot: string; sourceWorkspace?: string; sourceId?: string;
    /** Missing or pending means source ownership has not been safely handed over. */
    handover?: 'pending' | 'ready';
    issues?: string[]; deliveries?: import('./types.js').ImportedDelivery[]; completed?: number; lastRun?: string;
    /** Resume a partially sent result before executing another occurrence. */
    deliveryProgress?: { runId: string; text: string; direct: boolean; deliveries: import('./types.js').ImportedDelivery[]; next: number };
    monitorHash?: string; monitorOutput?: string; prepared?: { runId: string; prompt: string; direct?: string; skipped?: boolean; monitorHash?: string; monitorOutput?: string } }>;
}

export interface CompanionSecretIo {
  has?(key: string): boolean;
  read(key: string, assertOwner?: () => void): string | null | Promise<string | null>;
  write(key: string, value: string, assertOwner?: () => void): boolean | Promise<boolean>;
  /** Idempotent: a missing key is a successful removal, matching the account vault. */
  remove(key: string): boolean;
  removeResources?(botId: string, assertOwner: () => void): Promise<void>;
}

export interface CompanionDiscoveryEnvironment {
  env: CompanionEnvironment['env'];
  mcp: CompanionEnvironment['mcp'];
  identity: string;
  pendingImport: boolean;
}

function bindingPath(userData: string, botId: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(botId)) throw new CompanionImportError('INVALID_COMPANION');
  return path.join(userData, 'bots', botId, 'environment.json');
}
export const companionEnvironmentKey = (botId: string): string => `bot_environment_${fingerprint(botId)}`;
// Same account-scoped encrypted namespace; separate from the authoritative, backwards-compatible archive.
export const companionDiscoveryKey = (botId: string): string => `bot_environment_${fingerprint(['discovery', botId])}`;
function removalPath(userData: string, botId: string): string {
  bindingPath(userData, botId); // Apply the same host-owned ID validation.
  return path.join(userData, 'companion-import-cleanups', `${botId}.json`);
}

/** A companion owns its binding; secret bytes use the existing account-scoped encrypted store. */
export function createCompanionEnvironmentStore(io: CompanionSecretIo) {
  const queues = new Map<string, Promise<unknown>>();
  const writes = new Map<string, Set<Promise<void>>>();
  const discoveryQueue = new Map<string, Promise<unknown>>();
  const serializeDiscovery = async <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const task = (discoveryQueue.get(key) ?? Promise.resolve()).catch(() => {}).then(run);
    discoveryQueue.set(key, task);
    try { return await task; } finally { if (discoveryQueue.get(key) === task) discoveryQueue.delete(key); }
  };
  const saveDiscovery = async (botId: string, revision: unknown, environment: CompanionDiscoveryEnvironment, assertOwner: () => void) => {
    const { text } = await encodeEnvironment({ version: 1, revision: revision ?? null, environment }, assertOwner);
    assertOwner();
    if (!await io.write(companionDiscoveryKey(botId), text, assertOwner) || await io.read(companionDiscoveryKey(botId), assertOwner) !== text)
      throw new CompanionImportError('CREDENTIAL_STORAGE_FAILED');
    assertOwner();
  };
  const store = {
    async write(userData: string, botId: string, value: CompanionEnvironment, assertOwner: () => void): Promise<void> {
      const key = `${userData}:${botId}`;
      const task = serializeDiscovery(key, async () => {
        const file = bindingPath(userData, botId);
        assertOwner();
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        assertOwner();
        const { text: encoded, revision } = await encodeEnvironment(value, assertOwner);
        assertOwner();
        // Invalidate before touching the archive: a crash or failed write cannot retain stale connections.
        if (!io.remove(companionDiscoveryKey(botId))) throw new CompanionImportError('CREDENTIAL_STORAGE_FAILED');
        if (!await io.write(companionEnvironmentKey(botId), encoded, assertOwner) || await io.read(companionEnvironmentKey(botId), assertOwner) !== encoded)
          throw new CompanionImportError('CREDENTIAL_STORAGE_FAILED');
        assertOwner();
        await saveDiscovery(botId, revision, projectEnvironmentDiscovery(value), assertOwner);
        // Names are untrusted too: a connection or variable identifier can contain
        // a credential. This existence binding has no consumer for original names.
        const manifest = JSON.stringify({ version: 1, variables: Object.keys(value.env).map(name => fingerprint(name)), connections: value.mcp.map(server => fingerprint(server.name)), revision,
          importRequestId: value.pendingImport?.selection.requestId ?? null });
        atomicWriteFileSync(file, manifest);
      });
      const pending = writes.get(key) ?? new Set<Promise<void>>();
      pending.add(task); writes.set(key, pending);
      try { await task; } finally { pending.delete(task); if (!pending.size) writes.delete(key); }
    },
    /** Persisted discovery survives restarts; missing/legacy artifacts rebuild once under the writer lock. */
    async readDiscovery(userData: string, botId: string, assertOwner: () => void): Promise<CompanionDiscoveryEnvironment | undefined> {
      return serializeDiscovery(`${userData}:${botId}`, async () => {
        assertOwner();
        const binding = readAtomicFileSync(bindingPath(userData, botId));
        if (binding === null) return undefined;
        const revision: unknown = JSON.parse(binding).revision ?? null;
        let cached: string | null = null;
        try { cached = await io.read(companionDiscoveryKey(botId), assertOwner); }
        catch { assertOwner(); /* A damaged ciphertext is also a rebuildable derived artifact. */ }
        assertOwner();
        if (cached !== null) {
          try {
            const data = await decodeEnvironment<{ version: number; revision: unknown; environment: CompanionDiscoveryEnvironment }>(cached, assertOwner);
            if (data.version === 1 && data.revision === revision && data.environment?.env && Array.isArray(data.environment.mcp)
              && /^[a-f0-9]{64}$/.test(data.environment.identity) && typeof data.environment.pendingImport === 'boolean') return data.environment;
          } catch { assertOwner(); /* Rebuild a damaged derived artifact from the unchanged archive. */ }
        }
        const encoded = await io.read(companionEnvironmentKey(botId), assertOwner);
        assertOwner();
        if (encoded === null) throw new CompanionImportError('CREDENTIAL_STORAGE_UNAVAILABLE');
        let environment: CompanionDiscoveryEnvironment;
        try { environment = await decodeEnvironmentDiscovery(encoded, assertOwner); }
        catch { assertOwner(); throw new CompanionImportError('CREDENTIAL_STORAGE_INVALID'); }
        await saveDiscovery(botId, revision, environment, assertOwner);
        return environment;
      });
    },
    /** Opaque request binding only. Undefined means a legacy manifest needs one-time migration. */
    readImportRequestId(userData: string, botId: string, assertOwner: () => void): string | null | undefined {
      assertOwner();
      const text = readAtomicFileSync(bindingPath(userData, botId));
      if (text === null) return null;
      const id: unknown = JSON.parse(text).importRequestId;
      if (id !== undefined && id !== null && (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(id)))
        throw new CompanionImportError('CREDENTIAL_STORAGE_INVALID');
      return id as string | null | undefined;
    },
    async read(userData: string, botId: string, assertOwner: () => void): Promise<CompanionEnvironment | undefined> {
      assertOwner();
      if (readAtomicFileSync(bindingPath(userData, botId)) === null) return undefined;
      assertOwner();
      const encoded = await io.read(companionEnvironmentKey(botId), assertOwner);
      assertOwner();
      if (encoded === null) throw new CompanionImportError('CREDENTIAL_STORAGE_UNAVAILABLE');
      let result: CompanionEnvironment;
      try { result = await decodeEnvironment<CompanionEnvironment>(encoded, assertOwner); }
      catch { assertOwner(); throw new CompanionImportError('CREDENTIAL_STORAGE_INVALID'); }
      if (result.version !== 1 || !result.env || !Array.isArray(result.mcp) || !Array.isArray(result.credentials))
        throw new CompanionImportError('CREDENTIAL_STORAGE_INVALID');
      assertOwner();
      return result;
    },
    remove(botId: string): void {
      if (!io.remove(companionDiscoveryKey(botId))) throw new CompanionImportError('CREDENTIAL_STORAGE_FAILED');
      if (!io.remove(companionEnvironmentKey(botId))) throw new CompanionImportError('CREDENTIAL_STORAGE_FAILED');
    },
    /** Non-secret intent survives a crash between the DB commit and vault cleanup. */
    async stageRemoval(userData: string, botId: string, assertOwner: () => void): Promise<void> {
      assertOwner();
      const file = removalPath(userData, botId);
      // A failed manifest write can leave a vault-only checkpoint. Preserve its
      // cleanup path, while ordinary companions require no staging filesystem.
      const key = companionEnvironmentKey(botId);
      if (readAtomicFileSync(bindingPath(userData, botId)) === null && !(io.has ? io.has(key) : await io.read(key) !== null)
        && !(io.has ? io.has(companionDiscoveryKey(botId)) : await io.read(companionDiscoveryKey(botId)) !== null)) return;
      assertOwner();
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      assertOwner();
      atomicWriteFileSync(file, JSON.stringify({ version: 1, botId }));
    },
    async finishRemoval(userData: string, botId: string, assertOwner: () => void): Promise<void> {
      assertOwner();
      const file = removalPath(userData, botId);
      try { if (readAtomicFileSync(file) === null) return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') return; throw error; }
      // Account/profile fencing rejects new work; join pending asynchronous
      // writes before removing the last ciphertext so none can recreate it.
      const key = `${userData}:${botId}`;
      await queues.get(key)?.catch(() => {});
      await Promise.allSettled([...(writes.get(key) ?? [])]);
      await discoveryQueue.get(key)?.catch(() => {});
      assertOwner();
      await io.removeResources?.(botId, assertOwner);
      assertOwner();
      store.remove(botId);
      assertOwner();
      // Rejected pre-profile imports have no profile-folder deletion step.
      // Remove the binding only after the private data is successfully removed.
      await fs.rm(`${bindingPath(userData, botId)}.bak`, { force: true });
      await fs.rm(bindingPath(userData, botId), { force: true });
      assertOwner();
      await fs.rm(`${file}.bak`, { force: true });
      await fs.rm(file, { force: true });
    },
    async recoverRemovals(userData: string, assertOwner: () => void, profileExists: (botId: string) => Promise<boolean>): Promise<void> {
      assertOwner();
      let names: string[];
      try { names = await fs.readdir(path.join(userData, 'companion-import-cleanups')); }
      catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return; throw error; }
      const ids = new Set(names.flatMap(name => /^([a-z0-9][a-z0-9_-]{0,127})\.json(?:\.bak)?$/.exec(name)?.[1] ?? []));
      for (const botId of ids) {
        assertOwner();
        try {
          const exists = await profileExists(botId);
          assertOwner();
          // A failed DB deletion leaves the profile AND its credentials intact.
          if (!exists) await store.finishRemoval(userData, botId, assertOwner);
        } catch { assertOwner(); /* Keep the marker for the next owner recovery. */ }
      }
    },
    async update(userData: string, botId: string, assertOwner: () => void, mutate: (environment: CompanionEnvironment) => void): Promise<void> {
      const key = `${userData}:${botId}`;
      const task = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
        const environment = await store.read(userData, botId, assertOwner);
        if (!environment) throw new CompanionImportError('CREDENTIAL_STORAGE_UNAVAILABLE');
        mutate(environment); await store.write(userData, botId, environment, assertOwner);
      });
      queues.set(key, task);
      try { await task; } finally { if (queues.get(key) === task) queues.delete(key); }
    },
  };
  return store;
}
