/**
 * cross-agent-convert / shared types
 *
 * detector / converter / IPC / renderer 之间共享的契约。改动需同步更新 vite-env.d.ts。
 */

/** 当前 4 项迁移种类（双向对称）。Skill 通过共享链接复用，不做格式转换。 */
export type MigrationItemKind =
  | 'agents-md' // CLAUDE.md ↔ AGENTS.md
  | 'agents' // .claude/agents/ ↔ .codex/agents/
  | 'hooks' // .claude/hooks/ + settings.json ↔ .codex/hooks/ + .codex/hooks.json
  | 'mcp'; // .mcp.json ↔ .codex/config.toml [mcp_servers]

/** 转换方向。值即"目标端"。 */
export type MigrationDirection = 'to-claude' | 'to-codex';

export type MigrationStepStatus = 'pending' | 'running' | 'success' | 'skipped' | 'failed';

export type AgentKind = 'claude-code' | 'codex';

/** 一个迁移项 = 检测器认为"可做"的一个工作单元。 */
export interface MigrationItem {
  /** renderer 用这个稳定标识关联用户看到的设置和转换进度。 */
  id: string;
  kind: MigrationItemKind;
  direction: MigrationDirection;
  /** UI 文案，例如 "AGENTS.md → CLAUDE.md"。 */
  label: string;
  /** 主源路径（目录或单文件，按 kind 含义）。 */
  source: string;
  /** 主目标路径。 */
  target: string;
  /**
   * 子项（可选）。agents/hooks 这种集合类把要做的子单位列出来，
   * converter 按子项分别处理。
   */
  subItems?: { name: string; sourcePath: string; targetPath: string }[];
}

/** 进度事件（main → renderer push channel）。 */
export interface MigrationStepEvent {
  /** 关联到 MigrationItem.id。 */
  itemId: string;
  status: MigrationStepStatus;
  /** 失败原因 / "已存在 (跳过)" 等额外说明。 */
  detail?: string;
}

/** detector 返回值。 */
export interface DetectResult {
  /** 需要迁移的项；空数组 = 无事可做。 */
  items: MigrationItem[];
}
