import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import sharp from 'sharp';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import { parseRoutineInput, type RoutineInput } from '@cindy/maker-scheduler';
import { normalizeBotName } from '../../shared/botCreation.js';
import { listBotRemoteResourceSources } from '../localDb/ipc/bots.js';
import { validateBotAvatarBuffer, decodeBotAvatarImage } from '../localDb/ipc/botAvatarSelection.js';
import type { CompanionImportPreview, CompanionImportResult, CompanionImportSelection, CompanionImportSource } from '@cindy/maker-shared/companion-import';
import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { createBotCanonicalSession, createBotProfile, getBotMemoryService, getBotRemoteResourceSource, reconcileBotProfileFolder } from '../localDb/ipc/bots.js';
import { readBotProfileFolder, writeBotProfileFolder, BOT_PROFILE_TEXT_MAX_BYTES } from '../maker-ipc/botProfileFolder.js';
import { importBotSkillFiles, normalizeBotSkillSlug, validateBotSkillFiles, BOT_SKILL_MAX_COUNT } from '../maker-ipc/botSkillStore.js';
import { withBotProfileLocks } from '../maker-ipc/botProfileLock.js';
import { getRoutineEngine, routineTools, updateBotRoutineLifecycle } from '../routines/service.js';
import { previewImportRedactions, retainedImportRedactions, resolveImportReferences, selectedImportEnvironment, selectedImportRedactions } from './environmentSelection.js';
import { redactEnvironmentValues } from './process.js';
import { createImportSourceReader, discoverImportSources, inspectImportSource, type SourceReaderDeps } from './sources.js';
import { readOpenClawCronDatabase } from './openclawCron.js';
import { companionEnvironmentStore, recoverCompanionEnvironmentRemovals } from './runtime.js';
import { deserializeImportSnapshotAsync, fingerprint, serializeImportSnapshotAsync, reserveSnapshotItems, MAX_SNAPSHOT_BYTES } from './files.js';
import { transferCompanion, validateImportSelection, type ImportReceipt, type TransferDeps } from './transfer.js';
import { CompanionImportError, type ImportSnapshot, type ImportSource } from './types.js';
import { changeSourceAutomationState } from './takeover.js';
import { verifyImportedAutomation } from './verification.js';
import { projectImportedSkill } from './skillResources.js';
import { assertImportedAutomationReady } from './automationRuntime.js';

interface Owned<T> { owner: string; controller: string; value: T; createdAt: number }
const sources = new Map<string, Owned<ImportSource>>();
const previews = new Map<string, Owned<ImportSnapshot> & { bytes: number }>();
const jobs = new Map<string, Promise<CompanionImportResult>>();
const TTL = 30 * 60_000;
function owner() {
  const scope = activeOwnerScopeKey();
  const root = ownerScopedUserDataPath();
  const assert = () => {
    if (!getActiveAppSession().dataOwnerId || isAppSessionBoundaryPending() || scope !== activeOwnerScopeKey()) throw new CompanionImportError('OWNER_CHANGED');
  };
  assert();
  return { scope, root, assert };
}
const readers = (): SourceReaderDeps => ({ home: app.getPath('home'), env: process.env, readCronDatabase: readOpenClawCronDatabase });

function prune<T>(entries: Map<string, Owned<T>>) {
  for (const [key, entry] of entries) if (Date.now() - entry.createdAt > TTL || entry.owner !== activeOwnerScopeKey()) entries.delete(key);
}
function owned<T>(entries: Map<string, Owned<T>>, id: string, controller: string): T {
  prune(entries);
  const result = entries.get(id);
  if (!result || result.owner !== activeOwnerScopeKey() || result.controller !== controller) throw new CompanionImportError('PREVIEW_EXPIRED');
  return result.value;
}

export async function listCompanionImportSources(controller: string): Promise<CompanionImportSource[]> {
  const scope = owner();
  const deps = readers();
  const reader = createImportSourceReader(deps);
  const found = await discoverImportSources(deps, reader); scope.assert();
  prune(sources);
  const result: CompanionImportSource[] = [];
  // Only credential metadata contributes to the list; full snapshots are built
  // for the selected preview. Name masking shares cached config/token reads.
  for (const source of found) {
    let name = `${source.kind === 'hermes' ? 'Hermes' : 'OpenClaw'} · ${result.length + 1}`;
    try {
      name = await reader.readName(source);
    } catch {
      // An unreadable source remains selectable, but its unchecked name is not
      // public. Preview reports the underlying failure through its usual path.
    }
    scope.assert();
    const id = randomUUID();
    sources.set(id, { owner: scope.scope, controller, value: source, createdAt: Date.now() });
    result.push({ id, kind: source.kind, name });
  }
  return result;
}

/** Keep at most one preview per controller, four total, within one snapshot byte budget. */
function retainPreview(id: string, entry: Owned<ImportSnapshot>) {
  previews.delete(id);
  let bytes = Buffer.byteLength(JSON.stringify({ ...entry.value, items: undefined }));
  const reserve = (size: number) => { bytes += size; };
  reserveSnapshotItems(entry.value.items, { reserve, reserveFile: reserve });
  if (bytes > MAX_SNAPSHOT_BYTES) throw new CompanionImportError('SOURCE_SNAPSHOT_TOO_LARGE');
  prune(previews);
  for (const [key, prior] of previews) if (prior.controller === entry.controller) previews.delete(key);
  let total = [...previews.values()].reduce((sum, preview) => sum + preview.bytes, 0);
  for (const [key, prior] of previews) {
    if (previews.size < 4 && total + bytes <= MAX_SNAPSHOT_BYTES) break;
    previews.delete(key); total -= prior.bytes;
  }
  previews.set(id, { ...entry, bytes });
}

export async function previewCompanionImport(sourceId: string, controller: string): Promise<CompanionImportPreview> {
  const scope = owner();
  const source = owned(sources, sourceId, controller);
  const snapshot = await inspectImportSource(source, readers()); scope.assert();
  if (snapshot.avatarImageBase64) {
    const buffer = Buffer.from(snapshot.avatarImageBase64, 'base64');
    validateBotAvatarBuffer(buffer);
    snapshot.avatarImageBase64 = (await sharp(buffer, { limitInputPixels: 40_000_000 }).resize(256, 256, { fit: 'cover' }).jpeg({ quality: 65 }).toBuffer()).toString('base64');
    scope.assert();
  }
  const id = randomUUID();
  retainPreview(id, { owner: scope.scope, controller, value: snapshot, createdAt: Date.now() });
  const secrets = previewImportRedactions(snapshot.items);
  const redact = (text: string) => redactEnvironmentValues(text, secrets);
  return { id, source: { id: sourceId, kind: source.kind, name: redact(source.name) }, name: redact(source.name),
    ...(snapshot.avatarImageBase64 ? { avatarImageBase64: snapshot.avatarImageBase64 } : {}),
    entries: snapshot.items.map(({ view }) => ({ ...view, name: redact(view.name),
      ...(view.description === undefined ? {} : { description: redact(view.description) }) })) };
}

function receiptFile(root: string, requestId: string) {
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(requestId)) throw new CompanionImportError('INVALID_REQUEST');
  return path.join(root, 'companion-imports', `${requestId}.json`);
}

/** Reconcile only previously authorized, unfinished requests in the currently signed-in account. */
export async function recoverCompanionImports(): Promise<void> {
  const scope = owner();
  await recoverCompanionEnvironmentRemovals();
  scope.assert();
  let files: string[];
  try { files = await fs.readdir(path.join(scope.root, 'companion-imports')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const name of files.filter(name => /^[A-Za-z0-9_-]{16,100}\.json$/.test(name))) {
    scope.assert();
    try { await getCompanionImportResult(name.slice(0, -5)); } catch { scope.assert(); }
  }
}
async function readReceipt(root: string, requestId: string): Promise<ImportReceipt | undefined> {
  const text = readAtomicFileSync(receiptFile(root, requestId));
  return text ? JSON.parse(text) as ImportReceipt : undefined;
}
async function saveReceipt(root: string, receipt: ImportReceipt) {
  const file = receiptFile(root, receipt.result.requestId);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(file, JSON.stringify(receipt));
}

/** A definite DB rejection must not strand credentials without a deletable profile. */
async function cleanRejectedCreation(root: string, receipt: ImportReceipt, assertOwner: () => void): Promise<never> {
  assertOwner();
  try {
    await getBotRemoteResourceSource(receipt.result.botId);
    // Never erase credentials if creation actually committed (or its outcome is
    // unknown). The rejection marker is written only after a confirmed absence.
    throw new CompanionImportError('REQUEST_ALREADY_USED');
  } catch (error) { if (!(error instanceof Error) || !error.message.includes('[NOT_FOUND]')) throw error; }
  assertOwner();
  await companionEnvironmentStore.stageRemoval(root, receipt.result.botId, assertOwner);
  await companionEnvironmentStore.finishRemoval(root, receipt.result.botId, assertOwner);
  assertOwner();
  throw new CompanionImportError(receipt.creationRejected!);
}

/** Called inside the lifecycle profile lock, after the active transfer pass has joined. */
export async function prepareCompanionImportDeletion(botId: string): Promise<void> {
  const scope = owner();
  await updateBotRoutineLifecycle(botId, 'pause');
  scope.assert();
  await cancelCompanionImportsForDeletion(botId);
  scope.assert();
  await companionEnvironmentStore.stageRemoval(scope.root, botId, scope.assert);
  scope.assert();
  // Keep definitions and history until the profile deletion commits. The
  // post-commit lifecycle hook purges them; a failed DB write stays retryable.
}

/** Called with target routines paused, inside the lifecycle profile lock. */
export async function cancelCompanionImportsForDeletion(botId: string): Promise<void> {
  const scope = owner();
  let files: string[];
  try { files = await fs.readdir(path.join(scope.root, 'companion-imports')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const name of files.filter(name => /^[A-Za-z0-9_-]{16,100}\.json$/.test(name))) {
    const receipt = await readReceipt(scope.root, name.slice(0, -5)); scope.assert();
    if (!receipt || receipt.result.botId !== botId) continue;
    receipt.cancelled = true;
    receipt.result.status = 'needs-attention';
    receipt.result.checks = [...receipt.result.checks.filter(check => check.entryId !== 'import'),
      { entryId: 'import', status: 'needs-attention', message: 'IMPORT_CANCELLED' }];
    await saveReceipt(scope.root, receipt); scope.assert();
    // The lifecycle has paused target routines under the same profile
    // lock. Restore only source tasks this import actually paused, before the
    // profile/vault can be deleted; a failed handback remains visibly retryable.
    const environment = await companionEnvironmentStore.read(scope.root, botId, scope.assert);
    for (const [entryId, record] of Object.entries(receipt.routines)) {
      if (record.sourceRestored || !['pausing-source', 'source-paused', 'complete'].includes(record.phase)) continue;
      const takenOver = receipt.result.checks.some(check => check.entryId === entryId && check.status === 'taken-over');
      if (record.phase === 'complete' && !takenOver) continue;
      const binding = environment?.automations?.[record.id];
      if (!environment || !binding) throw new CompanionImportError('CREDENTIAL_STORAGE_UNAVAILABLE');
      const source = environment.source ?? (environment.pendingImport ? (await deserializeImportSnapshotAsync(environment.pendingImport.snapshotJson, scope.assert)).source : undefined)
        ?? (await discoverImportSources(readers())).find(source => source.kind === binding.kind && source.root === binding.sourceRoot);
      scope.assert();
      if (!source) throw new CompanionImportError('SOURCE_COMMAND_UNAVAILABLE');
      await companionEnvironmentStore.update(scope.root, botId, scope.assert, env => { env.automations![record.id]!.handover = 'pending'; });
      const sourceId = binding.sourceId ?? (typeof binding.original.id === 'string' ? binding.original.id : '');
      await changeSourceAutomationState(source, { view: { id: entryId, name: '', category: 'automations', selected: true },
        automation: { sourceId, original: binding.original, fingerprint: fingerprint(binding.original) } }, true, readers(), scope.assert, false, environment.env);
      record.sourceRestored = true;
      await saveReceipt(scope.root, receipt); scope.assert();
    }
  }
}

export async function getCompanionImportResult(requestId: string): Promise<CompanionImportResult | undefined> {
  const scope = owner();
  let receipt = await readReceipt(scope.root, requestId); scope.assert();
  const running = jobs.get(`${scope.scope}:${requestId}`);
  if (running) return receipt?.companionCreated || receipt?.environmentSaved ? receipt.result : running;
  if (receipt?.creationRejected) return withBotProfileLocks([receipt.result.botId], () => cleanRejectedCreation(scope.root, receipt!, scope.assert));
  // The request index precedes the first vault write. If that write never
  // published its binding, use the index to reclaim its otherwise orphaned key.
  if (receipt && !receipt.cancelled && !receipt.checkpointSaved && !receipt.companionCreated) await withBotProfileLocks([receipt.result.botId], async () => {
    receipt = await readReceipt(scope.root, requestId); scope.assert();
    if (!receipt || receipt.cancelled || receipt.checkpointSaved || receipt.companionCreated) return;
    const botId = receipt.result.botId;
    if (await companionEnvironmentStore.read(scope.root, botId, scope.assert)) return;
    try { await getBotRemoteResourceSource(botId); scope.assert(); return; }
    catch (error) { if (!(error instanceof Error) || !error.message.includes('[NOT_FOUND]')) throw error; }
    scope.assert();
    await companionEnvironmentStore.stageRemoval(scope.root, botId, scope.assert);
    await companionEnvironmentStore.finishRemoval(scope.root, botId, scope.assert);
  });
  // Upgrade earlier import bindings only from a durable successful receipt.
  // Failed/skipped active-source handovers must never become executable here.
  if (receipt && !receipt.cancelled && !receipt.handoverMarkers) await withBotProfileLocks([receipt.result.botId], async () => {
    receipt = await readReceipt(scope.root, requestId); scope.assert();
    if (!receipt || receipt.cancelled) return;
    const currentReceipt = receipt;
    const environment = await companionEnvironmentStore.read(scope.root, receipt.result.botId, scope.assert);
    const ready = Object.entries(receipt.routines).flatMap(([entryId, routine]) => {
      const binding = environment?.automations?.[routine.id];
      const status = currentReceipt.result.checks.find(check => check.entryId === entryId)?.status;
      return binding && binding.handover === undefined && routine.phase === 'complete'
        && (status === 'taken-over' || status === 'paused' && (binding.original.enabled === false || binding.original.state === 'paused')) ? [routine.id] : [];
    });
    if (ready.length) await companionEnvironmentStore.update(scope.root, receipt.result.botId, scope.assert, env => {
      for (const id of ready) if (env.automations?.[id]?.handover === undefined) env.automations![id]!.handover = 'ready';
    });
    if (receipt.result.status !== 'running') { receipt.handoverMarkers = true; await saveReceipt(scope.root, receipt); }
  });
  if (receipt && !receipt.cancelled && receipt.result.status === 'running' && !jobs.has(`${scope.scope}:${requestId}`)) {
    const environment = await companionEnvironmentStore.read(scope.root, receipt.result.botId, scope.assert);
    const pending = environment?.pendingImport;
    if (pending && pending.selection.requestId === requestId) {
      // Recovery already has a durable checkpoint; do not retain another preview.
      return startCompanionImport(pending.selection, `recovery:${scope.scope}`, true);
    }
    await withBotProfileLocks([receipt.result.botId], async () => {
      receipt = await readReceipt(scope.root, requestId); scope.assert();
      if (!receipt || receipt.cancelled) return;
      receipt.result.status = 'needs-attention';
      receipt.result.checks.push({ entryId: 'import', status: 'needs-attention', message: 'IMPORT_INTERRUPTED' });
      await saveReceipt(scope.root, receipt);
    });
  }
  return receipt?.result;
}

/** Explicit enable/run reuses the saved import retry, without a second settings UI. */
export async function ensureImportedAutomationReady(root: string, botId: string, routineId: string, assertOwner: () => void,
  request?: { input?: RoutineInput; expectedRevision?: number }): Promise<number | void> {
  assertOwner();
  const scope = owner();
  if (scope.root !== root) throw new CompanionImportError('OWNER_CHANGED');
  const environment = await companionEnvironmentStore.read(root, botId, assertOwner);
  const binding = environment?.automations?.[routineId];
  if (!binding) return;
  if (binding.issues?.length) throw new CompanionImportError(binding.issues[0]!);
  if (binding.handover === 'ready') return;
  const pending = environment?.pendingImport;
  if (!pending?.selection.takeover) throw new CompanionImportError('AUTOMATION_HANDOVER_REQUIRED');
  const current = (await routineTools.list(botId)).find(routine => routine.id === routineId); assertOwner();
  const expectedInput = current && JSON.stringify(parseRoutineInput({ ...current, enabled: false }));
  if (!current || request?.expectedRevision !== undefined && request.expectedRevision !== current.revision
    || request?.input && JSON.stringify(parseRoutineInput({ ...request.input, enabled: false })) !== expectedInput)
    throw new CompanionImportError('TARGET_AUTOMATION_CHANGED');
  await startCompanionImport(pending.selection, `routine:${routineId}`);
  await jobs.get(`${scope.scope}:${pending.selection.requestId}`);
  assertOwner(); scope.assert();
  await assertImportedAutomationReady(root, botId, routineId, assertOwner);
  const latest = (await routineTools.list(botId)).find(routine => routine.id === routineId); assertOwner();
  if (!latest || JSON.stringify(parseRoutineInput({ ...latest, enabled: false })) !== expectedInput)
    throw new CompanionImportError('TARGET_AUTOMATION_CHANGED');
  return latest.revision;
}

/** Main-owned work survives closing the import dialog. Repeated request IDs join the same work. */
export async function startCompanionImport(selection: CompanionImportSelection, controller: string, reconcileOnly = false): Promise<CompanionImportResult> {
  const scope = owner();
  if (!selection || typeof selection.previewId !== 'string') throw new CompanionImportError('INVALID_SELECTION');
  const rejected = await readReceipt(scope.root, selection.requestId); scope.assert();
  if (rejected?.creationRejected) return withBotProfileLocks([rejected.result.botId], () => cleanRejectedCreation(scope.root, rejected, scope.assert));
  let snapshot: ImportSnapshot;
  try { snapshot = owned(previews, selection.previewId, controller); }
  catch (error) {
    if (!(error instanceof CompanionImportError) || error.code !== 'PREVIEW_EXPIRED') throw error;
    const receipt = await readReceipt(scope.root, selection.requestId); scope.assert();
    const pending = receipt ? (await companionEnvironmentStore.read(scope.root, receipt.result.botId, scope.assert))?.pendingImport : undefined;
    const intentKey = (value: CompanionImportSelection) => fingerprint({ ...value, entryIds: [...value.entryIds].sort() });
    if (!pending || !Array.isArray(selection.entryIds) || intentKey(pending.selection) !== intentKey(selection)) throw error;
    snapshot = await deserializeImportSnapshotAsync(pending.snapshotJson, scope.assert);
  }
  const selected = validateImportSelection(selection, snapshot);
  if (selected.filter(item => item.view.category === 'skills').length > BOT_SKILL_MAX_COUNT) throw new CompanionImportError('INVALID_SELECTION');
  if (selection.avatarImageBase64 !== undefined) {
    try { decodeBotAvatarImage(selection.avatarImageBase64); } catch { throw new CompanionImportError('INVALID_SELECTION'); }
  }
  const contentSecrets = snapshot.publicationRedactions ?? Object.fromEntries([...new Set([
    ...Object.values(previewImportRedactions(snapshot.items)), ...Object.values(selectedImportRedactions(selected)),
  ])].map((value, index) => [`content_credential_${index}`, value]));
  const redactText = (text: string) => redactEnvironmentValues(text, contentSecrets);
  const publicRoutine = (input: RoutineInput): RoutineInput => ({ ...input, name: redactText(input.name), prompt: redactText(input.prompt) });
  let retainedRedactions = snapshot.publicationRedactions;
  // Resource capture finishes before saveCheckpoint; retain only selected embedded values.
  const publicationRedactions = (items: ImportSnapshot['items']) => retainedRedactions ??= retainedImportRedactions(items, contentSecrets);
  const skillSlug = (item: ImportSnapshot['items'][number]) => {
    const original = path.basename(item.sourceDirectory ?? item.view.name);
    if (redactText(original) !== original) return `import-${fingerprint(item.view.id).slice(0, 16)}`;
    const normalized = normalizeBotSkillSlug(original);
    return normalized === original ? original : `${normalized?.slice(0, 35) || 'import'}-${fingerprint(item.view.id).slice(0, 8)}`;
  };
  for (const role of ['identity', 'user', 'instructions'] as const) {
    const text = redactText(selected.filter(item => item.role === role).map(item => item.text).join('\n\n'));
    if (Buffer.byteLength(text, 'utf8') > BOT_PROFILE_TEXT_MAX_BYTES) throw new CompanionImportError('PROFILE_TEXT_TOO_LARGE');
  }
  const prior = await readReceipt(scope.root, selection.requestId); scope.assert();
  if (prior?.cancelled) return prior.result;
  if (!prior) {
    const profiles = await listBotRemoteResourceSources(); scope.assert();
    if (profiles.some(profile => profile.status !== 'archived' && normalizeBotName(profile.name) === normalizeBotName(selection.name))) throw new CompanionImportError('IMPORT_NAME_EXISTS');
  }
  const jobKey = `${scope.scope}:${selection.requestId}`;
  const running = jobs.get(jobKey);
  if (running) return accepted(running, scope.root, selection.requestId);
  const transferDeps: TransferDeps = {
    assertOwner: scope.assert,
    validateItems(items) {
      // Capturing lazily selected resources may grow even a rejected selection.
      const cached = previews.get(selection.previewId);
      if (cached?.value === snapshot) retainPreview(selection.previewId, cached);
      try {
        for (const item of items.filter(item => item.view.category === 'skills')) {
          const slug = skillSlug(item);
          validateBotSkillFiles(slug, projectImportedSkill(item.files ?? [], slug, contentSecrets).files);
        }
      } catch { throw new CompanionImportError('INVALID_SELECTION'); }
    },
    readReceipt: requestId => readReceipt(scope.root, requestId),
    saveReceipt: receipt => saveReceipt(scope.root, receipt),
    async createCompanion(botId, input) {
      try {
        const profile = await getBotRemoteResourceSource(botId); scope.assert();
        if (profile.status === 'deleting' || profile.status === 'archived') throw new CompanionImportError('IMPORT_CANCELLED');
        return;
      }
      catch (error) { if (!(error instanceof Error) || !error.message.includes('[NOT_FOUND]')) throw error; }
      try {
        await createBotProfile({ id: botId, name: input.name, description: '', avatarImageBase64: input.avatarImageBase64, prepareInvitation: false });
      } catch (error) {
        // Only a definite uniqueness conflict is retractable. Re-read the exact
        // ID first so a committed create with a lost acknowledgement is preserved.
        if (!(error instanceof Error) || !error.message.includes('[ALREADY_EXISTS]')) throw error;
        try { await getBotRemoteResourceSource(botId); scope.assert(); return; }
        catch (lookupError) { if (!(lookupError instanceof Error) || !lookupError.message.includes('[NOT_FOUND]')) throw lookupError; }
        scope.assert();
        throw new CompanionImportError('IMPORT_NAME_EXISTS');
      }
    },
    async importItem(botId, item) {
      if (item.view.category === 'skills') {
        const slug = skillSlug(item);
        await importBotSkillFiles(scope.root, botId, slug, projectImportedSkill(item.files ?? [], slug, contentSecrets).files, scope.assert);
      } else if (item.text && item.view.category === 'memory') {
        await getBotMemoryService().importDocument(botId, item.view.id, redactText(item.view.name), redactText(item.text), item.role === 'user' ? 'user' : 'reference');
      }
    },
    async saveCheckpoint(botId, items) {
      const previous = await companionEnvironmentStore.read(scope.root, botId, scope.assert);
      const pendingImport = { selection, snapshotJson: await serializeImportSnapshotAsync({ ...snapshot, avatarImageBase64: selection.avatarImageBase64, items, publicationRedactions: publicationRedactions(items) }, scope.assert) };
      if (previous) await companionEnvironmentStore.update(scope.root, botId, scope.assert, environment => { environment.pendingImport = pendingImport; });
      else await companionEnvironmentStore.write(scope.root, botId, { version: 1, env: {}, mcp: [], credentials: [], pendingImport }, scope.assert);
    },
    async saveEnvironment(botId, items) {
      const previous = await companionEnvironmentStore.read(scope.root, botId, scope.assert);
      const chosen = new Set(items.map(item => item.view.id));
      const env = selectedImportEnvironment(items);
      const resolveReferences = (value: unknown) => resolveImportReferences(value, env);
      const skillFiles = Object.fromEntries(items.filter(item => item.view.category === 'skills').flatMap(item => {
        const slug = skillSlug(item);
        const originals = projectImportedSkill(item.files ?? [], slug, contentSecrets).originals;
        return originals ? [[slug, originals]] : [];
      }));
      await companionEnvironmentStore.write(scope.root, botId, { version: 1, source: snapshot.source,
        env,
        mcp: items.flatMap(item => {
          if (!item.mcp || item.view.dependsOn?.some(id => !chosen.has(id)) || item.view.issues?.length) return [];
          const server = resolveReferences(item.mcp) as NonNullable<typeof item.mcp>;
          if (server.command && server.cwd !== undefined) {
            if (!server.cwd.trim() || server.cwd.includes('\0')) throw new CompanionImportError('SOURCE_CONFIG_INVALID');
            server.cwd = path.resolve(snapshot.source.workspace, server.cwd);
          }
          return [server];
        }),
        credentials: items.flatMap(item => item.credential && !item.view.dependsOn?.some(id => !chosen.has(id)) && (!item.view.issues?.length || item.credential.format !== 'telegram') ? [{ id: item.view.id, ...item.credential, ...(item.credential.format === 'telegram' ? { value: resolveReferences(item.credential.value) } : {}) }] : []),
        files: Object.fromEntries(items.flatMap(item => item.asset ? [[item.asset.name, item.asset.bytes.toString('base64')]] : [])),
        skillFiles,
        documents: Object.fromEntries(items.flatMap(item => item.text === undefined ? [] : [[item.view.id, item.text]])),
        contentRedactions: publicationRedactions(items),
        sourceAutomations: items.flatMap(item => item.automation ? [{ entryId: item.view.id, kind: snapshot.source.kind, original: item.automation.original }] : []),
        pendingImport: previous?.pendingImport ?? { selection, snapshotJson: await serializeImportSnapshotAsync({ ...snapshot, avatarImageBase64: selection.avatarImageBase64, items, publicationRedactions: publicationRedactions(items) }, scope.assert) },
        automations: previous?.automations ?? {},
      }, scope.assert);
      const roleText = (role: 'identity' | 'user' | 'instructions') => redactText(items.filter(item => item.role === role).map(item => item.text).join('\n\n'));
      const folder = await readBotProfileFolder(scope.root, botId); scope.assert();
      await writeBotProfileFolder(scope.root, botId, {
        config: { ...folder.config, mcpMode: 'allowlist', mcpServers: [...new Set([
          ...(Array.isArray(folder.config.mcpServers) ? folder.config.mcpServers : []),
          ...(items.some(item => item.mcp || item.env) || Object.keys(skillFiles).length ? ['companion_connections'] : []),
        ])] },
        ...(roleText('identity') ? { identitySource: roleText('identity') } : {}),
        ...(roleText('user') ? { userContextSource: roleText('user') } : {}),
        ...(roleText('instructions') ? { systemPromptOverride: roleText('instructions') } : {}),
      }); scope.assert();
      await reconcileBotProfileFolder(botId); scope.assert();
    },
    async createConversation(botId) {
      const source = await getBotRemoteResourceSource(botId); scope.assert();
      if (source.canonicalSessionId) return source.canonicalSessionId;
      const result = await createBotCanonicalSession({ botId, expectedCanonicalSessionId: null, expectedProfileVersion: source.currentVersion });
      scope.assert(); return result.canonicalSessionId;
    },
    async createRoutine(botId, input, creationId, item) {
      if (!item.automation) throw new CompanionImportError('SOURCE_AUTOMATION_INVALID');
      // createOnce uses creationId as its persisted routine ID. Publish the guard
      // first so there is no editor-visible window without a handover binding.
      await companionEnvironmentStore.update(scope.root, botId, scope.assert, environment => {
        environment.automations ??= {};
        environment.automations[creationId] ??= { kind: snapshot.source.kind,
          handover: item.view.enabled ? 'pending' : 'ready',
          original: item.automation!.original, sourceId: item.automation!.sourceId, sourceRoot: snapshot.source.root, deliveries: item.automation!.deliveries,
          issues: [...(item.view.issues ?? []), ...(item.view.dependsOn?.some(id => !selection.entryIds.includes(id)) ? ['AUTOMATION_DEPENDENCY_NOT_SELECTED'] : [])] };
      });
      const routine = await routineTools.createOnce(botId, publicRoutine(input), creationId); scope.assert();
      return routine.id;
    },
    verifyAutomation: (botId, item) => verifyImportedAutomation(scope.root, botId, item, scope.assert, selected, snapshot.source.root),
    pauseSource: (item, source, resumeInterruptedPause) => changeSourceAutomationState(source.source, item, false, readers(), scope.assert, resumeInterruptedPause, selectedImportEnvironment(selected)),
    resumeSource: (item, source) => changeSourceAutomationState(source.source, item, true, readers(), scope.assert, false, selectedImportEnvironment(selected)),
    async enableRoutine(botId, routineId, item) {
      const routine = (await routineTools.list(botId)).find(item => item.id === routineId); scope.assert();
      if (!routine) throw new CompanionImportError('AUTOMATION_NOT_FOUND');
      const binding = (await companionEnvironmentStore.read(scope.root, botId, scope.assert))?.automations?.[routineId];
      // The private activation committed even if its outer receipt was lost.
      // Preserve edits made after that success instead of restoring the source.
      if (binding?.handover === 'ready') return;
      if (!item.automation?.input || JSON.stringify(parseRoutineInput({ ...routine, enabled: false })) !== JSON.stringify(parseRoutineInput({ ...publicRoutine(item.automation.input), enabled: false }))) {
        throw new CompanionImportError(routine.enabled ? 'TARGET_HANDOVER_UNCERTAIN' : 'TARGET_AUTOMATION_CHANGED');
      }
      const expected = parseRoutineInput({ ...routine, enabled: true });
      if (!routine.enabled && expected.triggers.some(trigger => trigger.kind === 'once' && trigger.at <= Date.now())) throw new CompanionImportError('AUTOMATION_TIME_PASSED');
      // This private transaction is reached only after a confirmed source pause.
      // Ordinary saves remain guarded; execution waits for the durable ready bit.
      try { const engine = await getRoutineEngine(); scope.assert(); await engine.put(botId, expected, routineId, routine.revision); }
      catch (error) {
        // A committed enable with a lost acknowledgement must not resume the source as well.
        const saved = await routineTools.list(botId).then(rows => rows.find(item => item.id === routineId), () => { throw new CompanionImportError('TARGET_HANDOVER_UNCERTAIN'); }); scope.assert();
        if (saved?.enabled && JSON.stringify(parseRoutineInput(saved)) !== JSON.stringify(expected)) throw new CompanionImportError('TARGET_HANDOVER_UNCERTAIN');
        if (!saved || JSON.stringify(parseRoutineInput(saved)) !== JSON.stringify(expected)) throw error;
      }
      try {
        await companionEnvironmentStore.update(scope.root, botId, scope.assert, env => {
          const binding = env.automations?.[routineId];
          if (!binding) throw new CompanionImportError('AUTOMATION_NOT_FOUND');
          binding.handover = 'ready';
        });
      } catch {
        // The target was enabled. Keep the source paused if this acknowledgement
        // cannot be persisted; recovery retries it before any work is dispatched.
        throw new CompanionImportError('TARGET_HANDOVER_UNCERTAIN');
      }
    },
  };
  const task = (async () => {
    for (let pass = 0; ; pass++) {
      scope.assert();
      // Share deletion's existing profile lock. It joins every write (including
      // checkpoint cleanup) before removing the profile or its private environment.
      // Release between reconciliation passes so deletion can cancel retries.
      const botId = `import_${fingerprint(selection.requestId).slice(0, 24)}`;
      const result = await withBotProfileLocks([botId], async () => {
        scope.assert();
        const result = await transferCompanion(snapshot, selection, transferDeps, reconcileOnly || pass > 0);
        if (result.status === 'running' && pass >= 2) {
          const receipt = await readReceipt(scope.root, selection.requestId); scope.assert();
          if (receipt) { receipt.result.status = 'needs-attention'; await saveReceipt(scope.root, receipt); }
          result.status = 'needs-attention';
        }
        if (result.status === 'complete') await companionEnvironmentStore.update(scope.root, result.botId, scope.assert, env => { delete env.pendingImport; });
        return result;
      });
      if (result.status !== 'running') return result;
      // A native task can still be finishing when it is paused. Reconcile the
      // durable handover on the host even if the mobile link/dialog closes.
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  })().catch(async error => {
    scope.assert();
    return withBotProfileLocks([`import_${fingerprint(selection.requestId).slice(0, 24)}`], async () => {
      const receipt = await readReceipt(scope.root, selection.requestId);
      scope.assert();
      if (receipt?.cancelled) return receipt.result;
      if (receipt) {
        receipt.result.status = 'needs-attention';
        receipt.result.checks.push({ entryId: 'import', status: 'needs-attention', message: error instanceof CompanionImportError ? error.code : 'IMPORT_FAILED' });
        if (!receipt.companionCreated && error instanceof CompanionImportError && error.code === 'IMPORT_NAME_EXISTS') receipt.creationRejected = error.code;
        await saveReceipt(scope.root, receipt);
        if (receipt.creationRejected) return cleanRejectedCreation(scope.root, receipt, scope.assert);
        return receipt.result;
      }
      throw error;
    });
  }).finally(() => { if (jobs.get(jobKey) === task) jobs.delete(jobKey); });
  jobs.set(jobKey, task);
  return accepted(task, scope.root, selection.requestId);
}

async function accepted(task: Promise<CompanionImportResult>, root: string, requestId: string): Promise<CompanionImportResult> {
  // Acceptance requires a recoverable selection AND a created profile. Before
  // that point definitive name conflicts must reject/unlock the existing form.
  let finished = false;
  void task.then(() => { finished = true; }, () => { finished = true; });
  const receipt = (async () => {
    while (!finished) {
      const value = await readReceipt(root, requestId);
      if (value && (value.companionCreated || value.environmentSaved)) return value.result;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    return task;
  })();
  return Promise.race([task, receipt]);
}
