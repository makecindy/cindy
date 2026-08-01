import type { NormalizedRemoteMessage } from '@/session/messageNormalize';
import { stripChatQuoteMarkerLines } from '@cindy/maker-shared/chat-quotes';
import { formatCompactTokens } from '@cindy/maker-shared/usage-format';
import { i18n } from '@/i18n';
import {
  remoteMoneySymbol,
  type RemoteMoney,
} from '@/session/remoteMoney';

export type CopyMessageStatus = 'copied' | 'empty' | 'failed';

export type MobileMessageControlActionId = 'copy' | 'delete' | 'rewind' | 'fork';

export interface MobileMessageControlInput {
  canCopy: boolean;
  canFork: boolean;
  canRewind: boolean;
  isStreaming: boolean;
}

type ClipboardNavigator = {
  clipboard?: {
    writeText?: (text: string) => Promise<void>;
  };
};

export function buildMobileMessageCopyText(message: NormalizedRemoteMessage): string {
  const body = message.quotesEncoded
    ? stripChatQuoteMarkerLines(message.body)
    : message.body;
  const parts = [body];
  if (message.secondaryBody) parts.push(message.secondaryBody);
  const attachments = message.attachments?.map((item) => item.name).filter(Boolean) ?? [];
  if (attachments.length > 0) {
    parts.push(i18n.t('message.actions.attachmentsPrefix', { names: attachments.join(', ') }));
  }
  return parts.filter((part) => part.trim().length > 0).join('\n\n');
}

export interface MobileMessageActionBarInput {
  /** 归一化 kind(「user 行渲染系统卡」形态在渲染层已降级为 'system')。 */
  kind: NormalizedRemoteMessage['kind'];
  /** 该行渲染成系统边界卡(agent-switch / auto-resume / goal / slash 命令卡)。 */
  hasSystemCard: boolean;
  /** assistant 消息仍在流式输出。 */
  isStreamingAssistant: boolean;
  /** assistant 消息是本轮收尾正文(messageRenderModel 标注)。 */
  isTurnFinalAssistant: boolean;
}

/**
 * 消息行是否挂完成态操作条(复制 / 时间 / 花费 / More)。三条规则都对齐桌面:
 * - 流式 assistant 只显示「生成中」,不挂完成态操作;
 * - assistant 只有每轮收尾正文挂(桌面 AssistantMessage 的 showActionBar,#456);
 * - 系统边界卡整行不挂:它不是任何人的发言,没有复制 / 分叉 / 消息锚点 / 发送时间
 *   语义(桌面 MessageStream 对 systemCardType 提前 return SystemCard,卡片下方
 *   不存在操作行)。漏掉这条时,手机版跨 Agent 切换的分隔线药丸下会多出一行
 *   「··· 刚刚」。
 */
export function mobileMessageShowsActionBar(input: MobileMessageActionBarInput): boolean {
  if (input.isStreamingAssistant) return false;
  if (input.hasSystemCard) return false;
  return input.kind !== 'assistant' || input.isTurnFinalAssistant;
}

export function buildMobileMessageControlItems(
  input: MobileMessageControlInput,
): MobileMessageControlActionId[] {
  if (input.isStreaming) return [];
  const items: MobileMessageControlActionId[] = [];
  if (input.canCopy) items.push('copy');
  if (input.canRewind) items.push('rewind');
  if (input.canFork) items.push('fork');
  return items;
}

export async function copyMessageText(
  text: string,
  write: (value: string) => Promise<void> = writeClipboardText,
): Promise<CopyMessageStatus> {
  if (!text.trim()) return 'empty';
  try {
    await write(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}

export async function writeClipboardText(text: string): Promise<void> {
  let nativeError: unknown;
  try {
    const clipboard = await import('expo-clipboard');
    if (typeof clipboard.setStringAsync === 'function') {
      await clipboard.setStringAsync(text);
      return;
    }
  } catch (err) {
    nativeError = err;
  }

  const nav = globalThis.navigator as ClipboardNavigator | undefined;
  if (typeof nav?.clipboard?.writeText === 'function') {
    await nav.clipboard.writeText(text);
    return;
  }

  throw nativeError instanceof Error ? nativeError : new Error('Clipboard is unavailable');
}

export function formatMessageRelativeTime(createdAt: string, now = Date.now()): string {
  const timestamp = new Date(createdAt).getTime();
  if (!Number.isFinite(timestamp)) return '';
  const diffMs = Math.max(0, now - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return i18n.t('message.actions.justNow');
  if (diffMs < hour) return i18n.t('message.actions.minutesAgo', { n: Math.floor(diffMs / minute) });
  if (diffMs < day) return i18n.t('message.actions.hoursAgo', { n: Math.floor(diffMs / hour) });

  const date = new Date(timestamp);
  const current = new Date(now);
  const prefix = date.getFullYear() === current.getFullYear()
    ? `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    : `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return `${prefix} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function formatMessageAbsoluteTime(createdAt: string): string {
  const timestamp = new Date(createdAt).getTime();
  if (!Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  return [
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`,
  ].join(' ');
}

export function formatMessageTurnCost(money: RemoteMoney | undefined): string {
  if (!money || !Number.isFinite(money.amount) || money.amount <= 0) return '';
  const value = formatTurnCost(money);
  if (money.kind === 'value-estimate') {
    return i18n.t('message.actions.turnCostValue', { value });
  }
  return value;
}

/**
 * 金额缺席时操作行显示的本轮 token 总量(桌面算不出模型报价的轮次)。
 * 紧凑口径由 @cindy/maker-shared 提供,与桌面同一个函数,同一轮两端读到同一个数。
 */
export function formatMessageTurnTokens(totalTokens: number | undefined): string {
  if (typeof totalTokens !== 'number' || !Number.isFinite(totalTokens) || totalTokens <= 0) {
    return '';
  }
  return i18n.t('message.actions.turnTokens', {
    tokens: formatCompactTokens(Math.floor(totalTokens)),
  });
}

/**
 * raw model id → 短品牌标签(与桌面 renderer/lib/modelShortLabel.ts 同口径的
 * 精简版:去 [1m] / 日期尾缀 / vendor 前缀,Claude 家族折成「Family major.minor」)。
 * 用于模型降级提示行;未知形态兜底原样返回清洗后的 id。
 */
export function formatModelShortLabel(modelId: string | undefined | null): string {
  if (typeof modelId !== 'string') return '';
  let id = modelId.trim();
  if (!id) return '';
  id = id.replace(/\[1m\]$/i, '');
  id = id.replace(/-\d{8}$/, '');
  id = id.replace(/^us\.anthropic\./i, '').replace(/^anthropic\./i, '').replace(/^codex\//i, '');
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/i.exec(id);
  if (claude) {
    const family = claude[1][0].toUpperCase() + claude[1].slice(1).toLowerCase();
    return claude[3] ? `${family} ${claude[2]}.${claude[3]}` : `${family} ${claude[2]}`;
  }
  return id;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatTurnCost(money: RemoteMoney): string {
  const symbol = remoteMoneySymbol(money.currency);
  if (money.amount >= 10) return formatCompactMoney(money);
  if (money.amount >= 0.01) return `${symbol}${money.amount.toFixed(2)}`;
  if (money.amount >= 0.001) return `${symbol}${money.amount.toFixed(3)}`;
  return `<${symbol}0.001`;
}

function formatCompactMoney(money: RemoteMoney): string {
  const symbol = remoteMoneySymbol(money.currency);
  if (money.amount >= 1000) return `${symbol}${(money.amount / 1000).toFixed(1)}k`;
  return `${symbol}${Math.round(money.amount)}`;
}
