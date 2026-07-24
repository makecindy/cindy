/**
 * Maps server authorization scope into the client-facing source taxonomy.
 *
 * Scope is the source of truth for visibility and publishing authority. Whether a
 * public Plugin is installed by default is an installation policy, not a source.
 * An installed Ghost without a matching market record remains local.
 */
import type { PluginMarketItem } from '../../../../shared/pluginMarket';

export type PluginPresentationOrigin =
  | 'public'
  | 'organization'
  | 'personal'
  | 'local';

export function pluginPresentationOrigin(
  item: Pick<PluginMarketItem, 'scope'> | null | undefined,
): PluginPresentationOrigin {
  return item?.scope ?? 'local';
}
