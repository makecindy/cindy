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
}

export interface CompanionImportSelection {
  previewId: string;
  /** Stable across retries and remote reconnects. */
  requestId: string;
  name: string;
  avatarImageBase64?: string;
  entryIds: string[];
  takeover: boolean;
}

export interface CompanionImportCheck {
  entryId: string;
  status: 'copied' | 'verified' | 'needs-attention' | 'taken-over' | 'paused';
  message?: string;
}

export interface CompanionImportResult {
  requestId: string;
  botId: string;
  canonicalSessionId?: string;
  status: 'running' | 'complete' | 'needs-attention';
  checks: CompanionImportCheck[];
}

export interface CompanionImportApi {
  sources(): Promise<CompanionImportSource[]>;
  preview(sourceId: string): Promise<CompanionImportPreview>;
  start(selection: CompanionImportSelection): Promise<CompanionImportResult>;
  status(requestId: string): Promise<CompanionImportResult | undefined>;
}

export const companionImportCategories: CompanionImportCategory[] = ['personality', 'memory', 'skills', 'connections', 'automations'];

/** An alternative already chosen within this category also satisfies its group checkbox. */
export function areCompanionImportEntriesSelected(entries: CompanionImportEntry[], selected: string[]): boolean {
  const selectedHere = new Set(entries.filter(entry => selected.includes(entry.id)).map(entry => entry.id));
  return entries.every(entry => selectedHere.has(entry.id) || entry.exclusiveWith?.some(id => selectedHere.has(id)));
}

/** Reuse the existing checkboxes; bulk selection never guesses a credential account. */
export function toggleCompanionImportEntries(entries: CompanionImportEntry[], current: string[], ids: string[], checked: boolean): string[] {
  if (!checked) return current.filter(id => !ids.includes(id));
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  if (ids.length === 1) {
    const conflicts = new Set(byId.get(ids[0]!)?.exclusiveWith ?? []);
    return [...new Set([...current.filter(id => !conflicts.has(id)), ...ids])];
  }
  return [...new Set([...current, ...ids.filter(id => {
    const conflicts = byId.get(id)?.exclusiveWith ?? [];
    return !conflicts.some(other => current.includes(other) || ids.includes(other));
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

/** Transport-neutral client: Desktop and Mobile use their existing Remote Resource adapters. */
export function remoteCompanionImportApi(
  read: (id: string) => Promise<unknown>,
  invoke: (sourceId: string, selection: CompanionImportSelection) => Promise<unknown>,
): CompanionImportApi {
  const data = async (id: string): Promise<Record<string, unknown>> => {
    const raw = await read(id) as { blocks?: Array<{ primitive?: string; data?: Record<string, unknown> }> };
    const block = raw?.blocks?.find(block => block.primitive === 'companion-import');
    if (!block?.data) throw new Error('IMPORT_UNAVAILABLE');
    return block.data;
  };
  const status = async (requestId: string) => {
    const result = (await data(`result:${requestId}`)).result as CompanionImportResult | null;
    if (result && (result.requestId !== requestId || !Array.isArray(result.checks) || result.checks.length > 2001
      || !['running', 'complete', 'needs-attention'].includes(result.status))) throw new Error('INVALID_IMPORT_RESPONSE');
    return result ?? undefined;
  };
  const sources = new Map<string, string>();
  return {
    async sources() {
      const result = (await data('sources')).sources as CompanionImportSource[];
      if (!Array.isArray(result) || result.length > 2000 || result.some(source => !source.id || !source.name || !['hermes', 'openclaw'].includes(source.kind))) throw new Error('INVALID_IMPORT_RESPONSE');
      return result;
    },
    async preview(sourceId) {
      const result = (await data(`preview:${sourceId}`)).preview as CompanionImportPreview;
      if (!result?.id || !Array.isArray(result.entries) || result.entries.length > 2000
        || result.entries.some(entry => !entry.id || typeof entry.name !== 'string' || !companionImportCategories.includes(entry.category))) throw new Error('INVALID_IMPORT_RESPONSE');
      sources.set(result.id, sourceId);
      return result;
    },
    async start(selection) {
      const sourceId = sources.get(selection.previewId);
      if (!sourceId) throw new Error('PREVIEW_EXPIRED');
      await invoke(sourceId, selection);
      const result = await status(selection.requestId);
      if (!result) throw new Error('IMPORT_RECEIPT_MISSING');
      return result;
    },
    status,
  };
}
