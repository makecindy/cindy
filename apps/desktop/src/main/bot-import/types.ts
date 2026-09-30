import type {
  CompanionImportEntry,
  CompanionImportSourceKind,
} from '@cindy/maker-shared/companion-import';
import type { RoutineInput } from '@cindy/maker-scheduler';

export interface ImportSource {
  kind: CompanionImportSourceKind;
  agentId: string;
  name: string;
  root: string;
  workspace: string;
  configFile: string;
}

export interface ImportFile {
  /** Relative path within the selected item, never a client-supplied destination. */
  name: string;
  bytes: Buffer;
  executable: boolean;
  /** Host-validated native Python interpreter; retain its runtime/library location. */
  interpreterLink?: string;
}

export interface ImportedMcpServer {
  name: string;
  enabled?: boolean;
  command?: string;
  args?: string[];
  /** Host-only source working directory; references resolve after selection. */
  cwd?: string;
  url?: string;
  transport?: 'stdio' | 'sse' | 'http';
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface ImportedDelivery { connectionId: string; chatId: string; threadId?: number }

/** Private, host-only content. Do not serialize this into IPC, logs or model messages. */
export interface ImportItem {
  view: CompanionImportEntry;
  /** Stable index in the originating preview, retained in selected-only checkpoints. */
  sourceIndex?: number;
  files?: ImportFile[];
  sourceDirectory?: string;
  sourceAlias?: string;
  /** Failed document or subtree read; retained for an explicit retry. */
  sourceFile?: { root: string; file: string; kind?: 'file' | 'directory' | 'unknown'; logicalPrefix?: string; sharedDocumentRoots?: string[] };
  /** Recovered subtree documents stay under the original selected entry/receipt. */
  documents?: Array<{ id: string; name: string; text: string; role?: 'user' }>;
  /** Selected skill resources have been captured for copying, verification and restart. */
  filesComplete?: boolean;
  /** Item-level capture failure retained for a later retry, without discarding healthy siblings. */
  captureIssue?: string;
  text?: string;
  role?: 'identity' | 'user' | 'instructions';
  env?: Record<string, string>;
  /** Variable requirements are separate from mandatory entries: profiles are alternatives. */
  envDependencies?: { names: string[]; entries: string[] };
  mcp?: ImportedMcpServer;
  credential?: { format: string; value: unknown };
  asset?: { name: string; bytes: Buffer; executable?: boolean };
  automation?: {
    sourceId: string;
    input?: RoutineInput;
    original: Record<string, unknown>;
    /** Native schedule state fingerprint used before source handover. */
    fingerprint: string;
    deliveries?: ImportedDelivery[];
  };
}

export interface ImportSnapshot {
  source: ImportSource;
  items: ImportItem[];
  avatarImageBase64?: string;
  fingerprint: string;
  /** Private restart masks for values already embedded in selected source content. */
  publicationRedactions?: Record<string, string>;
}

export class CompanionImportError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CompanionImportError';
  }
}

export const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
export const string = (value: unknown): string => typeof value === 'string' ? value : '';

export function importFailureCode(error: unknown): string {
  if (error instanceof CompanionImportError) return error.code;
  const code = (error as { code?: string } | null)?.code;
  const known: Record<string, string> = {
    'description-has-newline': 'MEMORY_METADATA_INVALID', 'description-too-long': 'MEMORY_DESCRIPTION_TOO_LONG', 'title-too-long': 'MEMORY_TITLE_TOO_LONG',
    'shard-too-large': 'MEMORY_CONTENT_TOO_LARGE', 'invalid-frontmatter': 'MEMORY_METADATA_INVALID',
    'version-conflict': 'MEMORY_CHANGED', 'already-exists': 'MEMORY_CHANGED',
    'not-ready': 'MEMORY_STORAGE_UNAVAILABLE', 'io-error': 'MEMORY_WRITE_FAILED',
    ENOSPC: 'IMPORT_DISK_FULL', EACCES: 'IMPORT_PERMISSION_DENIED', EPERM: 'IMPORT_PERMISSION_DENIED',
  };
  return code && known[code] || 'IMPORT_ITEM_FAILED';
}
