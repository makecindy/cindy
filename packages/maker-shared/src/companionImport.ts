/** Public import projection. Source paths, credentials and configuration stay on the owning host. */
export type CompanionImportSourceKind = 'hermes' | 'openclaw';
export type CompanionImportCategory = 'personality' | 'memory' | 'skills' | 'connections' | 'automations';

export interface CompanionImportSource {
  id: string;
  kind: CompanionImportSourceKind;
  name: string;
}

export interface CompanionImportEntry {
  id: string;
  category: CompanionImportCategory;
  name: string;
  description?: string;
  selected: boolean;
  /** Source was paused: importing it must never enable it. */
  enabled?: boolean;
  dependsOn?: string[];
  /** Alternative entries that supply different values for the same variable. */
  exclusiveWith?: string[];
  /** An explicit compatibility problem, never silently discarded configuration. */
  issues?: string[];
}

export interface CompanionImportPreview {
  id: string;
  source: CompanionImportSource;
  name: string;
  avatarImageBase64?: string;
  entries: CompanionImportEntry[];
  /** Host understands compact immutable preview-index ranges. */
  selectionRanges?: true;
  /** Host accepts bounded selection uploads through the existing import action. */
  selectionChunks?: true;
}

export interface CompanionImportSelection {
  previewId: string;
  /** Stable across retries and remote reconnects. */
  requestId: string;
  name: string;
  avatarImageBase64?: string;
  entryIds: string[];
  /** Inclusive preview-index ranges, only when advertised; mutually exclusive with entryIds. */
  entryRanges?: Array<[number, number]>;
  takeover: boolean;
  /** Save first; connection checks and source handover continue from the teammate chat. */
  deferSetup?: boolean;
}

export type CompanionImportSubmission = CompanionImportSelection | {
  selectionChunk: { id: string; offset: number; total: number; text: string };
};
// Even worst-case JSON escaping stays below the existing 64 KiB action budget.
export const COMPANION_IMPORT_SELECTION_CHUNK_LENGTH = 8 * 1024;
export function* companionImportSubmissions(selection: CompanionImportSelection, chunked = false): Generator<CompanionImportSubmission> {
  if (!chunked) { yield selection; return; }
  const text = JSON.stringify(selection);
  if (text.length <= COMPANION_IMPORT_SELECTION_CHUNK_LENGTH) { yield selection; return; }
  for (let offset = 0; offset < text.length; offset += COMPANION_IMPORT_SELECTION_CHUNK_LENGTH) {
    yield { selectionChunk: { id: selection.requestId, offset, total: text.length, text: text.slice(offset, offset + COMPANION_IMPORT_SELECTION_CHUNK_LENGTH) } };
  }
}

export interface CompanionImportCheck {
  entryId: string;
  status: 'copied' | 'verified' | 'needs-attention' | 'taken-over' | 'paused';
  message?: string;
  /** Fully written parts before an item failure; absent for old receipts. */
  progress?: { saved: number; total: number };
}

export interface CompanionImportResult {
  requestId: string;
  botId: string;
  canonicalSessionId?: string;
  status: 'running' | 'complete' | 'needs-attention';
  checks: CompanionImportCheck[];
  /** The companion and selected content have finished their save pass. */
  saved?: boolean;
  /** Saved definitions/content, independently of later authorization and activation. */
  savedEntryIds?: string[];
}

export interface CompanionImportApi {
  sources(): Promise<CompanionImportSource[]>;
  preview(sourceId: string): Promise<CompanionImportPreview>;
  start(selection: CompanionImportSelection): Promise<CompanionImportResult>;
  status(requestId: string): Promise<CompanionImportResult | undefined>;
}

export const companionImportCategories: CompanionImportCategory[] = ['personality', 'memory', 'skills', 'connections', 'automations'];

/** Preserve exact choices while keeping large selections below the existing action budget. */
export function compactCompanionImportSelection(preview: CompanionImportPreview, selected: string[]): Pick<CompanionImportSelection, 'entryIds' | 'entryRanges'> {
  if (!preview.selectionRanges || selected.length < 200) return { entryIds: selected };
  const ids = new Set(selected);
  const ranges: Array<[number, number]> = [];
  preview.entries.forEach((entry, index) => {
    if (!ids.has(entry.id)) return;
    const last = ranges.at(-1);
    if (last && last[1] + 1 === index) last[1] = index;
    else ranges.push([index, index]);
  });
  return JSON.stringify(ranges).length < JSON.stringify(selected).length
    ? { entryIds: [], entryRanges: ranges } : { entryIds: selected };
}

/** An alternative already chosen within this category also satisfies its group checkbox. */
export function areCompanionImportEntriesSelected(entries: CompanionImportEntry[], selected: string[]): boolean {
  const all = new Set(selected);
  const selectedHere = new Set(entries.filter(entry => all.has(entry.id)).map(entry => entry.id));
  return entries.every(entry => selectedHere.has(entry.id) || entry.exclusiveWith?.some(id => selectedHere.has(id)));
}

/** Reuse the existing checkboxes; bulk selection never guesses a credential account. */
export function toggleCompanionImportEntries(entries: CompanionImportEntry[], current: string[], ids: string[], checked: boolean): string[] {
  const requested = new Set(ids);
  if (!checked) return current.filter(id => !requested.has(id));
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  if (ids.length === 1) {
    const conflicts = new Set(byId.get(ids[0]!)?.exclusiveWith ?? []);
    return [...new Set([...current.filter(id => !conflicts.has(id)), ...ids])];
  }
  const selected = new Set(current);
  return [...new Set([...current, ...ids.filter(id => {
    const conflicts = byId.get(id)?.exclusiveWith ?? [];
    return !conflicts.some(other => selected.has(other) || requested.has(other));
  })])];
}

export function companionImportIssueKey(code?: string): string {
  if (code === 'AUTOMATION_DEPENDENCY_NOT_SELECTED') return 'missingSelection';
  if (code === 'NATIVE_AUTH_REFRESH_REQUIRED') return 'authRefresh';
  if (code === 'SOURCE_TOOL_POLICY_NEEDS_MAPPING') return 'toolMapping';
  if (code === 'AUTOMATION_MODEL_NEEDS_MAPPING') return 'modelMapping';
  if (code === 'AUTOMATION_CONTEXT_NEEDS_MAPPING' || code === 'AUTOMATION_WORKDIR_NEEDS_MAPPING') return 'contextMapping';
  if (code?.startsWith('DELIVERY_')) return 'deliveryFailed';
  if (code === 'SOURCE_AUTOMATION_CHANGED' || code === 'SOURCE_CHANGED') return 'sourceChanged';
  if (code?.startsWith('CREDENTIAL_STORAGE_')) return 'credentialFailed';
  if (code === 'AUTOMATION_SCRIPT_MISSING') return 'scriptMissing';
  if (code === 'SOURCE_COMMAND_UNAVAILABLE') return 'sourceCommand';
  if (code?.includes('READ_') || code === 'VERIFICATION_MODEL_UNAVAILABLE') return 'readFailed';
  return 'itemAttention';
}

/** Additive read capability; older hosts continue returning the original projection. */
export const COMPANION_IMPORT_CHUNK_PRIMITIVE = 'companion-import-chunks-v1';
export const COMPANION_IMPORT_CHUNK_LENGTH = 256 * 1024;
export const COMPANION_IMPORT_READ_MAX_LENGTH = 128 * 1024 * 1024;

/** Transport-neutral client: Desktop and Mobile use their existing Remote Resource adapters. */
export function remoteCompanionImportApi(
  read: (id: string) => Promise<unknown>,
  invoke: (sourceId: string, selection: CompanionImportSubmission) => Promise<unknown>,
): CompanionImportApi {
  const readData = async (id: string): Promise<Record<string, unknown>> => {
    const raw = await read(id) as { blocks?: Array<{ primitive?: string; data?: Record<string, unknown> }> };
    const block = raw?.blocks?.find(block => block.primitive === 'companion-import');
    if (!block?.data) throw new Error('IMPORT_UNAVAILABLE');
    return block.data;
  };
  const data = async (id: string): Promise<Record<string, unknown>> => {
    let part = await readData(id);
    if (!part.chunk) return part;
    const pieces: string[] = [];
    let offset = 0;
    let token: string | undefined;
    let total: number | undefined;
    for (;;) {
      const chunk = part.chunk as { id?: unknown; offset?: unknown; total?: unknown; text?: unknown } | undefined;
      if (!chunk || typeof chunk.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(chunk.id)
        || chunk.offset !== offset || !Number.isSafeInteger(chunk.total)
        || typeof chunk.total !== 'number' || chunk.total <= 0 || chunk.total > COMPANION_IMPORT_READ_MAX_LENGTH
        || typeof chunk.text !== 'string' || !chunk.text.length || chunk.text.length > COMPANION_IMPORT_CHUNK_LENGTH
        || (token !== undefined && (token !== chunk.id || total !== chunk.total))
        || offset + chunk.text.length > chunk.total) throw new Error('INVALID_IMPORT_RESPONSE');
      token = chunk.id; total = chunk.total;
      pieces.push(chunk.text); offset += chunk.text.length;
      if (offset === total) break;
      if (chunk.text.length !== COMPANION_IMPORT_CHUNK_LENGTH) throw new Error('INVALID_IMPORT_RESPONSE');
      part = await readData(`chunk:${token}:${offset}`);
    }
    const serialized = pieces.join('');
    // Release transport chunks before materializing the full projection. Keeping
    // pieces alive through JSON.parse retains three copies of a large preview
    // (chunks, joined text and objects) on the controlling phone at once.
    pieces.length = 0;
    part = {};
    const result: unknown = JSON.parse(serialized);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('INVALID_IMPORT_RESPONSE');
    return result as Record<string, unknown>;
  };
  const status = async (requestId: string) => {
    const result = (await data(`result:${requestId}`)).result as CompanionImportResult | null;
    if (result && (result.requestId !== requestId || !Array.isArray(result.checks)
      || !['running', 'complete', 'needs-attention'].includes(result.status))) throw new Error('INVALID_IMPORT_RESPONSE');
    return result ?? undefined;
  };
  const sources = new Map<string, { id: string; selectionChunks: boolean }>();
  return {
    async sources() {
      const result = (await data('sources')).sources as CompanionImportSource[];
      if (!Array.isArray(result) || result.some(source => !source.id || !source.name || !['hermes', 'openclaw'].includes(source.kind))) throw new Error('INVALID_IMPORT_RESPONSE');
      return result;
    },
    async preview(sourceId) {
      const result = (await data(`preview:${sourceId}`)).preview as CompanionImportPreview;
      if (!result?.id || !Array.isArray(result.entries)
        || result.entries.some(entry => !entry.id || typeof entry.name !== 'string' || !companionImportCategories.includes(entry.category))) throw new Error('INVALID_IMPORT_RESPONSE');
      sources.set(result.id, { id: sourceId, selectionChunks: result.selectionChunks === true });
      return result;
    },
    async start(selection) {
      const sourceId = sources.get(selection.previewId);
      if (!sourceId) throw new Error('PREVIEW_EXPIRED');
      for (const part of companionImportSubmissions(selection, sourceId.selectionChunks)) await invoke(sourceId.id, part);
      const result = await status(selection.requestId);
      if (!result) throw new Error('IMPORT_RECEIPT_MISSING');
      return result;
    },
    status,
  };
}

/** Stable public reason categories, shared by Desktop/Mobile. Never display raw exceptions. */
export function companionImportReasonKey(code?: string): string {
  const keys: Record<string, string> = {
    SOURCE_DATABASE_DRIVER_UNAVAILABLE: 'databaseDriver', SOURCE_DATABASE_UNAVAILABLE: 'databaseUnavailable',
    SOURCE_DATABASE_INVALID: 'databaseUnavailable', SOURCE_DATABASE_TOO_LARGE: 'fileTooLarge',
    MEMORY_DESCRIPTION_TOO_LONG: 'memoryMetadata', MEMORY_TITLE_TOO_LONG: 'memoryMetadata', MEMORY_METADATA_INVALID: 'memoryMetadata',
    MEMORY_CONTENT_TOO_LARGE: 'fileTooLarge', MEMORY_WRITE_FAILED: 'memoryWrite', MEMORY_CHANGED: 'memoryChanged',
    MEMORY_STORAGE_UNAVAILABLE: 'memoryWrite', MEMORY_ATTACHMENT_UNSUPPORTED: 'attachmentUnsupported',
    SOURCE_FILE_TOO_LARGE: 'fileTooLarge', SOURCE_SNAPSHOT_TOO_LARGE: 'fileTooLarge', SOURCE_ITEM_TOO_LARGE: 'fileTooLarge',
    IMPORT_DISK_FULL: 'diskFull', IMPORT_PERMISSION_DENIED: 'permissionDenied',
    IMPORT_SETUP_DEFERRED: 'setupDeferred', SOURCE_TOOL_POLICY_NEEDS_MAPPING: 'toolMapping', AUTOMATION_MODEL_NEEDS_MAPPING: 'modelMapping',
    AUTOMATION_CONTEXT_NEEDS_MAPPING: 'contextMapping', AUTOMATION_WORKDIR_NEEDS_MAPPING: 'contextMapping',
    SOURCE_AUTOMATION_INVALID: 'automationInvalid', AUTOMATION_TRIGGER_NEEDS_ADAPTER: 'automationInvalid',
    AUTOMATION_DATA_READ_FAILED: 'readFailed', AUTOMATION_READ_NOT_VERIFIED: 'readFailed',
    NATIVE_AUTH_REFRESH_REQUIRED: 'authRefresh', AUTOMATION_DEPENDENCY_NOT_SELECTED: 'missingSelection',
  };
  return code && keys[code] || 'itemFailed';
}
export function companionImportErrorCode(error: unknown): string | undefined {
  const value = error as { code?: unknown; message?: unknown } | null;
  const pattern = /\b(?:SOURCE|IMPORT|MEMORY|CREDENTIAL|AUTOMATION|PROFILE|PREVIEW|SELECTION)_[A-Z_]+\b/;
  const candidate = typeof value?.code === 'string' && pattern.test(value.code) ? value.code
    : typeof value?.message === 'string' ? value.message.match(pattern)?.[0] : undefined;
  return candidate && /^[A-Z][A-Z_]+$/.test(candidate) ? candidate : undefined;
}
