/** Pure state and deterministic election rules for the dormant Discord ingress scheduler. */

export type SchedulerPlatform = 'darwin' | 'linux' | 'win32';

export interface SchedulerChannelIdentity {
  channel: 'discord';
  /** Discord application id only; credentials never belong in this type. */
  identity: string;
}

export interface SchedulerDevice {
  deviceId: string;
  online: boolean;
  platform: string;
  channels: readonly SchedulerChannelIdentity[];
  lastSeenAt: number;
}

const DESKTOP_PLATFORMS = new Set<SchedulerPlatform>(['darwin', 'linux', 'win32']);

export function isDesktopSchedulerPlatform(
  platform: string | null | undefined,
): platform is SchedulerPlatform {
  return typeof platform === 'string' && DESKTOP_PLATFORMS.has(platform as SchedulerPlatform);
}

/**
 * Pick exactly one ingress owner. Device ids are the only tie-breaker: time,
 * process ordering, and random values must not affect the result.
 */
export function selectIngressDevice(
  channel: 'discord',
  identity: string,
  devices: readonly SchedulerDevice[],
): string | null {
  return (
    devices
      .filter(
        (device) =>
          device.online &&
          isDesktopSchedulerPlatform(device.platform) &&
          device.channels.some(
            (configured) => configured.channel === channel && configured.identity === identity,
          ),
      )
      .map((device) => device.deviceId)
      .sort((left, right) => left.localeCompare(right))[0] ?? null
  );
}
