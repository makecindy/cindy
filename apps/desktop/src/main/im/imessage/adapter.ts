import { companionLaneRouteKey } from '../shared/imBotBindingRoute';
import { readBotImConnection } from '../shared/botImConnectionStore';
import { createHash, randomUUID } from 'node:crypto';
import { IMESSAGE_GROUP_WINDOW, sanitizeGroupWindowName } from '../shared/channelGroupWindow';
import { receivedHistoryScope, recordReceivedImageMessage } from '../shared/receivedImageHistory';
import { buildImReplyContextBlock, buildHistoryMediaNote } from '../shared/replyContext';
import { captureImContext } from '../../../shared/imMessageSource';
import { createLogger } from '../../logger';
import fs from 'node:fs';
import type { BlueBubblesIM } from '@cindy/im';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';
import type { ImChannelAdapter, ImOrchestratorConfig } from '../shared/types';
import { createImOrchestrator } from '../shared/orchestrator';
import { channelForceConfirmToolCall } from '../shared/channelToolPolicy';
import { handleDingTalkTextInteraction } from '../dingtalk/interaction';
import { archiveDirectory, readArchive } from './archive';
import { ui } from './uiText';

export function wireIMessageOrchestrator(im: BlueBubblesIM, config: ImOrchestratorConfig,
  options: { instanceKey: string; companionBotId: string; connectionId: string }) {
  const textInteractions = new Map<string, { cancelled: boolean }>();
  const companionLane: NonNullable<ImChannelAdapter['companionLane']> = userId => im.isGroup(userId)
    ? { kind: 'group', chatId: userId, threadId: '' }
    : userId === im.getOwnerUserId() ? { kind: 'owner-dm' } : { kind: 'guest-dm', userId };
  function historyScope(event: { contextId: string; chatId: string }) {
    const origin = im.connectedOrigin;
    if (!origin) return undefined;
    const serverId = createHash('sha256').update(origin).digest('hex');
    return receivedHistoryScope('imessage', `${event.contextId}:${serverId}`, event.chatId);
  }
  const adapter: ImChannelAdapter = {
    channel: 'imessage', im, config, ui,
    getBotContextId: () => im.botContextId,
    scheduledNotificationText(text) {
      const value = text.trim();
      if (value === '[SILENT]') return null;
      if (!value.startsWith('<heartbeat>')) return undefined;
      // Codex emits raw message text, including URLs and literal angle brackets.
      const envelope = /^<heartbeat>\s*<automation_id>[^<>]+<\/automation_id>\s*<decision>(NOTIFY|SILENT|DONT_NOTIFY)<\/decision>\s*(?:<message>([\s\S]*)<\/message>\s*)?<\/heartbeat>$/.exec(value);
      if (!envelope || (envelope[1] === 'NOTIFY' && !envelope[2]?.trim())) {
        throw new Error('IMESSAGE_INVALID_HEARTBEAT_NOTIFICATION');
      }
      return envelope[1] === 'NOTIFY' ? envelope[2].trim() : null;
    },
    processingEmoji: '', silentQueue: true,
    output: { kind: 'chunked-text', im, commitFinal: async output => {
      await im.commitFinal(output);
      if (!im.isGroup(output.userId) || output.terminal === 'error' || !output.text.trim()) return;
      await IMESSAGE_GROUP_WINDOW.record({ botId: im.botContextId, chatId: output.userId, threadId: '',
        messageId: `out:${randomUUID()}`, chatName: null, author: { name: 'bot', isBot: true },
        text: output.text, sentAt: Date.now() }).catch(() => createLogger('im:imessage').warn('group output context unavailable'));
    } },
    sessions: {
      source: 'imessage', workspaceKind: 'dialogue',
      sessionIdFor: (contextId, userId) => `imessage_${contextId}_${Buffer.from(userId).toString('base64url')}`,
      defaultTitle: userId => `iMessage · ${userId.slice(-6)}`,
      generatedTitlePrefix: 'iMessage · ',
      ensureWorkingDir: contextId => {
        const dir = ownerScopedImUserDataPath('im-working-dir', `imessage-${contextId}`);
        fs.mkdirSync(dir, { recursive: true }); return dir;
      },
      extraInsertColumns: (imBotContextId, imUserId) => ({ imBotContextId, imUserId }),
    },
    buildVendorOptions: userId => ({ imessageChatId: userId, source: 'imessage' }),
    companionLane,
    groupHistoryAccessFor: historyScope,
    connectedChatForLane(botId, routeKey) {
      if (botId !== options.companionBotId) return undefined;
      return im.listChats().find(chat => {
        const lane = companionLane(chat.guid);
        return lane.kind !== 'owner-dm' && companionLaneRouteKey('imessage', im.botContextId, lane) === routeKey;
      })?.guid;
    },
    channelToolScopeFor: event => {
      const origin = im.connectedOrigin;
      const directory = origin && archiveDirectory(options.connectionId, origin);
      return { channel: 'imessage', im, botId: event.contextId,
      laneUserId: event.senderId, chatId: event.chatId,
      readArchive: directory ? (query, before, limit) => readArchive(directory, event.chatId, query, before, limit) : undefined,
      chatKind: im.isGroup(event.chatId) ? 'group' : 'direct',
      requesterIsOwner: event.speaker?.isOwner === true, companion: true };
    },
    channelNoteSourceFor: event => ({
      toolsHint: 'iMessage via local BlueBubbles. cindy_imessage tools provide connected chat history, immediate text/file sending and connection health. Normal final replies are delivered automatically.',
      chatKind: im.isGroup(event.chatId) ? 'group' : 'direct', chatId: event.chatId,
      chatName: event.interactionSource?.chatName, senderId: event.speaker?.id,
      senderName: event.speaker?.name, senderIsOwner: event.speaker?.isOwner === true,
    }),
    ambientTurnGate: async event => {
      if (readBotImConnection(options.connectionId)?.groupActivation?.[event.chatId] === 'always') return 'proceed';
      // Preserve uninvoked group messages as context without invoking the model.
      await IMESSAGE_GROUP_WINDOW.record({ botId: event.contextId, chatId: event.chatId, threadId: '',
        messageId: event.messageId, chatName: sanitizeGroupWindowName(event.interactionSource?.chatName ?? '') || null,
        author: { name: sanitizeGroupWindowName(event.speaker?.name ?? 'user') }, text: event.text,
        fileNames: event.attachments.map(file => file.originalName), sentAt: Date.now() }).catch(() => createLogger('im:imessage').warn('ambient context unavailable'));
      // Skipped inputs never reach the shared message handler's image index.
      const scope = historyScope(event);
      if (scope) await recordReceivedImageMessage({
        scope, messageId: event.messageId, text: event.text, attachments: event.attachments,
        author: event.speaker?.name, chatName: event.interactionSource?.chatName,
      }).catch(() => createLogger('im:imessage').warn('ambient image indexing unavailable'));
      return 'skip';
    },
    prepareAgentTurnText: async event => {
      const group = im.isGroup(event.chatId);
      if (!group && !event.imessageReplyGuid) return null;
      const context = group ? await (async () => {
        await IMESSAGE_GROUP_WINDOW.record({ botId: event.contextId, chatId: event.chatId, threadId: '',
          messageId: event.messageId, chatName: sanitizeGroupWindowName(event.interactionSource?.chatName ?? '') || null,
          author: { name: sanitizeGroupWindowName(event.speaker?.name ?? 'user') },
          text: event.text, fileNames: event.attachments.map(file => file.originalName), sentAt: Date.now() });
        return IMESSAGE_GROUP_WINDOW.buildContextPrefix({ botId: event.contextId,
          chatId: event.chatId, threadId: '', triggerMessageId: event.messageId, replyMessageId: event.imessageReplyGuid });
      })().catch(() => { createLogger('im:imessage').warn('group input context unavailable'); return null; }) : null;
      const media = await im.contextMedia(event, event.ambient ? [] : context?.attachmentMessageIds ?? []);
      const replyBlock = media.reply ? buildImReplyContextBlock(media.reply) : '';
      const note = buildHistoryMediaNote({ provided: media.providedBy, unavailable: media.unavailable, directReply: !group });
      return { agentText: (context?.prefix ?? '') + replyBlock + note.modelText + event.text,
        contextSnapshot: captureImContext({ groupPrefix: [context?.prefix, note.displayText].filter(Boolean).join('\n'), groupMessageCount: context?.messageCount,
          replyPrefix: replyBlock, replyMessageCount: media.reply ? 1 : 0 }),
        ...(media.reply ? { replyContext: media.reply } : {}),
        contextAttachments: media.attachments,
        ...(context ? { commit: async () => { await context.commit(); } } : {}) };
    },
    turnPermissionPolicyFor: event => event.speaker?.isOwner ? undefined : {
      origin: { kind: 'im', channel: 'imessage', taskId: event.messageId },
      autoReviewContext: { requesterAuthority: 'guest', source: im.isGroup(event.chatId) ? 'group' : 'direct' },
      confirmationSurface: 'desktop',
      confirmationTimeoutMs: 30 * 60_000,
      forceConfirmToolCall: channelForceConfirmToolCall,
    },
    // Full access is the owner's explicit authorization for this teammate,
    // including guest-originated turns; other modes retain their turn policy.
    turnPolicyOptionalForMode: mode => mode === 'bypassPermissions',
    onUserMessagePersisted: async ({ userMessageId, persisted }) => {
      if (persisted && userMessageId) im.acknowledgeIncoming(userMessageId);
    },
    handleTextInteraction: async (userId, request, interactionOptions) => {
      const audience = request.kind === 'ask_user_question' ? 'chat' : 'owner';
      const target = audience === 'owner' ? im.getOwnerUserId() : userId;
      if (!target) {
        const reason = 'imessage_owner_not_connected';
        if (request.kind === 'plan_review') return { kind: 'plan_review', behavior: 'deny', dismissed: true, reason };
        if (request.kind === 'ask_user_question') return { kind: 'ask_user_question', answers: {}, dismissed: true };
        return interactionOptions?.sharedPermission?.result ?? { kind: 'permission', behavior: 'deny', reason };
      }
      const requestKey = JSON.stringify([userId, request.requestId]);
      const interaction = { cancelled: false };
      textInteractions.set(requestKey, interaction);
      try {
        return await handleDingTalkTextInteraction({
          sendText: im.sendText.bind(im),
          requestTextReply: (chatId, prompt, parse, timeoutMs, shared) => {
            if (interaction.cancelled) return Promise.reject(new Error('BLUEBUBBLES_INTERACTION_CANCELLED'));
            return im.requestTextReply(chatId, prompt, parse, timeoutMs, shared, requestKey, audience);
          },
        }, target, request, interactionOptions);
      } finally {
        if (textInteractions.get(requestKey) === interaction) textInteractions.delete(requestKey);
      }
    },
    cancelTextInteraction: (userId, requestId) => {
      const requestKey = JSON.stringify([userId, requestId]);
      const interaction = textInteractions.get(requestKey);
      if (interaction) interaction.cancelled = true;
      im.cancelTextReply(requestKey);
      // Cleanup does not decide the question: preserve the central router's cancellation result.
      return false;
    },
  };
  return createImOrchestrator(adapter, options);
}
