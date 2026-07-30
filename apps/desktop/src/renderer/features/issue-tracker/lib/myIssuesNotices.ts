/**
 * 「我的 Issue」页顶部提示的选取规则(纯函数,返回 i18n key)。
 *
 * 抽出来的原因:这里是产品判断而不是渲染细节 —— 哪些降级值得打扰用户、哪些不值得,
 * 需要能被单测钉住,不该埋在组件里。
 */

import type { MyIssuesResult } from '@/../shared/myIssues';

export function selectMyIssuesNotices(data: MyIssuesResult): string[] {
  const notices: string[] = [];

  // 服务端读接口上线前,platform-unavailable 对每个用户都成立。一条都没有时提它纯属
  // 噪音(用户没问、也没有可见损失);真有条目、状态显示为「未知」时才需要解释原因。
  if (data.degraded === 'platform-unavailable' && data.items.length > 0) {
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
