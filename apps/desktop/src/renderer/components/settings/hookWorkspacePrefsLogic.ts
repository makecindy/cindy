/**
 * hookWorkspacePrefsLogic —— Tina 页每目录偏好编辑器的联动 patch 纯逻辑。
 *
 * 语义对齐 slack-hook-server bot.ts 的 /model 卡校准(两个渠道编辑同一份
 * 数据, 联动规则必须一致, 规则 9 用代码保证确定性):
 *   - 换 agent: 偏好是 (agentKind, model) 配对, 换组即清 model/effort;
 *     agent 置 null(跟随默认)时同样整组清空。
 *     **权限档一律原样保留, 永不清空** —— 清空 = 无显式偏好 = 派发侧的
 *     bypassPermissions 历史默认, 等于「选了更严的档, 切个 agent 就被静默
 *     放宽成完全访问」(2026-07 安全修正; 旧实现在此清空, 注释却声称是为了
 *     防这件事)。兼容性统一交给 resolveEffectivePermissionMode 与 main 侧
 *     defaults.ts 收紧到该 agent 最严档, 显示与派发同口径。
 *   - 换 model: 随手写入 agentKind 配对; 原 effort 不被新模型支持时校准到
 *     该模型默认档(无默认档则清空)。
 *   - 换 effort / permission: 单字段直写(选项列表已按当前 agent/model
 *     过滤, 无需再校准)。
 *
 * 纯函数无 IO(规则 14), 组件只负责把 patch 发给 setWorkspacePrefs。
 */

import type { HookPrefsPatch, HookWorkspacePrefs } from '../../../shared/hookControlIpc';

/**
 * renderer 侧合法 agentKind 的单一来源(编辑器 UI 与本文件的归一化共用;与 main 侧
 * 派发 defaults.ts 的 AGENT_KINDS 同口径 —— 进程边界两侧各持一份,新增 agent 时同步)。
 */
export const AGENT_KINDS = ['claude-code', 'codex'] as const;
export type KnownAgent = (typeof AGENT_KINDS)[number];

export function isKnownAgent(value: string | null): value is KnownAgent {
  return value !== null && (AGENT_KINDS as readonly string[]).includes(value);
}

/** 编辑器需要的能力面(useAgentCapabilities 的最小消费形状)。 */
export interface PrefsAgentCaps {
  models: Array<{ id: string; efforts: readonly string[]; defaultEffort: string | null }>;
  permissionModes: Array<{ id: string }>;
}

/**
 * 换 agent 的联动 patch(next=null 即「跟随默认」)。
 *
 * **权限档一律原样保留, 绝不因「新 agent 不支持」而清空**(2026-07 安全修正):
 * 清空 = 回到「无显式偏好」= 派发侧的 bypassPermissions 历史默认, 于是用户选了
 * acceptEdits 再切一下 agent 就被静默放宽成完全访问 —— 正是原注释声称要防的那件事。
 * 保留原值后, 显示与派发都由同一个 resolveEffectivePermissionMode 校准到新 agent 的
 * **最严**档; 切回原 agent 时用户的原始选择还在, 意图不丢。
 */
export function patchForAgentChange(next: string | null): HookPrefsPatch {
  if (next === null) {
    // 跟随默认: agent/model/effort 整组清空(model/effort 与 agent 强绑定, 换组必失效)
    return { agentKind: null, model: null, effort: null };
  }
  return { agentKind: next, model: null, effort: null };
}

/** 换 model 的联动 patch(agentKind 随手配对写入 + effort 校准)。 */
export function patchForModelChange(
  agentKind: string,
  modelId: string | null,
  current: Pick<HookWorkspacePrefs, 'effort'>,
  caps: PrefsAgentCaps | null,
): HookPrefsPatch {
  if (modelId === null) return { model: null, effort: null };
  const entry = caps?.models.find((m) => m.id === modelId);
  const effortCompatible =
    current.effort === null || (entry?.efforts.includes(current.effort) ?? false);
  return {
    model: modelId,
    agentKind,
    ...(effortCompatible ? {} : { effort: entry?.defaultEffort ?? null }),
  };
}

/** IM 新会话默认设置的最小消费形状(shared/imDefaultSettings 的 ImDefaultSettings)。 */
export interface ImDefaultsLike {
  agentKind: string;
  agents: Partial<Record<string, { model: string; effort: string }>>;
}

/** 单字段的生效视图: 显式值或解析后的默认值。 */
export interface EffectiveField {
  /** 当前生效值 id(null = 无, 如模型不支持调档)。 */
  id: string | null;
  /** true = 未显式设置(跟随默认), UI 以「(默认)」标注。 */
  isDefault: boolean;
  /** 「默认」候选值(下拉首项展示; isDefault 时与 id 相同)。 */
  defaultId: string | null;
}

export interface EffectiveRow {
  agentKind: EffectiveField;
  model: EffectiveField;
  effort: EffectiveField;
  permissionMode: EffectiveField;
}

/** hook 无人值守链路的权限历史默认(与 main 侧 defaults.ts 保持一致)。 */
export const HOOK_DEFAULT_PERMISSION_MODE = 'bypassPermissions';

/**
 * 解析一行偏好**派发时真正会用的权限档** —— 与 main 侧 defaults.ts 第 5 步逐字对齐,
 * 设置页必须显示这个值。
 *
 * 三档取值(顺序即优先级):
 *   1. 显式档且当前 agent 支持 → 用它;
 *   2. 显式档但当前 agent 不支持 → 该 agent 的**最严**档(capabilities 的 permissionModes
 *      一律从严到宽声明, 取 [0]) —— 用户填过显式档就是表达过「不要默认的完全访问」,
 *      不支持时只能更严不能更宽;
 *   3. 从未填显式档 → bypassPermissions(hook 无人值守历史默认)。
 *
 * 不做这一步校准的后果(2026-07 实审发现): PermissionSelector 自己的 normalizeMode 会把
 * 不支持的值显示成列表首项(最严的 ask), 而派发侧当时回落 bypass(最宽) —— 设置页显示
 * 「询问权限」、bot 实际以完全访问跑, 方向完全相反。caps 未就绪(null)时不猜, 原样返回
 * 显式值, 由派发侧兜底。
 */
export function resolveEffectivePermissionMode(
  explicit: string | null,
  caps: PrefsAgentCaps | null,
): string {
  if (explicit === null) return HOOK_DEFAULT_PERMISSION_MODE;
  if (caps === null) return explicit;
  if (caps.permissionModes.some((pm) => pm.id === explicit)) return explicit;
  return caps.permissionModes[0]?.id ?? HOOK_DEFAULT_PERMISSION_MODE;
}

/**
 * 解析一行偏好的「当前生效值」—— 与 main 侧 defaults.ts 的取值链逐字段对齐
 * (显式偏好 > 桌面新会话默认 > 能力清单兜底; 权限无草稿层, 默认 bypass),
 * 让设置页直接显示派活时真正会用的值, 而不是一句「跟随默认」。
 * imDefaults / caps 未就绪时尽量退化显示(defaultId 可为 null)。
 */
export function resolveEffectiveRow(
  prefs: Pick<HookWorkspacePrefs, 'agentKind' | 'model' | 'effort' | 'permissionMode'>,
  imDefaults: ImDefaultsLike | null,
  capsFor: (agentKind: string) => PrefsAgentCaps | null,
): EffectiveRow {
  const defaultAgent = imDefaults?.agentKind ?? 'claude-code';
  // 未知/未来的 agentKind(server 快照可能存过期值)按「无显式偏好」处理,归一到默认
  // agent —— 与派发侧 defaults.ts 的 AGENT_KINDS 合法性校验同口径。不做这一步的后果
  // (2026-07 review): 未知值被裸透传,UI 显示成 Claude 且 caps 恒 null 把整行禁死,
  // 用户永远无法纠正那个过期值。
  const explicitAgent = isKnownAgent(prefs.agentKind) ? prefs.agentKind : null;
  const effAgent = explicitAgent ?? defaultAgent;
  const caps = capsFor(effAgent);
  const draft = imDefaults?.agents[effAgent];

  // model: 草稿默认在清单内用草稿, 否则清单第一个, 再否则裸草稿值
  const draftModel = draft?.model ?? null;
  const defaultModel =
    draftModel !== null && (caps?.models.some((m) => m.id === draftModel) ?? false)
      ? draftModel
      : (caps?.models[0]?.id ?? draftModel);
  const effModel = prefs.model ?? defaultModel;

  // effort: 生效模型支持调档时才有默认(草稿档合法用草稿, 否则模型默认档)
  const entry = effModel !== null ? (caps?.models.find((m) => m.id === effModel) ?? null) : null;
  let defaultEffort: string | null = null;
  if (entry !== null && entry.efforts.length > 0) {
    const draftEffort = draft?.effort ?? null;
    defaultEffort =
      draftEffort !== null && entry.efforts.includes(draftEffort)
        ? draftEffort
        : (entry.defaultEffort ?? entry.efforts[0]);
  }

  // effort: 显式档必须仍被生效模型支持才算数(目录变更/外部编辑可能留下失效值),
  // 否则按派发侧 defaults.ts 的同一条链落 defaultEffort(草稿>模型默认>首档)——
  // 不归一化的后果(2026-07 review): 失效显式档被裸透传,ModelSelector 的 trigger
  // 因 efforts.includes(effort) 不成立而**整个不显示档位**,存的值和实际会用的值
  // 都看不见。模型未知(entry null)时不猜,沿用显式值(派发侧该场景不传 effort)。
  const effortValid =
    prefs.effort === null || entry === null || entry.efforts.includes(prefs.effort);

  return {
    agentKind: { id: effAgent, isDefault: explicitAgent === null, defaultId: defaultAgent },
    model: { id: effModel, isDefault: prefs.model === null, defaultId: defaultModel },
    effort: {
      id: effortValid ? (prefs.effort ?? defaultEffort) : defaultEffort,
      isDefault: prefs.effort === null,
      defaultId: defaultEffort,
    },
    permissionMode: {
      // 校准到派发时真正会用的档(见 resolveEffectivePermissionMode): 显式档不被当前
      // agent 支持时是**最严**档, 不是裸显式值也不是 bypass。
      id: resolveEffectivePermissionMode(prefs.permissionMode, caps),
      isDefault: prefs.permissionMode === null,
      defaultId: HOOK_DEFAULT_PERMISSION_MODE,
    },
  };
}
