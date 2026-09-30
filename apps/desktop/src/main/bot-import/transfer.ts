import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CompanionImportResult, CompanionImportSelection } from '@cindy/maker-shared/companion-import';
import type { RoutineInput } from '@cindy/maker-scheduler';
import { createImportBudget, fingerprint, readImportFile, readImportTree, reserveSnapshotItems, type ImportReadBudget } from './files.js';
import { CompanionImportError, importFailureCode, object, type ImportItem, type ImportSnapshot, type ImportSource } from './types.js';
import { normalizeImportSkill, readImportSkillTree } from './skills.js';
import { indexAutomationDependencies, normalizeAutomation } from './sourceAutomations.js';
import { memoryFileContent } from './memoryFiles.js';
import { resolveImportEnvironmentDependencies, selectedImportEnvironment } from './environmentSelection.js';

export interface ImportReceipt {
  selectionHash: string;
  /** Present on receipts whose identity includes the original setup choice. */
  deferSetup?: boolean;
  result: CompanionImportResult;
  /** Already-redacted display metadata; status pages must not open the encrypted checkpoint. */
  entryNames?: Record<string, string>;
  copied: string[];
  environmentSaved?: boolean;
  checkpointSaved?: boolean;
  /** Completion cleanup acknowledged after the private pending snapshot was removed. */
  checkpointCleared?: boolean;
  companionCreated?: true;
  /** Terminal, non-secret rejection; retained so lost acknowledgements unlock callers. */
  creationRejected?: 'IMPORT_NAME_EXISTS';
  /** Current bindings carry explicit handover markers; old receipts upgrade once. */
  handoverMarkers?: true;
  /** Durable fence: a deleted companion's old preview/request must never recreate it. */
  cancelled?: boolean;
  routines: Record<string, { id: string; phase: 'created' | 'verified' | 'pausing-source' | 'source-paused' | 'complete'; sourceRestored?: boolean }>;
}

export interface TransferDeps {
  assertOwner(): void;
  readReceipt(requestId: string): Promise<ImportReceipt | undefined>;
  readLegacyDeferSetup?(botId: string): Promise<boolean | undefined>;
  readSkillConfig?(source: ImportSource, budget: ImportReadBudget): Promise<Record<string, unknown>>;
  /** Return serialized UTF-8 bytes when available, avoiding a second full serialization. */
  saveReceipt(receipt: ImportReceipt): Promise<number | void>;
  createCompanion(botId: string, selection: CompanionImportSelection): Promise<void>;
  validateItems?(items: ImportItem[]): void | Promise<void>;
  importItem(botId: string, item: ImportItem, snapshot: ImportSnapshot): Promise<void>;
  saveEnvironment(botId: string, items: ImportItem[]): Promise<void>;
  saveCheckpoint(botId: string, items: ImportItem[]): Promise<void>;
  createConversation(botId: string): Promise<string>;
  createRoutine(botId: string, input: RoutineInput, creationId: string, item: ImportItem): Promise<string>;
  /** Success requires actual read evidence from the target environment, not just presence of keys. */
  verifyAutomation(botId: string, item: ImportItem): Promise<{ verified: boolean; reason?: string }>;
  pauseSource(item: ImportItem, snapshot: ImportSnapshot, resumeInterruptedPause: boolean): Promise<void>;
  resumeSource(item: ImportItem, snapshot: ImportSnapshot): Promise<void>;
  enableRoutine(botId: string, routineId: string, item: ImportItem): Promise<void>;
}

/** Preserve previously accepted IDs; compact only IDs the memory service could never save. */
function recoveredDocumentId(id: string): string {
  return id.length <= 40 ? id : `memory-${fingerprint(id).slice(0, 32)}`;
}

export function validateImportSelection(value: CompanionImportSelection, snapshot: ImportSnapshot): ImportItem[] {
  if (!value || typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(value.requestId) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200 || typeof value.takeover !== 'boolean' || value.deferSetup !== undefined && typeof value.deferSetup !== 'boolean'
    || !Array.isArray(value.entryIds) || value.entryIds.some(id => typeof id !== 'string') || new Set(value.entryIds).size !== value.entryIds.length
    || value.avatarImageBase64 !== undefined && (typeof value.avatarImageBase64 !== 'string' || !value.avatarImageBase64.length || value.avatarImageBase64.length > 2_000_000))
    throw new CompanionImportError('INVALID_SELECTION');
  const selected = new Set(value.entryIds);
  let ranges: Array<[number, number]> | undefined;
  if (value.entryRanges !== undefined) {
    if (value.entryIds.length || !Array.isArray(value.entryRanges)) throw new CompanionImportError('INVALID_SELECTION');
    let previous = -1;
    for (const range of value.entryRanges) {
      if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger) || range[0] <= previous || range[1] < range[0]) throw new CompanionImportError('INVALID_SELECTION');
      previous = range[1];
    }
    ranges = value.entryRanges;
  }
  const count = ranges ? ranges.reduce((sum, [first, last]) => sum + last - first + 1, 0) : selected.size;
  // Bound expansion by the actual snapshot before allocating indexes. This also
  // supports selected-only checkpoints without assuming their storage order.
  if (!Number.isSafeInteger(count) || count > snapshot.items.length) throw new CompanionImportError('SELECTION_CHANGED');
  const remaining = new Set<number>();
  if (ranges) for (const [first, last] of ranges) for (let index = first; index <= last; index++) remaining.add(index);
  const items = snapshot.items.filter(item => ranges ? item.sourceIndex !== undefined && remaining.delete(item.sourceIndex) : selected.has(item.view.id));
  if (items.length !== count || remaining.size) throw new CompanionImportError('SELECTION_CHANGED');
  selectedImportEnvironment(items);
  return resolveImportEnvironmentDependencies(items);
}

/** Old hashes predate deferSetup; the durable checkpoint retains its original value. */
export async function validateImportRequestIdentity(snapshot: ImportSnapshot, selection: CompanionImportSelection, existing: ImportReceipt | undefined,
  readLegacyDeferSetup?: TransferDeps['readLegacyDeferSetup']): Promise<string> {
  const items = validateImportSelection(selection, snapshot);
  const identity = [selection.name, selection.avatarImageBase64, items.map(item => item.view.id).toSorted(), selection.takeover, snapshot.source.kind, snapshot.source.agentId, snapshot.source.root];
  const deferSetup = selection.deferSetup === true;
  const selectionHash = fingerprint([...identity, deferSetup]);
  if (!existing) return selectionHash;
  if (existing.deferSetup !== undefined) {
    if (existing.selectionHash !== selectionHash || existing.deferSetup !== deferSetup) throw new CompanionImportError('REQUEST_ALREADY_USED');
  } else {
    if (existing.selectionHash !== fingerprint(identity)) throw new CompanionImportError('REQUEST_ALREADY_USED');
    // Terminal legacy receipts may have already discarded their checkpoint.
    // Returning them cannot start setup or change any takeover side effects.
    if (!existing.cancelled && existing.result.status !== 'complete') {
      const original = await readLegacyDeferSetup?.(existing.result.botId)
        ?? existing.result.checks.some(check => check.message === 'IMPORT_SETUP_DEFERRED');
      if (original !== deferSetup) throw new CompanionImportError('REQUEST_ALREADY_USED');
    }
  }
  return selectionHash;
}

/** One receipt is shared by GUI, remote actions and command callers. Writes are serialized by the host. */
export async function transferCompanion(snapshot: ImportSnapshot, selection: CompanionImportSelection, deps: TransferDeps, reconcileOnly = false, resumeSetup = false): Promise<CompanionImportResult> {
  const items = validateImportSelection(selection, snapshot);
  deps.assertOwner();
  const selectedIds = items.map(item => item.view.id);
  const existing = await deps.readReceipt(selection.requestId);
  const selectionHash = await validateImportRequestIdentity(snapshot, selection, existing, deps.readLegacyDeferSetup);
  deps.assertOwner();
  if (existing?.creationRejected) throw new CompanionImportError(existing.creationRejected);
  if (existing?.cancelled) return existing.result;
  if (existing?.result.status === 'complete') return existing.result;
  // A prior attempt may already have captured the repaired subtree in its
  // checkpoint. Normalize that case too, without requiring another source read.
  for (const item of items) for (const document of item.documents ?? []) document.id = recoveredDocumentId(document.id);
  const receipt: ImportReceipt = existing ?? { selectionHash, handoverMarkers: true, copied: [], routines: {}, result: {
    requestId: selection.requestId, botId: `import_${fingerprint(selection.requestId).slice(0, 24)}`, status: 'running', checks: [],
  } };
  receipt.selectionHash = selectionHash;
  receipt.deferSetup = selection.deferSetup === true;
  const botId = receipt.result.botId;
  receipt.result.status = 'running';
  receipt.result.checks = receipt.result.checks.filter(item => item.entryId !== 'import');
  const copied = new Set(receipt.copied);
  const checkIndexes = new Map(receipt.result.checks.map((item, index) => [item.entryId, index]));
  const selected = new Set(selectedIds);
  // Charge changed records against the last serialized receipt (including the
  // immutable name index). As the receipt grows, ordinary snapshots get farther
  // apart instead of rewriting the full catalog ~100 times. Lost batches replay
  // idempotently; source handover milestones still save before/after mutations.
  let progressBatchBytes = 64 * 1024, pendingProgressBytes = 0;
  const save = async () => {
    deps.assertOwner();
    const bytes = await deps.saveReceipt(receipt);
    deps.assertOwner();
    progressBatchBytes = Math.max(64 * 1024, bytes ?? Buffer.byteLength(JSON.stringify(receipt)));
    pendingProgressBytes = 0;
  };
  const saveProgress = async (entryId: string) => {
    const index = checkIndexes.get(entryId);
    pendingProgressBytes += Buffer.byteLength(JSON.stringify([entryId, index === undefined ? null : receipt.result.checks[index], receipt.routines[entryId]]));
    if (pendingProgressBytes >= progressBatchBytes) await save();
  };
  const check = (entryId: string, status: CompanionImportResult['checks'][number]['status'], message?: string, progress?: { saved: number; total: number }) => {
    const index = checkIndexes.get(entryId) ?? receipt.result.checks.length;
    checkIndexes.set(entryId, index);
    receipt.result.checks[index] = { entryId, status, ...(message ? { message } : {}), ...(progress ? { progress } : {}) };
  };
  const needsAttention = (id: string) => {
    const index = checkIndexes.get(id);
    return index !== undefined && receipt.result.checks[index]?.status === 'needs-attention';
  };
  // Capture only selected resources, then publish a non-secret request index
  // before storing credentials. Acceptance still waits for the full checkpoint.
  if (!receipt.checkpointSaved || items.some(item => item.captureIssue)) {
    const budget = createImportBudget();
    await reserveSnapshotItems(snapshot.items, budget, deps.assertOwner);
    for (const item of items) {
      if (item.captureIssue && item.sourceDirectory && item.filesComplete && !copied.has(item.view.id)) {
        item.files = undefined; item.filesComplete = false;
      }
      if (item.captureIssue && item.sourceFile) {
        try {
          const source = item.sourceFile;
          const sharedDocumentRoots = source.sharedDocumentRoots ?? [];
          // Older checkpoints recorded only the physical root. Recover its
          // logical prefix only when both the known root and original entry ID
          // agree; custom/standalone document checkpoints keep their old names.
          const relative = path.relative(source.root, source.file).split(path.sep).join('/');
          const prefix = source.logicalPrefix ?? ['memories', 'memory'].find(candidate =>
            path.basename(source.root) === candidate && item.view.id === `memory-${fingerprint(`${candidate}/${relative}`).slice(0, 20)}`);
          const logicalName = (name: string) => prefix ? `${prefix}/${name}` : name;
          // Missing kind is a legacy checkpoint. Re-evaluate repaired paths, but
          // keep containment anchored to the original memory root in either case.
          const directory = source.kind === 'directory' || source.kind !== 'file' && (await fs.stat(source.file)).isDirectory();
          if (directory) {
            const files = await readImportTree(source.root, undefined, budget, undefined, source.file, sharedDocumentRoots);
            item.files = []; item.documents = [];
            for (const captured of files) {
              const file = { ...captured, name: logicalName(captured.name) };
              const content = memoryFileContent(file);
              if (content.kind !== 'text') item.files.push(file);
              else if (content.kind === 'text') item.documents.push({
                id: recoveredDocumentId(`${item.view.id}-${fingerprint(file.name).slice(0, 20)}`), name: file.name, text: content.text,
                ...(/(^|\/)USER\.md$/i.test(file.name) ? { role: 'user' as const } : {}),
              });
            }
          } else {
            const captured = await readImportFile(source.root, source.file, budget, sharedDocumentRoots);
            const file = { ...captured, name: logicalName(captured.name) };
            const content = memoryFileContent(file);
            if (content.kind === 'text') {
              item.text = content.text;
              // A failed individual USER.md has no role from initial discovery.
              if (!item.role && /(^|\/)USER\.md$/i.test(file.name)) item.role = 'user';
            }
            else item.asset = { name: file.name, bytes: file.bytes };
          }
          delete item.captureIssue;
        } catch (error) { item.captureIssue = importFailureCode(error); }
        deps.assertOwner();
      }
      if (item.sourceDirectory && !item.filesComplete) {
        // Failed discovery uses a directory-based ID. Older successful imports
        // also lack sourceAlias, so absence alone must not reinterpret them.
        const metadataPending = item.view.category === 'skills' && !!item.captureIssue && !item.sourceAlias
          && item.view.id === `skill-${fingerprint(item.sourceDirectory).slice(0, 20)}`;
        const captured = item.files ?? [];
        const names = new Set(captured.map(file => file.name));
        try {
          item.files = [...captured, ...await readImportSkillTree(item.sourceDirectory, name => !names.has(name), budget)];
          if (metadataPending) {
            const manifest = item.files.find(file => file.name === 'SKILL.md')?.bytes.toString('utf8');
            if (!manifest?.trim() || !deps.readSkillConfig) throw new CompanionImportError('SOURCE_CONFIG_INVALID');
            const config = await deps.readSkillConfig(snapshot.source, budget);
            deps.assertOwner();
            const metadata = normalizeImportSkill(snapshot.source.kind, item.view.name, manifest, object(config.skills));
            const restored = { ...item, ...metadata, view: { ...item.view, ...metadata.view, id: item.view.id } };
            // A newly readable credential must not silently choose a conflicting account.
            selectedImportEnvironment(items.map(candidate => candidate === item ? restored : candidate));
            Object.assign(item, restored);
          }
          item.filesComplete = true;
          delete item.captureIssue;
        } catch (error) {
          deps.assertOwner();
          item.captureIssue = importFailureCode(error);
        }
        deps.assertOwner();
      }
    }
    await deps.validateItems?.(items);
    await save();
    await deps.saveCheckpoint(botId, items);
    deps.assertOwner();
    receipt.checkpointSaved = true;
  }
  await save();
  await deps.createCompanion(botId, selection);
  deps.assertOwner();
  receipt.companionCreated = true;
  await save();
  // Retry only selected resources; saved batches skip completed idempotent copies.
  for (const item of items.filter(item => item.view.category !== 'automations' && item.view.category !== 'connections')) {
    if (copied.has(item.view.id)) continue;
    deps.assertOwner();
    try {
      if (item.captureIssue) throw new CompanionImportError(item.captureIssue);
      await deps.importItem(botId, item, snapshot);
      deps.assertOwner();
      receipt.copied.push(item.view.id); copied.add(item.view.id);
      check(item.view.id, item.view.issues?.length ? 'needs-attention' : 'copied', item.view.issues?.[0]);
    } catch (error) {
      deps.assertOwner();
      check(item.view.id, 'needs-attention', importFailureCode(error), (error as { importProgress?: { saved: number; total: number } })?.importProgress);
    }
    await saveProgress(item.view.id);
  }
  await save();
  if (!receipt.environmentSaved) {
    await deps.saveEnvironment(botId, items);
    deps.assertOwner();
    receipt.environmentSaved = true;
    await save();
  }
  for (const item of items.filter(item => item.view.category === 'connections')) {
    const issue = item.view.dependsOn?.some(id => !selected.has(id)) ? 'AUTOMATION_DEPENDENCY_NOT_SELECTED' : item.view.issues?.[0];
    check(item.view.id, issue ? 'needs-attention' : 'copied', issue);
  }
  receipt.result.canonicalSessionId = await deps.createConversation(botId);
  await save();
  const byId = new Map(items.map(item => [item.view.id, item]));
  const missingDependency = (id: string, visited = new Set<string>()): boolean => {
    if (!selected.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    const item = byId.get(id);
    return !!item?.captureIssue || item?.view.enabled === false && (item.view.category === 'skills' || !!item.mcp) || needsAttention(id) || !!item?.view.issues?.length || !!item?.view.dependsOn?.some(child => missingDependency(child, visited));
  };
  let automationDependencies: ReturnType<typeof indexAutomationDependencies> | undefined;
  for (const item of items.filter(item => item.automation)) {
    // Background reconciliation repairs only interrupted work. A definitive
    // failed verification needs an explicit retry, never another model/Ask call.
    const prior = receipt.routines[item.view.id];
    if (reconcileOnly && needsAttention(item.view.id)
      && prior?.phase !== 'pausing-source' && prior?.phase !== 'source-paused') continue;
    const automation = item.automation!;
    if (!automation.input) {
      // Retry checkpoints created before unsupported tasks had visible drafts.
      automationDependencies ??= indexAutomationDependencies(items);
      const restored = normalizeAutomation(snapshot.source, automation.original, automationDependencies, 'UTC');
      automation.input = restored.automation!.input;
      item.view.issues = [...new Set([...(item.view.issues ?? []), ...(restored.view.issues ?? []), 'SOURCE_AUTOMATION_INVALID'])];
    }
    let record = receipt.routines[item.view.id];
    if (!record) {
      try {
        const id = await deps.createRoutine(botId, { ...automation.input!, enabled: false }, fingerprint([selection.requestId, item.view.id]), item);
        deps.assertOwner();
        record = receipt.routines[item.view.id] = { id, phase: 'created' };
        // createOnce is idempotent if this progress batch is interrupted.
      } catch (error) {
        deps.assertOwner();
        check(item.view.id, 'needs-attention', importFailureCode(error));
        await saveProgress(item.view.id); continue;
      }
    }
    if (record.phase === 'complete') { check(item.view.id, item.view.enabled && selection.takeover ? 'taken-over' : 'paused'); continue; }
    if (item.view.issues?.length) {
      check(item.view.id, 'needs-attention', item.view.issues[0]); await saveProgress(item.view.id); continue;
    }
    if (!item.view.enabled || !selection.takeover) {
      record.phase = 'complete'; check(item.view.id, 'paused'); await saveProgress(item.view.id); continue;
    }
    if (selection.deferSetup && !resumeSetup && record.phase === 'created') {
      check(item.view.id, 'needs-attention', 'IMPORT_SETUP_DEFERRED'); await saveProgress(item.view.id); continue;
    }
    if (item.view.dependsOn?.some(id => missingDependency(id))) {
      check(item.view.id, 'needs-attention', 'AUTOMATION_DEPENDENCY_NOT_SELECTED'); await saveProgress(item.view.id); continue;
    }
    if (record.phase === 'created') {
      try {
        const verification = await deps.verifyAutomation(botId, item);
        deps.assertOwner();
        if (!verification.verified) { check(item.view.id, 'needs-attention', verification.reason ?? 'AUTOMATION_READ_NOT_VERIFIED'); await save(); continue; }
        record.phase = 'verified'; check(item.view.id, 'verified'); await save();
      } catch (error) {
        deps.assertOwner();
        check(item.view.id, 'needs-attention', error instanceof CompanionImportError ? error.code : 'AUTOMATION_READ_NOT_VERIFIED');
        await save(); continue;
      }
    }
    try {
      if (record.phase === 'verified' || record.phase === 'pausing-source') {
        const resumeInterruptedPause = record.phase === 'pausing-source';
        // Persist intent before the native mutation. Its adapter can reconcile an interrupted pause.
        record.phase = 'pausing-source'; await save();
        await deps.pauseSource(item, snapshot, resumeInterruptedPause);
        deps.assertOwner();
        record.phase = 'source-paused'; await save();
      }
      await deps.enableRoutine(botId, record.id, item);
      deps.assertOwner();
      record.phase = 'complete'; check(item.view.id, 'taken-over'); await save();
    } catch (error) {
      deps.assertOwner();
      if (record.phase === 'pausing-source' && error instanceof CompanionImportError && !['SOURCE_HANDOVER_UNCERTAIN', 'SOURCE_HANDOVER_PENDING'].includes(error.code)) record.phase = 'verified';
      if (record.phase === 'source-paused' && !(error instanceof CompanionImportError && error.code === 'TARGET_HANDOVER_UNCERTAIN')) {
        // Only restore a source task this transaction actually paused; never alter other tasks.
        await deps.resumeSource(item, snapshot);
        deps.assertOwner();
        record.phase = 'verified';
      }
      check(item.view.id, 'needs-attention', error instanceof CompanionImportError ? error.code : 'AUTOMATION_HANDOVER_FAILED');
      await save();
    }
  }
  receipt.result.savedEntryIds = [...new Set([...receipt.copied,
    ...items.filter(item => item.view.category === 'connections' && receipt.environmentSaved).map(item => item.view.id),
    ...Object.keys(receipt.routines),
  ])];
  receipt.result.saved = true;
  receipt.result.status = Object.values(receipt.routines).some(item => item.phase === 'pausing-source' || item.phase === 'source-paused') ? 'running'
    : receipt.result.checks.some(check => check.status === 'needs-attention') ? 'needs-attention' : 'complete';
  await save();
  return receipt.result;
}
