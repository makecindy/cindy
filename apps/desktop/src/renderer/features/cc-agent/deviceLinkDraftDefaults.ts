/**
 * deviceLinkDraftDefaults —— device-link 远程项目草稿的「选中模型默认值」解析(纯函数)。
 *
 * 背景:控制端为被控设备新建项目草稿时,要**全量镜像被控端当前 New Maker 草稿**
 * (model/effort/fast/permission/source),绝不取控制端本地草稿。被控端草稿值经隧道
 * `maker:get-new-maker-defaults` 拉到(可能为 null:旧版被控端无此 channel / 拉取失败),
 * 本函数把它**按被控端 capabilities 校准**后给出可直接 seed 的一组值;remoteDraft 为 null
 * 时回落纯 capabilities 默认(用户决策:旧版被控端回落被控端默认,绝不回落控制端本地)。
 *
 * 抽成纯函数(不依赖 React / IPC)是为了可在 node 直接单测 seed/clamp/fallback 三条路径
 * (规则 9:用代码而非 prompt 固化确定性;规则 14:main 外的高风险派生逻辑也补测)。
 *
 * 注:providerId(来源)这里**原样透传**——它的合法性(是否被控端已连来源 / 是否 offer 该
 * 模型)由 ChatInput 的 effectiveSourceId 统一校准(不在连接栏内即回落 nativeDefault),
 * 与「会话内切来源」同一口径,不在本函数重复一套。
 */

import type { AgentCapabilities, AgentKind } from '@/hooks/useAgentCapabilities';
import type { Effort, PermissionMode } from '@/lib/userPreferences.types';

/** 被控端当前草稿的原始值(maker:get-new-maker-defaults 隧道返回;字段全可选)。 */
export interface RemoteDraftDefaults {
  model?: string;
  effort?: string;
  fastMode?: boolean;
  permissionMode?: string;
  providerId?: string | null;
  /**
   * 被控端「每个模型各自记忆」的 effort / fast。控制端在远程草稿里切到**非当前选中**模型时,
   * 按目标 model id 查这两张表还原被控端记的值;旧版被控端不回 → undefined → 回落该模型 capabilities 默认。
   */
  effortByModel?: Record<string, string>;
  fastModeByModel?: Record<string, boolean>;
  /**
   * 被控端 providerModelMemory 全量快照;`${agent}:*` 是模型级全局预设,
   * `${agent}:${providerId}` 是旧 v2 兼容副本。device-link 草稿列表行据此镜像被控端预设;
   * 旧版被控端不回 → undefined → 控制端非选中行回落 capabilities 默认。
   */
  providerModelMemory?: Record<
    string,
    { effortByModel: Record<string, string>; fastByModel: Record<string, boolean> }
  >;
}

/** 校准后可直接 seed 控制端草稿 holder 的一组值。 */
export interface DeviceLinkDraftSelection {
  model: string;
  effort: Effort;
  fastMode: boolean;
  /** 仍是被控端支持的权限档则带上;否则 undefined(由 ChatInput 回落自身默认)。 */
  permissionMode?: PermissionMode;
  /** 来源透传,合法性交 ChatInput 校准;null = 跟随被控端默认路由。 */
  providerId: string | null;
}

/**
 * 把被控端草稿值(或 null=回落)按被控端 capabilities 校准成可 seed 的选择。
 *   - model:要解析的模型 = targetModel(用户在草稿里切模型)优先,否则 remoteDraft.model(初始 seed);
 *     该 id 在被控端清单内则用它,否则被控端 availableModels[0]。
 *   - 传 agentKind(New Maker 正式路径)时,effort/fast 优先读 `${agent}:*` 全局模型预设——首页
 *     没有运行中会话,当前显示模型也不受保护。兼容调用未传 agentKind 时保留旧顺序:
 *       · 当前模型 → 草稿激活值 remoteDraft.effort / remoteDraft.fastMode;
 *       · 其它模型 → per-model 记忆 effortByModel[id] / fastModeByModel[id]。
 *     最终 effort 仍按目标模型 efforts 校验(不支持则落 defaultEffort);fast 仍按 agent×模型 能力门控。
 *   - permissionMode:被控端支持该档才带,否则 undefined(非按模型记)。
 *   - providerId:原样透传(下游 clamp;非按模型记)。
 * capabilities.availableModels 为空(理论不该发生)→ 退化返回安全兜底。
 */
export function resolveDeviceLinkDraftDefaults(
  capabilities: AgentCapabilities,
  remoteDraft: RemoteDraftDefaults | null,
  targetModel?: string,
  agentKind?: AgentKind,
): DeviceLinkDraftSelection {
  const models = capabilities.availableModels;
  const providerId = remoteDraft?.providerId ?? null;
  const permissionMode = pickPermissionMode(capabilities, remoteDraft?.permissionMode);

  // 要解析哪个模型:显式 targetModel(切模型)优先;否则被控端当前选中模型(初始 seed)。
  const wantedModelId = targetModel ?? remoteDraft?.model;

  if (models.length === 0) {
    return {
      model: wantedModelId ?? '',
      effort: (remoteDraft?.effort as Effort) ?? 'high',
      fastMode: false,
      permissionMode,
      providerId,
    };
  }

  const chosen = models.find((m) => m.id === wantedModelId) ?? models[0];
  const globalPreset = agentKind ? remoteDraft?.providerModelMemory?.[`${agentKind}:*`] : undefined;
  // 解析的是不是被控端当前选中模型:是 → 草稿激活值;否 → per-model 记忆(切模型还原)。
  const isActiveModel = chosen.id === remoteDraft?.model;
  // 新建草稿没有 live 会话需要保护:全局模型预设存在时,即使是首页当前显示模型也优先采用。
  // agentKind 缺失时保留旧调用方语义,方便旧测试 / 兼容入口逐步迁移。
  const wantedEffort = (globalPreset?.effortByModel[chosen.id] ??
    (isActiveModel ? remoteDraft?.effort : remoteDraft?.effortByModel?.[chosen.id])) as
    Effort | undefined;
  const presetFast = globalPreset?.fastByModel[chosen.id];
  const wantedFast =
    presetFast ??
    (isActiveModel
      ? remoteDraft?.fastMode === true
      : remoteDraft?.fastModeByModel?.[chosen.id] === true);

  const effort: Effort =
    wantedEffort && chosen.efforts.includes(wantedEffort)
      ? wantedEffort
      : (chosen.defaultEffort ?? chosen.efforts[0] ?? wantedEffort ?? 'high');
  const fastMode = Boolean(capabilities.hasFastMode && chosen.supportsFastMode && wantedFast);

  return { model: chosen.id, effort, fastMode, permissionMode, providerId };
}

/** 被控端草稿权限档仍在被控端支持列表里则带上,否则 undefined(ChatInput 回落自身默认)。 */
function pickPermissionMode(
  capabilities: AgentCapabilities,
  raw: string | undefined,
): PermissionMode | undefined {
  if (!raw) return undefined;
  return capabilities.permissionModes.some((p) => p.id === raw)
    ? (raw as PermissionMode)
    : undefined;
}
