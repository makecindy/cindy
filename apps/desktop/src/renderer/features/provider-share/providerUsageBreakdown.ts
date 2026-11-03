/**
 * 组内电脑稳定键的解析(供应商组 §7)：「用量」块据此给组内电脑起名字。不读 window、不碰 i18n，便于单测。
 */

/** 组内电脑的稳定键里那台电脑的设备 id(`device:<deviceId>:<providerId>`)；不是同账号电脑时为 null。 */
export function deviceIdOfMemberKey(memberKey: string): string | null {
  if (!memberKey.startsWith('device:')) return null;
  const rest = memberKey.slice('device:'.length);
  const end = rest.indexOf(':');
  return end > 0 ? rest.slice(0, end) : null;
}

/** 分享来的电脑的稳定键里的任务位置(`share:<shareId>:<providerId>` → `share:<shareId>`)。 */
export function shareAgentDeviceIdOfMemberKey(memberKey: string): string | null {
  if (!memberKey.startsWith('share:')) return null;
  const rest = memberKey.slice('share:'.length);
  const end = rest.indexOf(':');
  return end > 0 ? `share:${rest.slice(0, end)}` : null;
}
