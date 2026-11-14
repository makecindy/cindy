import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { dataOwnerStorageKey, ownerScopedPath } from './dataOwnerPath.js';
import { LOCAL_PROFILE_DATA_OWNER_ID } from './profile/profileRegistryModel.js';
import { withCommittedLocalProfileDataOwner } from './localProfileDataMigration.js';
import { atomicWriteFileSync, readAtomicFileSync } from './utils/atomicWriteFile.js';
import { readBoundedFileNoFollow } from './utils/readBoundedFile.js';
import {
  classifyGhostDirEntry,
  collectGhostContentFiles,
  hashGhostContentFiles,
  resolveGhostContentPath,
} from './cindy-brain/ghostContentTree.js';
import {
  isCustomProviderRuntimeKeyStorageKey,
  ghostSecretStorageKey,
  ghostSecretHintStorageKey,
} from '../shared/providerSecrets.js';
import { GhostInstallReceiptStore } from './cindy-brain/ghostInstallReceipt.js';
import { parsePluginInstallRelId, pluginInstallStoragePart } from '../shared/pluginIdentity.js';
import { readModelVisibilityAdoption } from './localDb/modelVisibilityAdoption.js';

// This is an adoption of an existing installation, never an install/approval.
// Keep the content, receipts (including skill snapshots and instance registry),
// market provenance and user settings together. OAuth, directory grants,
// Library bindings and account/organization credentials are not copied.
const PLUGIN_PATHS = [
  'brain',
  'cindy-brain',
  'ghost-install-state',
  'ghost-kv',
  'ghost-fs',
  'ghost-cindy-prefs.json',
  'ghost-workdir-prefs.json',
  'ghost-recent-usage.json',
  'plugin-market/ledger.v1.json',
  'plugin-market/sources.v1.json',
] as const;
const STATE_FILE = '.local-profile-assets-v1.json';
const STAGING_PREFIX = '.local-profile-assets-';
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_SECRET_BYTES = 4 * 1024 * 1024;
type Entry = { name: string; kind: 'file' | 'directory'; digest: string };
type Plan = {
  version: 1;
  ownerId: string;
  stagingId: string;
  complete: boolean;
  plugins: Entry[];
  secrets: Entry[];
};

export interface LocalProfileAssetsMigrationDeps {
  userDataDir: string;
  dbFilePrefix: string;
  hasExclusiveSourceAccess(): boolean;
  acquireSourcePublicationBarrier?: () => Promise<{ isHeld(): boolean; release(): Promise<void> }>;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.promises.lstat(file);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isProviderSecret(name: string): boolean {
  return (
    isCustomProviderRuntimeKeyStorageKey(name) ||
    /^provider_headers_[a-zA-Z0-9_-]+_(?:claude-code|codex|pi)$/.test(name)
  );
}

function isPluginSecret(name: string): boolean {
  return /^(?:ghost_secret_|ghost_hint_|ghost_alias_migration_)[a-zA-Z0-9_-]+$/.test(name);
}

function parsePlan(raw: string, ownerId: string): Plan {
  const plan = JSON.parse(raw) as Plan;
  const validEntry = (entry: Entry, secret: boolean) =>
    entry &&
    typeof entry.name === 'string' &&
    /^[a-f0-9]{64}$/.test(entry.digest) &&
    (secret
      ? entry.kind === 'file' && (isProviderSecret(entry.name) || isPluginSecret(entry.name))
      : (entry.kind === 'file' || entry.kind === 'directory') &&
        (PLUGIN_PATHS as readonly string[]).includes(entry.name));
  if (
    plan.version !== 1 ||
    plan.ownerId !== ownerId ||
    typeof plan.complete !== 'boolean' ||
    !/^[a-f0-9-]{36}$/.test(plan.stagingId) ||
    !Array.isArray(plan.plugins) ||
    !Array.isArray(plan.secrets) ||
    !plan.plugins.every((e) => validEntry(e, false)) ||
    !plan.secrets.every((e) => validEntry(e, true)) ||
    new Set(plan.plugins.map((e) => e.name)).size !== plan.plugins.length ||
    new Set(plan.secrets.map((e) => e.name)).size !== plan.secrets.length
  ) {
    throw new Error('local profile asset handoff state is invalid');
  }
  return plan;
}

async function requireDirectory(dir: string): Promise<void> {
  if ((await classifyGhostDirEntry(dir)) !== 'directory') {
    throw new Error('local profile asset directory is not a real directory');
  }
}

async function makeParent(root: string, relative: string): Promise<void> {
  await requireDirectory(root);
  let current = root;
  for (const part of relative.split('/').slice(0, -1)) {
    current = path.join(current, part);
    try {
      await fs.promises.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await requireDirectory(current);
  }
}

async function syncFile(file: string): Promise<void> {
  // FlushFileBuffers needs write access on Windows. These are our snapshots,
  // never source files; temporarily add owner-write for read-only resources.
  if ((await classifyGhostDirEntry(file)) !== 'file') throw new Error('snapshot is not a file');
  const mode = (await fs.promises.lstat(file)).mode;
  const readOnly = (mode & 0o200) === 0;
  if (readOnly) await fs.promises.chmod(file, mode | 0o200);
  try {
    const handle = await fs.promises.open(file, 'r+');
    try {
      if (readOnly) await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } finally {
    if (readOnly) await fs.promises.chmod(file, mode);
  }
}

async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await fs.promises.open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function digest(root: string, entry: Pick<Entry, 'name' | 'kind'>): Promise<string> {
  const file = await resolveGhostContentPath(root, entry.name, {
    expect: entry.kind,
    label: 'local profile asset',
  });
  if (entry.kind === 'directory') {
    const tree = await collectGhostContentFiles(file, {
      dotEntries: 'include',
      nonRegular: 'throw',
      label: 'local profile asset',
    });
    const files =
      entry.name === 'ghost-install-state'
        ? tree.files.filter((name) => !name.startsWith('.oauth-locks/'))
        : tree.files;
    return hashGhostContentFiles(file, files, tree.rootIdentity);
  }
  return hashGhostContentFiles(root, [entry.name]);
}

async function snapshot(sourceRoot: string, stageRoot: string, name: string): Promise<Entry> {
  const source = path.join(sourceRoot, ...name.split('/'));
  const kind = await classifyGhostDirEntry(source);
  if (kind !== 'file' && kind !== 'directory')
    throw new Error('local profile asset is not regular');
  const entry = { name, kind, digest: await digest(sourceRoot, { name, kind }) };
  await makeParent(stageRoot, name);
  const target = path.join(stageRoot, ...name.split('/'));
  await fs.promises.cp(source, target, {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
    filter: async (file) => {
      if (
        name === 'ghost-install-state' &&
        path.relative(source, file).split(path.sep)[0] === '.oauth-locks'
      )
        return false;
      const type = await classifyGhostDirEntry(file);
      if (type !== 'file' && type !== 'directory')
        throw new Error('local profile asset is not regular');
      return true;
    },
  });
  // Verify both sides with the common plugin tree reader. No copied byte can
  // acquire a stronger approval: the original receipt travels unchanged.
  if (
    (await digest(stageRoot, entry)) !== entry.digest ||
    (await digest(sourceRoot, entry)) !== entry.digest
  ) {
    throw new Error('local profile assets changed during snapshot');
  }
  if (kind === 'directory') {
    const tree = await collectGhostContentFiles(target, {
      dotEntries: 'include',
      nonRegular: 'throw',
      label: 'local profile asset',
    });
    for (const file of tree.files) await syncFile(path.join(target, ...file.split('/')));
    // Persist every directory entry before publishing the durable plan, including
    // empty plugin storage directories. Child directories precede their parents.
    const directories = async (dir: string): Promise<void> => {
      for (const child of await fs.promises.readdir(dir)) {
        const target = path.join(dir, child);
        const kind = await classifyGhostDirEntry(target);
        if (kind === 'directory') await directories(target);
        else if (kind !== 'file') throw new Error('local profile snapshot is not regular');
      }
      await syncDirectory(dir);
    };
    await directories(target);
  } else await syncFile(target);
  await syncDirectory(path.dirname(target));
  return entry;
}

async function pluginSecretKeys(localRoot: string): Promise<Set<string>> {
  const keys = new Set<string>();
  const state = path.join(localRoot, 'ghost-install-state');
  if (!(await exists(state))) return keys;
  const store = new GhostInstallReceiptStore(() => state);
  const tree = await collectGhostContentFiles(state, {
    dotEntries: 'include',
    nonRegular: 'throw',
    label: 'local plugin approval',
  });
  for (const file of tree.files) {
    if (!file.endsWith('.json')) continue;
    const relId = file.slice(0, -5);
    if (!parsePluginInstallRelId(relId)) continue;
    const approval = await store.readAsync(relId);
    if (approval.state !== 'approved') continue;
    const installed =
      (await exists(path.join(localRoot, 'cindy-brain', ...relId.split('/')))) ||
      (await exists(path.join(localRoot, 'brain', ...relId.split('/'))));
    if (!installed) continue;
    const instanceKey = pluginInstallStoragePart(relId);
    keys.add(`ghost_alias_migration_${instanceKey}`);
    const manifest = approval.receipt.manifest;
    const userSecretKeys = [
      ...(manifest.network?.secrets ?? [])
        .filter((secret) => secret.source === undefined || secret.source === 'user')
        .map((secret) => secret.key),
      ...(manifest.node?.secretBindings ?? [])
        .filter((binding) => !binding.oauthSecret)
        .map((binding) => binding.key),
    ];
    for (const key of userSecretKeys) {
      keys.add(ghostSecretStorageKey(instanceKey, key));
      keys.add(ghostSecretHintStorageKey(instanceKey, key));
    }
  }
  return keys;
}

async function savePlan(file: string, plan: Plan): Promise<void> {
  const text = `${JSON.stringify(plan)}\n`;
  if (Buffer.byteLength(text) > MAX_STATE_BYTES)
    throw new Error('local profile handoff plan is too large');
  atomicWriteFileSync(file, text);
  await syncFile(file);
  await syncDirectory(path.dirname(file));
}

async function readPlan(file: string, ownerId: string): Promise<Plan | null> {
  // atomicWriteFileSync may have left only its backup after an interrupted
  // Windows replacement. Validate both paths before its recovery read.
  for (const candidate of [file, `${file}.bak`]) {
    if (!(await exists(candidate))) continue;
    const bytes = await readBoundedFileNoFollow(candidate, MAX_STATE_BYTES, {
      containWithin: await fs.promises.realpath(path.dirname(file)),
      nonBlocking: true,
      verifyContentStability: true,
    });
    if (bytes === null) throw new Error('local profile handoff state could not be safely read');
    parsePlan(bytes.toString('utf8'), ownerId);
  }
  const raw = readAtomicFileSync(file);
  return raw === null ? null : parsePlan(raw, ownerId);
}

async function removeStage(ownerRoot: string, stagingId: string): Promise<void> {
  const stage = path.join(ownerRoot, `${STAGING_PREFIX}${stagingId}`);
  if (!(await exists(stage))) return;
  await requireDirectory(stage);
  const realOwner = await fs.promises.realpath(ownerRoot);
  if (path.dirname(await fs.promises.realpath(stage)) !== realOwner) {
    throw new Error('local profile staging directory escaped its owner');
  }
  // The only recursive removal is this private UUID directory. rm does not
  // follow symlink children; source owner data is never removed.
  await fs.promises.rm(stage, { recursive: true, force: true });
  await syncDirectory(ownerRoot);
}

/** Called inside the auth owner commit, before consumers see a stable owner. */
export async function adoptLocalProfileAssets(
  ownerId: string,
  deps: LocalProfileAssetsMigrationDeps,
): Promise<'adopted' | 'complete' | 'not-owner'> {
  const result = await withCommittedLocalProfileDataOwner(
    ownerId,
    deps.userDataDir,
    deps.dbFilePrefix,
    async () => {
      const ownerRoot = ownerScopedPath(deps.userDataDir, ownerId);
      const localRoot = ownerScopedPath(deps.userDataDir, LOCAL_PROFILE_DATA_OWNER_ID);
      const ownersRoot = path.join(deps.userDataDir, 'owners');
      await fs.promises.mkdir(ownersRoot, { recursive: true, mode: 0o700 });
      await requireDirectory(ownersRoot);
      await fs.promises.mkdir(ownerRoot, { recursive: true, mode: 0o700 });
      await requireDirectory(ownerRoot);
      const stateFile = path.join(ownerRoot, STATE_FILE);
      let plan = await readPlan(stateFile, ownerId);
      if (plan?.complete) {
        await removeStage(ownerRoot, plan.stagingId);
        return 'complete' as const;
      }
      const barrier = await deps.acquireSourcePublicationBarrier?.();
      const assertExclusive = () => {
        if (!deps.hasExclusiveSourceAccess() || (barrier && !barrier.isHeld())) {
          throw new Error('local profile asset adoption requires exclusive source access');
        }
      };
      try {
        assertExclusive();
        const secretRoot = path.join(deps.userDataDir, 'safe-storage');
        const sourcePrefix = `owner_${dataOwnerStorageKey(LOCAL_PROFILE_DATA_OWNER_ID)}_`;
        const targetPrefix = `owner_${dataOwnerStorageKey(ownerId)}_`;
        if (!plan) {
          plan = {
            version: 1,
            ownerId,
            stagingId: randomUUID(),
            complete: false,
            plugins: [],
            secrets: [],
          };
          const stage = path.join(ownerRoot, `${STAGING_PREFIX}${plan.stagingId}`);
          await fs.promises.mkdir(stage, { mode: 0o700 });
          const pluginStage = path.join(stage, 'plugins');
          const secretStage = path.join(stage, 'secrets');
          await fs.promises.mkdir(pluginStage, { mode: 0o700 });
          await fs.promises.mkdir(secretStage, { mode: 0o700 });
          // An existing cloud installation is authoritative as a unit. Never
          // combine its receipts or market routing with a different local install.
          let adoptPlugins = await exists(localRoot);
          if (adoptPlugins) await requireDirectory(localRoot);
          for (const name of PLUGIN_PATHS) {
            if (await exists(path.join(ownerRoot, ...name.split('/')))) adoptPlugins = false;
          }
          if (adoptPlugins) {
            const stateRoot = path.join(localRoot, 'ghost-install-state');
            if (await exists(stateRoot)) {
              await requireDirectory(stateRoot);
              const pending = new GhostInstallReceiptStore(
                () => stateRoot,
              ).listPendingMutationIdsSync();
              if (pending.state !== 'ok' || pending.blocked || pending.ids.length > 0) {
                throw new Error('local plugin installation recovery must finish before adoption');
              }
            }
            for (const name of PLUGIN_PATHS) {
              if (await exists(path.join(localRoot, ...name.split('/')))) {
                plan.plugins.push(await snapshot(localRoot, pluginStage, name));
              }
            }
          }
          const pluginKeys = adoptPlugins ? await pluginSecretKeys(pluginStage) : new Set<string>();
          // A pre-existing, unrelated cloud DB did not adopt local provider rows.
          // Do not attach local credentials to its same-named providers. A prior
          // successful DB adoption is tied to the published file's identity.
          const cloudDb = path.join(deps.userDataDir, `${deps.dbFilePrefix}-${ownerId}.db`);
          const adoptProviders =
            !(await exists(cloudDb)) || readModelVisibilityAdoption(cloudDb) === 'adopted';
          if (await exists(secretRoot)) {
            await requireDirectory(secretRoot);
            const containWithin = await fs.promises.realpath(secretRoot);
            for (const file of await fs.promises.readdir(secretRoot)) {
              if (!file.startsWith(sourcePrefix) || !file.endsWith('.enc')) continue;
              const name = file.slice(sourcePrefix.length, -4);
              if (!(adoptProviders && isProviderSecret(name)) && !pluginKeys.has(name)) continue;
              if (await exists(path.join(secretRoot, `${targetPrefix}${name}.enc`))) continue;
              const bytes = await readBoundedFileNoFollow(
                path.join(secretRoot, file),
                MAX_SECRET_BYTES,
                { containWithin, nonBlocking: true, verifyContentStability: true },
              );
              if (bytes === null)
                throw new Error('local profile credential could not be safely read');
              const target = path.join(secretStage, name);
              await fs.promises.writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
              await syncFile(target);
              plan.secrets.push({
                name,
                kind: 'file',
                digest: createHash('sha256').update(bytes).digest('hex'),
              });
            }
          }
          assertExclusive();
          await syncDirectory(secretStage);
          await syncDirectory(pluginStage);
          await syncDirectory(stage);
          // Durable intent precedes every target write. A retry only uses this
          // frozen snapshot, never subsequently added local credentials/plugins.
          await savePlan(stateFile, plan);
        }
        const stage = path.join(ownerRoot, `${STAGING_PREFIX}${plan.stagingId}`);
        await requireDirectory(stage);
        const pluginStage = path.join(stage, 'plugins');
        for (const entry of plan.plugins) {
          assertExclusive();
          await makeParent(ownerRoot, entry.name);
          const source = path.join(pluginStage, ...entry.name.split('/'));
          const target = path.join(ownerRoot, ...entry.name.split('/'));
          if (await exists(target)) {
            // Only a byte-identical publication may complete an interrupted plan.
            if ((await digest(ownerRoot, entry)) !== entry.digest)
              throw new Error('local profile asset target conflict');
            continue;
          }
          if ((await digest(pluginStage, entry)) !== entry.digest)
            throw new Error('local profile snapshot changed');
          await fs.promises.rename(source, target);
          if ((await digest(ownerRoot, entry)) !== entry.digest)
            throw new Error('local profile publication changed');
          await syncDirectory(path.dirname(target));
        }
        for (const entry of plan.secrets) {
          assertExclusive();
          await requireDirectory(secretRoot);
          const target = path.join(secretRoot, `${targetPrefix}${entry.name}.enc`);
          if (await exists(target)) continue; // A user's newer value always wins.
          const source = path.join(stage, 'secrets', entry.name);
          const bytes = await readBoundedFileNoFollow(source, MAX_SECRET_BYTES, {
            containWithin: await fs.promises.realpath(stage),
            nonBlocking: true,
            verifyContentStability: true,
          });
          if (!bytes || createHash('sha256').update(bytes).digest('hex') !== entry.digest) {
            throw new Error('local profile credential snapshot changed');
          }
          // Link a complete, flushed ciphertext, never expose a partial .enc file.
          try {
            await fs.promises.link(source, target);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
          await syncDirectory(secretRoot);
        }
        assertExclusive();
        await savePlan(stateFile, { ...plan, complete: true });
        await removeStage(ownerRoot, plan.stagingId);
        return 'adopted' as const;
      } finally {
        try {
          // Before intent is durable there are no target writes to recover. Once
          // any plan exists, retain its snapshot even if its fsync threw.
          if (plan && !(await exists(stateFile)) && !(await exists(`${stateFile}.bak`))) {
            await removeStage(ownerRoot, plan.stagingId);
          }
        } finally {
          await barrier?.release();
        }
      }
    },
  );
  return result ?? 'not-owner';
}
