import { ApiError } from '@/lib/httpClient';
import { toast } from '@/lib/toast';
import { forkAtMessage } from '@/lib/sessionService';
import { listMessagesFor } from '@/lib/makerTransport';
import { sessionMessageDisplayText } from '@/lib/sessionMessageText';
import { emitRefresh } from '@/lib/sessionsBus';
import { getSessionDeviceId } from '@/features/device-link/remoteProjectsStore';
import { refreshRemoteDeviceSessions } from '@/features/device-link/refreshRemoteSessions';
import { createLogger } from '@/lib/logger';

const log = createLogger('workLouderCodexTaskActions');

export interface WorkLouderCodexTaskActionHost {
  navigate(path: string): void;
  t(key: string): string;
}

/** Fork the current task at its latest assistant reply, then open the new one. */
export async function forkCurrentTaskFromKeyboard(
  sessionId: string,
  host: WorkLouderCodexTaskActionHost,
): Promise<void> {
  try {
    const messages = await listRecentMessages(sessionId);
    const latestAssistant = messages.find(
      (message) => message.role === 'assistant' && message.clientId,
    );
    if (!latestAssistant?.clientId) {
      toast.error(host.t('chat.userMessage.forkErrors.noPriorAssistant'));
      return;
    }
    const newSession = await forkAtMessage(sessionId, latestAssistant.clientId);
    emitRefresh();
    const deviceId = getSessionDeviceId(sessionId);
    if (deviceId) await refreshRemoteDeviceSessions(deviceId);
    host.navigate(`/cc-agent/${newSession.id}`);
  } catch (error) {
    log.warn('fork from keyboard failed', error);
    toast.error(forkErrorMessage(error, host.t));
  }
}

/** Copy the current task as readable Markdown. */
export async function copyCurrentTaskMarkdown(
  sessionId: string,
  host: WorkLouderCodexTaskActionHost,
): Promise<void> {
  try {
    const messages = [...(await listAllMessagesNewestFirst(sessionId))].reverse();
    const lines = messages.flatMap((message) => {
      const text = sessionMessageDisplayText(message);
      if (!text) return [];
      const heading =
        message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Cindy' : null;
      return heading ? [`## ${heading}`, '', text, ''] : [];
    });
    if (lines.length === 0) {
      toast.warning(host.t('settings.shortcuts.workLouderCodex.commands.copyConversationMarkdown.empty'));
      return;
    }
    await navigator.clipboard.writeText(lines.join('\n').trimEnd());
    toast.success(host.t('settings.shortcuts.workLouderCodex.commands.copyConversationMarkdown.copied'));
  } catch (error) {
    log.warn('copy conversation markdown failed', error);
    toast.error(host.t('settings.shortcuts.workLouderCodex.commands.copyConversationMarkdown.failed'));
  }
}

const MESSAGE_PAGE_LIMIT = 100;

/** Newest-first pages from `listMessagesFor`, walking older with `before`. */
async function listRecentMessages(
  sessionId: string,
): Promise<Awaited<ReturnType<typeof listMessagesFor>>> {
  return listMessagesFor(sessionId, { limit: MESSAGE_PAGE_LIMIT });
}

async function listAllMessagesNewestFirst(
  sessionId: string,
): Promise<Awaited<ReturnType<typeof listMessagesFor>>> {
  const pages: Awaited<ReturnType<typeof listMessagesFor>> = [];
  let cursor: { before?: string; beforeTs?: number } = {};
  for (;;) {
    const page = await listMessagesFor(sessionId, { limit: MESSAGE_PAGE_LIMIT, ...cursor });
    pages.push(...page);
    if (page.length < MESSAGE_PAGE_LIMIT) break;
    const oldest = page[page.length - 1];
    if (!oldest?.id) break;
    const nextBeforeTs = Date.parse(oldest.createdAt);
    cursor = {
      before: oldest.id,
      ...(Number.isFinite(nextBeforeTs) ? { beforeTs: nextBeforeTs } : {}),
    };
  }
  return pages;
}

function forkErrorMessage(error: unknown, t: (key: string) => string): string {
  const code = error instanceof ApiError ? error.code : 'UNKNOWN';
  if (code === 'FORK_UNSUPPORTED_HISTORY') return t('chat.userMessage.forkErrors.unsupportedHistory');
  if (code === 'NO_PRIOR_ASSISTANT') return t('chat.userMessage.forkErrors.noPriorAssistant');
  if (code === 'SOURCE_NEVER_RAN') return t('chat.userMessage.forkErrors.sourceNeverRan');
  return t('chat.userMessage.forkErrors.generic');
}
