/** Optional plugin-page projection. Author pages receive no host paths or credentials. */
export const PLUGIN_COLLECTION = "plugins";
export const PLUGIN_PAGE_PRIMITIVE = "plugin-page";
export type PluginPageSurface = "panel" | "mainView" | "settings";
/** Safe configuration facts, never form values, secrets, account identifiers or action grants. */
export interface PluginConfigurationItem {
  id: string;
  kind: "secret" | "oauth" | "connection" | "parameter" | "managed" | "client";
  label: string;
  hint?: string;
  state: "configured" | "missing" | "expired" | "unknown" | "managed";
  count?: number;
  expiredCount?: number;
}
export interface PluginConfigurationSummary {
  items: PluginConfigurationItem[];
  alternatives: string[][];
}
export function parsePluginConfigurationSummary(
  value: unknown,
): PluginConfigurationSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const kinds = [
    "secret",
    "oauth",
    "connection",
    "parameter",
    "managed",
    "client",
  ];
  const states = ["configured", "missing", "expired", "unknown", "managed"];
  const bounded = (x: unknown, max: number): x is string =>
    typeof x === "string" && x.length > 0 && x.length <= max;
  if (
    !Array.isArray(v.items) ||
    v.items.length > 128 ||
    !Array.isArray(v.alternatives) ||
    v.alternatives.length > 16
  )
    return null;
  const items: PluginConfigurationItem[] = [];
  for (const raw of v.items) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    if (
      !bounded(item.id, 160) ||
      !bounded(item.label, 160) ||
      !kinds.includes(item.kind as string) ||
      !states.includes(item.state as string)
    )
      return null;
    if (
      item.hint !== undefined &&
      (typeof item.hint !== "string" || item.hint.length > 512)
    )
      return null;
    if (
      [item.count, item.expiredCount].some(
        (n) =>
          n !== undefined &&
          (!Number.isSafeInteger(n) ||
            (n as number) < 0 ||
            (n as number) > 10000),
      )
    )
      return null;
    if (items.some((other) => other.id === item.id)) return null;
    items.push({
      id: item.id,
      label: item.label,
      kind: item.kind as PluginConfigurationItem["kind"],
      state: item.state as PluginConfigurationItem["state"],
      ...(item.hint !== undefined ? { hint: item.hint as string } : {}),
      ...(item.count !== undefined ? { count: item.count as number } : {}),
      ...(item.expiredCount !== undefined
        ? { expiredCount: item.expiredCount as number }
        : {}),
    });
  }
  const alternatives: string[][] = [];
  for (const group of v.alternatives) {
    if (
      !Array.isArray(group) ||
      group.length < 2 ||
      group.length > 8 ||
      group.some(
        (id) => typeof id !== "string" || !items.some((item) => item.id === id),
      ) ||
      new Set(group).size !== group.length
    )
      return null;
    alternatives.push([...group]);
  }
  return { items, alternatives };
}
/** Optional installed-detail facts. No configuration values, action grants or host paths. */
export interface PluginUsageSummary {
  taskUsable: boolean;
  hasSettings: boolean;
  approvalRequired: boolean;
  builtin: boolean;
  retired: boolean;
  runtimeIssue?: "crashed" | "fused";
  configuration?: PluginConfigurationSummary;
  setup: {
    state: "ready" | "required" | "unknown";
    missing: string[];
    expired: string[];
    groups?: Array<{ missing: string[]; expired: string[] }>;
  };
}

export function parsePluginUsageSummary(
  value: unknown,
): PluginUsageSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    [
      "taskUsable",
      "hasSettings",
      "approvalRequired",
      "builtin",
      "retired",
    ].some((key) => typeof v[key] !== "boolean")
  )
    return null;
  if (!v.setup || typeof v.setup !== "object" || Array.isArray(v.setup))
    return null;
  const setup = v.setup as Record<string, unknown>;
  if (!["ready", "required", "unknown"].includes(setup.state as string))
    return null;
  const labels = (input: unknown): input is string[] =>
    Array.isArray(input) &&
    input.length <= 64 &&
    input.every((label) => typeof label === "string" && label.length <= 160);
  if (!labels(setup.missing) || !labels(setup.expired)) return null;
  const groups = setup.groups;
  const configuration =
    v.configuration === undefined
      ? undefined
      : parsePluginConfigurationSummary(v.configuration);
  if (configuration === null) return null;
  if (
    groups !== undefined &&
    (!Array.isArray(groups) ||
      groups.length > 64 ||
      groups.some(
        (group) =>
          !group ||
          typeof group !== "object" ||
          !labels(group.missing) ||
          !labels(group.expired),
      ))
  )
    return null;
  if (
    v.runtimeIssue !== undefined &&
    !["crashed", "fused"].includes(v.runtimeIssue as string)
  )
    return null;
  return {
    taskUsable: v.taskUsable as boolean,
    hasSettings: v.hasSettings as boolean,
    approvalRequired: v.approvalRequired as boolean,
    builtin: v.builtin as boolean,
    retired: v.retired as boolean,
    ...(configuration ? { configuration } : {}),
    ...(v.runtimeIssue
      ? { runtimeIssue: v.runtimeIssue as "crashed" | "fused" }
      : {}),
    setup: {
      state: setup.state as PluginUsageSummary["setup"]["state"],
      missing: [...setup.missing],
      expired: [...setup.expired],
      ...(Array.isArray(groups)
        ? {
            groups: groups.map((group) => ({
              missing: [...group.missing],
              expired: [...group.expired],
            })),
          }
        : {}),
    },
  };
}
export interface PluginMobileDeclaration {
  channels: string[];
  panel?: string;
  mainView?: string;
  settings?: string;
}
/** Unknown/invalid extensions do not disable a legacy installation. They simply cannot open a mobile page. */
export function parsePluginMobileDeclaration(
  value: unknown,
): PluginMobileDeclaration | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    !Array.isArray(v.channels) ||
    v.channels.length > 16 ||
    !v.channels.every(
      (c) =>
        typeof c === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(c),
    )
  )
    return null;
  const result: PluginMobileDeclaration = {
    channels: [...new Set(v.channels as string[])],
  };
  for (const key of ["panel", "mainView", "settings"] as const) {
    if (v[key] === undefined) continue;
    if (
      typeof v[key] !== "string" ||
      !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*(\/[a-zA-Z0-9_][a-zA-Z0-9_.-]*)*\.html$/.test(
        v[key] as string,
      )
    )
      return null;
    result[key] = v[key] as string;
  }
  return result;
}
export interface PluginPageAsset {
  mime: string;
  base64: string;
}
export interface PluginPageFetchResult extends PluginPageAsset {
  status: number;
  nextOffset?: number;
  revision?: string;
}
export interface PluginPageFile {
  path: string;
  mime: string;
  size: number;
}
export interface PluginPageDocument {
  pageId: string;
  pluginId: string;
  title: string;
  surface: PluginPageSurface;
  entry: string;
  channels: string[];
  files: PluginPageFile[];
  unreadAt?: number;
}
export interface PluginPageEvent {
  sequence: number;
  channel: string;
  data: unknown;
}
export interface PluginPageConfirm {
  id: string;
  pluginId: string;
  title: string;
  body: string;
  confirmText: string | null;
  cancelText: string | null;
  danger: boolean;
  expiresAt: number;
}
export interface PluginPagePoll {
  events: PluginPageEvent[];
  confirms: PluginPageConfirm[];
  notifications: Array<{ id: string; text: string }>;
  unreadAt?: number;
  directories?: PluginDirectoryRequest[];
  intents?: PluginNativeIntent[];
}
export type PluginNativeIntent = {
  id: string;
  pluginId: string;
  ghostName: string;
} & (
  | { kind: "task"; taskId: string }
  | { kind: "preview"; url: string }
  | { kind: "schedule"; name: string; prompt: string; intervalMs?: number }
  /** @deprecated Read compatibility for older hosts only; no longer produced. */
  | { kind: "simulator" }
  | { kind: "media"; path: string; mediaKind: "image" | "video" }
);
/** Trusted native picker presentation, never forwarded into an author page. */
export interface PluginDirectoryRequest {
  id: string;
  pluginId: string;
  ghostName: string;
  purpose: string | null;
  expiresAt: number;
}
// Pages preload code/assets; large user media remains streamed through owned media/library resources.
export const PLUGIN_PAGE_MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
export const PLUGIN_PAGE_MAX_MESSAGE_BYTES = 48 * 1024;
export function isPluginPageSurface(
  value: unknown,
): value is PluginPageSurface {
  return value === "panel" || value === "mainView" || value === "settings";
}

/** Trusted native settings; no directory, credentials or provider execution routing on the wire. */
export interface PluginTaskPreferences {
  revision: string;
  config: {
    agentKind?: "cc" | "codex" | "pi";
    model?: string;
    providerId?: string;
    effort?: string;
    fastMode?: boolean;
    permissionMode?: string;
  };
  permissionModes: string[];
  defaultPermissionMode: string;
}
