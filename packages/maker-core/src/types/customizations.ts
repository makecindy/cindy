import type { PiRuntimeCapabilityStatus } from './pi-runtime-capabilities.js';

/**
 * AgentCustomization —— "agent 自己认识的本地 customization" 的统一描述。
 *
 * 各 agent 通过 BaseAgent.listCustomizations 暴露;调用方 (Maker → main → SkillHub)
 * 拿到这份扁平列表后, 自己分组 / join 商店元数据 / 渲染。
 *
 * 设计要点:
 * - kind / scope 是 string 不是 enum: 不同 engine 用自己的词汇集
 *     - Claude: kind='skill'|'command'|'agent', scope='global'|'project'
 *     - Codex:  kind='skill', scope='user'|'repo'|'system'|'admin'
 *   将来加新 engine 不需要改本接口。
 * - engineExtras 兜底引擎特有字段, 主接口不膨胀。
 *
 * SkillHub 的 manifest / 装机记录 / 商店元数据完全不在本接口里 ——
 * 那是 main 的商店层职责, maker 不知道也不该知道。
 */

export interface AgentCustomizationFile {
  /** 一级 sibling 名 (无递归)。 */
  name: string;
  /** 'file' | 'dir' —— UI 选图标用。 */
  kind: 'file' | 'dir';
}

export interface AgentCustomization {
  /** 来自哪个 agent。等价于 AgentKind, 但避开循环依赖故用宽松 string。 */
  engine: 'claude-code' | 'codex' | 'pi';

  /**
   * Engine-specific 词汇:
   *   Claude: 'skill' | 'command' | 'agent'
   *   Codex:  'skill'
   * UI 自己决定怎么展示 (badge / 分组)。
   */
  kind: string;

  /**
   * Engine-specific 词汇:
   *   Claude: 'global' | 'project'
   *   Codex:  'user' | 'repo' | 'system' | 'admin'
   */
  scope: string;

  /** 入参列表无前导 `/`。 */
  name: string;

  /** 摘要描述 (frontmatter description / codex shortDescription, 截断 ~500 字)。 */
  description?: string;

  /**
   * 实体的绝对路径:
   *   - skill (folder-shaped): 文件夹路径
   *   - command/agent (.md):   .md 文件路径
   *   - codex skill:           codex SkillsList 给的 path (一般是 skill 目录)
   */
  absolutePath: string;

  /** 详情页要渲染的 markdown 文件路径 (folder-shaped 时是 SKILL.md, 否则同 absolutePath)。 */
  mdPath?: string;

  /** Project-scoped 才有: 触发本次扫描的 workingDir (POSIX, 无尾斜杠)。 */
  workingDir?: string;

  /** Codex 'enabled' 字段; Claude 视为始终 true (不填即 true)。 */
  enabled?: boolean;

  /** Pi scanner/runtime state. Omitted by engines without a runtime truth layer. */
  runtimeStatus?: PiRuntimeCapabilityStatus;

  /** Folder-shaped customization 的一级文件清单; 文件型空数组或不填。 */
  files?: AgentCustomizationFile[];

  /** Claude: SKILL.md / .md 的完整 frontmatter (UI 详情页 FRONTMATTER 面板用)。 */
  frontmatter?: Record<string, unknown>;

  /** Frontmatter 解析失败时填; UI 显示提示但不崩。 */
  parseError?: string;

  /**
   * 引擎特有字段, 主接口不消费, UI 选择性展示。
   * Codex: { brandColor?, iconSmall?, iconLarge?, defaultPrompt?, dependencies? }
   */
  engineExtras?: Record<string, unknown>;
}

export interface ListCustomizationsOptions {
  /**
   * 触发扫描的项目目录列表; 空数组 / 不填 = 仅扫 global (~/.claude 等)。
   * Codex 把整个数组作为 `cwds` 传给 app-server (一次 RPC 多项目)。
   * Claude 在每个 workingDir 下扫一次 .claude/。
   */
  workingDirs?: string[];

  /** Codex 透传 `forceReload`; Claude 不消费 (每次都重扫)。 */
  forceReload?: boolean;

  /**
   * 可选过滤; 调用方只关心某几种 kind 时减少传输。
   * 不填 = 全部返回。
   */
  kinds?: string[];
}

export interface ListCustomizationsResult {
  items: AgentCustomization[];
  /** 单个 source / cwd 失败不抛, 收集到这里; UI 可显示降级提示。 */
  errors: Array<{ path?: string; message: string }>;
}
