/**
 * 「我的 Issue」列表的跨进程契约。
 *
 * 看自己的 issue 与提交 issue 走**同一条公共能力**:只要 Cindy 登录态,不要求用户
 * 有 GitHub 账号。平台代发本来就是服务端在代提交,它天生知道「哪个 Cindy 账号提交
 * 了哪条 issue」,所以「我的 issue 列表」由它出既准确、也跨设备。
 *
 * 三路输入合成一份列表:
 *  - 平台通道(主)—— 服务端按 Cindy 账号返回的提交记录 + 实时状态;
 *  - 本机账本 —— 产品内 /issue 工具提交成功时落在本机的记录。平台接口未就绪或
 *    离线时是唯一来源,标题/编号/时间照常可见,只是没有实时状态;
 *  - GitHub 账号(可选增强)—— 仅当用户恰好配了 Cindy GitHub 插件或本机 gh CLI 时,
 *    把他自己 GitHub 账号名下的 issue 也并进来。**它只是加成,绝不是前提**,
 *    没有它列表照常工作。
 */

/** 反馈仓 —— 与 githubUserIssueSubmitter 的 FEEDBACK_REPOSITORY 同一个仓。 */
export const MY_ISSUES_REPOSITORY = { owner: 'makecindy', repo: 'cindy' } as const;

/**
 * 列表项的链接**一律由 issue 号派生**,不采纳任何来源给的原值。
 *
 * 三路输入里的链接字段都是外部数据(本机账本 JSON 可被篡改或损坏、平台响应、
 * 插件通道转发的 GitHub 响应),而这一页的每一行都在向用户声称「这是你在本仓提的
 * issue」,整行点击直接交给 openExternal。派生而非校验,是因为产出点有两处
 * (远端 overlay 与账本兜底),逐处校验总会漏掉新加的那处;`number` 在两条解析路径上
 * 都已被钉成正整数,派生后链接就没有可被污染的余地。
 *
 * (全局 `shell:open-external` 另有一道 http(s) 白名单,挡的是 scheme 滥用;
 * 这里挡的是「站内链接被换成任意站点」,两道各管一层。)
 */
export function myIssueUrl(issueNumber: number): string {
  const { owner, repo } = MY_ISSUES_REPOSITORY;
  return `https://github.com/${owner}/${repo}/issues/${issueNumber}`;
}

/**
 * 账本落盘条目的链接是否指向本仓对应编号的 issue。
 *
 * 比对 host + path 而不是整串相等:提交链路存的是远端返回的 html_url,容忍尾斜杠
 * 之类的无害差异,免得把用户真实的历史记录当垃圾清掉。
 */
export function isMyIssueUrl(url: string, issueNumber: number): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.host !== 'github.com') return false;
  const { owner, repo } = MY_ISSUES_REPOSITORY;
  return parsed.pathname.replace(/\/+$/, '') === `/${owner}/${repo}/issues/${issueNumber}`;
}

export type MyIssueSource = 'github-account' | 'cindy-tool';

/** 拿不到实时状态时落在 'unknown',UI 只展示已知信息、不假装知道状态。 */
export type MyIssueState = 'open' | 'closed' | 'unknown';

export interface MyIssueItem {
  number: number;
  /** 由 number 派生(myIssueUrl),不是任何来源给的原值 —— 原因见 myIssueUrl 注释。 */
  url: string;
  title: string;
  /** 由 labels 推断;两个标签都没有时为 null(例如 issue 被人工改过标签)。 */
  type: 'bug' | 'feature' | null;
  state: MyIssueState;
  /** ISO 时间。查得到远端数据时用远端 created_at,否则回退账本记的提交时间。 */
  createdAt: string;
  /** ISO 时间;拿不到远端数据时为 null。 */
  updatedAt: string | null;
  /** 评论数;拿不到远端数据时为 null。 */
  commentCount: number | null;
  sources: MyIssueSource[];
}

/**
 * 平台通道拿不到数据时的降级原因。三者都只影响「有没有实时状态」,
 * 本机账本记录照常展示。
 *  - platform-unavailable:服务端还没提供这条读接口(404 / 501);
 *  - not-signed-in:Cindy 登录态不可用;
 *  - fetch-failed:网络或服务端异常。
 */
export type MyIssuesDegradedReason = 'platform-unavailable' | 'not-signed-in' | 'fetch-failed';

/** 可选增强用到的 GitHub 身份来源:插件 PAT 优先,本机 gh CLI 兜底。 */
export type GithubEnhancementSource = 'ghost' | 'gh-cli';

export interface MyIssuesResult {
  items: MyIssueItem[];
  /**
   * 可选增强的 GitHub 身份;null = 没配,属于**正常状态**,
   * UI 不得因此提示「你需要 GitHub 账号」。
   */
  githubEnhancement: { login: string; source: GithubEnhancementSource } | null;
  degraded: MyIssuesDegradedReason | null;
  /** true = 结果超出单页上限被截断,UI 必须明说而不是静默丢。 */
  truncated: boolean;
}

/**
 * 查询失败时跨进程回传的**稳定脱敏码**。刻意不回原始 Error.message ——
 * 它可能带 userData 绝对路径或上游响应片段,细节只留在 main 日志里。
 *  - stale-account-scope:请求期间切了账号,结果属于旧账号已被丢弃,重取即可;
 *  - unexpected:其余意外错误,详情看 main 日志。
 */
export type MyIssuesErrorCode = 'stale-account-scope' | 'unexpected';

/** 本机账本里的一条提交记录。 */
export interface SubmittedIssueRecord {
  number: number;
  url: string;
  /** 提交时的最终标题(用户在确认卡片上确认的那一版)。 */
  title: string;
  type: 'bug' | 'feature';
  /** ISO 时间。 */
  submittedAt: string;
  identity: 'github-user' | 'platform';
  /** identity === 'github-user' 时的 GitHub 用户名。 */
  githubLogin?: string;
  /** identity === 'platform' 时写进 issue 正文的公开署名。 */
  publicName?: string;
}
