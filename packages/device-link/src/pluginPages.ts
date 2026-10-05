/** Optional, versioned plugin-page projection. No host path or credential is a wire value. */
export const PLUGIN_COLLECTION = "plugins";
export const PLUGIN_PAGE_PRIMITIVE = "plugin-page";
export type PluginPageSurface = "panel" | "mainView" | "settings";
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
