import type { NormalizedRemoteMessage } from '@/session/messageNormalize';
import { stripChatQuoteMarkerLines } from '@cindy/maker-shared/chat-quotes';
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
  return money.kind === 'value-estimate'
    ? i18n.t('message.actions.turnCostValue', { value })
    : value;
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
