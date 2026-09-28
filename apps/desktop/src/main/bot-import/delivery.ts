import { object, string, CompanionImportError, type ImportItem, type ImportSource, type ImportedDelivery } from './types.js';
import type { CompanionEnvironment } from './environment.js';

export function importDelivery(source: ImportSource, job: Record<string, unknown>, items: ImportItem[]): { deliveries: ImportedDelivery[]; issues: string[] } {
  const deliveries: ImportedDelivery[] = []; const issues: string[] = [];
  const origin = object(job.origin); const delivery = object(job.delivery);
  const targets: Array<{ channel: string; to: string; thread?: unknown; account?: string }> = [];
  if (source.kind === 'hermes') {
    for (const target of (string(job.deliver) || 'local').split(',').map(value => value.trim())) {
      if (target === 'local') continue;
      if (target === 'origin') targets.push({ channel: string(origin.platform), to: String(origin.chat_id ?? ''), thread: origin.thread_id });
      else { const [channel, ...parts] = target.split(':'); targets.push({ channel: channel!, to: parts.join(':') }); }
    }
  } else if (delivery.mode && delivery.mode !== 'none') {
    targets.push({ channel: string(delivery.channel), to: string(delivery.to), account: string(delivery.accountId), thread: delivery.threadId });
  }
  for (const target of targets) {
    const candidates = items.filter(item => item.credential?.format === 'telegram' && (!target.account || object(item.credential.value).account === target.account));
    // Reachability does not establish which bot the source intended to use.
    const connection = candidates.length === 1 ? candidates[0] : undefined;
    // Resolve only exact Telegram chats; directory aliases need their source adapter.
    const match = /^(?:telegram:)?(?:chat:)?(-?\d+|@[a-zA-Z0-9_]+)(?::(?:topic:)?(\d+))?$/.exec(target.to);
    if (target.channel !== 'telegram' || !connection || !match) { issues.push('DELIVERY_NEEDS_ADAPTER'); continue; }
    const thread = match[2] ?? target.thread;
    if (thread !== undefined && (!Number.isSafeInteger(Number(thread)) || Number(thread) <= 0)) { issues.push('DELIVERY_NEEDS_ADAPTER'); continue; }
    deliveries.push({ connectionId: connection.view.id, chatId: match[1]!, ...(thread === undefined ? {} : { threadId: Number(thread) }) });
  }
  return { deliveries, issues };
}

async function telegram(env: CompanionEnvironment, delivery: ImportedDelivery, method: string, body: Record<string, unknown>, assertOwner: () => void, signal?: AbortSignal) {
  const credential = env.credentials.find(item => item.id === delivery.connectionId && item.format === 'telegram');
  const token = string(object(credential?.value).token);
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new CompanionImportError('DELIVERY_CREDENTIAL_MISSING');
  assertOwner();
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
    const data = object(await response.json()); assertOwner();
    if (!response.ok || data.ok !== true) throw new Error('Delivery failed');
    return object(data.result);
  } catch { throw new CompanionImportError('DELIVERY_FAILED'); }
}

/** Reads the actual destination and bot identity; never sends a test message during migration. */
export async function verifyImportedDelivery(env: CompanionEnvironment, deliveries: ImportedDelivery[], assertOwner: () => void): Promise<void> {
  for (const target of deliveries) {
    const me = await telegram(env, target, 'getMe', {}, assertOwner);
    const chat = await telegram(env, target, 'getChat', { chat_id: target.chatId }, assertOwner);
    if (me.is_bot !== true || !me.id || !chat.id || !chat.type) throw new CompanionImportError('DELIVERY_NOT_VERIFIED');
    if (chat.type !== 'private') {
      const member = await telegram(env, target, 'getChatMember', { chat_id: target.chatId, user_id: me.id }, assertOwner);
      if (!['member', 'administrator', 'creator'].includes(string(member.status)) || chat.type === 'channel' && member.can_post_messages !== true && member.status !== 'creator') throw new CompanionImportError('DELIVERY_NOT_VERIFIED');
    }
  }
}

/** Existing source destination is retained; local routine history remains in the teammate chat. */
export async function sendImportedDelivery(env: CompanionEnvironment, deliveries: ImportedDelivery[], text: string, assertOwner: () => void, signal: AbortSignal,
  progress?: { next: number; acknowledge(next: number): Promise<void> }): Promise<void> {
  const characters = Array.from(text);
  let index = 0;
  for (const target of deliveries) {
    // Plain text avoids treating model output as Telegram HTML; retain all output in bounded messages.
    for (let start = 0; start < characters.length; start += 1750) {
      if (index++ < (progress?.next ?? 0)) continue;
      await telegram(env, target, 'sendMessage', { chat_id: target.chatId, text: characters.slice(start, start + 1750).join(''), ...(target.threadId ? { message_thread_id: target.threadId } : {}) }, assertOwner, signal);
      await progress?.acknowledge(index);
    }
  }
}
