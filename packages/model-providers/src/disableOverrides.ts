/**
 * disableOverrides —— 「模型 / 供应商停用」override 的形状与决策(纯逻辑,跨端共享)。
 *
 * 与「显示 / 隐藏」(modelVisibilityPrefs,renderer localStorage)是**两根正交的轴**:
 *   - 显示轴:纯陈列 —— 只决定模型选择面板里列不列;隐藏的模型被显式点名(MCP /
 *     IM / 记忆偏好)或参与自动兜底时照常可用。
 *   - 停用轴(本模块):准入 —— 停用的模型 / 供应商不可被任何**新**路由选中,
 *     所有清单派生(modelList.ts)与来源解析(registry.ts)统一过滤;已在运行的
 *     会话不打断(选择器的 keepSelected 豁免仍然生效)。
 *
 * 数据流:override 持久化在 desktop main 侧(model-disable-store,只存「停用」条目,
 * 默认全启用 —— 规则 20:只记 override 不快照默认),由 buildRegistry 烘焙进
 * ProviderView(`suspended` / CatalogModel.disabled),renderer 与 device-link 控制端
 * 直接消费带标志的视图,不需要各自再铺一份 override 表。
 */

/** 停用 override 表。只有「显式停用」的条目存在,缺席 = 启用(系统默认)。 */
export interface ModelDisableOverrides {
  /** key = `${providerId}:${modelId}`(真实目录 model id,桥接投影两端各记各的)。 */
  disabledModels?: Record<string, boolean>;
  /** key = providerId。供应商级停用:凭证保留,整体不可路由(盖住其下全部模型)。 */
  disabledProviders?: Record<string, boolean>;
}

/** 停用表的 key。与 store / UI 写入端共用,防三处手拼漂移。 */
export function modelDisableKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

/** 该供应商是否被整体停用。 */
export function isProviderDisabled(
  access: ModelDisableOverrides | undefined,
  providerId: string,
): boolean {
  return access?.disabledProviders?.[providerId] === true;
}

/** 该 (供应商, 模型) 是否被停用(不含供应商级 —— 供应商级由 ProviderView.suspended 表达)。 */
export function isModelDisabled(
  access: ModelDisableOverrides | undefined,
  providerId: string,
  modelId: string,
): boolean {
  return access?.disabledModels?.[modelDisableKey(providerId, modelId)] === true;
}
