/**
 * modelPickerSheetModel —— 模型选择浮窗的视图状态机与派生纯逻辑(**纯逻辑,零 react-native**)。
 *
 * 浮窗是「单 Modal 双 SheetSurface」叠层(见 ModelPickerSheet 头注释):一级 = 模型列表 + 权限行,
 * 二级 = 某行的「模型选项」(effort/Fast/元信息)或「权限」选择。Android 返回键 / backdrop /
 * 把手下拉的「先关二级再关一级」结算、二级标题派生、options 目标行现查都收在这里,可 node 单测。
 */
import type { ProviderView } from '@cindy/model-providers/registry';

import { i18n } from '@/i18n';

import type { MobileModelOption } from './agentCapabilities';
import type { PickerRowModel } from './modelPickerRows';
import type { ProviderModelRow } from './providerModelSections';

/** 浮窗当前视图:一级模型列表 / 二级模型选项(锁定某行)/ 二级权限选择。 */
export type ModelPickerSheetView =
  | { kind: 'models' }
  | { kind: 'options'; providerId: string | null; modelId: string }
  | { kind: 'permission' };

/**
 * 返回手势的统一结算(Android 返回键 / iOS onRequestClose / 二级把手下拉):
 * 二级先回一级,处于一级才允许关闭整个浮窗。
 */
export function settleModelPickerSheetBack(view: ModelPickerSheetView): {
  next: ModelPickerSheetView;
  close: boolean;
} {
  if (view.kind === 'models') return { next: view, close: true };
  return { next: { kind: 'models' }, close: false };
}

/** options 二级视图的目标行解析结果。 */
export interface ModelOptionsTarget {
  model: PickerRowModel;
  provider: ProviderView | null;
  displayName: string;
  /** 上下文窗口(元信息行用;flat 回退无该数据 → 0,元信息行自动省略)。 */
  contextWindow: number;
}

/**
 * options 目标行**现查**(每次渲染按最新 rows 找):providers 目录热更新后目标行可能消失,
 * 返回 null,组件据此自动回一级,绝不渲染悬空数据。
 *   - providerId 非空 → 供应商分段行(rows 里按 (providerId, modelId) 双键找);
 *   - providerId null → flat 回退行(flatOptions 按 id 找)。
 */
export function findOptionsTarget(
  view: ModelPickerSheetView,
  rows: readonly ProviderModelRow[],
  flatOptions: readonly MobileModelOption[],
): ModelOptionsTarget | null {
  if (view.kind !== 'options') return null;
  if (view.providerId !== null) {
    const row = rows.find(
      (r) => r.provider.id === view.providerId && r.model.id === view.modelId,
    );
    if (!row) return null;
    return {
      model: row.model,
      provider: row.provider,
      displayName: row.model.displayName,
      contextWindow: row.model.contextWindow,
    };
  }
  const option = flatOptions.find((o) => o.id === view.modelId);
  if (!option) return null;
  return {
    model: option,
    provider: null,
    displayName: option.label,
    contextWindow: 0,
  };
}

/** 二级 header 标题:options → 模型 displayName(目标失效回退 modelId);permission → 「权限」。 */
export function modelPickerSheetTitle(
  view: ModelPickerSheetView,
  rows: readonly ProviderModelRow[],
  flatOptions: readonly MobileModelOption[],
): string {
  if (view.kind === 'permission') return i18n.t('models.picker.permissionTitle');
  if (view.kind === 'options') {
    return findOptionsTarget(view, rows, flatOptions)?.displayName ?? view.modelId;
  }
  return i18n.t('models.picker.title');
}

/** flat 回退列表的 query 过滤(label / id 大小写不敏感包含,与供应商分段的共享 builder 同口径)。 */
export function filterFlatModelOptions(
  options: readonly MobileModelOption[],
  query: string,
): MobileModelOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...options];
  return options.filter(
    (m) => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
  );
}
