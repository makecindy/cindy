/**
 * connectionBannerVisibility.ts — ConnectionBanner 可见性判定的决策核。
 * 纯函数(不依赖 React / react-native),node 可单测;useShowConnectionBanner
 * 只负责喂时间维度的 offlineLongEnough,判定逻辑全在这里:
 *  - 请求级 error / 可分类连接问题(鉴权失效、被顶号等)→ 立即显示;
 *  - 关联设备熔断 open(电脑端未响应)→ 立即显示——relay 可能仍 online,
 *    只看 status 的旧判定对「进程活着但内部卡死」的半死态完全失明
 *    (2026-07 事故:presence 恒 online,banner 一直不出现,用户零信号);
 *  - 普通弱网断线 → 持续超过防闪窗口才显示(规则 7:杜绝跳变)。
 */
export function resolveConnectionBannerVisibility(input: {
  offline: boolean;
  offlineLongEnough: boolean;
  hasError: boolean;
  hasIssue: boolean;
  deviceUnresponsive: boolean;
}): boolean {
  return input.hasError
    || input.deviceUnresponsive
    || (input.offline && (input.hasIssue || input.offlineLongEnough));
}

/**
 * 屏幕层持有的请求级 error 是快照:熔断 open 期间的重试失败会把
 * DEVICE_UNRESPONSIVE 文案存进去,而探测成功自动关熔断只翻转
 * deviceUnresponsive,不会替屏幕清 error(review P1)。熔断已关时这类
 * 错误必然是陈旧的——它描述的状态(未响应 + 自动重试中)已不成立,
 * 按 null 处理,让 banner 随恢复自动消失;熔断仍 open 时保留原样
 * (banner 的 unresponsive 分支优先,error 本就不会被展示)。
 * hook 与组件都要用同一份结果,否则会出现「可见但无内容可渲染」的空壳。
 */
export function resolveEffectiveConnectionError(
  error: string | null,
  deviceUnresponsive: boolean,
): string | null {
  if (error && !deviceUnresponsive && error.includes('DEVICE_UNRESPONSIVE')) return null;
  return error;
}
