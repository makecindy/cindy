import type {
  AgentEvent,
  SessionStatus,
  SessionSendOptions,
  SessionSendResult,
  UserMessage,
} from '@cindy/maker-core';
import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import { isTurnContinuationBoundaryEvent } from '@cindy/maker-shared/turn-continuation';

import type { ReviewAttachmentInput } from '../reviewer/reviewEvidence.js';
import {
  isStaleReviewFailureCode,
  type ReviewFailureCode,
  type ReviewRunMeta,
  type ReviewRunOwner,
  type ReviewTargetKind,
} from '../../shared/reviewRun.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';
import { isTerminalTurnErrorEvent } from './sessionTurnActivityTracker.js';
import type { MakerSessionCreateOpts } from './sessionRequest.js';

export interface StartReviewRequest {
  sourceSessionId: string;
  focus?: string;
  attachments: ReviewAttachmentInput[];
}

export const REVIEW_START_REQUEST_LIMITS = {
  sourceSessionIdChars: 512,
  focusChars: 4_000,
  attachmentCount: 20,
  attachmentBase64Chars: 32 * 1024 * 1024,
  totalBase64Chars: 64 * 1024 * 1024,
  attachmentMetadataChars: {
    name: 4_096,
    path: 32 * 1024,
    url: 64 * 1024,
    category: 32,
    mimeType: 1_024,
    originalName: 4_096,
  },
  totalAttachmentMetadataChars: 256 * 1024,
} as const;

export function readStartReviewRequest(value: unknown): StartReviewRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throwIpcError('INVALID_PARAMS', 'review request must be an object');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.sourceSessionId !== 'string' ||
    record.sourceSessionId.length > REVIEW_START_REQUEST_LIMITS.sourceSessionIdChars ||
    !record.sourceSessionId.trim()
  ) {
    throwIpcError('INVALID_PARAMS', 'sourceSessionId required');
  }
  let focus = '';
  if (typeof record.focus === 'string') {
    if (record.focus.length > REVIEW_START_REQUEST_LIMITS.focusChars) {
      throwIpcError('INVALID_PARAMS', 'review focus is too long');
    }
    focus = record.focus.trim();
  }
  const rawAttachments = record.attachments ?? [];
  if (
    !Array.isArray(rawAttachments) ||
    rawAttachments.length > REVIEW_START_REQUEST_LIMITS.attachmentCount
  ) {
    throwIpcError('INVALID_PARAMS', 'review attachments must be an array of at most 20 files');
  }
  let totalBase64Chars = 0;
  let totalMetadataChars = 0;
  const attachments: ReviewAttachmentInput[] = rawAttachments.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throwIpcError('INVALID_PARAMS', `review attachment ${index} must be an object`);
    }
    const attachment = item as Record<string, unknown>;
    const readMetadata = (
      field: keyof typeof REVIEW_START_REQUEST_LIMITS.attachmentMetadataChars,
    ): string | undefined => {
      const raw = attachment[field];
      if (typeof raw !== 'string' || !raw) return undefined;
      if (raw.length > REVIEW_START_REQUEST_LIMITS.attachmentMetadataChars[field]) {
        throwIpcError(
          'INVALID_PARAMS',
          `review attachment ${index} ${field} is too long`,
        );
      }
      totalMetadataChars += raw.length;
      if (totalMetadataChars > REVIEW_START_REQUEST_LIMITS.totalAttachmentMetadataChars) {
        throwIpcError('INVALID_PARAMS', 'review attachment metadata is too large in total');
      }
      return raw;
    };
    const rawName = readMetadata('name');
    const name = rawName?.trim() || `attachment-${index + 1}`;
    const attachmentPath = readMetadata('path');
    const url = readMetadata('url');
    const category = readMetadata('category');
    const mimeType = readMetadata('mimeType');
    const originalName = readMetadata('originalName');
    const base64 = typeof attachment.base64 === 'string' ? attachment.base64 : undefined;
    if (base64 && base64.length > REVIEW_START_REQUEST_LIMITS.attachmentBase64Chars) {
      throwIpcError('INVALID_PARAMS', `review attachment ${index} is too large`);
    }
    totalBase64Chars += base64?.length ?? 0;
    if (totalBase64Chars > REVIEW_START_REQUEST_LIMITS.totalBase64Chars) {
      throwIpcError('INVALID_PARAMS', 'review attachments are too large in total');
    }
    return {
      name,
      ...(attachmentPath ? { path: attachmentPath } : {}),
      ...(url ? { url } : {}),
      ...(category === 'image' ||
      category === 'pdf' ||
      category === 'text' ||
      category === 'office' ||
      category === 'file'
        ? { category }
        : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(originalName ? { originalName } : {}),
      ...(base64 ? { base64 } : {}),
    };
  });
  return {
    sourceSessionId: record.sourceSessionId.trim(),
    ...(focus ? { focus } : {}),
    attachments,
  };
}

export interface PreparedReviewLaunch {
  message: UserMessage;
  reviewerCreateOpts: MakerSessionCreateOpts;
  /** Fail closed if evidence changed after extraction but before provider start. */
  verifyBeforeStart(): Promise<ReviewFailureReason | null>;
  /** Return why a completed result no longer represents the current source state. */
  verifyBeforePublish(): Promise<ReviewFailureReason | null>;
}

export interface ReviewFailureReason {
  code: ReviewFailureCode;
  /** Internal diagnostic/IPC detail. Stable cards persist code instead of this English text. */
  message: string;
}

export interface PreparedReviewRun {
  sourceAgentKind: 'cc' | 'codex' | 'pi';
  prompt: string;
  targetKind: ReviewTargetKind;
  prepareLaunch(): Promise<PreparedReviewLaunch>;
  cleanup?(): Promise<void>;
}

export interface ReviewRunnerHandle {
  onEvent(listener: (event: AgentEvent) => void): () => void;
  onStatusChange(listener: (status: SessionStatus) => void): () => void;
  send(message: UserMessage, options: SessionSendOptions): Promise<SessionSendResult>;
}

export interface ReviewCardWrite {
  sourceSessionId: string;
  sourceCardClientId: string;
  sourceAgentKind: PreparedReviewRun['sourceAgentKind'];
  meta: ReviewRunMeta;
  result: string;
}

export interface ReviewStartHandlerDeps {
  assertCaller(event: unknown): void;
  waitUntilReady(sourceSessionId: string): Promise<void>;
  createRunId(): string;
  createReviewerSessionId(): string;
  owner: ReviewRunOwner;
  now(): number;
  prepareRun(input: {
    event: unknown;
    request: StartReviewRequest;
    runId: string;
    reviewerSessionId: string;
  }): Promise<PreparedReviewRun>;
  acquireSourceLease(input: {
    sourceSessionId: string;
    runId: string;
    owner: ReviewRunOwner;
    createdAt: number;
  }): Promise<boolean>;
  releaseSourceLease(input: {
    sourceSessionId: string;
    runId: string;
    owner: ReviewRunOwner;
  }): Promise<void>;
  createSourceCard(input: ReviewCardWrite): Promise<void>;
  updateSourceCard(input: ReviewCardWrite): Promise<void>;
  publishReviewerLink(input: ReviewCardWrite): Promise<void>;
  startReviewer(createOpts: MakerSessionCreateOpts): Promise<ReviewRunnerHandle>;
  markReviewerStarted(reviewerSessionId: string, startedAt: number): Promise<void>;
  broadcastReviewerCreated(reviewerSessionId: string): void;
  persistReviewerPrompt(input: {
    reviewerSessionId: string;
    runId: string;
    prompt: string;
    sourceAgentKind: PreparedReviewRun['sourceAgentKind'];
  }): Promise<void>;
  drainPersistQueue(): Promise<void>;
  readReviewerResult(reviewerSessionId: string): Promise<string>;
  closeReviewer(reviewerSessionId: string): Promise<void>;
  warn(message: string, fields: Record<string, unknown>): void;
}

export interface ReviewRunControl {
  /** Record local user intent before the shared input coordinator aborts the Reviewer turn. */
  noteReviewerStopRequested(reviewerSessionId: string): boolean;
}

function terminalErrorDetails(event: AgentEvent): {
  error?: string;
  failureCode?: ReviewFailureCode;
} {
  const data = event.data as { message?: unknown } | null;
  return typeof data?.message === 'string' && data.message
    ? { error: data.message }
    : { failureCode: 'provider-failed' };
}

function isCancelledReviewDone(event: AgentEvent): boolean {
  if (event.type !== 'done') return false;
  const data = event.data as { cancelled?: unknown } | null;
  return data?.cancelled === true;
}

export class ReviewPreconditionError extends Error {
  constructor(readonly reason: ReviewFailureReason) {
    super(reason.message);
    this.name = 'ReviewPreconditionError';
  }
}

const REVIEW_SOURCE_LEASE_RELEASE_RETRY_MS = 100;
const REVIEW_SOURCE_LEASE_RELEASE_RETRY_MAX_MS = 5_000;
const REVIEW_TERMINAL_CARD_RETRY_MS = 100;
const REVIEW_TERMINAL_CARD_RETRY_MAX_MS = 5_000;

/**
 * Register the host-owned Review lifecycle behind the same small IPC registry used
 * by production Electron and in-memory tests. Evidence collection stays in the
 * adapter; this module owns the concurrency gate and every terminal transition.
 */
export function registerReviewStartHandler(
  registry: IpcHandlerRegistry,
  deps: ReviewStartHandlerDeps,
): ReviewRunControl {
  const activeReviewsBySource = new Map<string, { runId: string; reviewerSessionId: string }>();
  const activeStopNotifiersByReviewer = new Map<string, () => boolean>();

  registry.handle(MAKER_INVOKE.START_REVIEW, async (event, raw: unknown) => {
    deps.assertCaller(event);
    const request = readStartReviewRequest(raw);
    await deps.waitUntilReady(request.sourceSessionId);
    if (activeReviewsBySource.has(request.sourceSessionId)) {
      throwIpcError('SESSION_RUNNING', 'This task already has a review in progress');
    }

    const runId = deps.createRunId();
    const reviewerSessionId = deps.createReviewerSessionId();
    const sourceCardClientId = `review:${runId}`;
    activeReviewsBySource.set(request.sourceSessionId, { runId, reviewerSessionId });

    let disposeReviewEvents: (() => void) | null = null;
    let disposeReviewStatus: (() => void) | null = null;
    let runningMeta: ReviewRunMeta | null = null;
    let sourceAgentKind: PreparedReviewRun['sourceAgentKind'] | null = null;
    let settled = false;
    let settlementCause: 'provider-terminal' | 'reviewer-closed' | null = null;
    let reviewerClosed = false;
    let preparedRunCleaned = false;
    let preparedRunCleanup: (() => Promise<void>) | null = null;
    let terminalFinalization: Promise<void> | null = null;
    let sourceLeaseAcquired = false;
    let sourceCardCreated = false;
    let releasePromise: Promise<void> | null = null;
    let releaseRetryTimer: NodeJS.Timeout | null = null;
    let releaseRetryDelayMs = REVIEW_SOURCE_LEASE_RELEASE_RETRY_MS;
    let terminalCardRetryTimer: NodeJS.Timeout | null = null;
    let terminalCardRetryDelayMs = REVIEW_TERMINAL_CARD_RETRY_MS;
    let pendingTerminalCard: ReviewCardWrite | null = null;
    let terminalCardPersisted = false;
    let sourceCardWriteChain = Promise.resolve();
    let stopRequested = false;
    const noteStopRequested = (): boolean => {
      if (settled) return false;
      stopRequested = true;
      return true;
    };
    activeStopNotifiersByReviewer.set(reviewerSessionId, noteStopRequested);

    const enqueueSourceCardWrite = (write: () => Promise<void>): Promise<void> => {
      const next = sourceCardWriteChain.then(write, write);
      sourceCardWriteChain = next.catch(() => undefined);
      return next;
    };

    function scheduleReleaseRetry(): void {
      if (releaseRetryTimer) return;
      const delayMs = releaseRetryDelayMs;
      releaseRetryDelayMs = Math.min(
        releaseRetryDelayMs * 2,
        REVIEW_SOURCE_LEASE_RELEASE_RETRY_MAX_MS,
      );
      const timer = setTimeout(() => {
        if (releaseRetryTimer === timer) releaseRetryTimer = null;
        void release();
      }, delayMs);
      timer.unref?.();
      releaseRetryTimer = timer;
    }

    const release = (): Promise<void> => {
      // A running card and its durable lease are one gate. Never expose the
      // source for another /review until its terminal replacement is durable.
      if (pendingTerminalCard) return Promise.resolve();
      if (releasePromise) return releasePromise;
      const pending = (async () => {
        if (sourceLeaseAcquired) {
          try {
            await deps.releaseSourceLease({
              sourceSessionId: request.sourceSessionId,
              runId,
              owner: deps.owner,
            });
            sourceLeaseAcquired = false;
          } catch (error) {
            // Keep the in-process gate occupied if the durable gate could not
            // be released. A later process can reclaim it after owner death.
            deps.warn('review source lease release failed', {
              sourceSessionId: request.sourceSessionId,
              runId,
              error: error instanceof Error ? error.message : String(error),
            });
            scheduleReleaseRetry();
            return;
          }
        }
        if (releaseRetryTimer) {
          clearTimeout(releaseRetryTimer);
          releaseRetryTimer = null;
        }
        releaseRetryDelayMs = REVIEW_SOURCE_LEASE_RELEASE_RETRY_MS;
        const active = activeReviewsBySource.get(request.sourceSessionId);
        if (active?.runId === runId) activeReviewsBySource.delete(request.sourceSessionId);
        if (activeStopNotifiersByReviewer.get(reviewerSessionId) === noteStopRequested) {
          activeStopNotifiersByReviewer.delete(reviewerSessionId);
        }
      })();
      releasePromise = pending;
      void pending.finally(() => {
        if (releasePromise === pending) releasePromise = null;
      });
      return pending;
    };

    function scheduleTerminalCardRetry(): void {
      if (terminalCardRetryTimer || !pendingTerminalCard) return;
      const delayMs = terminalCardRetryDelayMs;
      terminalCardRetryDelayMs = Math.min(
        terminalCardRetryDelayMs * 2,
        REVIEW_TERMINAL_CARD_RETRY_MAX_MS,
      );
      const timer = setTimeout(() => {
        if (terminalCardRetryTimer === timer) terminalCardRetryTimer = null;
        const pendingCard = pendingTerminalCard;
        if (pendingCard) void persistTerminalCard(pendingCard);
      }, delayMs);
      timer.unref?.();
      terminalCardRetryTimer = timer;
    }

    async function persistTerminalCard(card: ReviewCardWrite): Promise<void> {
      pendingTerminalCard = card;
      try {
        await enqueueSourceCardWrite(() => deps.updateSourceCard(card));
      } catch (error) {
        deps.warn('review terminal card persist failed; retry scheduled', {
          sourceSessionId: request.sourceSessionId,
          runId,
          status: card.meta.status,
          error: error instanceof Error ? error.message : String(error),
        });
        scheduleTerminalCardRetry();
        return;
      }
      if (pendingTerminalCard !== card) return;
      terminalCardPersisted = true;
      pendingTerminalCard = null;
      if (terminalCardRetryTimer) {
        clearTimeout(terminalCardRetryTimer);
        terminalCardRetryTimer = null;
      }
      terminalCardRetryDelayMs = REVIEW_TERMINAL_CARD_RETRY_MS;
      await release();
    }

    const disposeReviewerListeners = (): void => {
      disposeReviewEvents?.();
      disposeReviewEvents = null;
      disposeReviewStatus?.();
      disposeReviewStatus = null;
    };
    const closeReviewer = async (): Promise<void> => {
      if (reviewerClosed) return;
      reviewerClosed = true;
      await deps.closeReviewer(reviewerSessionId).catch((error) => {
        deps.warn('reviewer runtime cleanup failed', {
          reviewerSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      if (!preparedRunCleaned && preparedRunCleanup) {
        preparedRunCleaned = true;
        await preparedRunCleanup().catch((error) => {
          deps.warn('review evidence cleanup failed', {
            reviewerSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    };
    const updateSourceCard = async (
      status: 'completed' | 'failed',
      result: string,
      error?: string,
      failureCode?: ReviewFailureCode,
    ): Promise<void> => {
      const currentSourceAgentKind = sourceAgentKind;
      if (!runningMeta || !currentSourceAgentKind) {
        await release();
        return;
      }
      const nextMeta: ReviewRunMeta = {
        ...runningMeta,
        status,
        completedAt: deps.now(),
        ...(failureCode
          ? { failureCode }
          : error
            ? { error: redactSensitiveText(error).slice(0, 2_000) }
            : {}),
      };
      await persistTerminalCard({
        sourceSessionId: request.sourceSessionId,
        sourceCardClientId,
        sourceAgentKind: currentSourceAgentKind,
        meta: nextMeta,
        result,
      });
    };

    try {
      const prepared = await deps.prepareRun({ event, request, runId, reviewerSessionId });
      preparedRunCleanup = prepared.cleanup?.bind(prepared) ?? null;
      const preparedSourceAgentKind = prepared.sourceAgentKind;
      sourceAgentKind = preparedSourceAgentKind;
      const startedAt = deps.now();
      if (
        !(await deps.acquireSourceLease({
          sourceSessionId: request.sourceSessionId,
          runId,
          owner: deps.owner,
          createdAt: startedAt,
        }))
      ) {
        throwIpcError('SESSION_RUNNING', 'This task already has a review in progress');
      }
      sourceLeaseAcquired = true;
      runningMeta = {
        version: 1,
        runId,
        sourceSessionId: request.sourceSessionId,
        status: 'running',
        targetKind: prepared.targetKind,
        startedAt,
        owner: deps.owner,
      };
      await deps.createSourceCard({
        sourceSessionId: request.sourceSessionId,
        sourceCardClientId,
        sourceAgentKind: preparedSourceAgentKind,
        meta: runningMeta,
        result: '',
      });
      sourceCardCreated = true;

      const launch = await prepared.prepareLaunch();
      const startFailure = await launch.verifyBeforeStart();
      if (startFailure) throw new ReviewPreconditionError(startFailure);
      const reviewer = await deps.startReviewer(launch.reviewerCreateOpts);
      const linkedRunningMeta: ReviewRunMeta = { ...runningMeta, reviewerSessionId };
      runningMeta = linkedRunningMeta;

      disposeReviewEvents = reviewer.onEvent((reviewEvent) => {
        if (settled) return;
        if (reviewEvent.type === 'done' && isTurnContinuationBoundaryEvent(reviewEvent)) return;
        const terminalError = reviewEvent.type === 'error' && isTerminalTurnErrorEvent(reviewEvent);
        if (reviewEvent.type !== 'done' && !terminalError) return;
        settled = true;
        settlementCause = 'provider-terminal';
        disposeReviewerListeners();
        terminalFinalization = (async () => {
          if (stopRequested || isCancelledReviewDone(reviewEvent)) {
            await updateSourceCard('failed', '', undefined, 'reviewer-closed');
            await closeReviewer();
            return;
          }
          if (terminalError) {
            const details = terminalErrorDetails(reviewEvent);
            await updateSourceCard('failed', '', details.error, details.failureCode);
            await closeReviewer();
            return;
          }
          await deps.drainPersistQueue();
          const result = await deps.readReviewerResult(reviewerSessionId);
          if (!result) {
            await updateSourceCard('failed', '', undefined, 'no-visible-result');
            await closeReviewer();
            return;
          }
          const staleReason = await launch.verifyBeforePublish();
          if (staleReason) {
            if (isStaleReviewFailureCode(staleReason.code)) {
              // Keep the persisted status readable by older clients. The stable
              // reason code distinguishes an out-of-date completed result from
              // a Reviewer execution failure in current clients.
              await updateSourceCard('failed', result, staleReason.message, staleReason.code);
            } else {
              await updateSourceCard('failed', '', staleReason.message, staleReason.code);
            }
            await closeReviewer();
            return;
          }
          await updateSourceCard('completed', result);
          await closeReviewer();
        })().catch(async (error) => {
          deps.warn('review result finalization failed', {
            sourceSessionId: request.sourceSessionId,
            reviewerSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
          await updateSourceCard(
            'failed',
            '',
            error instanceof Error ? error.message : String(error),
          ).catch((cardError) => {
            deps.warn('review failure card retry setup failed', {
              sourceSessionId: request.sourceSessionId,
              reviewerSessionId,
              error: cardError instanceof Error ? cardError.message : String(cardError),
            });
          });
          await closeReviewer();
        });
        void terminalFinalization;
      });
      disposeReviewStatus = reviewer.onStatusChange((status) => {
        if (status !== 'closed' || settled || reviewerClosed) return;
        settled = true;
        settlementCause = 'reviewer-closed';
        disposeReviewerListeners();
        terminalFinalization = (async () => {
          await updateSourceCard('failed', '', undefined, 'reviewer-closed');
          await closeReviewer();
        })().catch(async (error) => {
          deps.warn('reviewer close finalization failed', {
            sourceSessionId: request.sourceSessionId,
            reviewerSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
          await closeReviewer();
        });
        void terminalFinalization;
      });

      // Install both terminal listeners before the reviewer becomes visible to
      // the renderer. Otherwise an immediate user close can land between the
      // created broadcast and listener registration, leaving the source gate
      // permanently occupied.
      await deps.markReviewerStarted(reviewerSessionId, startedAt);
      if (settled) {
        await terminalFinalization;
        throwIpcError('PRECONDITION_FAILED', 'Reviewer task closed before it started');
      }
      deps.broadcastReviewerCreated(reviewerSessionId);
      if (settled) {
        await terminalFinalization;
        throwIpcError('PRECONDITION_FAILED', 'Reviewer task closed before it started');
      }
      await enqueueSourceCardWrite(() =>
        deps.publishReviewerLink({
          sourceSessionId: request.sourceSessionId,
          sourceCardClientId,
          sourceAgentKind: preparedSourceAgentKind,
          meta: linkedRunningMeta,
          result: '',
        }),
      );
      if (settled) {
        await terminalFinalization;
        throwIpcError('PRECONDITION_FAILED', 'Reviewer task closed before it started');
      }

      const sendResult = await reviewer.send(launch.message, {
        planMode: false,
        onAccepted: async () => {
          await deps.persistReviewerPrompt({
            reviewerSessionId,
            runId,
            prompt: prepared.prompt,
            sourceAgentKind: preparedSourceAgentKind,
          });
        },
      });
      if (!sendResult.accepted) {
        if (settled && terminalFinalization) {
          await terminalFinalization;
          throwIpcError(
            'PRECONDITION_FAILED',
            'Reviewer task closed before its start was accepted',
          );
        }
        disposeReviewerListeners();
        settled = true;
        await updateSourceCard('failed', '', undefined, 'cancelled-before-start');
        throwIpcError('SESSION_RUNNING', 'Reviewer was cancelled before it started');
      }
      if (settled) {
        await terminalFinalization;
        // A provider terminal event proves the turn crossed its dispatch boundary even
        // when Session.send has not returned yet. The source card already owns that
        // completed/failed outcome, so report the command as accepted instead of making
        // Renderer restore `/review` and offer an accidental duplicate run. A bare close
        // remains a startup rejection because it does not prove provider dispatch.
        if (settlementCause === 'provider-terminal') {
          return { ok: true as const, runId, reviewerSessionId };
        }
        throwIpcError('PRECONDITION_FAILED', 'Reviewer task closed before its start was accepted');
      }
      return { ok: true as const, runId, reviewerSessionId };
    } catch (error) {
      if (terminalFinalization) {
        await terminalFinalization;
        throw error;
      }
      disposeReviewerListeners();
      settled = true;
      await closeReviewer();
      const active = activeReviewsBySource.get(request.sourceSessionId);
      if (active?.runId === runId) {
        if (sourceCardCreated) {
          if (!pendingTerminalCard && !terminalCardPersisted) {
            const message = error instanceof Error ? error.message : String(error);
            const failureCode =
              error instanceof ReviewPreconditionError ? error.reason.code : undefined;
            await updateSourceCard('failed', '', message, failureCode).catch((cardError) => {
              deps.warn('review startup failure card retry setup failed', {
                sourceSessionId: request.sourceSessionId,
                reviewerSessionId,
                error: cardError instanceof Error ? cardError.message : String(cardError),
              });
            });
          }
        } else {
          await release();
        }
      }
      if (error instanceof ReviewPreconditionError) {
        throwIpcError('PRECONDITION_FAILED', error.message);
      }
      throw error;
    }
  });

  return {
    noteReviewerStopRequested: (reviewerSessionId) =>
      activeStopNotifiersByReviewer.get(reviewerSessionId)?.() ?? false,
  };
}
