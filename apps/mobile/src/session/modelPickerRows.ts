/**
 * modelPickerRows —— 模型选择列表「每行展示什么」的派生纯逻辑(**纯逻辑,零 react-native**)。
 *
 * 全部口径对齐桌面 ModelSelector.tsx 的同名函数(rowEffortOf / fastOnOf / fastEditable /
 * budgetDisabledOf / tooltipFor / formatContextWindow),文案对齐桌面 zh-CN common.json
 * (mobile i18n 化后由 models.json catalog 供文案,在使用点求值 i18n.t)。组件只做渲染,
 * 这里可 node 单测。
 */
import { modelSupportsFastMode, type ProviderView } from '@cindy/model-providers/registry';
import type { SectionModel } from '@cindy/model-providers/sections';
import type { AgentKind } from '@cindy/model-providers/types';

import {
  compactEnglishEffortLabel,
  MOBILE_EFFORT_LABELS,
} from '@cindy/maker-shared/agent-capabilities';

import { i18n } from '@/i18n';

import type { MobileAgentCapabilities, MobileSessionRuntimeOptions } from './agentCapabilities';
import type { MobileModelMemoryAccessors } from './draftModelMemory';
import type { DeviceApiKeyStatus } from '@/device-link/deviceModelMetaCache';
import type { MobileModelPricingMap } from '@/device-link/mobileMakerTransport';

/**
 * budget 档置灰时的行内提示(对位桌面 budgetNeedsApiKey,按远程语境改「被控电脑」)。
 * 函数而非常量:在使用点求值 i18n.t,避免模块顶层冻结语言。
 */
export function budgetDisabledHint(): string {
  return i18n.t('models.picker.budgetDisabledHint');
}

/** 行/展开区消费的最小模型形状(SectionModel 与 capabilities MobileModelOption 都满足)。 */
export interface PickerRowModel {
  id: string;
  efforts: readonly string[];
  defaultEffort: string | null;
  effortDisplayNames?: Record<string, string>;
  supportsFastMode?: boolean;
}

/** 上下文窗口 tokens → 紧凑展示("1M" / "272K" / "8192")。移植桌面 formatContextWindow。 */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : Number(m.toFixed(1))}M`;
  }
  if (tokens >= 1000) {
    const k = tokens / 1000;
    return `${Number.isInteger(k) ? k : Number(k.toFixed(0))}K`;
  }
  return String(tokens);
}

// 供应商完整展示名:三个内置 id 对齐桌面 zh-CN settings.providers.<id>.title,
// 自定义供应商回退目录里的 provider.name(桌面 providerDisplayName 同序)。
const PROVIDER_TITLE: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  xd: 'Cindy AI',
};

export function providerDisplayTitle(p: Pick<ProviderView, 'id' | 'name'>): string {
  return PROVIDER_TITLE[p.id] ?? p.name;
}

/** 单价行(对齐桌面 zh-CN priceTip:「输入 $3 · 输出 $15 / 百万 token」);无价返回 null。 */
export function formatPriceLine(
  price: { inputUsdPerMtok: number; outputUsdPerMtok: number } | undefined,
): string | null {
  if (!price) return null;
  const fmt = (v: number) => `$${Number(v.toFixed(2))}`;
  return i18n.t('models.picker.priceLine', {
    input: fmt(price.inputUsdPerMtok),
    output: fmt(price.outputUsdPerMtok),
  });
}

/**
 * 行展开区顶部的元信息行(对齐桌面 hover tooltip 的拼接口径:
 * 供应商完整名 · {contextWindow} 上下文 · 单价 · 快速)。全部缺失 → null(不渲染)。
 */
export function buildRowMetaLine(args: {
  provider: Pick<ProviderView, 'id' | 'name'> | null;
  model: Pick<SectionModel, 'id' | 'contextWindow' | 'supportsFastMode'>;
  pricing: MobileModelPricingMap | null;
}): string | null {
  const parts: string[] = [];
  if (args.provider) parts.push(providerDisplayTitle(args.provider));
  if (args.model.contextWindow > 0) {
    parts.push(i18n.t('models.picker.contextSuffix', { size: formatContextWindow(args.model.contextWindow) }));
  }
  const price = formatPriceLine(args.pricing?.[args.model.id]);
  if (price) parts.push(price);
  if (args.model.supportsFastMode) parts.push(i18n.t('models.picker.fastTag'));
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * effort 档完整展示名(桌面 modelEffortLabel 同序):客户端 i18n → 模型级
 * effortDisplayNames → agent capabilities effortLevels → 简中兼容词表 → 原 id。
 */
export function effortLabelFor(
  model: Pick<PickerRowModel, 'effortDisplayNames'>,
  effort: string,
  capabilities: MobileAgentCapabilities | null,
): string {
  const localized = i18n.t(`models.options.effortLevels.${effort}`, { defaultValue: '' });
  if (localized) return localized;
  const override = model.effortDisplayNames?.[effort];
  if (override) return override;
  const level = capabilities?.effortLevels.find((l) => l.id === effort);
  return level?.label ?? MOBILE_EFFORT_LABELS[effort] ?? effort;
}


/**
 * 会话页 composer / 新会话草稿摘要用的 effort 展示名。
 * runtime.effortOptions 来自被控端 zh-CN 兼容快照，这里走 effortLabelFor
 * 按当前 app 语言覆盖（英文 Extra High、简中 超高）。
 */
export function effortLabelFromRuntime(
  runtime: Pick<MobileSessionRuntimeOptions, 'currentModel' | 'effortOptions'>,
  effort: string | null | undefined,
): string {
  if (!effort) return '';
  return effortLabelFor(
    runtime.currentModel ?? { effortDisplayNames: {} },
    effort,
    {
      availableModels: [],
      effortLevels: runtime.effortOptions,
      permissionModes: [],
      hasFastMode: false,
      planModeSupported: false,
    },
  );
}

/**
 * 一级列表使用稳定 effort id 生成英文短码，避免被控端下发的长文案或混合语言挤占模型名。
 * 非英文界面继续使用完整本地化标签；完整英文名称仍由模型选项页展示。
 */
export function compactEffortLabelFor(
  model: Pick<PickerRowModel, 'effortDisplayNames'>,
  effort: string,
  capabilities: MobileAgentCapabilities | null,
): string {
  const fullLabel = effortLabelFor(model, effort, capabilities);
  const language = (i18n.resolvedLanguage ?? i18n.language).toLowerCase();
  if (!language.startsWith('en')) {
    return fullLabel;
  }

  return compactEnglishEffortLabel(effort, fullLabel);
}

/** 父 Pressable 的完整无障碍名称：基础选择动作 + 当前可见元信息的完整语义。 */
export function modelRowAccessibilityLabel(args: {
  baseLabel: string;
  subscriptionLabel?: string | null;
  effortLabel?: string | null;
  fastLabel?: string | null;
}): string {
  return [args.baseLabel, args.subscriptionLabel, args.effortLabel, args.fastLabel]
    .filter((label): label is string => !!label)
    .join(', ');
}

/** 选中行判定:分段模式比 (providerId, modelId) 双键;flat(providerId null)只比模型 id。 */
export function isSelectedRow(args: {
  providerId: string | null;
  modelId: string;
  activeModelId: string;
  activeSourceId: string | null;
}): boolean {
  return (
    args.modelId === args.activeModelId &&
    (args.providerId === null || args.providerId === args.activeSourceId)
  );
}

/**
 * 行级 Fast 可编辑性(桌面 fastEditable 同口径)= agent 能力 hasFastMode ×
 * 该 (供应商, 模型) 条目自己的 supportsFastMode(per-provider 现查,不读拍平列表)。
 */
export function rowFastEditable(args: {
  provider: ProviderView | undefined;
  modelId: string;
  agentKind: AgentKind | null;
  hasFastModeCap: boolean;
}): boolean {
  if (!args.hasFastModeCap || !args.agentKind) return false;
  return modelSupportsFastMode(args.provider, args.modelId, args.agentKind);
}

/**
 * 某行当前要展示的 effort(桌面 rowEffortOf 同口径):选中行 → live;非选中行 →
 * 注入记忆 → 模型默认。无 effort 档返回 null(行不显示 effort 标签)。
 */
export function rowEffortOf(args: {
  model: PickerRowModel;
  providerId: string | null;
  selected: boolean;
  liveEffort: string;
  agentKind: AgentKind | null;
  memory?: MobileModelMemoryAccessors;
}): string | null {
  const { model, providerId, selected, liveEffort, agentKind, memory } = args;
  if (!model.efforts || model.efforts.length === 0) return null;
  if (selected) {
    return model.efforts.includes(liveEffort) ? liveEffort : model.defaultEffort ?? model.efforts[0];
  }
  const remembered =
    agentKind && providerId ? memory?.getEffort(agentKind, providerId, model.id) : undefined;
  const cand = remembered ?? model.defaultEffort ?? undefined;
  return cand && model.efforts.includes(cand) ? cand : model.defaultEffort ?? model.efforts[0] ?? null;
}

/**
 * 行内 Fast 闪电是否点亮(桌面 fastOnOf 同口径):fastEditable 门控 → 选中行 live fastMode,
 * 非选中行读该 (供应商, 模型) 注入记忆,缺省 false。严格 per-(供应商, 模型),不跨来源串。
 */
export function rowFastOn(args: {
  model: PickerRowModel;
  providerId: string | null;
  selected: boolean;
  liveFastMode: boolean;
  agentKind: AgentKind | null;
  fastEditable: boolean;
  memory?: MobileModelMemoryAccessors;
}): boolean {
  if (!args.fastEditable) return false;
  if (args.selected) return args.liveFastMode;
  if (!args.agentKind || !args.providerId) return false;
  return args.memory?.getFast(args.agentKind, args.providerId, args.model.id) ?? false;
}

/**
 * budget 档置灰判定(桌面 budgetDisabledOf 同口径,key 判定换成被控端 presence 探测):
 * `codex/` 前缀 且 被控端明确无 key 才置灰;'unknown'(旧被控端 / 拉取失败)不置灰,
 * 宁可放行到被控端请求期报错也不误伤。
 */
export function budgetRowDisabled(modelId: string, keyStatus: DeviceApiKeyStatus): boolean {
  return modelId.startsWith('codex/') && keyStatus === 'absent';
}
