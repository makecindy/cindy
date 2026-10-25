import {pickModelMetadata,defaultEffortForCapabilities,type CatalogModel} from '@cindy/model-providers';
import type {CodexModelListItem} from '@cindy/maker-core';
import {CODEX_EFFORTS,isInternalCodexModelId,str} from '@cindy/model-providers/provider-auth/codex-model-discovery';


/**
 * app-server `model/list` 快照 → 规范化目录。
 *
 * live 协议不暴露 cache 的 context_window / priority，故上下文使用 Codex 当前统一窗口
 * 272k，排序严格保留 app-server 返回顺序。后续 `models_cache.json` 可读时仍可用上面的
 * mapper 提供更细元数据；首次 OAuth 的关键是绝不能因为 cache 尚未落盘而发布空目录。
 */
export function mapCodexAppServerModelsToCatalog(
  models: readonly CodexModelListItem[],
): CatalogModel[] {
  const out: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of models.entries()) {
    if (!raw || raw.hidden === true) continue;
    const modelId = str(raw.model);
    const itemId = str(raw.id);
    if (
      (modelId && isInternalCodexModelId(modelId)) ||
      (itemId && isInternalCodexModelId(itemId))
    ) {
      continue;
    }
    const slug = modelId ?? itemId;
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);

    const efforts = Array.isArray(raw.supportedReasoningEfforts)
      ? raw.supportedReasoningEfforts
          .map((item) => (item && typeof item === 'object' ? str(item.reasoningEffort) : null))
          .filter((effort): effort is string => effort != null && CODEX_EFFORTS.has(effort))
      : [];
    const requestedDefault = str(raw.defaultReasoningEffort);
    const defaultEffort =
      requestedDefault && efforts.includes(requestedDefault)
        ? (requestedDefault as CatalogModel['defaultEffort'])
        : defaultEffortForCapabilities(efforts as CatalogModel['efforts']);
    const tiers = [
      ...(Array.isArray(raw.serviceTiers) ? raw.serviceTiers.map((tier) => tier?.id) : []),
      ...(Array.isArray(raw.additionalSpeedTiers) ? raw.additionalSpeedTiers : []),
    ];
    const supportsFastMode = tiers.some((tier) => tier === 'priority' || tier === 'fast');
    const model: CatalogModel = {
      id: slug,
      discoveredMetadata: pickModelMetadata({
        name: str(raw.displayName),
        description: str(raw.description),
        efforts: Array.isArray(raw.supportedReasoningEfforts) ? efforts : undefined,
        defaultEffort: requestedDefault,
        supportsFastMode:
          Array.isArray(raw.serviceTiers) || Array.isArray(raw.additionalSpeedTiers)
            ? supportsFastMode
            : undefined,
      }),
      name: str(raw.displayName) ?? slug,
      group: 'gpt',
      // app-server 已按官方 picker 顺序返回；按返回位置记账户顺序。
      sortOrder: index,
      ...(str(raw.description) ? { description: raw.description } : {}),
      // 刻意**不**设 contextWindowVerified: live 协议不给 context_window, 这 272k 是
      // 统一兜底而非该模型的真实上限。标了它就会被拿去收敛运行期上报的窗口, 把真实
      // 更大的窗口(例如 400k 的 gpt-5.6)压成 272k, 上下文占比与 memory flush 全偏早。
      contextWindow: 272_000,
      efforts: efforts as CatalogModel['efforts'],
      defaultEffort,
      status: 'active',
      defaultEnabled: true,
      ...(Array.isArray(raw.serviceTiers) || Array.isArray(raw.additionalSpeedTiers)
        ? { supportsFastMode }
        : {}),
      supportsUltrafastMode: tiers.includes('ultrafast'),
    };
    if (efforts.includes('xhigh')) model.effortDisplayNames = { xhigh: 'Extra High' };
    out.push(model);
  }
  return out;
}