/** Same-account independent task copy. File bytes use existing peer attachments / OSS, never relay frames. */
export const TASK_MIGRATION_CHANNEL = "maker:task-copy";
export const TASK_MIGRATION_LOCAL_CHANNEL = "task-copy:request";
/** `estimate` stops early with MIGRATION_TOO_MANY_FILES above this many project files. */
export const TASK_MIGRATION_MAX_FILES = 500_000;
export const TASK_MIGRATION_ESTIMATE_TIMEOUT_MS = 3 * 60_000;
export const TASK_MIGRATION_RECEIVE_TIMEOUT_MS = 30 * 60_000;
/** Most transcripts one copy sends beside its conversation package. */
export const TASK_MIGRATION_MAX_TRANSCRIPTS = 256;
export interface MigrationFileRef {
  ref: string;
  size: number;
  sha256: string;
}
export type MigrationFile =
  MigrationFileRef | { size: number; parts: MigrationFileRef[] };
export interface MigrationResources {
  transferBytes: number;
  unpackedBytes: number;
  contextBytes: number;
  manifestBytes: number;
  repositoryBytes: number;
  entries: number;
  /** Native transcripts sent as separate files; absent from older sources. */
  transcriptBytes?: number;
}
export interface MigrationFiles {
  session: MigrationFile;
  workspace: MigrationFile;
  manifest: MigrationFile;
  repository?: MigrationFile;
  additionalWorkspaces?: Array<{
    workspace: MigrationFile;
    repository?: MigrationFile;
  }>;
  /**
   * Native transcripts kept out of the conversation package, in the order the copy's
   * workspace manifest lists them. Only sent to targets declaring `externalTranscripts`.
   */
  transcripts?: MigrationFile[];
}
export type TaskMigrationRequest =
  | {
      action: "preflight";
      targetProject: string | null;
      resources: MigrationResources;
    }
  | { action: "caps" }
  | { action: "move-project"; sessionId: string; workingDir: string | null }
  | {
      action: "start";
      sessionId: string;
      targetDeviceId: string;
      targetProject?: string | null;
    }
  | { action: "status" | "retry" | "cancel" | "estimate"; sessionId: string }
  | {
      action: "receive";
      id: string;
      sourceSessionId: string;
      targetProject: string | null;
      files: MigrationFiles;
    }
  | { action: "receipt"; id: string; sourceSessionId: string };
export interface TaskMigrationView {
  supported: true;
  deviceId: string;
  projectMove?: {
    sessionId: string;
    workingDir: string | null;
    workspaceKind: string;
  };
  stage?:
    | "preparing"
    | "transferring"
    | "complete"
    | "cancelled"
    | "receiving"
    | "active";
  estimate?: { fileCount: number; bytes: number };
  copyEstimate?: true;
  running?: boolean;
  /** A running copy accepts `cancel` (source staging only). Absent on older hosts. */
  cancellable?: true;
  /** `cancel` was accepted; the running copy is unwinding. Absent on older hosts. */
  cancelling?: true;
  /** Optional live source-side upload telemetry; absent on older hosts. Never persisted. */
  progress?: {
    phase: "sending" | "finishing";
    sentBytes: number;
    totalBytes: number;
    bytesPerSecond: number;
  };
  targetDeviceId?: string;
  targetSessionId?: string;
  error?: string;
  /** Project-relative entry blamed for `error` (e.g. a non-portable name). Absent on older hosts. */
  errorPath?: string;
  /**
   * Entries the copy left behind (a directory stands for its subtree), with why; `entries` is
   * capped and `total` counts them all. Absent when nothing was skipped or on older hosts.
   */
  skipped?: { total: number; entries: Array<{ path: string; code: string }> };
  projects?: string[];
  agents?: Array<"cc" | "codex" | "pi">;
  /** Entire Orca graph, native contexts and per-member workspaces. Absence means unsupported. */
  teamMigration?: true;
  /** Accepts `files.transcripts` (large native transcripts streamed outside the package). */
  externalTranscripts?: true;
  /** Bytes needed vs the limit, when `error` is a size failure. Absent on older hosts. */
  errorSize?: { needed: number; limit: number };
}

export function parseTaskMigrationRequest(
  value: unknown,
): TaskMigrationRequest {
  if (!value || typeof value !== "object")
    throw new Error("MIGRATION_INVALID_REQUEST");
  const r = value as Record<string, unknown>;
  const id = (v: unknown): v is string =>
    typeof v === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
  const uuid = (v: unknown): v is string =>
    typeof v === "string" && /^[a-f0-9-]{36}$/.test(v);
  const project = (v: unknown) =>
    v == null ||
    (typeof v === "string" &&
      v.length > 0 &&
      v.length <= 4096 &&
      !v.includes("\0"));
  if (
    r.action === "move-project" &&
    id(r.sessionId) &&
    r.workingDir !== undefined &&
    project(r.workingDir)
  )
    return {
      action: "move-project",
      sessionId: r.sessionId,
      workingDir: r.workingDir as string | null,
    };
  if (r.action === "caps") return { action: "caps" };
  if (
    r.action === "preflight" &&
    project(r.targetProject) &&
    r.resources &&
    typeof r.resources === "object"
  ) {
    const resources = r.resources as MigrationResources;
    for (const key of [
      "transferBytes",
      "unpackedBytes",
      "contextBytes",
      "manifestBytes",
      "repositoryBytes",
      "entries",
    ] as const)
      if (!Number.isSafeInteger(resources[key]) || resources[key] < 0)
        throw new Error("MIGRATION_INVALID_REQUEST");
    if (
      resources.transcriptBytes !== undefined &&
      (!Number.isSafeInteger(resources.transcriptBytes) ||
        resources.transcriptBytes < 0)
    )
      throw new Error("MIGRATION_INVALID_REQUEST");
    return {
      action: "preflight",
      targetProject: (r.targetProject as string | null) ?? null,
      resources,
    };
  }

  if (
    ["status", "retry", "cancel", "estimate"].includes(String(r.action)) &&
    id(r.sessionId)
  )
    return {
      action: r.action as "status" | "retry" | "cancel" | "estimate",
      sessionId: r.sessionId,
    };
  if (
    r.action === "start" &&
    id(r.sessionId) &&
    id(r.targetDeviceId) &&
    project(r.targetProject)
  )
    return {
      action: "start",
      sessionId: r.sessionId,
      targetDeviceId: r.targetDeviceId,
      targetProject: r.targetProject as string | null,
    };
  if (r.action === "receipt" && uuid(r.id) && id(r.sourceSessionId))
    return { action: r.action, id: r.id, sourceSessionId: r.sourceSessionId };
  if (
    r.action === "receive" &&
    uuid(r.id) &&
    id(r.sourceSessionId) &&
    project(r.targetProject) &&
    r.files &&
    typeof r.files === "object"
  ) {
    const files = r.files as MigrationFiles;
    if (
      files.additionalWorkspaces !== undefined &&
      (!Array.isArray(files.additionalWorkspaces) ||
        files.additionalWorkspaces.some(
          (entry) => !entry || typeof entry !== "object",
        ))
    )
      throw new Error("MIGRATION_INVALID_REQUEST");
    if (
      files.transcripts !== undefined &&
      (!Array.isArray(files.transcripts) ||
        files.transcripts.length > TASK_MIGRATION_MAX_TRANSCRIPTS)
    )
      throw new Error("MIGRATION_INVALID_REQUEST");
    const allFiles = [
      files.session,
      files.workspace,
      files.manifest,
      ...(files.repository ? [files.repository] : []),
      ...(files.additionalWorkspaces ?? []).flatMap((entry) => [
        entry.workspace,
        ...(entry.repository ? [entry.repository] : []),
      ]),
      ...(files.transcripts ?? []),
    ];
    for (const file of allFiles) {
      if (!file || !Number.isSafeInteger(file.size) || file.size <= 0)
        throw new Error("MIGRATION_INVALID_REQUEST");
      const parts = "parts" in file ? file.parts : [file];
      if (!Array.isArray(parts) || !parts.length)
        throw new Error("MIGRATION_INVALID_REQUEST");
      let size = 0;
      for (const part of parts) {
        if (
          !part ||
          typeof part.ref !== "string" ||
          part.ref.length > 16384 ||
          !Number.isSafeInteger(part.size) ||
          part.size <= 0 ||
          typeof part.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(part.sha256)
        )
          throw new Error("MIGRATION_INVALID_REQUEST");
        size += part.size;
      }
      if (!Number.isSafeInteger(size) || size !== file.size)
        throw new Error("MIGRATION_INVALID_REQUEST");
    }
    return {
      action: "receive",
      id: r.id,
      sourceSessionId: r.sourceSessionId,
      targetProject: (r.targetProject as string | null) ?? null,
      files,
    };
  }
  throw new Error("MIGRATION_INVALID_REQUEST");
}
