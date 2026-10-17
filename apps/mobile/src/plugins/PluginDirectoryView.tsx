import type {
  HostedRemoteCollectionItem,
  RemoteResourceHostTarget,
} from "@/device-link/remoteResources";

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
}

/** iOS renders the system list; other platforms keep the directory in PluginsScreen. */
export function PluginDirectoryView(_props: PluginDirectoryViewProps) {
  return null;
}
