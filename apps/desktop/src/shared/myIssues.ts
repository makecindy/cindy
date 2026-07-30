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

export type MyIssueSource = 'github-account' | 'cindy-tool';

/** 拿不到实时状态时落在 'unknown',UI 只展示已知信息、不假装知道状态。 */
export type MyIssueState = 'open' | 'closed' | 'unknown';

export interface MyIssueItem {
  number: number;
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
