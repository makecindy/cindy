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
  files?: ImportFile[];
  sourceDirectory?: string;
  /** Selected skill resources have been captured for copying, verification and restart. */
  filesComplete?: boolean;
  text?: string;
  role?: 'identity' | 'user' | 'instructions';
  env?: Record<string, string>;
  /** Variable requirements are separate from mandatory entries: profiles are alternatives. */
  envDependencies?: { names: string[]; entries: string[] };
  mcp?: ImportedMcpServer;
  credential?: { format: string; value: unknown };
  asset?: { name: string; bytes: Buffer };
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
