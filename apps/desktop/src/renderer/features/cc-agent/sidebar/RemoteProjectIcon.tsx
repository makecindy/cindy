import { Globe, MonitorOff, MonitorSmartphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();
  const disconnected = kind !== 'ssh' && connectionStatus === 'disconnected';
  // 检测中(冷启动缓存 / relay 重连,尚未拿到权威快照):保留普通设备图标,只压低一档,
  // 不画 MonitorOff —— 那是「确认离线」的意思,启动头几秒画它会把每台电脑都画成掉线。
  const connecting = kind !== 'ssh' && connectionStatus === 'connecting';
  const Icon = disconnected ? MonitorOff : kind === 'device-link' ? MonitorSmartphone : Globe;
  const icon = (
    <Icon
      size={size}
      strokeWidth={strokeWidth}
      className={cn('shrink-0', (disconnected || connecting) && 'opacity-75', className)}
      aria-hidden
    />
  );
  // 连接态不是 connected 时,同一行的收件箱快捷操作已被写保护收起(isRemoteSessionWriteBlocked),
  // 图标是这行唯一还在表达状态的东西:补一条读屏与悬停都读得到的说明,而不是纯装饰。
  if (!disconnected && !connecting) return icon;
  const label = t('ccAgent.remoteSession.actionsUnavailable');
  return (
    <span role="img" aria-label={label} title={label} className="inline-flex shrink-0">
      {icon}
    </span>
  );
}
