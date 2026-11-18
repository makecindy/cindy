/**
 * 崩溃恢复暂停的放行判据(#7209 / #7534)。
 *
 * 客户端重启后从快照恢复出的排队队列处于暂停态——重启本身不替用户发送。
 * 主人自己在会话里发消息走 INPUT_ENQUEUE,带 `resumeRestorePausedQueue`,暂停即解挂;
 * 另一条放行来源是「外部已授权投递」:伙伴发来的消息、伙伴房间里主人发来的消息。
 *
 * **判据必须是宿主盖章的来源,不是 clientId 字符串。** V1 的 Bot 私聊车道
 * (`bot-dm:` 前缀)已于 2026-11-08 退役(f7c977b274「retire V1 teammate direct
 * messages」):伙伴改用 send_to_session 互发消息,这条投递拿到的是宿主生成的普通
 * clientId(`register.ts` 的 `sendToSessionInternal` 里 `explicitClientId ?? createId()`),
 * 按前缀判断永远不会命中——那条判据既修不好 #7209,又会让人误以为放行口径还在。
 *
 * 两条盖章都只由宿主产生,模型、插件、渲染层与远端都无法自报:
 *
 * - `externalAuthorizedDelivery`:投递点宿主盖章。两个产生点:
 *   1. 伙伴房间投递(`deliverToCanonical`:主人从另一台设备在伙伴的房间里说话,
 *      clientId 由 `directRoomClientId` 生成);
 *   2. 跨设备任务动作投递(`sessionHandoffIpc`):收据(`taskActionReceipt`)已在本机
 *      通过 `taskActionDeliveryGuard` 校验后才盖章。收据由控制端电脑的宿主生成,
 *      校验包含控制端设备身份、发送方身份、目标任务与正文,失败即不投递,所以这个
 *      盖章是接收方可验的事实,不是 wire 上自报字段(#7512 review P1)。插件派活
 *      (`sender.kind === 'plugin'`)不属于这一类,按下面的口径不放行。
 * - `origin.senderBotId`:伙伴发来的消息。发送方身份由宿主按发送方 session 的
 *   伙伴绑定从库里读出来(`readSenderIdentity` → `bot_session_links`),不是
 *   wire 字段。
 *
 * 跨设备投递这一条尤其要自己盖:`origin.senderBotId` 走的是本机库里的伙伴绑定,
 * 而跨设备发送方在**另一台**电脑上,本机读不到它的绑定,只靠 `senderBotId` 的话
 * 伙伴互发消息永远解不开崩溃恢复出来的暂停队列,消息只会一直堆着。
 *
 * 自动来源(定时任务 / Orca 派活 / 插件派活)不带这两种盖章,一律不放行:
 * 自动来源不代表用户表态,不得借此把用户恢复出来的草稿自动发出去。
 */

import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';

export function isAuthorizedExternalDelivery(params: {
  /** 投递点宿主盖章:受信任的投递点会盖这个标记。 */
  externalAuthorizedDelivery?: boolean;
  /** 宿主按发送方身份盖章的来源。 */
  origin?: AgentInputQueuedMessage['origin'];
}): boolean {
  if (params.externalAuthorizedDelivery === true) return true;
  const origin = params.origin;
  return origin?.kind === 'session'
    && typeof origin.senderBotId === 'string'
    && origin.senderBotId !== '';
}
