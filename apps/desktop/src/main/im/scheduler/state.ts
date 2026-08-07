/** Pure state used by the same-account Desktop Discord scheduler. */

export interface SchedulerChannelIdentity {
  channel: 'discord';
  identity: string;
}

export interface SchedulerDevice {
  deviceId: string;
  online: boolean;
  platform: string;
  channels: readonly SchedulerChannelIdentity[];
  lastSeenAt: number;
}

const DESKTOP_PLATFORMS = new Set(['darwin', 'linux', 'win32']);

export function isDesktopSchedulerPlatform(
  platform: string | null | undefined,
): platform is string {
  return typeof platform === 'string' && DESKTOP_PLATFORMS.has(platform);
}

/** Deterministic ingress election; no clock or random tie-breaker. */
export function selectIngressDevice(
  channel: 'discord',
  identity: string,
  devices: readonly SchedulerDevice[],
): string | null {
  return devices
    .filter(
      (device) =>
        device.online
        && isDesktopSchedulerPlatform(device.platform)
        && device.channels.some(
          (configured) => configured.channel === channel && configured.identity === identity,
        ),
    )
    .map((device) => device.deviceId)
    .sort()[0] ?? null;
}
