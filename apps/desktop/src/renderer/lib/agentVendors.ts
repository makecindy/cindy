/**
 * agentVendors —— 「用户可选的 Agent 引擎(harness)」列表,纯数据。
 *
 * 放在 lib 而不是组件层:state(newMakerDraft 的 localStorage 校验)也要用它,
 * 而 state 不能反向依赖组件。展示元数据(名称 / 品牌 mark)在
 * `components/new-chat/agentOptions.ts`,由本表派生并用类型强制补齐。
 *
 * 顺序即展示顺序。**新增引擎只改这一行**:选择器会自动多出条目,
 * localStorage 校验也会自动放行(否则用户选中新引擎、重启后会被静默重置)。
 *
 * 注意 MakerVendor 还含 'orca',但它不是用户可选的引擎(已被 ChatInput 底部的
 * 协同 toggle 取代),故不在此表内。
 */

import type { MakerVendor } from './ccAgent.types';

export const SELECTABLE_VENDORS = ['cc', 'codex', 'pi', 'grok-build'] as const satisfies readonly MakerVendor[];

export type SelectableVendor = (typeof SELECTABLE_VENDORS)[number];

/** SELECTABLE_VENDORS 对应的 runtime AgentKind(统一选择器 / IPC 同一张表)。 */
export type SelectableAgentKind = 'claude-code' | 'codex' | 'pi' | 'grok-build';

export function agentKindOfVendor(vendor: SelectableVendor): SelectableAgentKind {
  if (vendor === 'cc') return 'claude-code';
  if (vendor === 'codex') return 'codex';
  if (vendor === 'pi') return 'pi';
  return 'grok-build';
}

export function vendorOfAgentKind(kind: SelectableAgentKind): SelectableVendor {
  if (kind === 'claude-code') return 'cc';
  if (kind === 'codex') return 'codex';
  if (kind === 'pi') return 'pi';
  return 'grok-build';
}

export const SELECTABLE_AGENT_KINDS: readonly SelectableAgentKind[] =
  SELECTABLE_VENDORS.map(agentKindOfVendor);

/** localStorage / IPC 等外部输入的引擎值校验(不认识的一律交给调用方回退默认)。 */
export function isSelectableVendor(value: unknown): value is SelectableVendor {
  return typeof value === 'string' && (SELECTABLE_VENDORS as readonly string[]).includes(value);
}
