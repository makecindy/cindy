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
  /** 上下文窗口大小 (tokens), SDK result.modelUsage 缺值时的 fallback。 */
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
   * 该模型在选择器里**默认是否可见**（源自目录 `defaultEnabled`，host 派生时透传；
   * 缺省 ⇒ 可见）。渲染层取种子默认模型时据它跳过默认收起的 legacy 模型 ——
   * 否则默认模型可能是用户在清单里根本看不到的那个。maker-core 运行时不读它。
   */
  defaultEnabled?: boolean;
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
