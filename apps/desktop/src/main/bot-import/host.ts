import { normalizeBotToolCapabilities } from '../../shared/botCapabilitySelection.js';
import { companionImportReasonKey } from '@cindy/maker-shared/companion-import';
import { createMessage } from '../localDb/ipc/messages.js';
import { t } from '../i18n.js';
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
import { COMPANION_IMPORT_CHUNK_LENGTH, COMPANION_IMPORT_READ_MAX_LENGTH, COMPANION_IMPORT_SELECTION_CHUNK_LENGTH } from '@cindy/maker-shared/companion-import';
import type { CompanionImportPreview, CompanionImportResult, CompanionImportSelection, CompanionImportSubmission, CompanionImportSource } from '@cindy/maker-shared/companion-import';
import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { createBotCanonicalSession, createBotProfile, getBotMemoryService, getBotRemoteResourceSource, reconcileBotProfileFolder } from '../localDb/ipc/bots.js';
import { readBotProfileFolder, writeBotProfileFolder, BOT_PROFILE_TEXT_MAX_BYTES } from '../maker-ipc/botProfileFolder.js';
import { splitImportedMemoryText } from '../maker-ipc/botMemoryService.js';
import { memoryFileContent } from './memoryFiles.js';
import { importBotSkillFiles, normalizeBotSkillSlug, validateBotSkillFiles } from '../maker-ipc/botSkillStore.js';
import { withBotProfileLocks } from '../maker-ipc/botProfileLock.js';
import { getRoutineEngine, routineTools, updateBotRoutineLifecycle } from '../routines/service.js';
import { previewImportRedactions, retainedImportRedactions, resolveImportReferences, selectedImportEnvironment, selectedImportRedactions } from './environmentSelection.js';
import { createEnvironmentRedactor } from './process.js';
import { importedContentRedactions } from './connectionCatalog.js';
import { createImportSourceReader, discoverImportSources, inspectImportSource, type SourceReaderDeps } from './sources.js';
import { readOpenClawCronDatabase } from './openclawCron.js';
import { companionEnvironmentStore, recoverCompanionEnvironmentRemovals } from './runtime.js';
import { deserializeImportSnapshotAsync, fingerprint, serializeImportSnapshotAsync, reserveSnapshotItems, MAX_SNAPSHOT_BYTES } from './files.js';
import { transferCompanion, validateImportSelection, validateImportRequestIdentity, type ImportReceipt, type TransferDeps } from './transfer.js';
import { CompanionImportError, type ImportItem, type ImportSnapshot, type ImportSource } from './types.js';
import { changeSourceAutomationState } from './takeover.js';
import { verifyImportedAutomation } from './verification.js';
import { importMemoryMedia } from './memoryMedia.js';
import { projectImportedSkill } from './skillResources.js';
import { assertImportedAutomationReady } from './automationRuntime.js';

interface Owned<T> { owner: string; controller: string; value: T; createdAt: number }
const sources = new Map<string, Owned<ImportSource>>();
const previews = new Map<string, Owned<ImportSnapshot> & { bytes: number }>();
const remoteReads = new Map<string, Owned<string>>();
const remoteSelections = new Map<string, Owned<{ parts: string[]; offset: number; total: number }>>();
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
async function retainPreview(id: string, entry: Owned<ImportSnapshot>, assertOwner: () => void, refresh = false) {
  let bytes = Buffer.byteLength(JSON.stringify({ ...entry.value, items: undefined }));
  const reserve = (size: number) => {
    bytes += size;
    if (bytes > MAX_SNAPSHOT_BYTES) throw new CompanionImportError('SOURCE_SNAPSHOT_TOO_LARGE');
  };
  await reserveSnapshotItems(entry.value.items, { reserve, reserveFile: reserve }, assertOwner);
  if (bytes > MAX_SNAPSHOT_BYTES) throw new CompanionImportError('SOURCE_SNAPSHOT_TOO_LARGE');
  if (refresh && previews.get(id) !== entry) return;
  previews.delete(id);
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
  const inspected = await inspectImportSource(source, readers()); scope.assert();
  const snapshot = { ...inspected, items: inspected.items.map((item, index) => ({ ...item, sourceIndex: index })) };
  if (snapshot.avatarImageBase64) {
    const buffer = Buffer.from(snapshot.avatarImageBase64, 'base64');
    validateBotAvatarBuffer(buffer);
    snapshot.avatarImageBase64 = (await sharp(buffer, { limitInputPixels: 40_000_000 }).resize(256, 256, { fit: 'cover' }).jpeg({ quality: 65 }).toBuffer()).toString('base64');
    scope.assert();
  }
  const id = randomUUID();
  await retainPreview(id, { owner: scope.scope, controller, value: snapshot, createdAt: Date.now() }, scope.assert);
  const secrets = previewImportRedactions(snapshot.items);
  const redact = createEnvironmentRedactor(secrets);
  return { id, selectionRanges: true, selectionChunks: true, source: { id: sourceId, kind: source.kind, name: redact(source.name) }, name: redact(source.name),
    ...(snapshot.avatarImageBase64 ? { avatarImageBase64: snapshot.avatarImageBase64 } : {}),
    entries: snapshot.items.map(({ view }) => ({ ...view, name: redact(view.name),
      ...(view.description === undefined ? {} : { description: redact(view.description) }) })) };
}

/** Freeze each public read while transferring it; never re-inspect a source between chunks.
 * UTF-16 slices are at most 1.5 MiB after JSON escaping, well below a 2 MiB frame. */
export async function readRemoteCompanionImport(id: string, controller: string, chunked: boolean): Promise<Record<string, unknown>> {
  const scope = owner();
  const chunk = (token: string, text: string, offset: number) => ({
    chunk: { id: token, offset, total: text.length, text: text.slice(offset, offset + COMPANION_IMPORT_CHUNK_LENGTH) },
  });
  if (id.startsWith('chunk:')) {
    const match = /^chunk:([a-zA-Z0-9-]{1,64}):(0|[1-9][0-9]*)$/.exec(id);
    if (!chunked || !match) throw new CompanionImportError('INVALID_REQUEST');
    const text = owned(remoteReads, match[1]!, controller);
    const offset = Number(match[2]);
    if (!Number.isSafeInteger(offset) || offset >= text.length || offset % COMPANION_IMPORT_CHUNK_LENGTH) throw new CompanionImportError('INVALID_REQUEST');
    return chunk(match[1]!, text, offset);
  }
  const data = id === 'sources' ? { sources: await listCompanionImportSources(controller) }
    : id.startsWith('preview:') ? { preview: await previewCompanionImport(id.slice(8), controller) }
      : id.startsWith('result:') ? { result: await getCompanionImportResult(id.slice(7)) ?? null } : undefined;
  scope.assert();
  if (!data) throw new CompanionImportError('INVALID_REQUEST');
  const text = JSON.stringify(data);
  if (!chunked) {
    // Keep the original shape for older controllers, with room for the resource
    // and invoke envelopes inside a 2 MiB frame. Never silently omit entries.
    if (Buffer.byteLength(text) > 1.5 * 1024 * 1024) throw new CompanionImportError('IMPORT_CLIENT_UPGRADE_REQUIRED');
    return data;
  }
  if (text.length <= COMPANION_IMPORT_CHUNK_LENGTH) return data;
  if (text.length > COMPANION_IMPORT_READ_MAX_LENGTH || text.length * 2 > MAX_SNAPSHOT_BYTES) throw new CompanionImportError('SOURCE_SNAPSHOT_TOO_LARGE');
  prune(remoteReads);
  for (const [key, entry] of remoteReads) if (entry.controller === controller) remoteReads.delete(key);
  let bytes = [...remoteReads.values()].reduce((sum, entry) => sum + entry.value.length * 2, 0);
  for (const [key, entry] of remoteReads) {
    if (remoteReads.size < 4 && bytes + text.length * 2 <= MAX_SNAPSHOT_BYTES) break;
    remoteReads.delete(key); bytes -= entry.value.length * 2;
  }
  const token = randomUUID();
  remoteReads.set(token, { owner: scope.scope, controller, value: text, createdAt: Date.now() });
  return chunk(token, text, 0);
}

/** No import side effects until the entire selection arrives. A reconnect replays
 * chunks from zero under the same request ID, then uses normal durable recovery. */
export async function submitRemoteCompanionImport(input: CompanionImportSubmission, controller: string): Promise<CompanionImportResult | undefined> {
  const scope = owner();
  if (!input || typeof input !== 'object' || !('selectionChunk' in input)) return startCompanionImport(input as CompanionImportSelection, controller);
  const chunk = input.selectionChunk;
  if (!chunk || typeof chunk.id !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(chunk.id)
    || !Number.isSafeInteger(chunk.offset) || chunk.offset < 0 || chunk.offset % COMPANION_IMPORT_SELECTION_CHUNK_LENGTH
    || !Number.isSafeInteger(chunk.total) || chunk.total <= 0 || chunk.total * 2 > MAX_SNAPSHOT_BYTES
    || typeof chunk.text !== 'string' || !chunk.text.length || chunk.text.length > COMPANION_IMPORT_SELECTION_CHUNK_LENGTH
    || chunk.offset + chunk.text.length > chunk.total
    || chunk.offset + chunk.text.length < chunk.total && chunk.text.length !== COMPANION_IMPORT_SELECTION_CHUNK_LENGTH)
    throw new CompanionImportError('INVALID_SELECTION');
  prune(remoteSelections);
  const key = JSON.stringify([scope.scope, controller, chunk.id]);
  if (!remoteSelections.has(key)) {
    if (chunk.offset !== 0) throw new CompanionImportError('PREVIEW_EXPIRED');
    for (const [id, prior] of remoteSelections) if (prior.controller === controller) remoteSelections.delete(id);
    let bytes = [...remoteSelections.values()].reduce((sum, prior) => sum + prior.value.total * 2, 0);
    for (const [id, prior] of remoteSelections) {
      if (remoteSelections.size < 4 && bytes + chunk.total * 2 <= MAX_SNAPSHOT_BYTES) break;
      remoteSelections.delete(id); bytes -= prior.value.total * 2;
    }
    remoteSelections.set(key, { owner: scope.scope, controller, createdAt: Date.now(), value: { parts: [], offset: 0, total: chunk.total } });
  }
  const upload = owned(remoteSelections, key, controller);
  if (upload.total !== chunk.total || chunk.offset > upload.offset) throw new CompanionImportError('INVALID_SELECTION');
  if (chunk.offset < upload.offset) {
    if (upload.parts[chunk.offset / COMPANION_IMPORT_SELECTION_CHUNK_LENGTH] !== chunk.text) throw new CompanionImportError('REQUEST_ALREADY_USED');
    return undefined;
  }
  upload.parts.push(chunk.text); upload.offset += chunk.text.length;
  if (upload.offset < upload.total) return undefined;
  const text = upload.parts.join('');
  upload.parts.length = 0; remoteSelections.delete(key);
  let selection: CompanionImportSelection;
  try { selection = JSON.parse(text); } catch { throw new CompanionImportError('INVALID_SELECTION'); }
  if (!selection || selection.requestId !== chunk.id) throw new CompanionImportError('INVALID_SELECTION');
  return startCompanionImport(selection, controller);
}

function documentEntries(item: ImportItem): Array<[string, string]> {
  return [...(item.text === undefined ? [] : [[item.view.id, item.text] as [string, string]]),
    ...(item.documents ?? []).map(document => [document.id, document.text] as [string, string])];
}

function isMemoryItem(item: ImportItem): boolean {
  return item.view.category === 'memory' || item.view.category === 'personality';
}

function memoryFileEntries(item: ImportItem): Array<[string, string]> {
  if (!isMemoryItem(item)) return [];
  // Managed media is owned by the ledger and referenced by imported memory.
  // Failed attachments remain in pendingImport until they can be retried.
  return [...(item.asset ? [item.asset] : []), ...item.files ?? []]
    .filter(file => memoryFileContent({ ...file, executable: false }).kind !== 'attachment')
    .map(file => [file.name, file.bytes.toString('base64')]);
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
  const contents = JSON.stringify(receipt);
  atomicWriteFileSync(file, contents);
  return Buffer.byteLength(contents);
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

/** Caller holds the profile lock; acknowledge only after cleanup has committed. */
async function clearCompletedCheckpoint(root: string, receipt: ImportReceipt, assertOwner: () => void) {
  if (receipt.cancelled || receipt.result.status !== 'complete' || receipt.checkpointCleared) return;
  const { botId, requestId } = receipt.result;
  const environment = await companionEnvironmentStore.read(root, botId, assertOwner);
  if (environment?.pendingImport?.selection.requestId === requestId) await companionEnvironmentStore.update(root, botId, assertOwner, env => {
    if (env.pendingImport?.selection.requestId === requestId) delete env.pendingImport;
  });
  assertOwner();
  receipt.checkpointCleared = true;
  await saveReceipt(root, receipt); assertOwner();
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
  if (receipt?.result.status === 'complete' && !receipt.cancelled && !receipt.checkpointCleared) await withBotProfileLocks([receipt.result.botId], async () => {
    const latest = await readReceipt(scope.root, requestId); scope.assert();
    if (latest) await clearCompletedCheckpoint(scope.root, latest, scope.assert);
  });
  return receipt?.result;
}

function setupEntryNames(items: ImportItem[], redact: (text: string) => string): Record<string, string> {
  // A display-only caption, never the original Skill/persona/file name. Redact
  // before clipping so a partial credential cannot escape into the receipt.
  return Object.fromEntries(items.map(item => [item.view.id, redact(item.view.name).slice(0, 200)]));
}

/** Status uses public receipt metadata, not the encrypted source tree or attachment buffers. */
export async function getCompanionImportSetupStatus(botId: string, root: string, assertOwner: () => void, offset: number) {
  assertOwner();
  const scope = owner();
  if (scope.root !== root) throw new CompanionImportError('OWNER_CHANGED');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new CompanionImportError('INVALID_SELECTION');
  let requestId = companionEnvironmentStore.readImportRequestId(root, botId, assertOwner);
  let receipt = requestId ? await readReceipt(root, requestId) : undefined;
  assertOwner();
  if (receipt && receipt.result.botId !== botId) throw new CompanionImportError('INVALID_COMPANION');
  if (requestId === undefined || receipt && !receipt.entryNames) await withBotProfileLocks([botId], async () => {
    // Legacy checkpoints pay this cost once. Recheck under the same lock used by
    // import/retry so a status migration cannot overwrite a newer receipt.
    requestId = companionEnvironmentStore.readImportRequestId(root, botId, assertOwner);
    receipt = requestId ? await readReceipt(root, requestId) : undefined;
    assertOwner();
    if (receipt && receipt.result.botId !== botId) throw new CompanionImportError('INVALID_COMPANION');
    if (requestId !== undefined && (!receipt || receipt.entryNames)) return;
    const environment = await companionEnvironmentStore.read(root, botId, assertOwner);
    const pending = environment?.pendingImport;
    if (pending) {
      requestId = pending.selection.requestId;
      receipt = await readReceipt(root, requestId); assertOwner();
      if (receipt && receipt.result.botId !== botId) throw new CompanionImportError('INVALID_COMPANION');
      if (receipt && !receipt.entryNames) {
        const snapshot = await deserializeImportSnapshotAsync(pending.snapshotJson, assertOwner);
        const secrets = Object.fromEntries([...new Set([
          ...Object.values(importedContentRedactions(environment)), ...Object.values(previewImportRedactions(snapshot.items)),
          ...Object.values(snapshot.publicationRedactions ?? {}),
        ])].map((value, index) => [`setup_credential_${index}`, value]));
        receipt.entryNames = setupEntryNames(snapshot.items, createEnvironmentRedactor(secrets));
        await saveReceipt(root, receipt); assertOwner();
      }
    } else requestId = null;
    // Rewriting through the serialized store upgrades only metadata; the latest
    // encrypted environment is preserved, including concurrent routine changes.
    if (environment) await companionEnvironmentStore.update(root, botId, assertOwner, () => {});
  });
  assertOwner();
  if (!requestId) return { complete: true };
  const result = await getCompanionImportResult(requestId); assertOwner();
  if (result && result.botId !== botId) throw new CompanionImportError('INVALID_COMPANION');
  // Recovery may have refreshed names/checks. Read its durable public metadata.
  receipt = await readReceipt(root, requestId); assertOwner();
  if (receipt && receipt.result.botId !== botId) throw new CompanionImportError('INVALID_COMPANION');
  let total = 0;
  const items: Array<CompanionImportResult['checks'][number] & { name?: string }> = [];
  for (const check of result?.checks ?? []) if (check.status === 'needs-attention') {
    if (total >= offset && items.length < 20) items.push({ ...check, name: receipt?.entryNames?.[check.entryId] });
    total++;
  }
  return { status: result?.status, total, nextOffset: offset + items.length < total ? offset + items.length : undefined, items };
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
  await startCompanionImport(pending.selection, `routine:${routineId}`, false, true);
  await jobs.get(`${scope.scope}:${pending.selection.requestId}`);
  assertOwner(); scope.assert();
  await assertImportedAutomationReady(root, botId, routineId, assertOwner);
  const latest = (await routineTools.list(botId)).find(routine => routine.id === routineId); assertOwner();
  if (!latest || JSON.stringify(parseRoutineInput({ ...latest, enabled: false })) !== expectedInput)
    throw new CompanionImportError('TARGET_AUTOMATION_CHANGED');
  return latest.revision;
}

/** Main-owned work survives closing the import dialog. Repeated request IDs join the same work. */
export async function startCompanionImport(selection: CompanionImportSelection, controller: string, reconcileOnly = false, resumeSetup = false): Promise<CompanionImportResult> {
  const scope = owner();
  if (!selection || typeof selection.previewId !== 'string') throw new CompanionImportError('INVALID_SELECTION');
  const rejected = await readReceipt(scope.root, selection.requestId); scope.assert();
  if (rejected?.cancelled) return rejected.result;
  if (rejected?.creationRejected) return withBotProfileLocks([rejected.result.botId], () => cleanRejectedCreation(scope.root, rejected, scope.assert));
  let snapshot: ImportSnapshot;
  try {
    // Once accepted, the durable selected snapshot is authoritative, including failed captures.
    if (rejected?.checkpointSaved && rejected.result.status !== 'complete') throw new CompanionImportError('PREVIEW_EXPIRED');
    snapshot = owned(previews, selection.previewId, controller);
  }
  catch (error) {
    if (!(error instanceof CompanionImportError) || error.code !== 'PREVIEW_EXPIRED') throw error;
    const receipt = await readReceipt(scope.root, selection.requestId); scope.assert();
    const pending = receipt ? (await companionEnvironmentStore.read(scope.root, receipt.result.botId, scope.assert))?.pendingImport : undefined;
    const intentKey = (value: CompanionImportSelection) => fingerprint([value.requestId, value.previewId, value.name, value.avatarImageBase64,
      [...value.entryIds].sort(), value.entryRanges, value.takeover, value.deferSetup === true]);
    if (!pending || !Array.isArray(selection.entryIds)) throw error;
    if (intentKey(pending.selection) !== intentKey(selection)) throw new CompanionImportError('REQUEST_ALREADY_USED');
    snapshot = await deserializeImportSnapshotAsync(pending.snapshotJson, scope.assert);
  }
  const selected = validateImportSelection(selection, snapshot);
  if (selection.avatarImageBase64 !== undefined) {
    try { decodeBotAvatarImage(selection.avatarImageBase64); } catch { throw new CompanionImportError('INVALID_SELECTION'); }
  }
  // A failed resource is read afresh on retry. Refresh masking metadata as well,
  // without retaining unselected credential values that never occur in selected content.
  const freshMasks = snapshot.publicationRedactions && selected.some(item => item.captureIssue)
    ? await createImportSourceReader(readers()).readRedactions(snapshot.source) : {};
  scope.assert();
  const contentSecrets = snapshot.publicationRedactions ? { ...snapshot.publicationRedactions }
    : Object.fromEntries(Object.values(previewImportRedactions(snapshot.items)).map((value, index) => [`content_credential_${index}`, value]));
  const knownValues = new Set(Object.values(contentSecrets));
  let nextMask = 0;
  for (const value of [...Object.values(selectedImportRedactions(selected)), ...Object.values(freshMasks)]) {
    if (knownValues.has(value)) continue;
    while (`content_retry_${nextMask}` in contentSecrets) nextMask++;
    contentSecrets[`content_retry_${nextMask++}`] = value;
    knownValues.add(value);
  }
  let redactText = createEnvironmentRedactor(contentSecrets);
  const publicRoutine = (input: RoutineInput): RoutineInput => ({ ...input, name: redactText(input.name), prompt: redactText(input.prompt) });
  // Resource capture finishes before saveCheckpoint; retain only selected embedded values.
  const publicationRedactions = (items: ImportSnapshot['items']) => retainedImportRedactions(items, contentSecrets);
  let entryNames = setupEntryNames(selected, redactText);
  const skillSlug = (item: ImportSnapshot['items'][number]) => {
    const original = item.view.name;
    if (redactText(original) !== original) return `import-${fingerprint(item.view.id).slice(0, 16)}`;
    const normalized = normalizeBotSkillSlug(original);
    return normalized === original ? original : `${normalized?.slice(0, 35) || 'import'}-${fingerprint(item.view.id).slice(0, 8)}`;
  };
  const prior = await readReceipt(scope.root, selection.requestId); scope.assert();
  if (prior?.cancelled) return prior.result;
  // Completed entries may be skipped after a crash before environmentSaved.
  // Partial entries contribute only documents completed during this attempt.
  const previouslyCopied = new Set(prior?.copied);
  const completedDocumentIds = new Set(selected.filter(item => previouslyCopied.has(item.view.id))
    .flatMap(item => documentEntries(item).map(([id]) => id)));
  const readLegacyDeferSetup = async (botId: string) => {
    const pending = (await companionEnvironmentStore.read(scope.root, botId, scope.assert))?.pendingImport;
    return pending ? pending.selection.deferSetup === true : undefined;
  };
  await validateImportRequestIdentity(snapshot, selection, prior, readLegacyDeferSetup); scope.assert();
  if (!prior) {
    const profiles = await listBotRemoteResourceSources(); scope.assert();
    if (profiles.some(profile => profile.status !== 'archived' && normalizeBotName(profile.name) === normalizeBotName(selection.name))) throw new CompanionImportError('IMPORT_NAME_EXISTS');
  }
  const jobKey = `${scope.scope}:${selection.requestId}`;
  const running = jobs.get(jobKey);
  if (running) return accepted(running, scope.root, selection.requestId);
  let skillConfigReader: { budget: Parameters<NonNullable<TransferDeps['readSkillConfig']>>[1]; reader: ReturnType<typeof createImportSourceReader> } | undefined;
  const applyProfile = async (botId: string, items: ImportItem[], baseline?: Record<string, string>, originals?: Record<string, string>) => {
    const roleText = (role: 'identity' | 'user' | 'instructions', originals?: Record<string, string>) => {
      const text = redactText(items.flatMap(item => [...(item.role === role ? [originals ? originals[item.view.id] : item.text] : []), ...(item.documents ?? []).filter(document => document.role === role).map(document => originals ? originals[document.id] : document.text)]).filter((value): value is string => typeof value === 'string').join('\n\n'));
      if (Buffer.byteLength(text, 'utf8') <= BOT_PROFILE_TEXT_MAX_BYTES) return text;
      // Keep the original profile text without synthesizing new system instructions.
      // The entire source remains in personal memory and the encrypted document archive.
      let bytes = 0, end = 0;
      for (const char of text) {
        bytes += Buffer.byteLength(char, 'utf8');
        if (bytes > BOT_PROFILE_TEXT_MAX_BYTES) break;
        end += char.length;
      }
      return text.slice(0, end);
    };
    const folder = await readBotProfileFolder(scope.root, botId); scope.assert();
    const fields = { identity: 'identitySource', user: 'userContextSource', instructions: 'systemPromptOverride' } as const;
    const patch: { identitySource?: string; userContextSource?: string; systemPromptOverride?: string } = {};
    for (const [role, field] of Object.entries(fields) as Array<[keyof typeof fields, typeof fields[keyof typeof fields]]>) {
      const text = roleText(role, originals);
      if (!text || baseline && text === roleText(role, baseline)) continue;
      if (baseline && (folder[field] ?? '') !== roleText(role, baseline) && folder[field] !== text) throw new CompanionImportError('PROFILE_CHANGED');
      patch[field] = text;
    }
    if (!baseline || Object.keys(patch).length) {
      await writeBotProfileFolder(scope.root, botId, {
        config: baseline ? folder.config : { ...normalizeBotToolCapabilities(folder.config), mcpServers: [...new Set([
          ...(Array.isArray(folder.config.mcpServers) ? folder.config.mcpServers : []), 'companion_connections',
        ])] }, ...patch,
      }); scope.assert();
      await reconcileBotProfileFolder(botId); scope.assert();
    }
  };
  const transferDeps: TransferDeps = {
    assertOwner: scope.assert,
    async validateItems(items) {
      // Repaired manifests can reveal credentials that were unavailable at preview time.
      const previousMaskCount = knownValues.size;
      for (const value of Object.values(selectedImportRedactions(items))) {
        if (knownValues.has(value)) continue;
        while (`content_retry_${nextMask}` in contentSecrets) nextMask++;
        contentSecrets[`content_retry_${nextMask++}`] = value; knownValues.add(value);
      }
      if (knownValues.size !== previousMaskCount) redactText = createEnvironmentRedactor(contentSecrets);
      // Capturing lazily selected resources may grow even a rejected selection.
      const cached = previews.get(selection.previewId);
      if (cached?.value === snapshot) await retainPreview(selection.previewId, cached, scope.assert, true);
      for (const item of items.filter(item => item.view.category === 'skills' && !item.captureIssue)) {
        try {
          const slug = skillSlug(item);
          validateBotSkillFiles(slug, projectImportedSkill(item.files ?? [], slug, contentSecrets).files);
        } catch { item.captureIssue = 'IMPORT_ITEM_FAILED'; }
      }
    },
    readReceipt: requestId => readReceipt(scope.root, requestId),
    readLegacyDeferSetup,
    readSkillConfig(source, budget) {
      if (skillConfigReader?.budget !== budget) skillConfigReader = { budget, reader: createImportSourceReader(readers(), budget) };
      return skillConfigReader.reader.readConfig(path.dirname(source.configFile), source.configFile);
    },
    saveReceipt: receipt => { receipt.entryNames = entryNames; return saveReceipt(scope.root, receipt); },
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
      let pendingFailure: Error | undefined;
      let persistedItem = item;
      if (item.view.category === 'skills') {
        const slug = skillSlug(item);
        const projected = projectImportedSkill(item.files ?? [], slug, contentSecrets);
        await importBotSkillFiles(scope.root, botId, slug, projected.files, scope.assert, item.view.enabled !== false);
      } else if (isMemoryItem(item)) {
        const documents = [...(item.text ? [{ id: item.view.id, name: item.view.name, text: item.text, role: item.role }] : []), ...item.documents ?? []];
        const attachments = [...(item.asset ? [item.asset] : []), ...(item.files ?? [])];
        let firstFailure: unknown; let failedAttachments = 0;
        for (const file of attachments) {
          try {
            // Old checkpoints may classify textual memory as an attachment.
            const content = memoryFileContent({ ...file, executable: false });
            if (content.kind === 'empty') continue;
            if (content.kind === 'text') {
              documents.push({ id: `memory-${fingerprint([item.view.id, file.name]).slice(0, 32)}`, name: file.name, text: content.text, role: undefined });
              continue;
            }
            const sessionId = await transferDeps.createConversation(botId);
            const url = await importMemoryMedia(botId, sessionId, file.bytes, scope.assert);
            documents.push({ id: `memory-${fingerprint([item.view.id, file.name]).slice(0, 32)}`, name: file.name,
              text: `![${redactText(file.name).replace(/[\[\]\r\n]/g, '')}](${url})`, role: undefined });
          } catch (error) {
            scope.assert();
            firstFailure ??= error; failedAttachments++;
          }
        }
        let total = failedAttachments, saved = 0;
        const savedDocuments = new Set<string>();
        for (const document of documents) {
          let parts = 1; total++;
          try {
            scope.assert();
            const text = redactText(document.text);
            parts = splitImportedMemoryText(text).length;
            total += parts - 1;
            await getBotMemoryService().importDocument(botId, document.id, redactText(document.name), text, document.role === 'user' ? 'user' : 'reference');
            saved += parts; savedDocuments.add(document.id);
            completedDocumentIds.add(document.id);
          } catch (error) {
            scope.assert();
            const progress = (error as { importProgress?: { saved: number; total: number } })?.importProgress;
            if (progress) { saved += progress.saved; total += progress.total - parts; }
            firstFailure ??= error;
          }
        }
        if (firstFailure) {
          const error = firstFailure instanceof Error ? firstFailure : new CompanionImportError('IMPORT_ITEM_FAILED');
          pendingFailure = Object.assign(error, { importProgress: { saved, total } });
          // Failed siblings remain in the encrypted checkpoint. Only documents
          // saved in full may advance the profile projection and its baseline.
          persistedItem = { ...item, text: savedDocuments.has(item.view.id) ? item.text : undefined,
            documents: item.documents?.filter(document => savedDocuments.has(document.id)) };
        }
      }
      if (prior?.environmentSaved && (item.role || item.documents?.some(document => document.role))) {
        const environment = await companionEnvironmentStore.read(scope.root, botId, scope.assert);
        const previous = environment?.documents ?? {};
        await applyProfile(botId, selected.map(candidate => candidate.view.id === item.view.id ? item : candidate), previous,
          { ...previous, ...Object.fromEntries(documentEntries(persistedItem)) });
      }
      if (prior?.environmentSaved) await companionEnvironmentStore.update(scope.root, botId, scope.assert, environment => {
        // A formerly unreadable manifest may only now supply its own settings.
        if (item.env) environment.env = { ...environment.env, ...item.env };
        if (isMemoryItem(item)) {
          environment.memoryFiles = { ...environment.memoryFiles, ...Object.fromEntries(memoryFileEntries(item)) };
          // A successful retry may upgrade an earlier mixed execution archive.
          // Remove only the exact copy whose original has just been preserved.
          for (const file of [...(item.asset ? [item.asset] : []), ...item.files ?? []]) {
            if (environment.files?.[file.name] === file.bytes.toString('base64')) {
              delete environment.files[file.name];
              delete environment.fileExecutables?.[file.name];
            }
          }
        } else if (item.asset) {
          environment.files = { ...environment.files, [item.asset.name]: item.asset.bytes.toString('base64') };
          environment.fileExecutables = { ...environment.fileExecutables, [item.asset.name]: item.asset.executable === true };
        }
        if (item.credential) environment.credentials = [...environment.credentials.filter(value => value.id !== item.view.id), { id: item.view.id, ...item.credential }];
        for (const [id, text] of documentEntries(persistedItem)) { environment.documents ??= {}; environment.documents[id] = text; }
        if (item.view.category === 'skills') {
          const slug = skillSlug(item);
          const originals = projectImportedSkill(item.files ?? [], slug, contentSecrets).originals;
          if (originals) { environment.skillFiles ??= {}; environment.skillFiles[slug] = originals; }
        }
        environment.contentRedactions = { ...environment.contentRedactions, ...publicationRedactions([item]) };
      });
      if (pendingFailure) throw pendingFailure;
    },
    async saveCheckpoint(botId, items) {
      const previous = await companionEnvironmentStore.read(scope.root, botId, scope.assert);
      entryNames = setupEntryNames(items, redactText);
      const pendingImport = { selection, snapshotJson: await serializeImportSnapshotAsync({ ...snapshot, avatarImageBase64: selection.avatarImageBase64, items, publicationRedactions: publicationRedactions(items) }, scope.assert) };
      if (previous) await companionEnvironmentStore.update(scope.root, botId, scope.assert, environment => { environment.pendingImport = pendingImport; });
      else await companionEnvironmentStore.write(scope.root, botId, { version: 1, env: {}, mcp: [], credentials: [], pendingImport }, scope.assert);
    },
    async saveEnvironment(botId, items) {
      const previous = await companionEnvironmentStore.read(scope.root, botId, scope.assert);
      const roleDocumentIds = new Set(items.flatMap(item => [...(item.role ? [item.view.id] : []),
        ...(item.documents ?? []).filter(document => document.role).map(document => document.id)]));
      // Failed role originals remain in pendingImport, not in the applied
      // profile or its retry baseline. Keep healthy children of partial items.
      const documents = Object.fromEntries(items.flatMap(documentEntries)
        .filter(([id]) => !roleDocumentIds.has(id) || completedDocumentIds.has(id)));
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
        files: Object.fromEntries(items.flatMap(item => item.asset && !isMemoryItem(item) ? [[item.asset.name, item.asset.bytes.toString('base64')]] : [])),
        fileExecutables: Object.fromEntries(items.flatMap(item => item.asset && !isMemoryItem(item) ? [[item.asset.name, item.asset.executable === true]] : [])),
        memoryFiles: Object.fromEntries(items.flatMap(memoryFileEntries)),
        skillFiles,
        documents,
        contentRedactions: publicationRedactions(items),
        sourceAutomations: items.flatMap(item => item.automation ? [{ entryId: item.view.id, kind: snapshot.source.kind, original: item.automation.original }] : []),
        pendingImport: previous?.pendingImport ?? { selection, snapshotJson: await serializeImportSnapshotAsync({ ...snapshot, avatarImageBase64: selection.avatarImageBase64, items, publicationRedactions: publicationRedactions(items) }, scope.assert) },
        automations: previous?.automations ?? {},
      }, scope.assert);
      await applyProfile(botId, items, undefined, documents);
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
          original: item.automation!.original, sourceId: item.automation!.sourceId, sourceRoot: snapshot.source.root, sourceWorkspace: snapshot.source.workspace, deliveries: item.automation!.deliveries,
          issues: [...(item.view.issues ?? []), ...(item.view.dependsOn?.some(id => !selected.some(item => item.view.id === id)) ? ['AUTOMATION_DEPENDENCY_NOT_SELECTED'] : [])] };
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
        const result = await transferCompanion(snapshot, selection, transferDeps, reconcileOnly || pass > 0, resumeSetup);
        if (result.status === 'running' && pass >= 2) {
          const receipt = await readReceipt(scope.root, selection.requestId); scope.assert();
          if (receipt) { receipt.result.status = 'needs-attention'; await saveReceipt(scope.root, receipt); }
          result.status = 'needs-attention';
        }
        if (selection.deferSetup && result.saved && result.canonicalSessionId) {
          const pending = result.checks.some(check => check.status === 'needs-attention');
          // Keep the legacy setup ID across upgrades, but do not let its
          // idempotency key swallow the later successful completion message.
          const savedIds = new Set(result.savedEntryIds);
          const unsaved = new Map(selected.filter(item => !savedIds.has(item.view.id)).map(item => [item.view.id, item]));
          const failures = result.checks.filter(check => unsaved.has(check.entryId));
          const details = failures.slice(0, 20).map(check => `${redactText(unsaved.get(check.entryId)?.view.name ?? check.entryId).slice(0, 160)} · ${t(`bots.import.${check.progress?.saved ? 'partlySaved' : 'notSaved'}`)} · ${t(`bots.import.${companionImportReasonKey(check.message)}`)}`).join('\n');
          const partialKey = unsaved.size ? `:partial:${fingerprint(failures).slice(0, 16)}` : '';
          await createMessage(result.canonicalSessionId, { clientId: `companion-import:${selection.requestId}${partialKey || (pending ? '' : ':ready')}`, role: 'assistant',
            content: unsaved.size ? `${t('bots.import.chatPartial')}\n\n${details}${failures.length > 20 ? `\n… (${failures.length})` : ''}` : t(`bots.import.${pending ? 'chatSetup' : 'chatReady'}`) });
          scope.assert();
        }
        if (result.status === 'complete') {
          const completed = await readReceipt(scope.root, selection.requestId); scope.assert();
          if (completed) await clearCompletedCheckpoint(scope.root, completed, scope.assert);
        }
        return result;
      });
      if (result.status !== 'running') return result;
      // A native task can still be finishing when it is paused. Reconcile the
      // durable handover on the host even if the mobile link/dialog closes.
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  })().catch(async error => {
    scope.assert();
    if (error instanceof CompanionImportError && error.code === 'REQUEST_ALREADY_USED') throw error;
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
      // A retry must not acknowledge the previous attempt's terminal receipt.
      if (value?.result.status === 'running' && (value.companionCreated || value.environmentSaved)) return value.result;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    return task;
  })();
  return Promise.race([task, receipt]);
}

/** Continue only this companion's durable request; no source discovery or new selection. */
export async function continueCompanionImport(botId: string, root: string, assertOwner: () => void) {
  const scope = owner();
  assertOwner();
  if (scope.root !== root) throw new CompanionImportError('OWNER_CHANGED');
  const environment = await companionEnvironmentStore.read(root, botId, assertOwner);
  const pending = environment?.pendingImport;
  if (!pending) return undefined;
  if (`import_${fingerprint(pending.selection.requestId).slice(0, 24)}` !== botId) throw new CompanionImportError('INVALID_COMPANION');
  await startCompanionImport(pending.selection, `companion:${botId}`, false, true);
  return getCompanionImportResult(pending.selection.requestId);
}

/** Explicit adoption of Cindy's runtime settings; source scheduling/data checks still apply. */
export async function useCindyImportSettings(botId: string, root: string, entryIds: unknown, assertOwner: () => void): Promise<void> {
  const scope = owner(); assertOwner();
  if (scope.root !== root) throw new CompanionImportError('OWNER_CHANGED');
  if (!Array.isArray(entryIds) || !entryIds.length || entryIds.some(id => typeof id !== 'string')) throw new CompanionImportError('INVALID_SELECTION');
  await withBotProfileLocks([botId], async () => {
    const environment = await companionEnvironmentStore.read(root, botId, assertOwner);
    const pending = environment?.pendingImport;
    if (!pending || `import_${fingerprint(pending.selection.requestId).slice(0, 24)}` !== botId) throw new CompanionImportError('INVALID_COMPANION');
    const snapshot = await deserializeImportSnapshotAsync(pending.snapshotJson, assertOwner);
    const selected = new Set(entryIds);
    const items = snapshot.items.filter(item => selected.has(item.view.id));
    if (items.length !== selected.size || items.some(item => !item.automation && !['source-model', 'source-tools'].includes(item.credential?.format ?? ''))) throw new CompanionImportError('INVALID_SELECTION');
    const mappings = new Set(['SOURCE_TOOL_POLICY_NEEDS_MAPPING', 'AUTOMATION_MODEL_NEEDS_MAPPING']);
    for (const item of items) item.view.issues = item.view.issues?.filter(issue => !mappings.has(issue));
    const encoded = await serializeImportSnapshotAsync(snapshot, assertOwner);
    await companionEnvironmentStore.update(root, botId, assertOwner, current => {
      if (!current.pendingImport || current.pendingImport.selection.requestId !== pending.selection.requestId) throw new CompanionImportError('SELECTION_CHANGED');
      current.pendingImport.snapshotJson = encoded;
      for (const item of items) {
        const binding = current.automations?.[fingerprint([pending.selection.requestId, item.view.id])];
        if (binding) binding.issues = binding.issues?.filter(issue => !mappings.has(issue));
      }
    });
    const receipt = await readReceipt(root, pending.selection.requestId); assertOwner();
    if (receipt) {
      receipt.result.checks = receipt.result.checks.map(check => selected.has(check.entryId) && mappings.has(check.message ?? '')
        ? { ...check, status: items.find(item => item.view.id === check.entryId)?.automation ? 'needs-attention' : 'copied', message: 'IMPORT_SETUP_DEFERRED' } : check);
      await saveReceipt(root, receipt);
    }
  });
}
