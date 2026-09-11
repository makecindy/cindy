export interface RewriteInput {
  /** 仓库根目录；可选以保持现有 adapter 调用兼容。 */
  cwd?: string;
  /** Full .md content (including frontmatter) of the existing knowledge file. */
  oldContent: string;
  /** Unified-diff text for the change being applied. */
  diff: string;
  /** Plain-text instruction template explaining what to do. */
  instruction: string;
}

export interface RefreshInput {
  /** Full .md content (including frontmatter) of the existing knowledge file. */
  oldContent: string;
  /** Plain-text instruction template explaining what to do. */
  instruction: string;
  /**
   * Hint about what code this knowledge covers — passed verbatim into the prompt.
   * Typically: module id, covers globs, repo-root-relative paths the agent should
   * inspect. The adapter does NOT pre-fetch source; it relies on the underlying
   * agent's tool access (Read / Glob / Grep) to explore.
   */
  contextHint: string;
  /**
   * Repo root absolute path. The adapter spawns the agent with this as cwd so
   * relative globs in contextHint resolve correctly.
   */
  cwd: string;
}

export interface AgentAdapter {
  /** Adapter identifier, e.g. "claude-code". */
  name: string;
  /**
   * Diff-driven update path. Used by `update` for small diffs.
   * Returns the new markdown body (without frontmatter). May throw on failure.
   */
  rewriteKnowledge(input: RewriteInput): Promise<string>;
  /**
   * Source-driven refresh path. Used by `refresh` to rebuild a module from
   * current code state (no diff). Agent is expected to read source via its own
   * tool access. Returns the new markdown body (without frontmatter).
   */
  refreshKnowledge(input: RefreshInput): Promise<string>;
}
