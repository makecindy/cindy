/**
 * 「调整性格」之后，TA 自己回一句 —— 改完口气总得听见新口气。
 *
 * 机制与入伙打招呼(botWelcome.ts)同源，刻意复用同一套形状：
 *
 *  - 落成主任务里一条**真的** assistant 行(`localDb.messages.create`)，不是
 *    renderer 里的临时提示。刷新还在、侧栏预览看得到、读起来跟后面每一句一样。
 *  - 不花模型回合。文案是模板文案，直接写行既便宜又确定。
 *  - 「保存」发生在设置页，「落地」发生在对话页，中间隔着一次导航，所以先把这条
 *    待发的确认寄存在 localStorage，对话页打开时再消费。
 *
 * 与打招呼的**唯一**区别：打招呼要求任务还是空的(不能插进已经开始的对话)，
 * 确认消息恰恰相反 —— 它本来就发生在一段已有的对话里。所以幂等只靠
 * `clientId`：`createMessage` 对 `(sessionId, clientId)` 幂等，clientId 里带上
 * 这次人格选择的指纹，因此
 *   - 同一次调整重复投递(两个窗口、返回再进) → 只会有一行；
 *   - 改成别的性格再调一次 → 指纹变了，会有新的一行(这是对的，口气又变了)；
 *   - 调回上一次调过的性格 → 指纹撞回旧值，不会再重复说一遍同样的话。
 */

import type { PersonaSelection } from './botPersona';

const PENDING_PERSONA_ACK_KEY = 'cindy.bots.pendingPersonaAck.v1';

/**
 * 人格选择的稳定指纹。用选择本身而不是自增版本号：它可离线计算、跨窗口一致，
 * 且天然满足「调回旧选择不再重复说」。
 */
export function personaFingerprint(selection: PersonaSelection): string {
  const call =
    selection.call === 'custom' ? `custom:${(selection.customCall ?? '').trim()}` : selection.call;
  return `${selection.style}.${selection.proactivity}.${call}`;
}

/** `role: 'assistant'` 行 id。确定性 —— 并发写入不会写出两行。 */
export function personaAckClientId(botId: string, selection: PersonaSelection): string {
  return `persona-ack:${botId}:${personaFingerprint(selection)}`;
}

type PendingAckMap = Record<string, PersonaSelection>;

function isSelection(value: unknown): value is PersonaSelection {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.style === 'string' &&
    typeof record.proactivity === 'string' &&
    typeof record.call === 'string'
  );
}

function readPending(): PendingAckMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(PENDING_PERSONA_ACK_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: PendingAckMap = {};
    for (const [botId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isSelection(value)) out[botId] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writePending(next: PendingAckMap): void {
  if (typeof window === 'undefined') return;
  try {
    if (Object.keys(next).length === 0) {
      window.localStorage.removeItem(PENDING_PERSONA_ACK_KEY);
      return;
    }
    window.localStorage.setItem(PENDING_PERSONA_ACK_KEY, JSON.stringify(next));
  } catch {
    // 存储不可用 —— 这一句是锦上添花，永远不能挡住保存。
  }
}

/**
 * 人格**确实变了**才寄存。没变就不寄存 —— 打开向导又原样关掉，
 * TA 不该无端冒出来说一句「以后就这么说话」。
 */
export function rememberPendingBotPersonaAck(
  botId: string,
  previous: PersonaSelection | null,
  next: PersonaSelection,
): boolean {
  if (!botId) return false;
  if (previous && personaFingerprint(previous) === personaFingerprint(next)) return false;
  writePending({ ...readPending(), [botId]: next });
  return true;
}

export function peekPendingBotPersonaAck(botId: string): PersonaSelection | null {
  return readPending()[botId] ?? null;
}

export function clearPendingBotPersonaAck(botId: string): void {
  const current = readPending();
  if (!(botId in current)) return;
  delete current[botId];
  writePending(current);
}

/** 测试缝：不用直接戳 localStorage。 */
export function resetPendingBotPersonaAckForTests(): void {
  writePending({});
}

/**
 * 这次确认该说哪一句。
 *
 * 说话风格三档各一条；称呼选了「老板 / 自定义」时换成带称呼的那条，让新口气在
 * 这一句里就已经生效 —— 用户读到的第一句就是改完之后的 TA。
 */
export function botPersonaAckCopy(selection: PersonaSelection): {
  key: string;
  params?: Record<string, string>;
} {
  const called =
    selection.call === 'boss'
      ? 'boss'
      : selection.call === 'custom' && (selection.customCall ?? '').trim()
        ? (selection.customCall ?? '').trim()
        : null;
  if (called === null) return { key: `bots.persona.ack.${selection.style}` };
  if (called === 'boss') return { key: `bots.persona.ack.${selection.style}Boss` };
  return { key: `bots.persona.ack.${selection.style}Called`, params: { call: called } };
}

export interface BotPersonaAckMessageBody {
  clientId: string;
  role: 'assistant';
  content: string;
}

export interface DeliverBotPersonaAckDeps {
  createMessage: (sessionId: string, body: BotPersonaAckMessageBody) => Promise<unknown>;
  translate: (key: string, params?: Record<string, string>) => string;
}

/**
 * 把寄存的确认消息投进 `sessionId`。
 *
 * 返回 true 只在这次调用真的写了行时 —— 「第二次打开什么都不做」这条契约要显式。
 */
export async function deliverPendingBotPersonaAck(
  botId: string,
  sessionId: string,
  deps: DeliverBotPersonaAckDeps,
): Promise<boolean> {
  const selection = peekPendingBotPersonaAck(botId);
  if (!selection) return false;
  const copy = botPersonaAckCopy(selection);
  const text = deps.translate(copy.key, copy.params).trim();
  if (!text || text === copy.key) {
    // 文案缺条目时绝不把 raw key 写进对话。
    clearPendingBotPersonaAck(botId);
    return false;
  }
  try {
    await deps.createMessage(sessionId, {
      clientId: personaAckClientId(botId, selection),
      role: 'assistant',
      content: text,
    });
  } catch {
    // 写失败就把它留在寄存处，下次打开再试。
    return false;
  }
  clearPendingBotPersonaAck(botId);
  return true;
}
