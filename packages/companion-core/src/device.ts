export interface DeviceLinkDeviceInfo {
  cpuLabel?: string;
  memoryGb?: number;
  osVersion?: string;
  modelLabel?: string;
}

export interface DeviceLinkDeviceView {
  deviceId: string;
  name: string;
  selfName?: string | null;
  deviceInfo?: DeviceLinkDeviceInfo | null;
  platform: string | null;
  appVersion: string | null;
  lastSeenAt: string | null;
  online: boolean;
  busy: boolean;
  remoteControlEnabled: boolean;
  /** 本机是否允许主动控制该目标设备(控制端本地偏好)。 */
  controlEnabled: boolean;
  isSelf: boolean;
}

