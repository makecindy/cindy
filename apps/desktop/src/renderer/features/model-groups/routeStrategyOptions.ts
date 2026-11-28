import type { TFunction } from 'i18next';

import { splitRouteStrategies, type RouteStrategy } from '../../../shared/routeStrategy';

/**
 * 选法选择框的两组选项：主推的在上面，其余收在「更多选法」下面(shared/routeStrategy.ts 的 PRIMARY_ROUTE_STRATEGIES)。
 * 智能路由的路由、账号、电脑与另一台电脑上的组用同一份，选项名字与说明都来自 modelGroups.strategy.*。
 */
export function routeStrategySelectGroups(strategies: readonly RouteStrategy[], t: TFunction) {
  const { primary, more } = splitRouteStrategies(strategies);
  const option = (value: RouteStrategy) => ({ value, label: t(`modelGroups.strategy.${value}.title`) });
  return [
    { options: primary.map(option) },
    ...(more.length > 0 ? [{ label: t('modelGroups.settings.moreStrategies'), options: more.map(option) }] : []),
  ];
}
