/** Host bridge revision, independent of provider SDK and Pi runtime catalog revisions. */
export const HARNESS_BRIDGE_REVISION = 1 as const;

export interface HarnessHookRequest {
  name: "permission.request" | "tool.before" | "compaction.before";
  /** Metadata only. Arguments, descriptions and native opaque state are not exposed. */
  toolName?: string;
  toolUseId?: string;
  /** Tool input is released by Main only with separate tool-content approval. */
  input?: unknown;
}
export type HarnessHookResult =
  { action: "continue" } | { action: "block"; reason?: string };
export type HarnessHookHandler = (
  request: HarnessHookRequest,
) => Promise<HarnessHookResult>;

export interface HarnessCapabilityCatalog {
  revision: typeof HARNESS_BRIDGE_REVISION;
  agent: string;
  /** Unknown until a provider supplies the actual running version; never a bundled pin. */
  runtimeVersion: string | null;
  read: string[];
  events: string[];
  hooks: Array<{
    name: HarnessHookRequest["name"];
    source: "host-permission" | "native";
    connected?: boolean;
    actions: ["continue", "block"];
    timeoutMs: number;
    onFailure: "continue-normal-permission-flow";
  }>;
  actions: string[];
  /** Known common interfaces and actual adapter readiness are separate facts. */
  availability?: Array<{
    group: "hooks" | "actions";
    name: string;
    connected: boolean;
  }>;
  /** No prepare/commit protocol is implemented by this bridge revision. */
  backgroundCompaction: {
    supported: false;
    nativeEnabled: "unknown";
    nativeRunning: "unknown";
  };
}
