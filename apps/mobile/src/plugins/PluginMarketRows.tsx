import type { PluginMarketModel } from "./usePluginMarket";

export interface PluginMarketRowsProps {
  market: PluginMarketModel;
  onConnectComputer(): void;
}

/** iOS renders market rows inside the native directory List; other platforms use PluginMarketSection. */
export function PluginMarketRows(_props: PluginMarketRowsProps) {
  return null;
}
