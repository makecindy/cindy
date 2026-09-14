/**
 * 客户端更新通道三态(2026-08 新增 beta 测试渠道)。
 *
 * 与 canary 不同:canary 是**账号级、服务端下发**的灰度标记(feature-flags →
 * 本地持久化 → 登出清);beta 是**设备级、客户端本地开关**(设置页开关,登出不清)。
 * 两者来源与生命周期不同,但最终都收敛成同一个发布通道选择。
 *
 * 优先级固定:canary > beta > release。canary 命中时完全忽略 beta(避免 beta 开关
 * 把灰度用户从 canary 指针切走),canary 不生效才看 beta,都不生效走 release。
 *
 * 桌面/手机共用这一判定;消费点只拿最终 channel,不再各自写 if-else。
 */

export type UpdateChannel = 'canary' | 'beta' | 'release';

/** 优先级收敛:canary > beta > release。 */
export function resolveUpdateChannel(isCanary: boolean, isBeta: boolean): UpdateChannel {
  if (isCanary) return 'canary';
  if (isBeta) return 'beta';
  return 'release';
}
