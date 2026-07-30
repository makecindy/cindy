/**
 * 「我的 Issue」页顶部提示的选取规则(纯函数,返回 i18n key)。
 *
 * 抽出来的原因:这里是产品判断而不是渲染细节 —— 哪些降级值得打扰用户、哪些不值得,
 * 需要能被单测钉住,不该埋在组件里。
 */

import type { MyIssuesResult } from '@/../shared/myIssues';

export function selectMyIssuesNotices(data: MyIssuesResult): string[] {
  const notices: string[] = [];

  // 服务端读接口上线前,platform-unavailable 对每个用户都成立,所以只在它造成**可见
  // 损失**时才解释:即列表里确有状态显示为「未知」的条目。
  // 判据是 state === 'unknown' 而不是 items.length > 0 —— 平台接口 404 但列表全部来自
  // GitHub 增强(每条都有真实状态)时,提示「只显示本机记录」既是噪音也不成立。
  if (data.degraded === 'platform-unavailable' && data.items.some((i) => i.state === 'unknown')) {
    notices.push('issueTracker.mine.platformUnavailableHint');
  }
  // 未登录 / 取数失败无条件提示:空列表时用户同样需要分清「真的没有」和「没查到」。
  if (data.degraded === 'not-signed-in') {
    notices.push('issueTracker.mine.notSignedInHint');
  }
  if (data.degraded === 'fetch-failed') {
    notices.push('issueTracker.mine.fetchFailedHint');
  }
  if (data.truncated) {
    notices.push('issueTracker.mine.truncatedHint');
  }

  return notices;
}
