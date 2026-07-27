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
