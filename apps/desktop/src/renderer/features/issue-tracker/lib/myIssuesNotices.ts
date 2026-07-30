/**
 * 「我的 Issue」页顶部提示的选取规则(纯函数,返回 i18n key)。
 *
 * 抽出来的原因:这里是产品判断而不是渲染细节 —— 哪些降级值得打扰用户、哪些不值得,
 * 需要能被单测钉住,不该埋在组件里。
 *
 * 贯穿本文件的一条判据:**提示不得断言页面上不存在的数据范围**。「只显示本机记录」
 * 这类结论必须先确认列表里真的没有远端内容,否则它会与同一页列出的东西自相矛盾。
 */

import type { MyIssuesResult } from '@/../shared/myIssues';

/**
 * 列表里是否有远端数据。判据用 state —— 账本兜底项一律 `unknown`,任何带真实状态的
 * 条目都只能来自远端(平台通道或 GitHub 增强)。
 *
 * 刻意**不**看 `sources.includes('github-account')`:账本里 identity 为 github-user
 * 的记录也会打这个来源(那是提交时就确认的事实),所以它不再等价于「来自远端」。
 */
function hasRemoteData(data: MyIssuesResult): boolean {
  return data.items.some((item) => item.state !== 'unknown');
}

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
    // 同上一条判据:平台取数失败时列表 = 本机账本 + GitHub 增强。增强真带回了内容
    // (存在有实时状态的条目)还说「只显示本机记录」,就与同页列出的 GitHub 来源矛盾 ——
    // 换成不带「仅本机」结论的说法。
    notices.push(
      hasRemoteData(data)
        ? 'issueTracker.mine.fetchFailedPartialHint'
        : 'issueTracker.mine.fetchFailedHint',
    );
  }
  if (data.truncated) {
    notices.push('issueTracker.mine.truncatedHint');
  }

  return notices;
}
