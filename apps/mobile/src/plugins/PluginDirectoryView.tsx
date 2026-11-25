import type {
  HostedRemoteCollectionItem,
  RemoteResourceHostTarget,
} from "@/device-link/remoteResources";
import type { PluginMarketModel } from "./usePluginMarket";
import type { PluginNoticeProps } from "./PluginNotice";

export interface PluginDirectoryViewProps {
  targets: readonly RemoteResourceHostTarget[];
  deviceId: string;
  onDeviceChange(value: string): void;
  query: string;
  items: HostedRemoteCollectionItem[];
  selectedKey?: string;
  loading: boolean;
  error: boolean;
  isOnline(row: HostedRemoteCollectionItem): boolean;
  onRefresh(): Promise<void>;
  onOpen(row: HostedRemoteCollectionItem): void;
  onDetail(row: HostedRemoteCollectionItem): void;
  onConnectComputer(): void;
  /** Installed / market switch; hidden while searching, when both sections are listed. */
  segment: PluginDirectorySegment;
  onSegmentChange(value: PluginDirectorySegment): void;
  market: PluginMarketModel;
  /** iOS: the page's notice of unfinished plugin operations, as this native list's first row (see PluginDetailView). */
  pageNotice?: PluginNoticeProps;
}
export type PluginDirectorySegment = "installed" | "market";

/** iOS renders the system list; other platforms keep the directory in PluginsScreen. */
export function PluginDirectoryView(_props: PluginDirectoryViewProps) {
  return null;
}
