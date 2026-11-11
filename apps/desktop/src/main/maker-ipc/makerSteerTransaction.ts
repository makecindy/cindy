import { FORWARDED_REQUEST_RECEIPT, type AgentRequestReceipt } from '../../shared/forwardedRequest.js';
import { MCP_APP_MESSAGE_GUARD, type McpAppMessageGuard } from '../mcp-apps/message.js';
import { AUTO_REVIEW_SOURCE_CONTENT, AUTO_REVIEW_USER_INTENT, MAIN_OWNED_SEND_CONTEXT, ASYNC_QUESTION_ANSWER, SUPERSEDE_ASYNC_QUESTIONS } from '@cindy/maker-core';
import { AUTO_REVIEW_DELEGATED_CONTINUATION, restoreAutoReviewSteerIntent } from './autoReviewUserIntent.js';
import { type MainOwnedSendContext } from '@cindy/maker-core';
import { throwIpcError } from '../utils/ipcValidate.js';
import { noteInteractionRouteSteer } from './interactionRouter.js';
import { isOwnerOwnMessage } from '../input-handoff/ownerMessage.js';
import { prependNoteToWireUserMessage, type HandoffWireMessage } from './agentHandoff.js';
import { REPLY_QUOTE_SOURCE_CONTENT } from './chatReplyQuoteNote.js';
import { isMobileControllerInvoke } from '../device-link/invoke-context.js';
import { buildClientEnvironmentNote, shouldPrependMobileClientPromptNote } from './mobileClientPromptNote.js';
import { buildWireMessageSourceNote, readWireSourceDevice } from './messageSourceNote.js';
import { SIDE_CHAT_CONTEXT } from './sideChatContext.js';
import { buildUiLanguageErrorNote, turnClassicalStyleFromSendOpts, turnUiLanguageFromSendOpts } from './uiLanguageErrorNote.js';

import type { Session } from '@cindy/maker-core';
import type { MakerSendTransactionDeps } from './makerSendTransaction.js';
import type { createWireNoteMemory } from './wireNoteMemory.js';

type IpcUserMessage = string | { type: 'user'; content: string | Array<{ type: string; [k: string]: unknown }> };

/** Launcher-owned IO; the same transaction delivers all accepted steers. */
export interface MakerSteerTransactionDeps {
  maker: {
    getSession(id: string): Session | null | undefined;
    getSessionMeta(id: string): Promise<{ title?: string; parentSessionId?: string | null } | null | undefined>;
  };
  assertInputAllowed(id: string): Promise<void>;
  assertInputCurrent(id: string, options: unknown): void;
  prepareUserMessageForAgent(id: string, message: unknown, mode: 'steer'): Promise<IpcUserMessage>;
  readReplyQuoteNote: typeof import('./chatReplyQuoteNote.js').readReplyQuoteNote;
  readAutoReviewHistory: NonNullable<MakerSendTransactionDeps['readAutoReviewHistory']>;
  readSessionSource(id: string): Promise<string | null>;
  getHostSourceDevice: () => ReturnType<NonNullable<MakerSendTransactionDeps['readHostDeviceIdentity']>> | undefined;
  getResolvedMainLocale: MakerSendTransactionDeps['getResolvedMainLocale'];
  getMainClassicalStyle: MakerSendTransactionDeps['getMainClassicalStyle'];
  wireNoteMemory: Pick<ReturnType<typeof createWireNoteMemory>, 'plan'>;
  inputHandoffSteerNote(id: string, message: unknown): string | null;
  inputHandoffNoteDelivered(id: string): void;
  mcpAppModelContext: MakerSendTransactionDeps['readMcpAppModelContext'];
  publishUiSessionIntervention(id: string): void;
  log: Pick<ReturnType<typeof import('../logger.js').createLogger>, 'info' | 'warn' | 'debug'>;
}

export function createMakerSteerTransaction(deps: MakerSteerTransactionDeps) {
  const { maker, assertInputAllowed, assertInputCurrent, prepareUserMessageForAgent,
    readReplyQuoteNote, readAutoReviewHistory, readSessionSource, getHostSourceDevice,
    getResolvedMainLocale, getMainClassicalStyle, wireNoteMemory, inputHandoffSteerNote,
    inputHandoffNoteDelivered, mcpAppModelContext, publishUiSessionIntervention, log } = deps;
  const steerToAgentAccepted = async (
    sessionId: unknown,
    message: unknown,
    sendOpts?: unknown,
  ): Promise<void> => {
    if (typeof sessionId !== 'string') throwIpcError('INVALID_PARAMS', 'sessionId required');
    await assertInputAllowed(sessionId);
    const so = (sendOpts ?? {}) as {
      messageUuid?: string;
      userName?: string;
      signal?: AbortSignal;
      beforeProviderStart?: () => Promise<void>;
      /** coordinator 从队列项透传的手机来源(main 构造,非 wire 输入)。 */
      fromMobileClient?: boolean;
      uiLanguage?: string;
      classicalStyle?: string;
      /**
       * 消息来源(coordinator 从队列项透传;直连 maker:steer 只有 IPC 边界按 invoke
       * context 盖的 sourceDevice,其余字段的 wire 值已被 stripMainOnlySendOpts 剥掉)。
       * 只用于生成发给模型的说明,不是权限判据。
       */
      sourceDevice?: unknown;
      sourceOrigin?: unknown;
      [FORWARDED_REQUEST_RECEIPT]?: AgentRequestReceipt;
      sourcePlugin?: unknown;
      sharedTaskAuthor?: unknown;
      expectedClearBoundaryMs?: number | null;
      expectedInputGeneration?: number;
      expectedTurnSession?: object;
      expectedTurnGeneration?: number;
      readonly [MAIN_OWNED_SEND_CONTEXT]?: MainOwnedSendContext;
      readonly [ASYNC_QUESTION_ANSWER]?: true;
      readonly [SUPERSEDE_ASYNC_QUESTIONS]?: true;
      readonly [AUTO_REVIEW_SOURCE_CONTENT]?: string;
      readonly [AUTO_REVIEW_DELEGATED_CONTINUATION]?: true;
      readonly [AUTO_REVIEW_USER_INTENT]?: string;
      readonly [MCP_APP_MESSAGE_GUARD]?: McpAppMessageGuard;
      readonly [REPLY_QUOTE_SOURCE_CONTENT]?: string;
    };
    const readCurrentSteerSession = () => {
      const current = maker.getSession(sessionId);
      if (!current) {
        log.warn('steer: session not running', { sessionId });
        throwIpcError('NO_ACTIVE_TURN', `Session ${sessionId} is not running`);
      }
      if (
        (so.expectedTurnSession !== undefined && current !== so.expectedTurnSession) ||
        (so.expectedTurnGeneration !== undefined &&
          current.getTurnGeneration() !== so.expectedTurnGeneration)
      ) {
        throw new Error(`[STALE_TURN] Session ${sessionId} changed turns before steer delivery`);
      }
      return current;
    };
    let sess = readCurrentSteerSession();
    log.info('steer: invoked', {
      sessionId,
      agentKind: sess.agentKind,
      sameTurnSteerSupported: sess.capabilities.sameTurnSteer.supported,
      activeBeforeNormalize: sess.isTurnRunning(),
    });
    if (!sess.capabilities.sameTurnSteer.supported) {
      throwIpcError(
        'UNSUPPORTED_CAPABILITY',
        `Agent ${sess.agentKind} does not support same-turn steer`,
      );
    }
    if (!sess.isTurnRunning()) {
      throwIpcError('NO_ACTIVE_TURN', `Session ${sessionId} has no active turn`);
    }

    let normalized: IpcUserMessage;
    try {
      normalized = await prepareUserMessageForAgent(sessionId, message, 'steer');
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      log.warn('steer: normalize message failed', {
        sessionId,
        agentKind: sess.agentKind,
        error: messageText,
      });
      throwIpcError('INTERNAL', messageText);
    }
    // Attachment normalization can cross async boundaries. Re-check active turn so
    // a just-finished turn does not accidentally accept a stale 插话 request.
    log.debug('steer: normalized message', {
      sessionId,
      agentKind: sess.agentKind,
      activeAfterNormalize: sess.isTurnRunning(),
      ...summarizeIpcUserMessage(normalized),
    });
    sess = readCurrentSteerSession();
    if (!sess.isTurnRunning()) {
      throwIpcError('NO_ACTIVE_TURN', `Session ${sessionId} has no active turn`);
    }
    // Same `[引用说明]` as an ordinary send (steer does not go through the send transaction).
    const steerReplyQuoteNote = shouldPrependMobileClientPromptNote(normalized, sess.agentKind)
      ? ((await readReplyQuoteNote(sessionId, so[REPLY_QUOTE_SOURCE_CONTENT]).catch(() => null)) ?? null)
      : null;
    const meta = await maker.getSessionMeta(sessionId).catch(() => null);
    sess = readCurrentSteerSession();
    const authorizationSession = sess;
    const authorizationTurn = sess.getTurnGeneration();
    const restoredSteerIntent = await restoreAutoReviewSteerIntent(
      typeof normalized === 'string' ? normalized : normalized.content,
      so,
      () => readAutoReviewHistory(sessionId),
    );
    sess = readCurrentSteerSession();
    if (sess !== authorizationSession || sess.getTurnGeneration() !== authorizationTurn) {
      throw new Error(`[STALE_TURN] Session ${sessionId} changed turns while restoring authorization`);
    }
    // 来源说明与客户端说明同样只进 wire payload(steer 路径的落库由 coordinator 写原话,
    // 天然不污染原话)。steer 不经 send 事务,两段说明只在这里加一次。
    const steerSourceNote = shouldPrependMobileClientPromptNote(normalized, sess.agentKind)
      ? buildWireMessageSourceNote({
          origin: so.sourceOrigin,
          autoReviewUserText: so[FORWARDED_REQUEST_RECEIPT],
          sourcePlugin: so.sourcePlugin,
          sharedTaskAuthor: so.sharedTaskAuthor,
        })
      : null;
    const withSteerReplyQuoteNote = steerReplyQuoteNote
      ? prependNoteToWireUserMessage(normalized as HandoffWireMessage, steerReplyQuoteNote)
      : normalized;
    const withSteerSourceNote = steerSourceNote
      ? prependNoteToWireUserMessage(withSteerReplyQuoteNote as HandoffWireMessage, steerSourceNote)
      : withSteerReplyQuoteNote;
    // 设备来源只认盖章值(coordinator 透传 / 直连 IPC 边界按 async context 盖);没有设备
    // 信息时沿用旧手机判据:IPC 直连 steer 时 async context 在;coordinator 投递时靠透传。
    const steerDevice = readWireSourceDevice(so.sourceDevice);
    const steerAllowsEnvironmentNotes = shouldPrependMobileClientPromptNote(normalized, sess.agentKind);
    const steerNote = steerAllowsEnvironmentNotes
      ? buildClientEnvironmentNote({
          device: steerDevice,
          host: steerDevice ? getHostSourceDevice() : undefined,
          legacyMobile: isMobileControllerInvoke() || so.fromMobileClient === true,
        })
      : null;
    const steerLanguage = steerAllowsEnvironmentNotes ? turnUiLanguageFromSendOpts(so, getResolvedMainLocale()) : null;
    const steerLanguageNote = steerLanguage
      ? buildUiLanguageErrorNote(steerLanguage, {
          classicalStyle: turnClassicalStyleFromSendOpts(so, getMainClassicalStyle()),
        })
      : null;
    // 环境说明与 send 事务共用同一份去重记忆:插话进的是同一个原生上下文。
    const steerNotePlan = steerAllowsEnvironmentNotes
      ? wireNoteMemory.plan(sessionId, {
          'client-environment': steerNote,
          'ui-language': steerLanguageNote,
          'side-chat': meta?.parentSessionId && (await readSessionSource(sessionId)) === 'side-chat' ? SIDE_CHAT_CONTEXT : null,
        }, { force: false })
      : null;
    const steerPlannedNotes = steerNotePlan?.notes ?? {};
    const withSteerNote = steerPlannedNotes['client-environment']
      ? prependNoteToWireUserMessage(withSteerSourceNote as HandoffWireMessage, steerPlannedNotes['client-environment'])
      : withSteerSourceNote;
    let steerPayload = steerPlannedNotes['ui-language']
      ? prependNoteToWireUserMessage(withSteerNote as HandoffWireMessage, steerPlannedNotes['ui-language'])
      : withSteerNote;
    // The owner's message closed a waiting 代输入 card: tell the agent, on this message only.
    // Same owner test as the queue's: this runs outside the context that told a guest apart at enqueue.
    const pendingHandoffNote = isOwnerOwnMessage({
      sharedTaskAuthor: so.sharedTaskAuthor,
      sourcePlugin: so.sourcePlugin,
      appMessageGuard: so[MCP_APP_MESSAGE_GUARD],
    })
      ? inputHandoffSteerNote(sessionId, message)
      : null;
    // A native command keeps its first characters: it carries no note, and the note is dropped, not kept for later.
    const steerHandoffNote = pendingHandoffNote && shouldPrependMobileClientPromptNote(normalized, sess.agentKind) ? pendingHandoffNote : null;
    if (pendingHandoffNote && !steerHandoffNote) inputHandoffNoteDelivered(sessionId);
    if (steerHandoffNote) {
      steerPayload = prependNoteToWireUserMessage(steerPayload as HandoffWireMessage, steerHandoffNote);
    }
    if (steerPlannedNotes['side-chat']) {
      steerPayload = prependNoteToWireUserMessage(steerPayload as HandoffWireMessage, steerPlannedNotes['side-chat']);
    }
    const appContext = shouldPrependMobileClientPromptNote(normalized, sess.agentKind)
      ? await mcpAppModelContext(sessionId)
      : undefined;
    if (appContext?.text) {
      steerPayload = prependNoteToWireUserMessage(steerPayload as HandoffWireMessage, appContext.text);
    }
    try {
      assertInputCurrent(sessionId, sendOpts);
      if (so[MCP_APP_MESSAGE_GUARD]) await so[MCP_APP_MESSAGE_GUARD]!();
      await so.beforeProviderStart?.();
      sess = readCurrentSteerSession();
      // 同轮插话也属于新输入。必须在 vendor await 前通知，旧轮可能先于 steer ack 结束。
      // 共用入口同时覆盖 INPUT_STEER、队列提升和旧 STEER IPC。
      publishUiSessionIntervention(sessionId);
      // A channel route vouches only for its triggering sender; steered input ends that.
      noteInteractionRouteSteer(sess);
      await sess.steer(steerPayload as never, {
        ...(so[MCP_APP_MESSAGE_GUARD] || so.beforeProviderStart || appContext?.text ? {
          beforeProviderStart: async () => {
            await so[MCP_APP_MESSAGE_GUARD]?.();
            await appContext?.assertCurrent();
            await so.beforeProviderStart?.();
          },
        } : {}),
        logTitle: meta?.title,
        messageUuid: so.messageUuid,
        userName: so.userName,
        signal: so.signal,
        [MAIN_OWNED_SEND_CONTEXT]: so[MAIN_OWNED_SEND_CONTEXT],
        [ASYNC_QUESTION_ANSWER]: so[ASYNC_QUESTION_ANSWER],
        [SUPERSEDE_ASYNC_QUESTIONS]: so[SUPERSEDE_ASYNC_QUESTIONS],
        [AUTO_REVIEW_SOURCE_CONTENT]: so[AUTO_REVIEW_SOURCE_CONTENT],
        [AUTO_REVIEW_DELEGATED_CONTINUATION]: so[AUTO_REVIEW_DELEGATED_CONTINUATION],
        [AUTO_REVIEW_USER_INTENT]: restoredSteerIntent,
      });
      appContext?.consume();
      steerNotePlan?.commit();
      if (steerHandoffNote) inputHandoffNoteDelivered(sessionId);
      log.info('steer: delivered', { sessionId, agentKind: sess.agentKind });
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      const isClosedDeliveryFailure =
        /session (?:is )?closed|closed session|input queue is closed/i.test(messageText);
      if (!isClosedDeliveryFailure && /no active .*turn|has no active turn/i.test(messageText)) {
        log.warn('steer: no active turn during delivery', {
          sessionId,
          agentKind: sess.agentKind,
          error: messageText,
        });
        throwIpcError('NO_ACTIVE_TURN', `Session ${sessionId} has no active turn`);
      }
      log.warn('steer: delivery failed', {
        sessionId,
        agentKind: sess.agentKind,
        error: messageText,
      });
      throwIpcError('INTERNAL', messageText);
    }
  };
  return steerToAgentAccepted;
}

export function summarizeIpcUserMessage(message: IpcUserMessage): Record<string, unknown> {
  if (typeof message === 'string') {
    return { contentType: 'string', textLen: message.length };
  }
  const content = message.content;
  if (typeof content === 'string') {
    return { contentType: 'string', textLen: content.length };
  }
  let textLen = 0;
  let imageCount = 0;
  let fileCount = 0;
  let mentionCount = 0;
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') textLen += block.text.length;
    else if (block.type === 'image') imageCount += 1;
    else if (block.type === 'file') fileCount += 1;
    else if (block.type === 'mention') mentionCount += 1;
  }
  return {
    contentType: 'blocks',
    blockCount: content.length,
    textLen,
    imageCount,
    fileCount,
    mentionCount,
  };
}
