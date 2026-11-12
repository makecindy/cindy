/**
 * 日志安全:新增的过程面/出箱路径**只记固定的失败类型**, 不记错误原文。
 *
 * 平台错误的 message 可能是任意内容 —— 短中文、文件名、绝对路径、成员姓名,
 * 甚至被回显的回复正文; 靠"替换 URL 和长随机串"挡不住这些。所以这里只给
 * 一个来自白名单的稳定码, 用于区分"哪一步失败了", 具体调查靠渠道 SDK 自己的
 * 脱敏日志与可复现的最小输入。
 */
export const DELIVERY_FAILURE = {
  /** 过程面(进度卡/流式帧)投放或刷新失败。 */
  progress: 'progress_failed',
  /** 终稿正文的结果不明(已发起调用但没有接受证据)。 */
  textUncertain: 'text_uncertain',
  /** 媒体素材上传或图片消息发送失败。 */
  media: 'media_failed',
  /** 文件素材上传/发送失败。 */
  file: 'file_failed',
  /** 确认卡投放、更新或撤按钮失败。 */
  card: 'card_failed',
} as const;

export type DeliveryFailureKind = (typeof DELIVERY_FAILURE)[keyof typeof DELIVERY_FAILURE];
