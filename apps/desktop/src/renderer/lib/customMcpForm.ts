export type ParsedStdioArgs = { ok: true; args: string[] } | { ok: false };

/** JSON keeps empty arguments and meaningful leading/trailing whitespace losslessly. */
export function parseStdioArgsInput(value: string): ParsedStdioArgs {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((arg) => typeof arg === 'string')
      ? { ok: true, args: parsed }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function selectStdioEnvMutation(options: {
  editing: boolean;
  initialTransport?: string;
  envLoaded: boolean;
  envDirty: boolean;
  env: Record<string, string>;
}): Record<string, string> | undefined {
  const { editing, initialTransport, envLoaded, envDirty, env } = options;
  // An unresolved/failed safeStorage read must preserve the old secret unless the user edits it.
  return !editing || initialTransport !== 'stdio' || envLoaded || envDirty ? env : undefined;
}
