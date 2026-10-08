/**
 * telegram/progressFrame.ts — 运行中过程消息的单帧口径(两个 Telegram bot 同源)。
 * ---------------------------------------------------------------------------
 * 过程消息的生命周期(惰性占位、节流、send→edit)在 `streamingText.ts`, 个人 bot
 * 用 Bot API 驱动它, 官方 bot 用 msg.op 驱动它(desktop
 * `hook-control/telegramProgressCarrier.ts`)。这里只放两侧都要引用、又不属于那个
 * 生命周期类的单帧口径:
 *   - 单帧上限 `TELEGRAM_PROGRESS_FRAME_MAX_CHARS`(源 markdown 字符数);
 *   - 哪些帧不该落地(`isTelegramProgressFrameSilent`)。
 *
 * 上限按**源 markdown** 计, 不按渲染后的 HTML 计: Telegram 的 4096 上限是实体解析
 * 之后的可见字符数, 标签不占额度; 按 HTML 长度截会把本来放得下的正文无故截掉。
 * 3800 给渲染时新增的少量可见字符(列表符号、省略号)留了余量。
 */

/**
 * 运行中过程消息的单帧上限(源 markdown 字符数)。两个 bot 的唯一出处:
 * `streamingText` 超过它就停止编辑(终稿另行新发); 官方 presenter 的
 * `PresenterPolicy.intermediateMaxRenderedChars` 默认值取它(整轮正文超限时退回
 * 当前消息, 再超限才头部截断), 所以交给过程载体的帧不会触到这条停止线。
 */
export const TELEGRAM_PROGRESS_FRAME_MAX_CHARS = 3800;

/**
 * 自主判断沉默哨兵(全响应群的 ambient turn): 模型整条回复只有它时,
 * 本次 turn 静默。
 */
export const NO_REPLY_SENTINEL = 'NO_REPLY';

/**
 * 这一帧该不该出现在聊天里。空白帧不建消息(惰性占位); NO_REPLY 哨兵及其流式
 * 前缀(分片可能先到 "NO_")同样不落地 —— 否则准备闭嘴的轮次会先冒出一条过程消息。
 */
export function isTelegramProgressFrameSilent(markdown: string): boolean {
  const trimmed = markdown.trim();
  return trimmed === '' || NO_REPLY_SENTINEL.startsWith(trimmed);
}
