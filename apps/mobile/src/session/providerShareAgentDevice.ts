/** 任务记录里「Agent 在某个分享者的电脑上」的设备 id 前缀(与桌面同构:`share:<shareId>`)。 */
export const PROVIDER_SHARE_AGENT_DEVICE_PREFIX = 'share:';

export function isProviderShareAgentDeviceId(deviceId: string | null | undefined): deviceId is string {
  return typeof deviceId === 'string'
    && deviceId.length > PROVIDER_SHARE_AGENT_DEVICE_PREFIX.length
    && deviceId.startsWith(PROVIDER_SHARE_AGENT_DEVICE_PREFIX);
}
