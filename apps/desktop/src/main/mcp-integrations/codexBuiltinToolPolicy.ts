/**
 * Internal vendor-options key carrying the immutable built-in tool policy of
 * one Codex thread across maker-core and the desktop HTTP MCP bridge.
 */
export const CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY = '__cindyDisabledBuiltinPluginIds';

/** Read a valid frozen built-in policy without widening malformed input. */
export function readDisabledBuiltinPluginIds(
  vendorOptions: Readonly<Record<string, unknown>> | undefined,
): string[] | null {
  const raw = vendorOptions?.[CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY];
  if (!Array.isArray(raw) || !raw.every((value) => typeof value === 'string')) {
    return null;
  }
  return [...raw];
}
