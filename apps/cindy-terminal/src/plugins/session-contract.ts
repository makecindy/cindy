import type { AutoReviewRequest, Session } from "@cindy/maker-core";
import type {
  PluginTaskRoute,
  PluginTaskView,
} from "@cindy/plugin-runtime/shared/pluginTasks";
import type { PluginMessageImage } from "@cindy/plugin-runtime/pluginMessageAttachments";
import type {
  SessionExecutionIdentity,
  OwnedQueuedInput,
} from "@cindy/plugin-runtime/sessionExecutionOwnership";
import type { AutoReviewHistoryMessage } from "@cindy/maker-shared/auto-review-intent";
import type { Submission } from "../tasks/storage.js";

export interface TerminalPluginSessionHooks {
  isWorkerLabelLockedByPlan?(input: { leadSessionId: string; labels: string[] }): Promise<boolean>;
  captureOrcaAuthority?(taskId: string, acceptedInputId?: string): Promise<{ permissionMode?: 'auto'; assertCurrent(): Promise<void> }>;
  validateWorkerPlan?: import('@cindy/orca-workflow/host/orcaWorkerCreationService').OrcaWorkerCreationPlanValidator;
  assertDispatch(pluginId: string, taskId: string): Promise<void>;
  accept(
    pluginId: string,
    taskId: string,
    clientId: string,
    execution: SessionExecutionIdentity,
  ): Promise<void>;
  onSubmission(receipt: Submission): Promise<void>;
  review(request: AutoReviewRequest): Promise<AutoReviewRequest>;
  recoverWriteAccess(
    taskId: string,
    retry: boolean,
    current: () => void,
  ): Promise<{ granted: boolean; available?: boolean; mode?: string }>;
}
export interface TerminalPluginSessionPort {
  resolve(route: Partial<PluginTaskRoute>): Promise<PluginTaskRoute>;
  create(
    input: {
      id: string;
      title: string;
      route: PluginTaskRoute;
      workingDir?: string;
      permissionMode: string;
      hidden?: boolean;
    },
    guard: () => void,
    onPersistenceStarted: () => void,
  ): Promise<void>;
  read(id: string): Promise<PluginTaskView | null>;
  setModel(
    id: string,
    route: PluginTaskRoute,
    current: () => Promise<void>,
  ): Promise<{ status: string }>;
  live(id: string): Session | undefined;
  inspect(id: string): Promise<{
    execution: SessionExecutionIdentity | null;
    pending: OwnedQueuedInput[];
  }>;
  dispatch(
    plugin: { id: string; name: string },
    id: string,
    clientId: string,
    text: string,
    images: PluginMessageImage[],
    guard: () => void,
  ): Promise<{ ok: boolean }>;
  cancel(
    id: string,
    clientIds: readonly string[],
    execution: SessionExecutionIdentity | undefined,
    guard: () => void,
  ): Promise<"cancelled" | "stopping" | "stale">;
  hidden(id: string, value: boolean, guard: () => void): Promise<void>;
  history(id: string): Promise<AutoReviewHistoryMessage[]>;
  withTaskLock<T>(id: string, run: () => Promise<T>): Promise<T>;
  withPermissionLock<T>(id: string, run: () => Promise<T>): Promise<T>;
  assertIdle(
    id: string,
    unstarted: boolean,
    current: () => void,
  ): Promise<void>;
  confirmPermission(
    id: string,
    input: { title: string; message: string; detail: string },
    current: () => void,
    signal: AbortSignal,
  ): Promise<boolean>;
  changePermission(
    id: string,
    mode: "acceptEdits" | "auto",
    current: () => void,
    persistPreferences: () => Promise<void>,
  ): Promise<void>;
}
