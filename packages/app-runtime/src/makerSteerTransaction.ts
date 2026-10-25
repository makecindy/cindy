import { eq } from 'drizzle-orm';
import type { DbClient } from '@cindy/runtime-db';
import { sessions, botSessionLinks, botProfiles } from '@cindy/runtime-db/schema';
import { MAIN_OWNED_SEND_CONTEXT, AUTO_REVIEW_SOURCE_CONTENT, AUTO_REVIEW_USER_INTENT, type MainOwnedSendContext, type Session, type SessionMeta, type UserMessage } from '@cindy/maker-core';
import { AUTO_REVIEW_DELEGATED_CONTINUATION, restoreAutoReviewSteerIntent, type AutoReviewHistoryMessage } from '@cindy/im-runtime/autoReviewUserIntent';
import { REPLY_QUOTE_SOURCE_CONTENT } from '@cindy/maker-shared/chat-reply-quote';
import type { MessageSourceHostDevice } from '@cindy/maker-shared/message-source';
import { throwIpcError } from '@cindy/remote-agent/ipcValidate';
import { prependNoteToWireUserMessage, type HandoffWireMessage } from '@cindy/im-runtime/agentHandoff';
import { noteInteractionRouteSteer } from '@cindy/im-runtime/interactionRouter';
import { buildClientEnvironmentNote, shouldPrependMobileClientPromptNote } from '@cindy/im-runtime/mobileClientPromptNote';
import { buildWireMessageSourceNote, readWireSourceDevice } from '@cindy/im-runtime/messageSourceNote';
import { MCP_APP_MESSAGE_GUARD, type McpAppMessageGuard } from './mcpAppMessage.js';
import { botSessionInputBlockReason } from './botSessionInputGuard.js';
import { SIDE_CHAT_CONTEXT } from './sideChatContext.js';
import { buildUiLanguageErrorNote, turnUiLanguageFromSendOpts } from './uiLanguageErrorNote.js';
import type { createWireNoteMemory } from './wireNoteMemory.js';
import type { MakerSendPlatform } from './makerSendTransaction.js';
import type { DbLogger } from '@cindy/runtime-db/logging';
type IpcUserMessage = UserMessage | string;
export interface MakerSteerHost {
  getDbClient(): DbClient;
  assertReviewExternalInputAllowed(id: string): Promise<void>;
  maker: { getSession(id: string): Session | null | undefined; getSessionMeta(id: string): Promise<SessionMeta | null> };
  log: DbLogger;
  prepareUserMessageForAgent(id: string, value: unknown, mode: 'steer'): Promise<IpcUserMessage>;
  readReplyQuoteNote(id: string, content: string | undefined): Promise<string | null>;
  readAutoReviewHistory(id: string): Promise<AutoReviewHistoryMessage[]>;
  getHostSourceDevice(): MessageSourceHostDevice;
  isMobileControllerInvoke(): boolean;
  isDeviceLinkInvoke(): boolean;
  getResolvedMainLocale: MakerSendPlatform['getResolvedMainLocale'];
  wireNoteMemory: ReturnType<typeof createWireNoteMemory>;
  readSessionSource(id: string): Promise<string | null>;
  mcpAppModelContext: NonNullable<MakerSendPlatform['mcpAppModelContext']>;
  assertRemoteInputClearNotInFlight(id: string, remote: boolean): void;
  readRemoteInputClearBoundaryPrecondition(opts: unknown): { present: false } | { present: true; expected: number | null };
  assertCurrentInputClearBoundary(id: string, expected: number | null): void;
  assertCurrentInputGeneration(id: string, expected: number | undefined): void;
  readExpectedInputGeneration(opts: unknown): number | undefined;
  publishUiSessionIntervention(id: string): void;
}

function summarizeIpcUserMessage(message: IpcUserMessage): Record<string, unknown> {
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

export function createMakerSteerTransaction(host: MakerSteerHost) {
const { getDbClient, assertReviewExternalInputAllowed, maker, log, prepareUserMessageForAgent, readReplyQuoteNote, readAutoReviewHistory, getHostSourceDevice, isMobileControllerInvoke, isDeviceLinkInvoke, getResolvedMainLocale, wireNoteMemory, readSessionSource, mcpAppModelContext, assertRemoteInputClearNotInFlight, readRemoteInputClearBoundaryPrecondition, assertCurrentInputClearBoundary, assertCurrentInputGeneration, readExpectedInputGeneration, publishUiSessionIntervention } = host;
const steerToAgentAccepted = async (
    sessionId: unknown,
    message: unknown,
    sendOpts?: unknown,
  ): Promise<void> => {
    if (typeof sessionId !== 'string') throwIpcError('INVALID_PARAMS', 'sessionId required');
    await assertReviewExternalInputAllowed(sessionId);
    const [botInput] = await getDbClient()
      .drizzle.select({
        source: sessions.source,
        role: botSessionLinks.role,
        profileStatus: botProfiles.status,
      })
      .from(sessions)
      .leftJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
      .leftJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
      .where(eq(sessions.id, sessionId))
      .limit(1);
    const blocked = botSessionInputBlockReason(botInput ?? null);
    if (blocked) throwIpcError('PRECONDITION_FAILED', blocked);
    const so = (sendOpts ?? {}) as {
      messageUuid?: string;
      userName?: string;
      signal?: AbortSignal;
      beforeProviderStart?: () => Promise<void>;
      /** coordinator 从队列项透传的手机来源(main 构造,非 wire 输入)。 */
      fromMobileClient?: boolean;
      uiLanguage?: string;
      /**
       * 消息来源(coordinator 从队列项透传;直连 maker:steer 只有 IPC 边界按 invoke
       * context 盖的 sourceDevice,其余字段的 wire 值已被 stripMainOnlySendOpts 剥掉)。
       * 只用于生成发给模型的说明,不是权限判据。
       */
      sourceDevice?: unknown;
      sourceOrigin?: unknown;
      sourcePlugin?: unknown;
      sharedTaskAuthor?: unknown;
      expectedClearBoundaryMs?: number | null;
      expectedInputGeneration?: number;
      expectedTurnSession?: object;
      expectedTurnGeneration?: number;
      readonly [MAIN_OWNED_SEND_CONTEXT]?: MainOwnedSendContext;
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
    const steerLanguageNote = steerAllowsEnvironmentNotes
      ? buildUiLanguageErrorNote(turnUiLanguageFromSendOpts(so, getResolvedMainLocale()))
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
      const remote = isDeviceLinkInvoke();
      assertRemoteInputClearNotInFlight(sessionId, remote);
      const precondition = readRemoteInputClearBoundaryPrecondition(sendOpts);
      if (precondition.present) {
        assertCurrentInputClearBoundary(sessionId, precondition.expected);
      }
      assertCurrentInputGeneration(sessionId, readExpectedInputGeneration(sendOpts));
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
        [AUTO_REVIEW_SOURCE_CONTENT]: so[AUTO_REVIEW_SOURCE_CONTENT],
        [AUTO_REVIEW_DELEGATED_CONTINUATION]: so[AUTO_REVIEW_DELEGATED_CONTINUATION],
        [AUTO_REVIEW_USER_INTENT]: restoredSteerIntent,
      });
      appContext?.consume();
      steerNotePlan?.commit();
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
return { steerToAgentAccepted };
}
