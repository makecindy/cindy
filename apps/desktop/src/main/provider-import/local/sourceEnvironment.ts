/** Only a source directory is retained; keys/tokens are never copied or restored. */
let launchClaudeConfigDir: string | undefined;

/** Used at Desktop boot before any provider import handlers are loaded. */
export function stripAnthropicEnvPreservingImportDirectory(
  strip: (env: NodeJS.ProcessEnv) => string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  launchClaudeConfigDir = env.CLAUDE_CONFIG_DIR;
  return strip(env);
}

export function localImportClaudeConfigDirectory(): string | undefined {
  return launchClaudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR;
}
