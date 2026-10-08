import { Globe, MonitorOff, MonitorSmartphone } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { DeviceLinkConnectionStatus } from '@/lib/ccAgent.types';

/**
 * 整件任务在远端(device-link 设备 / SSH 主机)。任务在本机、只有 Agent 在另一台电脑
 * 运行的不走这里:标识画在 Agent 图标上(VendorIcon remote 的信号波纹)。
 */
type RemoteProjectIconKind = 'device-link' | 'ssh';

interface RemoteProjectIconProps {
  kind: RemoteProjectIconKind;
  size?: number;
  strokeWidth?: number;
  connectionStatus?: DeviceLinkConnectionStatus | null;
  className?: string;
}

/** Sidebar remote-project icon shared by project headers and remote session rows. */
export function RemoteProjectIcon({
  kind,
  size = 14,
  strokeWidth = 2,
  connectionStatus,
  className,
}: RemoteProjectIconProps) {
  const disconnected = kind !== 'ssh' && connectionStatus === 'disconnected';
  const Icon = disconnected ? MonitorOff : kind === 'device-link' ? MonitorSmartphone : Globe;
  return (
    <Icon
      size={size}
      strokeWidth={strokeWidth}
      className={cn('shrink-0', disconnected && 'opacity-75', className)}
      aria-hidden
    />
  );
}
