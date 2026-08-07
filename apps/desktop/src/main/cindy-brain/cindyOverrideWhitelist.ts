/**
 * cindyOverrideWhitelist.ts — ghosts:cindy-prefs:set 的白名单校验(纯函数,零 Electron,可直测)。
 *
 * 按能力键类目分流:image.* / video.* 钉的是媒体目录里的模型 id;text.*(快问
 * 快答)钉的是轻量任务模型链的**档位键**(供应商×模型,见 shared/utilityModelProfiles)。
 * 判据必须与消费方严格同集合——cindySlot 把 override 当 pinnedProfileId 用
 * isUtilityModelProviderKind 复核,这里放行的值链路必须认,否则用户钉档存进去
 * 也是静默回落默认。
 */

import { isUtilityModelProviderKind } from '../../shared/utilityModelProfiles.js';

/** 媒体目录条目(本函数只读 id 与 image 的 supportsEdit)。 */
export interface CindyOverrideCatalogs {
  image: readonly { id: string; supportsEdit?: boolean }[];
  video: readonly { id: string }[];
  embed: readonly { id: string }[];
  /**
   * text.* 合法目录钉值全集(cat: 编码,由调用侧按当前供应商目录现算);
   * 轻量档位键另行放行(与消费方 pinnedProfileId 同判据)。
   */
  textPinIds: readonly string[];
}

/**
 * 校验一项覆盖值是否可写入。model 为 null = 清除覆盖(恢复跟随默认),任何
 * 类目都放行;非字符串 / 空串一律拒(IPC 入参是 unknown,这里是最窄防线)。
 */
export function isCindyOverrideModelAllowed(
  capability: string,
  model: unknown,
  catalogs: CindyOverrideCatalogs,
): boolean {
  if (model === null) return true;
  if (typeof model !== 'string' || model.length === 0) return false;
  if (capability.startsWith('text.')) {
    return isUtilityModelProviderKind(model) || catalogs.textPinIds.includes(model);
  }
  if (capability.startsWith('video.')) {
    return catalogs.video.some((m) => m.id === model);
  }
  if (capability === 'image.edit') {
    return catalogs.image.some((m) => m.id === model && m.supportsEdit === true);
  }
  if (capability.startsWith('image.')) {
    return catalogs.image.some((m) => m.id === model);
  }
  if (capability.startsWith('embed.')) {
    return catalogs.embed.some((m) => m.id === model);
  }
  return false;
}
