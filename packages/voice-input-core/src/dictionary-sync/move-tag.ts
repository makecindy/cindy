import { HLC_PREFIX_LENGTH, type HlcTimestamp } from "./hlc";

/**
 * 搬移化身时用的确定性 tag。
 *
 * 两台设备必须为同一次改名算出同一个新 tag，同时又不能复用会被原键墓碑覆盖的
 * 旧 tag。保留 HLC 前缀可避免把任一设备的时钟推向未来，定长哈希则避免反复改名
 * 让 tag 持续增长。
 */
export function deriveMoveTag(
  sourceTag: HlcTimestamp,
  targetKey: string,
): HlcTimestamp {
  const prefix = sourceTag.slice(0, HLC_PREFIX_LENGTH);
  return `${prefix}mv${fold36(`${sourceTag}\u0000${targetKey}`)}`;
}

/** FNV-1a 折叠成定长 base36。只用于派生搬移标记，不参与任何安全判断。 */
function fold36(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}
