/** Named, independently approved capabilities. Unknown names survive parsing, never grant access. */
export const GHOST_HARNESS_CAPABILITIES = {
  read: ["runtime", "usage", "status", "messages", "tool-content"],
  events: ["tool", "usage", "compaction", "task", "status", "message"],
  hooks: ["permission.request", "tool.before", "compaction.before"],
  actions: ["context.compact", "turn.interrupt"],
} as const;

export type GhostHarnessGroup = keyof typeof GHOST_HARNESS_CAPABILITIES;
export interface GhostHarnessNeeds {
  read?: string[];
  events?: string[];
  hooks?: string[];
  actions?: string[];
  [key: string]: unknown;
}

export type GhostHarnessHookName =
  (typeof GHOST_HARNESS_CAPABILITIES.hooks)[number];
export type GhostHarnessActionName =
  (typeof GHOST_HARNESS_CAPABILITIES.actions)[number];

export interface GhostHarnessRuntime {
  revision: 1;
  agent: string;
  runtimeVersion: string | null;
  read: string[];
  events: string[];
  hooks: Array<{
    name: GhostHarnessHookName;
    source: "host-permission" | "native";
    connected?: boolean;
    actions: ["continue", "block"];
    timeoutMs: number;
    onFailure: "continue-normal-permission-flow";
  }>;
  actions: string[];
  availability?: Array<{
    group: "hooks" | "actions";
    name: string;
    connected: boolean;
  }>;
  capabilityStates: Array<{
    group: GhostHarnessGroup;
    name: string;
    connected: boolean;
    declared: boolean;
    approved: boolean;
  }>;
  hookSubscriptions: Array<{
    name: GhostHarnessHookName;
    state:
      | "not-declared"
      | "denied"
      | "not-ready"
      | "disabled"
      | "fused"
      | "not-running"
      | "ready";
  }>;
  backgroundCompaction: {
    supported: false;
    nativeEnabled: "unknown";
    nativeRunning: "unknown";
  };
}

export interface GhostHarnessActionValue {
  /** Interrupt acknowledgement only; observe native terminal events for completion. */
  state?: "requested" | "noop";
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  noop?: boolean;
}

export interface GhostHarnessMetadata {
  revision: 1;
  sessionId: string;
  /** Opaque binding identity. Changes when the host replaces this Session. */
  runtimeId: string;
  turnGeneration: number;
  agent: string;
  toolId?: string;
  toolName?: string;
  taskId?: string;
  taskStatus?: "running" | "completed" | "failed" | "stopped";
  isError?: boolean;
  status?: "running" | "idle";
  usage?: Record<string, number>;
  /** Content is separately approved, bounded, and never includes agentMeta. */
  content?: unknown;
  role?: "assistant" | "tool_use" | "tool_result";
  truncated?: boolean;
  isFullText?: boolean;
  isFinal?: boolean;
}

export interface GhostHarnessReadRequest {
  type: "harness-request";
  kind: "read";
  name: string;
  sessionId: string;
  runtimeId?: string;
  limit?: number;
  cursor?: string;
}

export interface GhostHarnessActionRequest {
  type: "harness-request";
  kind: "action";
  name: "context.compact" | "turn.interrupt";
  sessionId: string;
  runtimeId: string;
  turnGeneration: number;
  /** One-shot identity; reuse never dispatches the action again. */
  requestId: string;
}

export interface GhostHarnessHookSubscriptionRequest {
  type: "harness-request";
  kind: "hook";
  name: "permission.request" | "tool.before" | "compaction.before";
  sessionId: string;
  runtimeId: string;
  enabled: boolean;
}

export type GhostHarnessRequest =
  | GhostHarnessReadRequest
  | GhostHarnessActionRequest
  | GhostHarnessHookSubscriptionRequest;
export type GhostHarnessRequestInput =
  | Omit<GhostHarnessReadRequest, "type">
  | Omit<GhostHarnessActionRequest, "type">
  | Omit<GhostHarnessHookSubscriptionRequest, "type">;

export interface GhostHarnessHistoryItem {
  id: string;
  role: "user" | "assistant" | "tool_use" | "tool_result";
  createdAt: number;
  toolId?: string;
  content: unknown;
  truncated?: boolean;
}

export interface GhostHarnessHistoryPage {
  items: GhostHarnessHistoryItem[];
  nextCursor: string | null;
  /** Saved history only, never a complete provider transcript. */
  source: "saved-history";
}

export type GhostHarnessReadResult<T = unknown> =
  | ({ ok: true; value: T } & Pick<
      GhostHarnessMetadata,
      "revision" | "sessionId" | "runtimeId" | "turnGeneration" | "agent"
    >)
  | {
      ok: false;
      errorCode:
        | "INVALID_PARAMS"
        | "DENIED"
        | "UNSUPPORTED"
        | "SESSION_UNAVAILABLE"
        | "STALE_RUNTIME"
        | "BUSY"
        | "TIMEOUT"
        | "UNAVAILABLE";
      /** Dispatch may have happened. Never automatically repeat the operation. */
      outcome?: "unknown";
    };

export type GhostHarnessResult<T = unknown> = GhostHarnessReadResult<T>;

export interface GhostPipeHarnessVerdict {
  type: "harness-verdict";
  hookId: string;
  action: "continue" | "block";
}

export interface GhostPipeHarnessEvent {
  type: "harness-event";
  name:
    | "tool.started"
    | "tool.completed"
    | "usage.updated"
    | "compaction.boundary"
    | "task.updated"
    | "status.updated"
    | "message.updated";
  topic: "tool" | "usage" | "compaction" | "task" | "status" | "message";
  seq: number;
  ts: number;
  dropped?: number;
  data: GhostHarnessMetadata;
}

export interface GhostPipeHarnessHook {
  type: "harness-hook";
  name: "permission.request" | "tool.before" | "compaction.before";
  hookId: string;
  deadline: number;
  data: GhostHarnessMetadata;
}

/** Host-owned receipt keys; never infer these from a previously unknown manifest field. */
export function ghostHarnessPermissionKeys(
  needs: GhostHarnessNeeds | undefined,
): string[] {
  if (!needs || typeof needs !== "object" || Array.isArray(needs)) return [];
  return Object.entries(GHOST_HARNESS_CAPABILITIES).flatMap(
    ([group, known]) => {
      const declared = needs[group];
      return Array.isArray(declared)
        ? declared
            .filter((name) => (known as readonly string[]).includes(name))
            .map((name) => `harness:${group}:${name}`)
        : [];
    },
  );
}

export function parseGhostHarnessNeeds(
  value: unknown,
): GhostHarnessNeeds | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const raw = value as Record<string, unknown>;
  const result: GhostHarnessNeeds = { ...raw };
  for (const group of Object.keys(
    GHOST_HARNESS_CAPABILITIES,
  ) as GhostHarnessGroup[]) {
    if (raw[group] === undefined) continue;
    const names = raw[group];
    if (
      !Array.isArray(names) ||
      names.length === 0 ||
      names.length > 32 ||
      names.some(
        (name) =>
          typeof name !== "string" || !/^[a-z][a-z0-9._:-]{0,127}$/.test(name),
      ) ||
      new Set(names).size !== names.length
    )
      return null;
    result[group] = [...names];
  }
  return result;
}
