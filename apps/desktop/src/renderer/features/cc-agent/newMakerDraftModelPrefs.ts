import { EFFORT_VALUES } from '@cindy/model-providers';

import type { Effort } from '@/lib/userPreferences.types';

/**
 * 草稿档位的**单点校准规则**:把「草稿手上的档」收敛到「当前 (来源, 模型, 引擎) 真的支持的档」。
 *
 * 三个来源的档都从这里过,规则完全一样 —— 谁提供的值不重要,能不能跑才重要:
 *   1. `presetEffort` —— 其它对话写下的 (agent, 来源, 模型) 全局预设。首页是「下一次建会话」
 *      的配置草稿,没有运行中的模型需要保护,预设存在就该采用。
 *   2. `currentEffort` —— 草稿自己的值。它有两个出处,**两个都可能是脏的**:
 *      · 新用户的种子默认(newMakerDraft.defaultVendorPrefs 写死 'medium')。种子模型由目录
 *        排序 / 服务端 `newSessionDefault` 决定,和这个写死的 'medium' 毫无关系:目录把
 *        DeepSeek V4 Pro(efforts=['high','max'])下发成新用户默认时,草稿就带着一个该模型
 *        根本不支持的 'medium'(2026-08-12 登录态沙盒实证)。
 *      · 老用户的 `lastByVendor.effort` 记忆。服务端随时可能改某个模型的档位表,昨天存下的
 *        'medium' 今天就可能不在表里了。
 *   3. 都没有 → 目录 `defaultEffort` → 表内最接近档。
 *
 * 为什么必须在这一层(而不是在 ChatInput 或 pill 上补):这个返回值同时喂**显示**
 * (composer pill / 选择器 trigger)与**提交**(createSession 的 effort)。只修显示会让 UI
 * 说一套、首条请求发另一套;在消费端各补一次则必然漂移。与 `calibrateDraftModel`(模型可用性
 * 校准)同一个位置、同一条原则:**种子只是起点,最终值必须由目录裁决**。
 *
 * 刻意**不回写**草稿:`lastByVendor.effort` 是用户跨模型的偏好记忆,不能因为当前这个模型不
 * 支持就把它擦掉 —— 切回支持 'medium' 的模型时那份记忆还得在。与 `calibratedDraftModel`
 * 只派生不落盘同理。
 */

/** 档位强弱序里的位置;不认识的档返回 -1(不参与距离计算)。 */
function effortRank(effort: string): number {
  return (EFFORT_VALUES as readonly string[]).indexOf(effort);
}

/**
 * 表内离目标档最近的一档。距离相同时取**更低**的那档 —— 降级到更省的一侧是可逆的误差
 * (用户嫌不够聪明会自己往上调),升级则直接多花钱 / 多花时间,用户未必察觉。
 */
function nearestSupportedEffort(efforts: readonly Effort[], target: Effort): Effort | null {
  const targetRank = effortRank(target);
  if (targetRank < 0) return null;
  const ranked = efforts
    .map((effort) => ({ effort, rank: effortRank(effort) }))
    .filter((entry) => entry.rank >= 0);
  if (ranked.length === 0) return null;
  ranked.sort((a, b) => {
    const byDistance = Math.abs(a.rank - targetRank) - Math.abs(b.rank - targetRank);
    return byDistance !== 0 ? byDistance : a.rank - b.rank;
  });
  return ranked[0]?.effort ?? null;
}

export function resolveNewMakerDraftEffort(args: {
  currentEffort: Effort;
  presetEffort?: Effort;
  efforts: readonly Effort[];
  defaultEffort: Effort | null;
}): Effort {
  const { currentEffort, presetEffort, efforts, defaultEffort } = args;
  // 目录尚未就绪(档位表为空)= **还不知道**,不是「不支持」:保留草稿原值,避免首帧跳变。
  // 这也是唯一一条允许放行未经校验档位的路径。
  if (efforts.length === 0) return currentEffort;
  // 优先级:全局预设 > 草稿当前值。两者都必须过档位表这一关(旧实现在没有预设时直接
  // 交出 currentEffort,种子 'medium' 就是这样漏到 DeepSeek 这类 high/max-only 模型上的)。
  const preferred = presetEffort ?? currentEffort;
  if (efforts.includes(preferred)) return preferred;
  if (defaultEffort && efforts.includes(defaultEffort)) return defaultEffort;
  return nearestSupportedEffort(efforts, preferred) ?? efforts[0] ?? currentEffort;
}
