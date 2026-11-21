/**
 * 升级卡：Lead 的派单主张补派一轮后仍无凭据时，宿主在会话里落的唯一一张卡。
 * 正常派单不落卡（Lead 自己的正文就是记录）；异常才有可见性。
 * 它不是模型消息，也不参与主张对账（对账读宿主派发记录）。
 *
 * 只存事实、不存成句：同一行记录在桌面、手机、英文界面上按各自语言拼正文，
 * 否则正文会永远是落库那台机器的语言。
 */

/** 主张对账的失败原因：没有派单 / 没派给点名的人 / 队列编号对不上。 */
export type OrcaDispatchClaimFailure = 'no-dispatch' | 'target-not-dispatched' | 'unknown-message-id';

export interface OrcaDispatchClaimNotice {
  version: 1;
  state: 'unverified';
  /** Lead 这轮点名要派的目标标签，按花名册解析得到，可能为空。 */
  targets: string[];
  reason: OrcaDispatchClaimFailure;
  /** 判定细节：没派到的目标标签，或对不上的队列编号。 */
  detail: string;
  /** 主张原句，卡片整句引用。 */
  quote: string;
  at: number;
}

export type OrcaDispatchSystemRecord = OrcaDispatchClaimNotice;

/** 引文在卡片里的长度上限：升级卡要能读，引文不能占满整屏。 */
export const ORCA_DISPATCH_CLAIM_QUOTE_MAX = 120;
