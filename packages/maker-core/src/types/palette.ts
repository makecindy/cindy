export type SlashCommandSource = 'user' | 'skill';

/**
 * @internal 仅供 maker-core 内部 scanner 用的中间形状。
 * 对外消费一律走 AgentSkillCommand (palette refactor 后的统一形状, 多了 kind 判别符)。
 * 保留是因为 palette-scanner 在 scan→merge 阶段不需要也不该背 kind 字段。
 */
export interface AgentSlashCommand {
  /** Command / skill name without a leading slash. */
  name: string;
  description?: string;
  source: SlashCommandSource;
  /** Absolute path when the backing agent exposes one (e.g. Codex SKILL.md). */
  path?: string;
  scope?: 'global' | 'project' | 'user' | 'repo' | 'system' | 'admin';
  enabled?: boolean;
}

// ── New unified command model (palette refactor) ──────────────────────────
//
// Three sources contribute to the chat-input `/` palette:
//   - 'desktop'       : registered in DesktopCommandRegistry (main process).
//                       Executed locally in main; never forwarded to agent.
//                       Old BUILTIN_SLASH_COMMANDS (/help, /clear) live here.
//   - 'agent-builtin' : hard-coded per-agent whitelist in maker-core
//                       (e.g. Claude Code's /compact). Executed by being sent
//                       to the agent as a `/name args` prompt prefix.
//   - 'agent-skill'   : .md files discovered by scanning ~/.claude or codex
//                       app-server. Same dispatch as agent-builtin (prompt
//                       prefix) but rendered/grouped differently in palette.
//
// All three flow through the renderer as `UnifiedCommand`. Dispatch picks
// the route from `kind`. The old `local: boolean` field on the renderer-side
// `SlashCommand` interface is replaced by this discriminator.

export type CommandKind = 'desktop' | 'agent-builtin' | 'agent-skill';

/** A desktop-side command. Execution is performed in the main process. */
export interface DesktopCommandMeta {
  kind: 'desktop';
  name: string;
  description: string;
}

/** A command baked into the agent (e.g. /compact for Claude Code). */
export interface AgentBuiltinCommand {
  kind: 'agent-builtin';
  name: string;
  description: string;
}

/** A user/project skill discovered by scanning the agent's customisation dirs. */
export interface AgentSkillCommand {
  kind: 'agent-skill';
  name: string;
  description?: string;
  /** Whether the skill came from a user-global or project-local directory. */
  source: SlashCommandSource;
  path?: string;
  scope?: 'global' | 'project' | 'user' | 'repo' | 'system' | 'admin';
  enabled?: boolean;
}

export type UnifiedCommand = DesktopCommandMeta | AgentBuiltinCommand | AgentSkillCommand;

export interface ListAgentSkillsOptions {
  /** Omit to list only agent-global skills without a project scope. */
  workingDir?: string;
  forceReload?: boolean;
}

export interface ListAgentSkillsResult {
  skills: AgentSkillCommand[];
  errors?: Array<{ path?: string; message: string }>;
}

export type AtResourceType = 'file' | 'dir' | 'agent';

export interface AtResourceItem {
  type: AtResourceType;
  name: string;
  relPath: string;
  description?: string;
}

export interface ScanAtResourcesOptions {
  workingDir: string;
  cap?: number;
  query?: string;
}

export interface ScanAtResourcesResult {
  items: AtResourceItem[];
  truncated: boolean;
}
