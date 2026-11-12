/**
 * Internal vendor-options key carrying the immutable built-in tool policy of
 * one Codex thread across maker-core and the desktop HTTP MCP bridge.
 */
export const CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY = '__cindyDisabledBuiltinPluginIds';
export const CODEX_ALLOWED_BUILTIN_PLUGIN_IDS_KEY = '__cindyAllowedBuiltinPluginIds';

function readStringArray(
  vendorOptions: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string[] | null {
  const raw = vendorOptions?.[key];
  if (!Array.isArray(raw) || !raw.every((value) => typeof value === 'string')) return null;
  return [...raw];
}

/** Read a valid frozen built-in policy without widening malformed input. */
export function readDisabledBuiltinPluginIds(
  vendorOptions: Readonly<Record<string, unknown>> | undefined,
): string[] | null {
  return readStringArray(vendorOptions, CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY);
}

export function readAllowedBuiltinPluginIds(
  vendorOptions: Readonly<Record<string, unknown>> | undefined,
): string[] | null {
  return readStringArray(vendorOptions, CODEX_ALLOWED_BUILTIN_PLUGIN_IDS_KEY);
}

/** Custom App transports follow the same frozen mounts at configuration and use time. */
export function isFrozenMcpServerAllowed(
  vendorOptions: Readonly<Record<string, unknown>> | undefined,
  serverName: string,
): boolean {
  if (readAllowedBuiltinPluginIds(vendorOptions) === null) return true;
  const mounted = vendorOptions?.cindyRuntimeMcpServerNames;
  return Array.isArray(mounted) && mounted.includes(serverName);
}

/** Frozen per-runtime policy always wins over live/stable provider exceptions. */
export function isFrozenBuiltinPluginAllowed(
  vendorOptions: Readonly<Record<string, unknown>> | undefined,
  pluginId: string,
): boolean {
  const allowed = readAllowedBuiltinPluginIds(vendorOptions);
  if (allowed) return allowed.includes(pluginId);
  return !readDisabledBuiltinPluginIds(vendorOptions)?.includes(pluginId);
}
