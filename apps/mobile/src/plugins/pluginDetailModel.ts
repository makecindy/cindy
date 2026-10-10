import {
  parsePluginUsageSummary,
  type PluginPageSurface,
  type RemoteResource,
  type PluginConfigurationSummary,
} from "@cindy/device-link";
import type { HostedRemoteCollectionItem } from "@/device-link/remoteResources";

export type PluginDetailStatus =
  | "offline"
  | "loading"
  | "loadFailed"
  | "retired"
  | "approvalRequired"
  | "disabled"
  | "setupRequired"
  | "setupUnknown";
export interface PluginDetailModel {
  details?: Array<{ key: string; title: string; value: string }>;
  tools?: Array<{ name: string; description: string }>;
  permissions?: Array<{ title: string; description: string }>;
  description?: string;
  version?: string;
  status?: PluginDetailStatus;
  statusAction?: "connect" | "retry" | "enable" | "settings" | "reconnect";
  taskUsable: boolean;
  canUseTasks: boolean;
  canToggle: boolean;
  hasSettings: boolean;
  taskPreferences: boolean;
  mainSurface?: PluginPageSurface;
  mobileSettings: boolean;
  builtin: boolean;
  missing: string[];
  expired: string[];
  setupGroups: Array<{ missing: string[]; expired: string[] }>;
  runtimeIssue?: "crashed" | "fused";
  configuration?: PluginConfigurationSummary;
}

/** Presentation only. Every write still uses the existing Host action and authorization checks. */
export function pluginDetailModel(
  row: HostedRemoteCollectionItem,
  resource: RemoteResource | undefined,
  online: boolean,
  loading: boolean,
  loadFailed: boolean,
): PluginDetailModel {
  const capabilities = resource?.blocks?.find(
    (block) => block.id === "capabilities",
  )?.data as
    | {
        tasks?: boolean;
        usage?: unknown;
        tools?: unknown;
        permissions?: unknown;
        details?: unknown;
      }
    | undefined;
  const usage = parsePluginUsageSummary(capabilities?.usage);
  const enabled =
    row.item.actions?.some((action) => action.id === "disable") ?? false;
  const actions = row.item.actions ?? [];
  const main =
    actions.find((action) => action.id === "open:panel") ??
    actions.find((action) => action.id === "open:mainView");
  const mobileSettings = actions.some(
    (action) => action.id === "open:settings",
  );
  const taskPreferences = capabilities?.tasks === true;
  const status: PluginDetailStatus | undefined = !online
    ? "offline"
    : loadFailed
      ? "loadFailed"
      : loading
        ? "loading"
        : usage?.retired
          ? "retired"
          : usage?.approvalRequired
            ? "approvalRequired"
            : !enabled
              ? "disabled"
              : usage?.setup.state === "required"
                ? "setupRequired"
                : usage?.setup.state === "unknown"
                  ? "setupUnknown"
                  : capabilities?.usage !== undefined && !usage
                    ? "setupUnknown"
                    : undefined;
  const statusAction =
    status === "offline"
      ? "connect"
      : status === "loadFailed" || status === "setupUnknown"
        ? "retry"
        : status === "disabled"
          ? "enable"
          : status === "setupRequired"
            ? !usage?.setup.missing.length && usage?.setup.expired.length
              ? "reconnect"
              : "settings"
            : undefined;
  // Older Hosts have no usage facts; preserve their existing task entry, without claiming readiness.
  const taskUsable = usage?.taskUsable ?? true;
  const tools =
    Array.isArray(capabilities?.tools) &&
    capabilities.tools.every(
      (tool) =>
        tool &&
        typeof tool.name === "string" &&
        (tool.description === undefined ||
          typeof tool.description === "string"),
    )
      ? capabilities.tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
        }))
      : undefined;
  const permissions =
    Array.isArray(capabilities?.permissions) &&
    capabilities.permissions.every(
      (permission) =>
        permission &&
        typeof permission.title === "string" &&
        typeof permission.description === "string",
    )
      ? capabilities.permissions.map((permission) => ({
          title: permission.title,
          description: permission.description,
        }))
      : undefined;
  const details =
    Array.isArray(capabilities?.details) &&
    capabilities.details.every(
      (fact) =>
        fact &&
        typeof fact.key === "string" &&
        typeof fact.title === "string" &&
        typeof fact.value === "string",
    )
      ? capabilities.details.map((fact) => ({
          key: fact.key,
          title: fact.title,
          value: fact.value,
        }))
      : undefined;
  return {
    details,
    tools,
    permissions,
    description: resource?.blocks?.find((block) => block.id === "about")
      ?.fallbackMarkdown,
    version: resource?.blocks?.find((block) => block.id === "version")
      ?.fallbackMarkdown,
    status,
    statusAction,
    taskUsable,
    canUseTasks: taskUsable && !status && usage?.runtimeIssue !== "fused",
    canToggle:
      online &&
      !loading &&
      !loadFailed &&
      !usage?.retired &&
      !usage?.approvalRequired &&
      actions.some(
        (action) =>
          (action.id === "enable" || action.id === "disable") &&
          !action.disabled,
      ),
    hasSettings: Boolean(
      usage?.hasSettings ||
      mobileSettings ||
      taskPreferences ||
      usage?.configuration?.items.length ||
      status === "setupRequired",
    ),
    taskPreferences,
    mainSurface: main?.id.slice(5) as PluginPageSurface | undefined,
    mobileSettings,
    builtin: usage?.builtin ?? false,
    missing: usage?.setup.missing ?? [],
    expired: usage?.setup.expired ?? [],
    setupGroups: usage?.setup.groups ?? [],
    runtimeIssue: usage?.runtimeIssue,
    configuration: usage?.configuration,
  };
}
