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

/**
 * 平台那一路拿不到数据时的提示。`platform-unavailable`(接口还没上线)与 `fetch-failed`
 * (网络 / 服务端异常)**结构完全相同** —— 都是「平台侧的历史与实时状态都拿不到」,
 * 区别只在原因,所以共用一份逻辑,不各写一遍。
 *
 * 两条都**无条件提示**。先前 platform-unavailable 只在「列表里有 unknown 项」时才提示,
 * 想省掉接口上线前的常驻横幅,但那个优化会造出更坏的结果:账本为空(新设备、重装、或
 * 提交早于账本功能)时一条提示都没有,页面直接显示「还没有提交过 Issue」——
 * 空的本机兜底**不能证明远端历史为空**,于是把「暂时查不到」说成了「你从未提交」。
 * 噪音只是烦,错误信息是骗人的,后者更糟。
 *
 * 措辞按列表里有没有远端内容选:混合列表用不带「仅本机」结论的那版。
 */
function platformNoticeKey(data: MyIssuesResult, reason: 'unavailable' | 'fetchFailed'): string {
  const suffix = hasRemoteData(data) ? 'PartialHint' : 'Hint';
  const base = reason === 'unavailable' ? 'platformUnavailable' : 'fetchFailed';
  return `issueTracker.mine.${base}${suffix}`;
}

export function selectMyIssuesNotices(data: MyIssuesResult): string[] {
  const notices: string[] = [];

  if (data.degraded === 'platform-unavailable') {
    notices.push(platformNoticeKey(data, 'unavailable'));
  }
  // 未登录:文案讲的是「登录后能看到全部与最新状态」,不含「仅本机」结论,
  // 无论列表里有没有远端内容都成立,所以只有这一条不需要分版本。
  if (data.degraded === 'not-signed-in') {
    notices.push('issueTracker.mine.notSignedInHint');
  }
  if (data.degraded === 'fetch-failed') {
    notices.push(platformNoticeKey(data, 'fetchFailed'));
  }
  if (data.truncated) {
    notices.push('issueTracker.mine.truncatedHint');
  }

  return notices;
}
