import { and, eq, or } from 'drizzle-orm';
import { isAnsweredAsyncQuestionClientId } from '@cindy/maker-shared/interaction';
import { UI_ACTION_TRIGGER_PREFIX } from '../../shared/interruptedTurn.js';
import { richAnswerText } from '@cindy/maker-shared/rich-answer';
import { chatReplyQuoteExcerpt, type ChatReplyQuote } from '../../shared/chatReplyQuote.js';
import { getDbClient } from '../localDb/client/current.js';
import { messages } from '../localDb/schema.js';
import { getMakerIfReady } from '../maker-host/index.js';
import { resolveHelperSurface } from '../mcp-integrations/helperSurface.js';
import { setSelectedReplyQuote } from './selectedReplyQuote.js';

export async function selectReplyQuote(
  context: { sessionId?: string; sessionInstanceId?: string; mcpCallerKind?: string },
  messageId: string | null,
) {
  const fail = (errorCode: string, message: string) => ({ ok: false as const, errorCode, message });
  if (context.mcpCallerKind === 'descendant') return fail('NOT_SUPPORTED', '子代理不能选择主对话的引用。');
  const session = context.sessionId ? getMakerIfReady()?.getSession(context.sessionId) : undefined;
  if (!session || session.instanceId !== context.sessionInstanceId || !session.isTurnRunning()) {
    return fail('NO_ACTIVE_TURN', '当前任务没有可选择引用的活动回复。');
  }
  const generation = session.getTurnGeneration();
  const db = getDbClient();
  if (await resolveHelperSurface(db, session.id) !== 'bot-main') {
    return fail('NOT_SUPPORTED', '当前入口不是伙伴私聊；群聊和外部消息平台请使用各自的回复工具。');
  }
  let quote: ChatReplyQuote | null = null;
  if (messageId !== null) {
    const [row] = await db.drizzle.select().from(messages).where(and(
      eq(messages.sessionId, session.id), or(eq(messages.id, messageId), eq(messages.clientId, messageId)),
    )).limit(1);
    if (!row || row.rewindAt !== null || (row.role !== 'user' && row.role !== 'assistant')) {
      return fail('NOT_FOUND', '引用目标必须是当前任务里未撤回的用户或伙伴消息。');
    }
    let content: unknown = row.content;
    let meta: Record<string, unknown> = {};
    try { content = JSON.parse(row.content); } catch { /* Legacy plain text. */ }
    try { meta = JSON.parse(row.agentMeta ?? '{}') ?? {}; } catch { /* Legacy empty metadata. */ }
    const envelope = content && typeof content === 'object' ? content as Record<string, unknown> : null;
    if (meta.botPrivateReply || meta.botGroupLane || meta.origin || meta.hookSource
      || isAnsweredAsyncQuestionClientId(row.clientId) || envelope?.isSyntheticTrigger
      || envelope?.automationOrigin || envelope?.hookSource) {
      return fail('NOT_FOUND', '内部触发和渠道消息不能作为私聊引用。');
    }
    const text = typeof content === 'string' ? content : typeof envelope?.text === 'string' ? envelope.text : '';
    if (text.startsWith(UI_ACTION_TRIGGER_PREFIX)) return fail('NOT_FOUND', '内部触发不能作为私聊引用。');
    const attachments = [
      ...(Array.isArray(envelope?.images) ? envelope.images : []),
      ...(Array.isArray(envelope?.files) ? envelope.files : []),
    ];
    const attachmentName = attachments.map(item => item?.originalName ?? item?.name).find(name => typeof name === 'string');
    quote = {
      clientId: row.clientId,
      role: row.role as 'user' | 'assistant',
      excerpt: chatReplyQuoteExcerpt((row.role === 'assistant' ? richAnswerText(text) : text) || attachmentName || ''),
    };
  }
  if (getMakerIfReady()?.getSession(session.id) !== session || session.getTurnGeneration() !== generation || !session.isTurnRunning()) {
    return fail('TURN_CHANGED', '回复已结束或切换，请在当前回复中重新选择引用。');
  }
  setSelectedReplyQuote(session, quote);
  return { ok: true as const };
}
