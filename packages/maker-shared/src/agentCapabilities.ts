export interface MobileModelOption {
  id: string;
  label: string;
  description?: string;
  efforts: string[];
  effortDisplayNames: Record<string, string>;
  defaultEffort: string | null;
  supportsFastMode: boolean;
  /** 区域门控后的新任务默认标记；Pi 复用 claude-code 标记。 */
  newSessionDefault?: ('claude-code' | 'codex')[];
}

export interface MobileChoiceOption {
  id: string;
  label: string;
  description?: string;
}

export interface MobileAgentCapabilities {
  availableModels: MobileModelOption[];
  effortLevels: MobileChoiceOption[];
  permissionModes: MobileChoiceOption[];
  hasFastMode: boolean;
  /** 计划模式一级开关能力(maker-core Capabilities.planMode.supported,#494 起替代 permissionMode='plan')。 */
  planModeSupported: boolean;
  /** desktop host 是否支持同一会话 Claude Code / Codex pending-intent 切换；旧 host 缺省 false。 */
  supportsSessionAgentSwitch?: boolean;
}

export interface MobileSessionRuntimeOptions {
  modelOptions: MobileModelOption[];
  currentModel: MobileModelOption | null;
  effortOptions: MobileChoiceOption[];
  permissionOptions: MobileChoiceOption[];
  fastModeSupported: boolean;
  /** 新协议:capabilities.planMode.supported 为真 → 走 maker:set-plan-mode;
   *  老被控端(permissionModes 仍含 'plan')走 permissionMode 兼容路径,由页面判断。 */
  planModeSupported: boolean;
  capabilitiesLoaded: boolean;
}

export interface MobileRuntimeDraft {
  model: string;
  effort: string;
  permissionMode: string;
  fastMode: boolean;
}

/**
 * 手机端的粗分类取值。**没有 `china`**:「中国」只由目录的 `group:'china'` 产生,而手机端
 * 这条链上只有 model id(descriptor 不透传 group,见桌面 providerModels.toDescriptor),
 * 拿不到该信号,所以国产模型在这里归入 `ungrouped`。这只影响跨厂商切换提示里显示的分类名,
 * 不影响可选性与分组展示(手机端不按厂商分组)。
 */
export type MobileModelCategory = 'anthropic' | 'gpt' | 'gpt-budget' | 'google' | 'ungrouped';

export const MOBILE_MODEL_CATEGORY_LABEL: Record<MobileModelCategory, string> = {
  anthropic: 'Anthropic',
  gpt: 'GPT',
  'gpt-budget': 'GPT 折扣',
  google: 'Google',
  ungrouped: '未分组',
};

export interface MobileModelSwitchConfirmation {
  fromCategory: MobileModelCategory;
  toCategory: MobileModelCategory;
  fromLabel: string;
  toLabel: string;
  targetModelId: string;
  title: string;
  description: string;
}

/**
 * effort 档展示名词表(手机端简体中文,与桌面 i18n `effortLevels.*` 的 zh-CN 值对齐:
 * 低 / 中 / 高 / 超高 / 最高 / 极致)。手机无 i18n 体系,在 normalize 单点把 capabilities 的
 * 英文 displayName 换成中文,下游(列表行 / 模型选项 / trigger 药丸 / 会话设置)全部继承;
 * 未知档 id 不在词表内 → 保留被控端给的 displayName 原文。
 */
export const MOBILE_EFFORT_LABELS: Record<string, string> = {
  minimal: '最小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高',
  ultra: '极致',
};

const FALLBACK_EFFORT_OPTIONS: MobileChoiceOption[] = [
  { id: 'low', label: MOBILE_EFFORT_LABELS.low },
  { id: 'medium', label: MOBILE_EFFORT_LABELS.medium },
  { id: 'high', label: MOBILE_EFFORT_LABELS.high },
];

const FALLBACK_PERMISSION_OPTIONS: MobileChoiceOption[] = [
  { id: 'default', label: 'default' },
  { id: 'ask', label: 'ask' },
  { id: 'acceptEdits', label: 'acceptEdits' },
  { id: 'plan', label: 'plan' },
  { id: 'bypassPermissions', label: 'bypassPermissions' },
];

export function normalizeMobileAgentCapabilities(value: unknown): MobileAgentCapabilities | null {
  if (!isRecord(value)) return null;
  const availableModels = Array.isArray(value.availableModels)
    ? value.availableModels.map(normalizeModelOption).filter((item): item is MobileModelOption => !!item)
    : [];
  const effortLevels = Array.isArray(value.effortLevels)
    ? value.effortLevels.map(normalizeChoiceOption).filter((item): item is MobileChoiceOption => !!item)
      // 已知档 id 换中文词表名(被控端 displayName 是英文;新旧被控端在此统一)。
      .map((item) => ({ ...item, label: MOBILE_EFFORT_LABELS[item.id] ?? item.label }))
    : [];
  const permissionModes = Array.isArray(value.permissionModes)
    ? value.permissionModes.map(normalizeChoiceOption).filter((item): item is MobileChoiceOption => !!item)
    : [];

  return {
    availableModels,
    effortLevels,
    permissionModes,
    hasFastMode: value.hasFastMode === true,
    planModeSupported: isRecord(value.planMode) && value.planMode.supported === true,
    supportsSessionAgentSwitch: value.supportsSessionAgentSwitch === true,
  };
}

export function buildSessionRuntimeOptions(
  session: { model: string },
  capabilities: MobileAgentCapabilities | null,
): MobileSessionRuntimeOptions {
  const currentModel = capabilities?.availableModels.find((item) => item.id === session.model) ?? null;
  const modelEfforts = currentModel?.efforts ?? null;
  const effortMeta = new Map((capabilities?.effortLevels ?? []).map((item) => [item.id, item]));
  const effortOptions = modelEfforts
    ? modelEfforts.map((id) => ({
      id,
      label: currentModel?.effortDisplayNames[id] ?? effortMeta.get(id)?.label ?? MOBILE_EFFORT_LABELS[id] ?? id,
      description: effortMeta.get(id)?.description,
    }))
    : capabilities?.effortLevels.length
      ? capabilities.effortLevels
      : FALLBACK_EFFORT_OPTIONS;

  return {
    modelOptions: capabilities?.availableModels ?? [],
    currentModel,
    effortOptions,
    permissionOptions: capabilities?.permissionModes.length
      ? capabilities.permissionModes
      : FALLBACK_PERMISSION_OPTIONS,
    fastModeSupported: capabilities
      ? capabilities.hasFastMode && currentModel?.supportsFastMode === true
      : true,
    planModeSupported: capabilities?.planModeSupported === true,
    capabilitiesLoaded: !!capabilities,
  };
}

export function reconcileRuntimeDraftWithCapabilities<T extends MobileRuntimeDraft>(
  draft: T,
  capabilities: MobileAgentCapabilities | null,
): T {
  if (!capabilities) return draft;
  const currentModel = capabilities.availableModels.find((item) => item.id === draft.model)
    ?? (draft.model ? null : capabilities.availableModels[0])
    ?? null;
  // 新模型可能已由 provider catalog 选中，但 capabilities 仍在同代刷新。
  // descriptor 缺失期间保留整份显式草稿，不能套用第一项模型的 effort/fast 元数据。
  if (!currentModel && draft.model) return draft;
  const model = currentModel?.id ?? draft.model;
  const runtime = buildSessionRuntimeOptions({ model }, capabilities);
  const effortIds = new Set(runtime.effortOptions.map((item) => item.id));
  const permissionIds = new Set(runtime.permissionOptions.map((item) => item.id));
  const nextEffort = effortIds.size === 0
    ? ''
    : effortIds.has(draft.effort)
      ? draft.effort
      : currentModel?.defaultEffort && effortIds.has(currentModel.defaultEffort)
        ? currentModel.defaultEffort
        : runtime.effortOptions[0]?.id ?? '';
  const nextPermissionMode = permissionIds.size > 0 && !permissionIds.has(draft.permissionMode)
    ? runtime.permissionOptions[0]?.id ?? draft.permissionMode
    : draft.permissionMode;
  const nextFastMode = draft.fastMode && runtime.fastModeSupported;

  if (
    draft.model === model
    && draft.effort === nextEffort
    && draft.permissionMode === nextPermissionMode
    && draft.fastMode === nextFastMode
  ) {
    return draft;
  }

  return {
    ...draft,
    model,
    effort: nextEffort,
    permissionMode: nextPermissionMode,
    fastMode: nextFastMode,
  };
}

/**
 * 手机端跨厂商切换提示用的粗分类(只服务 buildMobileModelSwitchConfirmation,不做展示分组)。
 * 与桌面 `@cindy/model-providers` 的 `categorize` 同一取向:认不出厂商就落 `ungrouped`,不猜。
 * 提示语会把分类名直接读给用户看(「X 和 Y 的消息格式可能不兼容」),猜错就是错的断言。
 *
 * 本包按设计零依赖(见 docs/dev-rules/architecture-invariants.md 的依赖方向),不能反向引用
 * model-providers,故保持独立副本;改一侧记得同步另一侧。
 */
export function categorizeMobileModel(id: string): MobileModelCategory {
  const lower = id.toLowerCase();
  // 命名空间形态(anthropic/claude-opus-5、openai/gpt-5.5)与裸 id 都要认:目录下发的 id
  // 本来就带命名空间,只认裸 id 会让整批模型掉进兜底分类。
  const tail = lower.slice(lower.lastIndexOf('/') + 1);
  if (lower.startsWith('claude-') || tail.startsWith('claude-')) return 'anthropic';
  // 折扣路由必须判在 gpt 之前:`codex/gpt-5.5` 的尾段就是 `gpt-5.5`,顺序反了会被认成
  // 'gpt',于是切换确认框把「GPT 折扣」模型读成「GPT」。桌面 categorize 同一处理。
  if (lower.startsWith('codex/')) return 'gpt-budget';
  if (lower.startsWith('gpt-') || tail.startsWith('gpt-')) return 'gpt';
  if (lower.startsWith('gemini-') || tail.startsWith('gemini-')) return 'google';
  return 'ungrouped';
}

export function isMobileHistoryCompatibleModelSwitch(
  from: MobileModelCategory,
  to: MobileModelCategory,
): boolean {
  return (
    (from === 'gpt' && to === 'gpt-budget') ||
    (from === 'gpt-budget' && to === 'gpt')
  );
}

export function buildMobileModelSwitchConfirmation({
  currentModelId,
  messageCount,
  targetModelId,
}: {
  currentModelId: string;
  messageCount: number;
  targetModelId: string;
}): MobileModelSwitchConfirmation | null {
  if (!currentModelId || !targetModelId || currentModelId === targetModelId || messageCount <= 0) {
    return null;
  }
  const fromCategory = categorizeMobileModel(currentModelId);
  const toCategory = categorizeMobileModel(targetModelId);
  if (fromCategory === toCategory || isMobileHistoryCompatibleModelSwitch(fromCategory, toCategory)) {
    return null;
  }
  const fromLabel = MOBILE_MODEL_CATEGORY_LABEL[fromCategory];
  const toLabel = MOBILE_MODEL_CATEGORY_LABEL[toCategory];
  return {
    fromCategory,
    toCategory,
    fromLabel,
    toLabel,
    targetModelId,
    title: `切换到 ${toLabel} 模型?`,
    description: `这个任务已有历史消息。${fromLabel} 和 ${toLabel} 的消息格式可能不兼容，切换后旧上下文可能无法继续使用。`,
  };
}

function normalizeModelOption(value: unknown): MobileModelOption | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  if (!id) return null;
  const effortDisplayNames = isRecord(value.effortDisplayNames)
    ? Object.fromEntries(Object.entries(value.effortDisplayNames).filter((entry): entry is [string, string] =>
      typeof entry[1] === 'string',
    ))
    : {};
  const newSessionDefault = Array.isArray(value.newSessionDefault)
    ? [...new Set(value.newSessionDefault.filter(
      (item): item is 'claude-code' | 'codex' => item === 'claude-code' || item === 'codex',
    ))]
    : [];
  return {
    id,
    label: readString(value.displayName) ?? id,
    description: readString(value.description) ?? undefined,
    efforts: Array.isArray(value.efforts)
      ? value.efforts.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [],
    effortDisplayNames,
    defaultEffort: readString(value.defaultEffort),
    supportsFastMode: value.supportsFastMode === true,
    ...(newSessionDefault.length > 0 ? { newSessionDefault } : {}),
  };
}

function normalizeChoiceOption(value: unknown): MobileChoiceOption | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  if (!id) return null;
  return {
    id,
    label: readString(value.displayName) ?? id,
    description: readString(value.description) ?? undefined,
  };
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
