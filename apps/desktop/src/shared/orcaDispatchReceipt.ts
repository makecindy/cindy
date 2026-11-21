/**
 * 升级卡：Lead 交的回合声明与宿主派发凭据对不上、补交一轮仍不一致时，落的唯一一张卡。
 * 正常派单不落卡；它不是模型消息，也不参与对账（对账读宿主派发记录）。
 *
 * 只存事实、不存成句：同一行记录在桌面、手机、英文界面上按各自语言拼正文。
 * 所以这里不保留 Lead 的原话——正文由字段拼出来，卡片不因措辞变化而改形。
 */

/** 对账失败原因：没交声明 / 声明了没派出去 / 派了没写进声明 / 队列编号对不上。 */
export type OrcaDispatchClaimFailure =
  | 'no-declaration'
  | 'declared-not-dispatched'
  | 'dispatched-not-declared'
  | 'unknown-message-id';

export interface OrcaDispatchClaimNotice {
  version: 1;
  state: 'unverified';
  /** 对不上的目标（Worker 标签）；空数组表示没交声明。 */
  targets: string[];
  reason: OrcaDispatchClaimFailure;
  /** 判定细节：目标标签、队列编号，或空声明提示。 */
  detail: string;
  at: number;
}

/** 系统记录区的同一份载荷；保留旧名以免在渲染层多改一处。 */
export type OrcaDispatchSystemRecord = OrcaDispatchClaimNotice;
