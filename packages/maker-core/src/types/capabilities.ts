/**
 * Capabilities 声明 —— UI 据此降级渲染（灰按钮/隐藏入口）。
 *
 * 关键设计：CapabilityStatus 区分 "SDK 真不支持" 和 "我们暂未实现"，
 * 让 UI 能给用户更准确的提示，也方便跟踪上游补全进度。
 */

import type { Effort, PermissionMode, ReasoningDisplay } from './common.js';

export type CapabilityStatus =
  | { supported: true }
  | {
      supported: false;
      reason: 'sdk-missing' | 'not-implemented' | 'platform-limited';
      /** 上游引用，便于跟踪修复（如 '@openai/codex-sdk Thread.setModel'） */
      upstreamRef?: string;
      /** UI tooltip 文案 */
      message?: string;
    };

export interface MultimodalCapability {
  text: CapabilityStatus;
  image: CapabilityStatus;
  file: CapabilityStatus;
}

export interface Capabilities {
  /** 运行时切换底层模型 */
  switchModel: CapabilityStatus;
  availableModels: ModelDescriptor[];

  /**
   * Agent 是否实现 Fast Mode 运行时能力。
   * UI 需同时检查 hasFastMode 与当前模型 supportsFastMode，才显示 Fast toggle。
   */
  hasFastMode: boolean;

  /** Reasoning 强度切换 */
  effort: CapabilityStatus;
  effortLevels: EffortDescriptor[];

  /** Reasoning 显示模式 */
  reasoningDisplay: ReasoningDisplay[];

  /** 权限模式 */
  permissionModes: PermissionModeDescriptor[];
  setPermissionModeMidSession: CapabilityStatus;
  /**
   * Per-turn host policy that can force selected tool calls through the
   * interaction resolver before execution. Optional for older/custom agents.
   *
   * `unsupportedPermissionModes` is load-bearing: a host must reject those
   * combinations instead of silently weakening either the selected permission
   * mode or the per-turn safety policy.
   */
  turnPermissionPolicy?: {
    supported: CapabilityStatus;
    unsupportedPermissionModes: PermissionMode[];
  };

  /**
   * 计划模式（Plan Mode）—— 与 permissionMode 正交的独立会话状态：
   * 开启后 agent 先产出计划、经用户审批（plan_review 交互）后再进入执行。
   *  - Claude: 复用 SDK permissionMode='plan' 机制，底层权限档保留为用户所选，
   *            计划批准后 agent 自动退出计划模式并切回底层权限档。
   *  - Codex:  走 app-server experimental collaborationMode ({ mode:'plan' })，
   *            plan item 产出后由 agent 发起 plan_review，批准后自动发起实施 turn。
   * optional：device-link 老版本 host 序列化的 capabilities 没有此字段，
   * 消费方用 `capabilities?.planMode?.supported === true` 判定（缺省视为不支持）。
   */
  planMode?: CapabilityStatus;

  /** 输入类型 */
  multimodal: MultimodalCapability;

  /** Session 操作 */
  fork: CapabilityStatus;
  rewind: CapabilityStatus;
  /** 同一 SDK session 内的原生分支树；与创建独立 Cindy 会话的 fork 正交。 */
  sessionTree?: CapabilityStatus;

  /** 中断当前 turn */
  abort: CapabilityStatus;

  /**
   * 同 turn 插话：agent 正在执行时，把用户补充输入追加到当前 in-flight turn，
   * 而不是排到下一轮。UI 不能只看 abort/streaming 推断此能力，因为未来 agent
   * 可能支持取消但不支持 same-turn steering。
   */
  sameTurnSteer: CapabilityStatus;

  /**
   * 自动记忆通道 (Claude auto-memory / Codex experimental memories)。
   * 不含用户手写的 CLAUDE.md / AGENTS.md (那些走 settingSources / project_doc_max_bytes)。
   */
  memory: MemoryCapability;

  /**
   * Session 附加只读引用目录 (extra dirs)。
   *  - Claude: SDK 原生 `additionalDirectories` 字段, supported=true, 改完下一 turn 即时生效
   *  - Codex:  app-server runtimeWorkspaceRoots + named permission profile；
   *            每 turn 覆盖 roots，额外目录保持只读。
   * UI 据此决定是否在 ChatInput 显示 ExtraDirsButton。
   */
  extraDirs: CapabilityStatus;
  /**
   * 会话导出为 HTML —— pi 原生 export_html RPC(自带 export-html 渲染器,离线、无网关)。
   * 支持时 handle 实现 exportSessionHtml;UI 据此决定是否显示「导出 HTML」入口。
   * CC/Codex 无对应能力(缺省视为不支持)。
   */
  sessionHtmlExport?: CapabilityStatus;
  /**
   * 手动压缩会话上下文 —— pi 原生 compact RPC(可带聚焦指令,调 LLM 生成摘要)。
   * 支持时 handle 实现 compactSession;UI 据此决定是否显示「压缩会话」入口。
   * CC/Codex 的 /compact 走各自 agent 内置斜杠命令,不经此能力(缺省视为不支持)。
   */
  manualCompact?: CapabilityStatus;
}

/** 手动压缩结果(数值可缺省:自定义压缩 handler 可能不上报)。 */
export interface ManualCompactResult {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  /**
   * 良性空操作:上下文太小 / 无可压缩内容,agent 拒绝压缩但这不是错误。
   * UI 应给信息性提示(「暂无可压缩内容」),而非「压缩失败」。
   */
  noop?: boolean;
}

export type SessionTreeEntryKind =
  | 'message'
  | 'compaction'
  | 'branch_summary'
  | 'model_change'
  | 'thinking_level_change'
  | 'label'
  | 'custom'
  | 'other';

export interface SessionTreeNode {
  id: string;
  parentId: string | null;
  kind: SessionTreeEntryKind;
  role?: 'user' | 'assistant' | 'tool' | 'summary' | 'system';
  preview: string;
  timestamp?: string;
  label?: string;
  labelTimestamp?: string;
  children: SessionTreeNode[];
}

/** 当前 SDK 会话的完整树；activePathIds 从根到当前活动 leaf。 */
export interface SessionTreeSnapshot {
  roots: SessionTreeNode[];
  leafId: string | null;
  activePathIds: string[];
}

/** 分支切换后供 host 重建可见聊天时间线的安全、harness-neutral 消息。 */
export interface SessionTreeHistoryMessage {
  clientId: string;
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'thinking';
  content: unknown;
  toolUseId?: string;
  createdAt: number;
  agentMeta?: Record<string, unknown> | null;
}

export interface NavigateSessionTreeOptions {
  summarize?: boolean;
  customInstructions?: string;
  label?: string;
}

export interface NavigateSessionTreeResult {
  tree: SessionTreeSnapshot;
  messages: SessionTreeHistoryMessage[];
  /** 当前活动分支最后一次模型调用占用的上下文(input + cache read/write)。 */
  contextTokens: number;
  /** 当前活动分支模型的上下文窗口。 */
  contextWindow: number;
  /** 选中 user entry 时 Pi 回到其 parent，并把原 prompt 放回编辑器。 */
  draftText?: string;
  cancelled?: boolean;
}

/**
 * Memory 能力描述。UI 据此渲染 toggle / badge / reset 按钮。
 *
 * 不与 types/memory.ts 的 MemoryStatus 重叠 — 后者是"运行时当前值",
 * 这里是"agent 静态描述符"。
 */
export interface MemoryCapability {
  /** 整体支持声明; supported:false 时下面字段无意义, UI 不渲染 memory 入口 */
  supported: CapabilityStatus;
  /** UI 标签, e.g. 'Auto Memory' / '记忆 (实验性)' */
  displayName?: string;
  /** UI tooltip / 描述 */
  description?: string;
  /** stable / experimental — UI 显 badge */
  stage?: 'stable' | 'experimental';
  /** Agent 自带默认值 (Claude=true, Codex=false) — 仅元数据 */
  defaultEnabled?: boolean;
  /** 是否暴露 reset 操作 (有的 agent 没法清, 比如纯服务端记忆) */
  resettable?: boolean;
  /**
   * setMemory 是否能立即影响 live session/thread:
   *  - supported:true  : Codex 走 experimentalFeature/enablement/set 自动热重载所有 live thread
   *  - supported:false : CC 走 SDK Settings, applyFlagSettings 是 per-Query, 当前 Query 不会自动更新
   *                      (新会话能立即用新值, 但已开的 Query 要等 close 重起)
   */
  setEnabledMidSession?: CapabilityStatus;
}

export interface ModelDescriptor {
  id: string;
  displayName: string;
  description?: string;
  /**
   * 上下文窗口大小 (tokens), SDK result.modelUsage 缺值时的 fallback。
   *
   * **只用于展示与兜底,不要拿它去收敛运行期上报的窗口**: 这张清单是跨 provider 去重后的
   * 扁平表, 同一 model id 由多个 provider 提供时归属已丢, 而且这里的值可能是派生时补的
   * 兜底常量(上游不给元数据时)。收敛需要「该路由已核实的上限」,走
   * AgentDeps.resolveVerifiedContextWindow。
   */
  contextWindow: number;
  /** 该模型支持的 effort 列表; 空数组表示不支持 effort 切换 (如 Haiku)。 */
  efforts: readonly Effort[];
  /**
   * Model-specific effort display labels. Falls back to agent-level effortLevels
   * when absent.
   */
  effortDisplayNames?: Partial<Record<Effort, string>>;
  /** 该模型默认 effort; null = 不支持 effort。 */
  defaultEffort: Effort | null;
  /**
   * 该模型是否支持 Fast Mode (Claude 1M context 通道 / Codex priority service tier)。
   * UI 据此显示 / 隐藏 Fast Mode 开关, 不再自己 startsWith 解析 model id。
   */
  supportsFastMode?: boolean;
  /**
   * 厂商分组 id（纯展示元数据，源自目录 providers.json，host 派生时透传）。
   * 渲染层据此对模型分组；缺省时回退 id 前缀归类。maker-core 运行时不读它。
   */
  group?: string;
  /**
   * 展示排序权重（纯展示元数据，源自目录）。渲染层据此排序;缺省排末尾。maker-core 运行时不读它。
   */
  sortOrder?: number;
  /**
  * Gateway 原生 mode（issue #882，纯展示/判定元数据，源自目录 CatalogModel.mode）。
   * availableModels 派生时已经过 isChatEligible 过滤，这里透传只是为了让下游（如
   * resolveSourceSwitch 之类按 model 二次判定分组的逻辑）拿到 mode 而不必回读目录——
   * 2026-07 review：ModelDescriptor 曾经丢弃 mode，下游对象只能靠 id/group 猜，
   * 与本条目"已经聊天可用"的事实脱节。maker-core 运行时不读它。
   */
  mode?: string;
  /**
   * 该模型在选择器里**默认是否可见**（源自目录 `defaultEnabled`，host 派生时透传；
   * 缺省 ⇒ 可见）。渲染层取种子默认模型时据它跳过默认收起的 legacy 模型 ——
   * 否则默认模型可能是用户在清单里根本看不到的那个。maker-core 运行时不读它。
  */
  defaultEnabled?: boolean;
  /**
   * 模型计费($/1M tokens,源自目录/网关刷新,host 派生时透传)。pi 用它生成
   * models.json 的 cost 让 pi 自行计价;缺省按 0 计(用量页不显示钱数)。
   */
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  /** 最大输出 tokens(源自目录 maxOutput)。缺省时各 agent 用自身默认值。 */
  maxOutputTokens?: number;
}

/**
 * Effort / PermissionMode 描述符 —— 把列表 + 展示文案统一放在 maker 侧,
 * UI 不维护平行字典, 只维护 value → icon 这种纯前端映射。
 */
export interface EffortDescriptor {
  id: Effort;
  displayName: string;
  description?: string;
}

export interface PermissionModeDescriptor {
  id: PermissionMode;
  displayName: string;
  description?: string;
}

/**
 * Helper: 抛 NotSupportedError 时使用的 reason。
 */
export class NotSupportedError extends Error {
  constructor(
    public readonly capability: string,
    public readonly status: Extract<CapabilityStatus, { supported: false }>,
  ) {
    super(
      `Capability '${capability}' not supported (reason: ${status.reason}${
        status.upstreamRef ? `, upstream: ${status.upstreamRef}` : ''
      })`,
    );
    this.name = 'NotSupportedError';
  }
}
