import type { DeviceView } from '@cindy/device-link';

export interface DeviceManagementListProps {
  rows: Array<{
    device: DeviceView;
    statusLabel: string;
    statusDetail: string;
  }>;
  busy: boolean;
  onOpen(device: DeviceView): void;
  onRename(device: DeviceView): void;
  onDelete(device: DeviceView): void;
}
