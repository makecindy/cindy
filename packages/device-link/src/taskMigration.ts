/** Same-account task handoff. File bytes use existing peer attachments / OSS, never relay frames. */
export const TASK_MIGRATION_CHANNEL = "maker:task-migration";
export const TASK_MIGRATION_LOCAL_CHANNEL = "task-migration:request";
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
  | { action: "status" | "retry" | "cancel"; sessionId: string }
  | {
      action: "receive";
      id: string;
      sourceSessionId: string;
      targetProject: string | null;
      files: MigrationFiles;
    }
  | { action: "activate"; id: string; sourceSessionId: string }
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
    | "moved"
    | "complete"
    | "cancelled"
    | "receiving"
    | "ready"
    | "active";
  running?: boolean;
  targetDeviceId?: string;
  targetSessionId?: string;
  error?: string;
  projects?: string[];
  agents?: Array<"cc" | "codex" | "pi">;
  /** Entire Orca graph, native contexts and per-member workspaces. Absence means unsupported. */
  teamMigration?: true;
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
    return {
      action: "preflight",
      targetProject: (r.targetProject as string | null) ?? null,
      resources,
    };
  }

  if (
    ["status", "retry", "cancel"].includes(String(r.action)) &&
    id(r.sessionId)
  )
    return {
      action: r.action as "status" | "retry" | "cancel",
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
  if (
    (r.action === "activate" || r.action === "receipt") &&
    uuid(r.id) &&
    id(r.sourceSessionId)
  )
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
    const allFiles = [
      files.session,
      files.workspace,
      files.manifest,
      ...(files.repository ? [files.repository] : []),
      ...(files.additionalWorkspaces ?? []).flatMap((entry) => [
        entry.workspace,
        ...(entry.repository ? [entry.repository] : []),
      ]),
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
