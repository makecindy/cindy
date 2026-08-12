/**
 * agentOptions —— Agent 引擎(harness)的**展示元数据**,由 lib/agentVendors 的
 * SELECTABLE_VENDORS 派生。
 *
 * 同一份表被两个控件消费:
 *   · AgentSelect(新建对话工具条的引擎下拉)
 *   · VendorSegmentedSwitcher(模型面板内的两步切换分段等定值场景)
 * 两处各自维护会漂移出「一个控件有、另一个没有」的引擎,所以集中在这里。
 *
 * 新增引擎的流程:在 lib/agentVendors 的 SELECTABLE_VENDORS 里加一项 —— 下面的
 * VENDOR_PRESENTATION 是 Record<SelectableVendor, …>,漏补名称 / mark 会**编译报错**,
 * 不会出现「列表里多了个没图标的引擎」。
 */

import type { ComponentType } from 'react';

import { ClaudeMark } from '@/components/icons/ClaudeMark';
import { CodexMark } from '@/components/icons/CodexMark';
import { PiMark } from '@/components/icons/PiMark';
import { SELECTABLE_VENDORS, type SelectableVendor } from '@/lib/agentVendors';

export interface AgentOption {
  vendor: SelectableVendor;
  /** 品牌名,不进 i18n(产品名跨语言不翻译)。 */
  label: string;
  Mark: ComponentType<{ size?: number; className?: string }>;
}

const VENDOR_PRESENTATION: Record<SelectableVendor, Omit<AgentOption, 'vendor'>> = {
  cc: { label: 'Claude', Mark: ClaudeMark },
  codex: { label: 'Codex', Mark: CodexMark },
  pi: { label: 'Pi', Mark: PiMark },
};

export const AGENT_OPTIONS: readonly AgentOption[] = SELECTABLE_VENDORS.map((vendor) => ({
  vendor,
  ...VENDOR_PRESENTATION[vendor],
}));

/** 找不到时回落第一项 —— 调用方拿到的永远是可渲染的选项。 */
export function agentOptionOf(vendor: string): AgentOption {
  return AGENT_OPTIONS.find((o) => o.vendor === vendor) ?? AGENT_OPTIONS[0];
}
