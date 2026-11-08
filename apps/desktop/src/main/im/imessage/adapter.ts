import { readBotImConnection } from '../shared/botImConnectionStore';
import { randomUUID } from 'node:crypto';
import { IMESSAGE_GROUP_WINDOW, sanitizeGroupWindowName } from '../shared/channelGroupWindow';
import { captureImContext } from '../../../shared/imMessageSource';
import { createLogger } from '../../logger';
import fs from 'node:fs';
import type { BlueBubblesIM } from '@cindy/im';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';
import type { ImChannelAdapter, ImOrchestratorConfig } from '../shared/types';
import { createImOrchestrator } from '../shared/orchestrator';
import { channelForceConfirmToolCall } from '../shared/channelToolPolicy';
import { handleDingTalkTextInteraction } from '../dingtalk/interaction';
import { ui } from './uiText';

export function wireIMessageOrchestrator(im: BlueBubblesIM, config: ImOrchestratorConfig,
  options: { instanceKey: string; companionBotId: string; connectionId: string }) {
  const textInteractions = new Map<string, { cancelled: boolean }>();
  const adapter: ImChannelAdapter = {
    channel: 'imessage', im, config, ui,
    getBotContextId: () => im.botContextId,
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
    companionLane: userId => im.isGroup(userId) ? { kind: 'group', chatId: userId, threadId: '' }
      : userId === im.getOwnerUserId() ? { kind: 'owner-dm' } : { kind: 'guest-dm', userId },
    channelToolScopeFor: event => ({ channel: 'imessage', im, botId: event.contextId,
      laneUserId: event.senderId, chatId: event.chatId,
      chatKind: im.isGroup(event.chatId) ? 'group' : 'direct',
      requesterIsOwner: event.speaker?.isOwner === true, companion: true }),
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
      return 'skip';
    },
    prepareAgentTurnText: async event => {
      if (!im.isGroup(event.chatId)) return null;
      try {
        await IMESSAGE_GROUP_WINDOW.record({ botId: event.contextId, chatId: event.chatId, threadId: '',
          messageId: event.messageId, chatName: sanitizeGroupWindowName(event.interactionSource?.chatName ?? '') || null,
          author: { name: sanitizeGroupWindowName(event.speaker?.name ?? 'user') },
          text: event.text, fileNames: event.attachments.map(file => file.originalName), sentAt: Date.now() });
        const context = await IMESSAGE_GROUP_WINDOW.buildContextPrefix({ botId: event.contextId,
          chatId: event.chatId, threadId: '', triggerMessageId: event.messageId });
        return { agentText: context.prefix + event.text,
          contextSnapshot: captureImContext({ groupPrefix: context.prefix, groupMessageCount: context.messageCount }),
          commit: async () => { await context.commit(); } };
      } catch {
        createLogger('im:imessage').warn('group input context unavailable');
        return null;
      }
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
      // Only the configured owner can answer permissions, including member-originated turns.
      const target = request.kind === 'permission' ? im.getOwnerUserId() : userId;
      if (!target) return interactionOptions?.sharedPermission?.result
        ?? Promise.resolve({ kind: 'permission', behavior: 'deny', reason: 'imessage_owner_not_connected' });
      const requestKey = JSON.stringify([userId, request.requestId]);
      const interaction = { cancelled: false };
      textInteractions.set(requestKey, interaction);
      try {
        return await handleDingTalkTextInteraction({
          sendText: im.sendText.bind(im),
          requestTextReply: (chatId, prompt, parse, timeoutMs, shared) => {
            if (interaction.cancelled) return Promise.reject(new Error('BLUEBUBBLES_INTERACTION_CANCELLED'));
            return im.requestTextReply(chatId, prompt, parse, timeoutMs, shared, requestKey);
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
