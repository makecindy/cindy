/**
 * 企业微信模板卡片(确认卡)。
 * ---------------------------------------------------------------------------
 * 企业微信智能机器人的长连接支持 `template_card` 被动回复与 `update_template_card`
 * 更新(官方文档 path/101836 回复与卡片更新、path/101835 事件)。确认卡用
 * `button_interaction` 类型:
 *
 *  - 每个按钮的 `key` 是**每次呈现随机生成的 token**, 不是固定的 allow/deny;
 *    点击事件只带 `event_key`(长连接路径是 `body.event.template_card_event.event_key`),
 *    token 无法猜中就无法代替别人作答;
 *  - 卡片带 `task_id`, 点击回调回传同一个 task_id, 用来确认"点的是我要的那张卡";
 *  - **撤按钮不依赖远端更新**: 平台对 `update_template_card` 的结构要求很严
 *    (`button_interaction` 空按钮被拒 errcode=40016; 无跳转的 `text_notice`
 *    被拒 errcode=42045 `card_action Missing or Invalid`, 官方社区也确认该类更新只
 *    接受跳转 1/2)。我们**不编造跳转地址、不伪造回调帧**, 也不试其它卡型; 收口一律
 *    先本地作废(移出活卡 + 作废 pending), 再用结果文字告知决定。远端按钮可能短暂
 *    仍可见, 但迟到点击不会再提交决定。
 */
import type { TemplateCard } from '@wecom/aibot-node-sdk';

import type { InteractiveCardSpec } from '../types.js';

/** 卡片按钮文案建议不超过 10 个字, 超出由平台截断, 这里先截一层。 */
const MAX_BUTTON_LABEL = 10;
/** 卡片二级文本建议不超过 112 个字。 */
const MAX_SUB_TITLE = 112;
const MAX_MAIN_TITLE = 26;

export interface WecomLiveCard {
  id: string;
  /** 卡片所属 lane(`group/<chatid>` 或主人 userid), 与入站 senderId 同值域。 */
  lane: string;
  taskId: string;
  title: string;
  body: string;
  /** token → 按钮语义值(业务方给的 payload)。 */
  actions: Map<string, { value: string; label: string }>;
  answered: boolean;
  expiresAt: number;
  createdAt: number;
}

export interface WecomCardClock {
  now(): number;
}

/** 卡片按钮 style: 1 蓝 / 2 红, 其余按默认蓝。 */
function buttonStyle(type: InteractiveCardSpec['buttons'][number]['type']): number {
  return type === 'danger' ? 2 : 1;
}

function truncate(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 创建按钮确认卡。调用方必须至少给一个按钮: 平台的 `button_interaction` 不接受空
 * `button_list`, 而没有按钮的 `text_notice` 更新已被真机拒绝(42045), 所以这里不为
 * “无按钮卡”提供任何构造 —— 收口走本地作废 + 结果文字, 不再尝试远端换卡。
 */
export function buildWecomTemplateCard(args: {
  taskId: string;
  title: string;
  body: string;
  buttons: Array<{ token: string; label: string; type?: 'primary' | 'default' | 'danger' }>;
}): TemplateCard {
  if (args.buttons.length === 0) {
    throw new Error('WECOM_CARD_BUTTONS_REQUIRED');
  }
  return {
    card_type: 'button_interaction',
    main_title: {
      title: truncate(args.title || 'Cindy', MAX_MAIN_TITLE),
      desc: 'Cindy',
    },
    sub_title_text: truncate(args.body, MAX_SUB_TITLE),
    button_list: args.buttons.slice(0, 6).map((button) => ({
      text: truncate(button.label, MAX_BUTTON_LABEL),
      style: buttonStyle(button.type),
      key: button.token,
    })),
    task_id: args.taskId,
  };
}

export interface ParsedTemplateCardEvent {
  eventKey: string;
  taskId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 解析模板卡片点击事件。长连接推送的 `body.event` 目前有两种写法:
 *
 *  - SDK 类型定义: `{ eventtype: 'template_card_event', event_key, task_id }`;
 *  - 官方文档举例: `{ template_card_event: { event_key, task_id, eventtype } }`。
 *
 * 两种都按同一组字段读(嵌套优先), 不 `any` 强转、不依赖某一版 SDK 类型, 也不
 * 拿 URL 回调的 `eventkey` 字段充数 —— 那是另一条协议路径。
 */
export function parseTemplateCardEvent(body: unknown): ParsedTemplateCardEvent | null {
  if (!isRecord(body) || !isRecord(body.event)) return null;
  const event = body.event;
  const nested = isRecord(event.template_card_event) ? event.template_card_event : event;
  const eventType = str(nested.eventtype) || str(event.eventtype);
  if (eventType && eventType !== 'template_card_event') return null;
  const eventKey = str(nested.event_key) || str(event.event_key);
  const taskId = str(nested.task_id) || str(event.task_id);
  if (!eventKey || !taskId) return null;
  return { eventKey, taskId };
}
