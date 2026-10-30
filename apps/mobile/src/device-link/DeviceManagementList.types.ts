import type { DeviceView } from '@cindy/device-link';
import type { DeviceListItem } from '@cindy/maker-shared/device-list';

export interface DeviceManagementListProps {
  rows: DeviceListItem<DeviceView>[];
  busy: boolean;
  onOpen(device: DeviceView): void;
  onRename(device: DeviceView): void;
  onDelete(device: DeviceView): void;
  /** 下拉刷新;Promise 在本次刷新结束(成功或失败)后 resolve。 */
  onRefresh(): Promise<void>;
}
