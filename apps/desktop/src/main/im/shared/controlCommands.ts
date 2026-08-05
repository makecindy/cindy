/**
 * `!stop` control command shared by the normal message router and channel
 * interaction interceptors. Keep this leaf module dependency-free so prompts
 * can bypass stop handling without importing the full message pipeline.
 */
export function isStopCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === '!stop' || normalized === '！stop';
}

/**
 * 控制命令(`!stop` / slash)是否被授权执行 —— **主人专属**。
 *
 * 判据只看 `speaker`:
 *   - 有 speaker = 群/多人对话的一次发言, 必须 `isOwner === true`(fail-closed:
 *     字段缺失或为假一律不放行);
 *   - 无 speaker = 私聊/单人对话, 各渠道在入站处已做过 owner 门(telegram 非
 *     owner 私聊回礼貌提示即 return, wecom 一切消息都过 acceptOwner), 这里放行。
 *
 * 为什么必须在这一层拦: 群消息的 `senderId` 被折叠成**群 lane**(telegram 的
 * `g/<chatId>`、钉钉的 `encodeLaneUserId(conversationId)`), 于是任何群成员发的
 * `!stop` 都会解析到**同一个群会话**, 效果等同于掐掉主人正在跑的那一轮; slash
 * 命令同理会操作主人的目录/会话。telegram 在入站层已经拦了(命令 owner 专属),
 * 钉钉没有 —— 门放在共用路由上, 六个渠道一次盖住。
 */
export function isCommandAuthorized(event: { speaker?: { isOwner: boolean } }): boolean {
  if (event.speaker === undefined) return true;
  return event.speaker.isOwner === true;
}
