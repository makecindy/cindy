import type { AgentEvent, SessionSendOptions, UserMessage } from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';

import { MAKER_INVOKE } from '../channels.js';
import {
  readStartReviewRequest,
  REVIEW_START_REQUEST_LIMITS,
  registerReviewStartHandler,
  ReviewPreconditionError,
  type PreparedReviewLaunch,
  type PreparedReviewRun,
  type ReviewRunnerHandle,
  type ReviewStartHandlerDeps,
} from '../reviewStartHandler.js';
import { IpcHarness } from './helpers/ipcHarness.js';

class FakeReviewer implements ReviewRunnerHandle {
  private listener: ((event: AgentEvent) => void) | null = null;
  private statusListener: ((status: 'active' | 'aborting' | 'closed' | 'error') => void) | null =
    null;
  accepted = true;
  readonly send = vi.fn(async (_message: UserMessage, options: SessionSendOptions) => {
    await options.onAccepted?.();
    return this.accepted
      ? ({ accepted: true } as const)
      : ({ accepted: false, reason: 'cancelled-before-dispatch' } as const);
  });

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  onStatusChange(
    listener: (status: 'active' | 'aborting' | 'closed' | 'error') => void,
  ): () => void {
    this.statusListener = listener;
    return () => {
      if (this.statusListener === listener) this.statusListener = null;
    };
  }

  emit(event: AgentEvent): void {
    this.listener?.(event);
  }

  emitStatus(status: 'active' | 'aborting' | 'closed' | 'error'): void {
    this.statusListener?.(status);
  }
}

function makeLaunch(overrides: Partial<PreparedReviewLaunch> = {}): PreparedReviewLaunch {
  return {
    message: { type: 'user', content: [{ type: 'text', text: 'review prompt' }] },
    reviewerCreateOpts: {
      id: 'reviewer-1',
      agentKind: 'codex',
      workingDir: '/repo',
      model: 'gpt-test',
      reviewMode: true,
    },
    verifyBeforeStart: vi.fn(async () => null),
    verifyBeforePublish: vi.fn(async () => null),
    ...overrides,
  };
}

function makePreparedRun(
  launch: PreparedReviewLaunch,
  overrides: Partial<PreparedReviewRun> = {},
): PreparedReviewRun {
  return {
    sourceAgentKind: 'codex',
    prompt: 'review prompt',
    targetKind: 'mixed',
    prepareLaunch: vi.fn(async () => launch),
    ...overrides,
  };
}

function makeDeps(
  reviewer: FakeReviewer,
  overrides: Partial<ReviewStartHandlerDeps> = {},
): ReviewStartHandlerDeps {
  let id = 0;
  const launch = makeLaunch();
  return {
    assertCaller: vi.fn(),
    waitUntilReady: vi.fn(async () => undefined),
    createRunId: vi.fn(() => `run-${++id}`),
    createReviewerSessionId: vi.fn(() => `reviewer-${id}`),
    owner: { instanceId: 'main-instance-1', processId: 123 },
    now: vi.fn(() => 1_000 + id),
    prepareRun: vi.fn(async () => makePreparedRun(launch)),
    acquireSourceLease: vi.fn(async () => true),
    releaseSourceLease: vi.fn(async () => undefined),
    createSourceCard: vi.fn(async () => undefined),
    updateSourceCard: vi.fn(async () => undefined),
    publishReviewerLink: vi.fn(async () => undefined),
    startReviewer: vi.fn(async () => reviewer),
    markReviewerStarted: vi.fn(async () => undefined),
    broadcastReviewerCreated: vi.fn(),
    persistReviewerPrompt: vi.fn(async () => undefined),
    drainPersistQueue: vi.fn(async () => undefined),
    readReviewerResult: vi.fn(async () => 'P1: real finding'),
    closeReviewer: vi.fn(async () => undefined),
    warn: vi.fn(),
    ...overrides,
  };
}

function reviewRequest(sourceSessionId = 'source-1') {
  return { sourceSessionId, attachments: [] };
}

describe('maker:review:start IPC lifecycle', () => {
  it.each(
    Object.entries(REVIEW_START_REQUEST_LIMITS.attachmentMetadataChars) as Array<
      [keyof typeof REVIEW_START_REQUEST_LIMITS.attachmentMetadataChars, number]
    >,
  )('rejects oversized %s metadata before downstream normalization', (field, maxChars) => {
    expect(() =>
      readStartReviewRequest({
        sourceSessionId: 'source-1',
        attachments: [
          {
            name: 'artifact',
            [field]: ' '.repeat(maxChars + 1),
          },
        ],
      }),
    ).toThrow(`review attachment 0 ${field} is too long`);
  });

  it('rejects aggregate attachment metadata before authorization or prompt assembly', () => {
    const perAttachmentChars =
      Math.floor(
        REVIEW_START_REQUEST_LIMITS.totalAttachmentMetadataChars /
          REVIEW_START_REQUEST_LIMITS.attachmentCount,
      ) + 1;
    expect(() =>
      readStartReviewRequest({
        sourceSessionId: 'source-1',
        attachments: Array.from(
          { length: REVIEW_START_REQUEST_LIMITS.attachmentCount },
          (_, index) => ({ name: `artifact-${index}`, path: 'p'.repeat(perAttachmentChars) }),
        ),
      }),
    ).toThrow('review attachment metadata is too large in total');
  });

  it('bounds raw trimmed request fields before trim can copy oversized input', () => {
    expect(() =>
      readStartReviewRequest({
        sourceSessionId: ' '.repeat(REVIEW_START_REQUEST_LIMITS.sourceSessionIdChars + 1),
        attachments: [],
      }),
    ).toThrow('sourceSessionId required');
    expect(() =>
      readStartReviewRequest({
        sourceSessionId: 'source-1',
        focus: ' '.repeat(REVIEW_START_REQUEST_LIMITS.focusChars + 1),
        attachments: [],
      }),
    ).toThrow('review focus is too long');
  });

  it('validates the caller and bounded request before preparing evidence', async () => {
    const harness = new IpcHarness();
    const reviewer = new FakeReviewer();
    const deps = makeDeps(reviewer);
    registerReviewStartHandler(harness, deps);

    await expect(harness.invoke(MAKER_INVOKE.START_REVIEW, null)).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    await expect(
      harness.invoke(MAKER_INVOKE.START_REVIEW, {
        sourceSessionId: 'source-1',
        attachments: Array.from({ length: 21 }, () => ({ name: 'x' })),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });

    expect(deps.assertCaller).toHaveBeenCalledTimes(2);
    expect(deps.waitUntilReady).not.toHaveBeenCalled();
    expect(deps.prepareRun).not.toHaveBeenCalled();
  });

  it('runs card, bootstrap, accepted send, and completed result through the real handler', async () => {
    const harness = new IpcHarness();
    const reviewer = new FakeReviewer();
    const cleanup = vi.fn(async () => undefined);
    const deps = makeDeps(reviewer, {
      prepareRun: vi.fn(async () => makePreparedRun(makeLaunch(), { cleanup })),
    });
    registerReviewStartHandler(harness, deps);

    await expect(harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest())).resolves.toEqual({
      ok: true,
      runId: 'run-1',
      reviewerSessionId: 'reviewer-1',
    });

    expect(deps.waitUntilReady).toHaveBeenCalledWith('source-1');
    expect(deps.createSourceCard).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSessionId: 'source-1',
        sourceCardClientId: 'review:run-1',
        meta: expect.objectContaining({
          status: 'running',
          targetKind: 'mixed',
          owner: { instanceId: 'main-instance-1', processId: 123 },
        }),
      }),
    );
    const createdCard = vi.mocked(deps.createSourceCard).mock.calls[0]?.[0];
    expect(createdCard?.meta).not.toHaveProperty('reviewerSessionId');
    expect(deps.publishReviewerLink).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          status: 'running',
          reviewerSessionId: 'reviewer-1',
        }),
      }),
    );
    expect(deps.startReviewer).toHaveBeenCalledWith(expect.objectContaining({ reviewMode: true }));
    expect(deps.persistReviewerPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', prompt: 'review prompt' }),
    );

    reviewer.emit({ type: 'done', data: {} });
    await vi.waitFor(() =>
      expect(deps.updateSourceCard).toHaveBeenCalledWith(
        expect.objectContaining({
          result: 'P1: real finding',
          meta: expect.objectContaining({ status: 'completed' }),
        }),
      ),
    );
    expect(deps.closeReviewer).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('accepts a provider done emitted synchronously before send returns', async () => {
    const harness = new IpcHarness();
    const reviewer = new FakeReviewer();
    reviewer.send.mockImplementationOnce(async (_message, options) => {
      await options.onAccepted?.();
      reviewer.emit({ type: 'done', data: {} });
      return { accepted: true } as const;
    });
    const deps = makeDeps(reviewer);
    registerReviewStartHandler(harness, deps);

    await expect(harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest())).resolves.toEqual({
      ok: true,
      runId: 'run-1',
      reviewerSessionId: 'reviewer-1',
    });
    expect(deps.updateSourceCard).toHaveBeenCalledTimes(1);
    expect(deps.updateSourceCard).toHaveBeenCalledWith(
      expect.objectContaining({
        result: 'P1: real finding',
        meta: expect.objectContaining({ status: 'completed' }),
      }),
    );
    expect(deps.closeReviewer).toHaveBeenCalledTimes(1);
  });

  it('persists a stable failure code when the reviewer returns no visible conclusion', async () => {
    const harness = new IpcHarness();
    const reviewer = new FakeReviewer();
    const deps = makeDeps(reviewer, {
      readReviewerResult: vi.fn(async () => ''),
    });
    registerReviewStartHandler(harness, deps);
    await harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest());

    reviewer.emit({ type: 'done', data: {} });
    await vi.waitFor(() => expect(deps.updateSourceCard).toHaveBeenCalledTimes(1));

    const meta = vi.mocked(deps.updateSourceCard).mock.calls[0]?.[0].meta;
    expect(meta).toMatchObject({ status: 'failed', failureCode: 'no-visible-result' });
    expect(meta).not.toHaveProperty('error');
  });

  it('does not publish a partial result when the user stops Review', async () => {
    const harness = new IpcHarness();
    const reviewer = new FakeReviewer();
    const deps = makeDeps(reviewer);
    const control = registerReviewStartHandler(harness, deps);
    await harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest());

    expect(control.noteReviewerStopRequested('reviewer-1')).toBe(true);
    expect(control.noteReviewerStopRequested('reviewer-1')).toBe(true);
    // Pi and some Claude stop paths close with an ordinary done event, so the
    // host-owned stop marker must win over any partial provider result.
    reviewer.emit({ type: 'done', data: {} });
    await vi.waitFor(() => expect(deps.updateSourceCard).toHaveBeenCalledTimes(1));

    expect(deps.readReviewerResult).not.toHaveBeenCalled();
    expect(deps.updateSourceCard).toHaveBeenCalledWith(
      expect.objectContaining({
        result: '',
        meta: expect.objectContaining({
          status: 'failed',
          failureCode: 'reviewer-closed',
        }),
      }),
    );
    expect(deps.closeReviewer).toHaveBeenCalledTimes(1);
    expect(deps.releaseSourceLease).toHaveBeenCalledTimes(1);
    expect(control.noteReviewerStopRequested('reviewer-1')).toBe(false);

    await expect(harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest())).resolves.toMatchObject(
      { ok: true, runId: 'run-2' },
    );
  });

  it('uses a stable provider failure code only when no diagnostic detail exists', async () => {
    const harness = new IpcHarness();
    const reviewer = new FakeReviewer();
    const deps = makeDeps(reviewer);
    registerReviewStartHandler(harness, deps);
    await harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest());

    reviewer.emit({ type: 'error', data: { isTerminal: true } });
    await vi.waitFor(() => expect(deps.updateSourceCard).toHaveBeenCalledTimes(1));

    const meta = vi.mocked(deps.updateSourceCard).mock.calls[0]?.[0].meta;
    expect(meta).toMatchObject({ status: 'failed', failureCode: 'provider-failed' });
    expect(meta).not.toHaveProperty('error');
  });

  it('uses a localized provider failure code for tool-loop terminal diagnostics', async () => {
    const harness = new IpcHarness();
    const reviewer = new FakeReviewer();
    const deps = makeDeps(reviewer);
    registerReviewStartHandler(harness, deps);
    await harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest());

    reviewer.emit({
      type: 'error',
      data: {
        message: '上游模型 claude 连续 3 次 Edit 调用因同类参数错误被拒',
        reason: 'tool_use_loop_detected',
        isTerminal: true,
      },
    });
    await vi.waitFor(() => expect(deps.updateSourceCard).toHaveBeenCalledTimes(1));

    const meta = vi.mocked(deps.updateSourceCard).mock.calls[0]?.[0].meta;
    expect(meta).toMatchObject({ status: 'failed', failureCode: 'provider-failed' });
    expect(meta).not.toHaveProperty('error');
  });

  it('accepts a synchronously dispatched terminal failure after failing the card once', async () => {
    const harness = new IpcHarness();
    const reviewer = new FakeReviewer();
    reviewer.send.mockImplementationOnce(async (_message, options) => {
      await options.onAccepted?.();
      reviewer.emit({
        type: 'error',
        data: { message: 'provider failed after dispatch', isTerminal: true },
      });
      return { accepted: true } as const;
    });
    const deps = makeDeps(reviewer);
    registerReviewStartHandler(harness, deps);

    await expect(harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest())).resolves.toEqual({
      ok: true,
      runId: 'run-1',
      reviewerSessionId: 'reviewer-1',
    });
    expect(deps.updateSourceCard).toHaveBeenCalledTimes(1);
    expect(deps.updateSourceCard).toHaveBeenCalledWith(
      expect.objectContaining({
        result: '',
        meta: expect.objectContaining({
          status: 'failed',
          error: 'provider failed after dispatch',
        }),
      }),
    );
  });

  it('rejects a duplicate source submission while provider send is still pending', async () => {
    const harness = new IpcHarness();
    const reviewer = new FakeReviewer();
    let releaseSend!: () => void;
    const sendPending = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    reviewer.send.mockImplementationOnce(async (_message, options) => {
      await options.onAccepted?.();
      await sendPending;
      return { accepted: true } as const;
    });
    const deps = makeDeps(reviewer);
    registerReviewStartHandler(harness, deps);

    const first = harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest());
    await vi.waitFor(() => expect(reviewer.send).toHaveBeenCalledTimes(1));
    await expect(harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest())).rejects.toMatchObject({
      code: 'SESSION_RUNNING',
    });

    releaseSend();
    await expect(first).resolves.toMatchObject({ ok: true, runId: 'run-1' });
    expect(deps.startReviewer).toHaveBeenCalledTimes(1);
  });

  it('rejects a provider send failure before dispatch and permits retry', async () => {
    const harness = new IpcHarness();
    const reviewer = new FakeReviewer();
    reviewer.send.mockRejectedValueOnce(new Error('provider dispatch failed'));
    const deps = makeDeps(reviewer);
    registerReviewStartHandler(harness, deps);

    await expect(harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest())).rejects.toThrow(
      'provider dispatch failed',
    );
    expect(deps.updateSourceCard).toHaveBeenCalledWith(
      expect.objectContaining({
        result: '',
        meta: expect.objectContaining({ status: 'failed' }),
      }),
    );

    await expect(harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest())).resolves.toMatchObject(
      {
        ok: true,
        runId: 'run-2',
      },
    );
  });

  it('fails a send rejected before provider dispatch, releases the source, and permits retry', async () => {
    const harness = new IpcHarness();
    const reviewer = new FakeReviewer();
    reviewer.accepted = false;
    const deps = makeDeps(reviewer);
    registerReviewStartHandler(harness, deps);

    await expect(harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest())).rejects.toMatchObject({
      code: 'SESSION_RUNNING',
    });
    expect(deps.updateSourceCard).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          status: 'failed',
          failureCode: 'cancelled-before-start',
        }),
      }),
    );
    expect(vi.mocked(deps.updateSourceCard).mock.calls[0]?.[0].meta.reviewerSessionId).toBe(
      'reviewer-1',
    );
    expect(deps.closeReviewer).toHaveBeenCalledTimes(1);

    reviewer.accepted = true;
    await expect(harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest())).resolves.toMatchObject(
      { ok: true, runId: 'run-2' },
    );
  });

  it('fails and releases an active Review when its reviewer task is closed', async () => {
    const harness = new IpcHarness();
    const reviewer = new FakeReviewer();
    const deps = makeDeps(reviewer);
    registerReviewStartHandler(harness, deps);

    await expect(harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest())).resolves.toMatchObject(
      {
        ok: true,
        runId: 'run-1',
      },
    );

    reviewer.emitStatus('closed');
    await vi.waitFor(() =>
      expect(deps.updateSourceCard).toHaveBeenCalledWith(
        expect.objectContaining({
          result: '',
          meta: expect.objectContaining({
            status: 'failed',
            failureCode: 'reviewer-closed',
          }),
        }),
      ),
    );

    await expect(harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest())).resolves.toMatchObject(
      {
        ok: true,
        runId: 'run-2',
      },
    );
  });

  it('rejects startup when the reviewer closes before send acceptance returns', async () => {
    const harness = new IpcHarness();
    const reviewer = new FakeReviewer();
    reviewer.send.mockImplementationOnce(async (_message, options) => {
      await options.onAccepted?.();
      reviewer.emitStatus('closed');
      return { accepted: true } as const;
    });
    const deps = makeDeps(reviewer);
    registerReviewStartHandler(harness, deps);

    await expect(harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest())).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(deps.updateSourceCard).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ status: 'failed', failureCode: 'reviewer-closed' }),
      }),
    );

    await expect(harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest())).resolves.toMatchObject(
      {
        ok: true,
        runId: 'run-2',
      },
    );
  });

  it('lets close finalization own a simultaneous rejected send', async () => {
    const harness = new IpcHarness();
    const reviewer = new FakeReviewer();
    reviewer.send.mockImplementationOnce(async (_message, options) => {
      await options.onAccepted?.();
      reviewer.emitStatus('closed');
      return { accepted: false, reason: 'cancelled-before-dispatch' } as const;
    });
    const deps = makeDeps(reviewer);
    registerReviewStartHandler(harness, deps);

    await expect(harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest())).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(deps.updateSourceCard).toHaveBeenCalledTimes(1);
    expect(deps.updateSourceCard).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          status: 'failed',
          failureCode: 'reviewer-closed',
        }),
      }),
    );
  });

  it('installs the close listener before publishing the reviewer task', async () => {
    const harness = new IpcHarness();
    const reviewer = new FakeReviewer();
    const deps = makeDeps(reviewer);
    vi.mocked(deps.broadcastReviewerCreated).mockImplementationOnce(() => {
      reviewer.emitStatus('closed');
    });
    registerReviewStartHandler(harness, deps);

    await expect(harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest())).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(reviewer.send).not.toHaveBeenCalled();

    await expect(harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest())).resolves.toMatchObject(
      {
        ok: true,
        runId: 'run-2',
      },
    );
  });

  it('serializes a close that lands while the real reviewer link is being published', async () => {
    const harness = new IpcHarness();
    const reviewer = new FakeReviewer();
    const deps = makeDeps(reviewer);
    vi.mocked(deps.publishReviewerLink).mockImplementationOnce(async () => {
      reviewer.emitStatus('closed');
    });
    registerReviewStartHandler(harness, deps);

    await expect(harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest())).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(deps.updateSourceCard).toHaveBeenCalledTimes(1);
    expect(deps.updateSourceCard).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          reviewerSessionId: 'reviewer-1',
          status: 'failed',
        }),
      }),
    );
  });

  it('locks a source during evidence preparation and releases it when preparation fails', async () => {
    const harness = new IpcHarness();
    const reviewer = new FakeReviewer();
    let rejectPreparation!: (error: Error) => void;
    const preparation = new Promise<PreparedReviewRun>((_resolve, reject) => {
      rejectPreparation = reject;
    });
    const deps = makeDeps(reviewer, {
      prepareRun: vi.fn(() => preparation),
    });
    registerReviewStartHandler(harness, deps);

    const first = harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest());
    await vi.waitFor(() => expect(deps.prepareRun).toHaveBeenCalledTimes(1));
    await expect(harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest())).rejects.toMatchObject({
      code: 'SESSION_RUNNING',
    });

    rejectPreparation(new Error('evidence failed'));
    await expect(first).rejects.toThrow('evidence failed');
    expect(deps.startReviewer).not.toHaveBeenCalled();
    expect(deps.closeReviewer).toHaveBeenCalledTimes(1);
  });

  it('uses the durable lease to admit only one shared-database handler', async () => {
    const firstHarness = new IpcHarness();
    const secondHarness = new IpcHarness();
    const firstReviewer = new FakeReviewer();
    const secondReviewer = new FakeReviewer();
    let lease: { runId: string; instanceId: string } | null = null;
    const acquireSourceLease = vi.fn(
      async (input: { runId: string; owner: { instanceId: string } }) => {
        if (lease) return false;
        lease = { runId: input.runId, instanceId: input.owner.instanceId };
        return true;
      },
    );
    const releaseSourceLease = vi.fn(
      async (input: { runId: string; owner: { instanceId: string } }) => {
        if (lease?.runId === input.runId && lease.instanceId === input.owner.instanceId) {
          lease = null;
        }
      },
    );
    const firstDeps = makeDeps(firstReviewer, {
      owner: { instanceId: 'first-main', processId: 101 },
      acquireSourceLease,
      releaseSourceLease,
    });
    const secondDeps = makeDeps(secondReviewer, {
      owner: { instanceId: 'second-main', processId: 202 },
      acquireSourceLease,
      releaseSourceLease,
    });
    registerReviewStartHandler(firstHarness, firstDeps);
    registerReviewStartHandler(secondHarness, secondDeps);

    await expect(
      firstHarness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest()),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      secondHarness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest()),
    ).rejects.toMatchObject({ code: 'SESSION_RUNNING' });
    expect(secondDeps.createSourceCard).not.toHaveBeenCalled();
    expect(secondDeps.startReviewer).not.toHaveBeenCalled();

    firstReviewer.emitStatus('closed');
    await vi.waitFor(() => expect(lease).toBeNull());
    await expect(
      secondHarness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest()),
    ).resolves.toMatchObject({ ok: true });
  });

  it('retries a transient durable lease release and eventually frees the source gate', async () => {
    const harness = new IpcHarness();
    const reviewer = new FakeReviewer();
    const releaseSourceLease = vi
      .fn<ReviewStartHandlerDeps['releaseSourceLease']>()
      .mockRejectedValueOnce(new Error('database is temporarily locked'))
      .mockResolvedValue(undefined);
    const deps = makeDeps(reviewer, { releaseSourceLease });
    registerReviewStartHandler(harness, deps);

    await expect(harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest())).resolves.toMatchObject({
      ok: true,
      runId: 'run-1',
    });
    reviewer.emitStatus('closed');

    await vi.waitFor(() => expect(releaseSourceLease).toHaveBeenCalledTimes(2));
    expect(deps.warn).toHaveBeenCalledWith(
      'review source lease release failed',
      expect.objectContaining({ sourceSessionId: 'source-1', runId: 'run-1' }),
    );
    await expect(harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest())).resolves.toMatchObject({
      ok: true,
      runId: 'run-2',
    });
  });

  it('keeps both source gates until a failed terminal card write eventually persists', async () => {
    const harness = new IpcHarness();
    const reviewer = new FakeReviewer();
    let rejectFirstWrite!: (error: Error) => void;
    let rejectSecondWrite!: (error: Error) => void;
    const firstWrite = new Promise<void>((_resolve, reject) => {
      rejectFirstWrite = reject;
    });
    const secondWrite = new Promise<void>((_resolve, reject) => {
      rejectSecondWrite = reject;
    });
    const updateSourceCard = vi
      .fn<ReviewStartHandlerDeps['updateSourceCard']>()
      .mockImplementationOnce(() => firstWrite)
      .mockImplementationOnce(() => secondWrite)
      .mockResolvedValue(undefined);
    const releaseSourceLease = vi.fn(async () => undefined);
    const deps = makeDeps(reviewer, { updateSourceCard, releaseSourceLease });
    registerReviewStartHandler(harness, deps);

    await expect(harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest())).resolves.toMatchObject({
      ok: true,
      runId: 'run-1',
    });
    reviewer.emitStatus('closed');
    await vi.waitFor(() => expect(updateSourceCard).toHaveBeenCalledTimes(1));
    expect(releaseSourceLease).not.toHaveBeenCalled();
    await expect(harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest())).rejects.toMatchObject({
      code: 'SESSION_RUNNING',
    });

    rejectFirstWrite(new Error('database still locked'));
    await vi.waitFor(() => expect(updateSourceCard).toHaveBeenCalledTimes(2));
    expect(releaseSourceLease).not.toHaveBeenCalled();
    await expect(harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest())).rejects.toMatchObject({
      code: 'SESSION_RUNNING',
    });

    rejectSecondWrite(new Error('database still locked'));
    await vi.waitFor(() => {
      expect(updateSourceCard).toHaveBeenCalledTimes(3);
      expect(releaseSourceLease).toHaveBeenCalledTimes(1);
    });
    expect(updateSourceCard).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        meta: expect.objectContaining({ status: 'failed', failureCode: 'reviewer-closed' }),
      }),
    );
    expect(deps.warn).toHaveBeenCalledTimes(2);
    await expect(harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest())).resolves.toMatchObject({
      ok: true,
      runId: 'run-2',
    });
  });

  it('ignores continuation boundaries and lets only the first terminal event finalize', async () => {
    const harness = new IpcHarness();
    const reviewer = new FakeReviewer();
    const deps = makeDeps(reviewer);
    registerReviewStartHandler(harness, deps);
    await harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest());

    reviewer.emit({ type: 'done', data: {}, turnContinuationId: 7 });
    expect(deps.updateSourceCard).not.toHaveBeenCalled();
    reviewer.emit({
      type: 'error',
      data: { message: 'model format rejected', isTerminal: true },
    });
    reviewer.emit({ type: 'done', data: {} });

    await vi.waitFor(() => {
      expect(deps.updateSourceCard).toHaveBeenCalledTimes(1);
      expect(deps.closeReviewer).toHaveBeenCalledTimes(1);
    });
    expect(deps.updateSourceCard).toHaveBeenCalledWith(
      expect.objectContaining({
        result: '',
        meta: expect.objectContaining({
          status: 'failed',
          error: 'model format rejected',
        }),
      }),
    );
    expect(deps.readReviewerResult).not.toHaveBeenCalled();
  });

  it('preserves a completed result as stale when final freshness verification fails', async () => {
    const harness = new IpcHarness();
    const reviewer = new FakeReviewer();
    const staleReason = {
      code: 'artifact-changed' as const,
      message: 'A review artifact changed while Review was running.',
    };
    const launch = makeLaunch({
      verifyBeforePublish: vi.fn(async () => staleReason),
    });
    const deps = makeDeps(reviewer, {
      prepareRun: vi.fn(async () => makePreparedRun(launch)),
    });
    registerReviewStartHandler(harness, deps);
    await harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest());

    reviewer.emit({ type: 'done', data: {} });
    await vi.waitFor(() => expect(deps.updateSourceCard).toHaveBeenCalledTimes(1));

    expect(deps.updateSourceCard).toHaveBeenCalledWith(
      expect.objectContaining({
        result: 'P1: real finding',
        meta: expect.objectContaining({ status: 'failed', failureCode: staleReason.code }),
      }),
    );
    expect(vi.mocked(deps.updateSourceCard).mock.calls[0]?.[0].meta).not.toHaveProperty('error');
    expect(deps.closeReviewer).toHaveBeenCalledTimes(1);
  });

  it('fails the visible card when evidence changes before reviewer bootstrap', async () => {
    const harness = new IpcHarness();
    const reviewer = new FakeReviewer();
    const cleanup = vi.fn(async () => undefined);
    const launch = makeLaunch({
      verifyBeforeStart: vi.fn(async () => ({
        code: 'artifact-changed' as const,
        message: 'artifact changed before start',
      })),
    });
    const deps = makeDeps(reviewer, {
      prepareRun: vi.fn(async () => makePreparedRun(launch, { cleanup })),
    });
    registerReviewStartHandler(harness, deps);

    await expect(harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest())).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(deps.startReviewer).not.toHaveBeenCalled();
    expect(deps.updateSourceCard).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ status: 'failed', failureCode: 'artifact-changed' }),
      }),
    );
    expect(vi.mocked(deps.updateSourceCard).mock.calls[0]?.[0].meta).not.toHaveProperty('error');
    expect(vi.mocked(deps.createSourceCard).mock.calls[0]?.[0].meta).not.toHaveProperty(
      'reviewerSessionId',
    );
    expect(vi.mocked(deps.updateSourceCard).mock.calls[0]?.[0].meta).not.toHaveProperty(
      'reviewerSessionId',
    );
    expect(deps.publishReviewerLink).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('persists a stable failure code when artifact fingerprint preparation is unsafe', async () => {
    const harness = new IpcHarness();
    const reviewer = new FakeReviewer();
    const deps = makeDeps(reviewer, {
      prepareRun: vi.fn(async () =>
        makePreparedRun(makeLaunch(), {
          prepareLaunch: vi.fn(async () => {
            throw new ReviewPreconditionError({
              code: 'artifact-unavailable',
              message: 'internal artifact safety detail',
            });
          }),
        }),
      ),
    });
    registerReviewStartHandler(harness, deps);

    await expect(harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest())).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(deps.startReviewer).not.toHaveBeenCalled();
    expect(deps.updateSourceCard).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ status: 'failed', failureCode: 'artifact-unavailable' }),
      }),
    );
    expect(vi.mocked(deps.updateSourceCard).mock.calls[0]?.[0].meta).not.toHaveProperty('error');
  });

  it('does not publish a generated reviewer id when reviewer bootstrap itself fails', async () => {
    const harness = new IpcHarness();
    const reviewer = new FakeReviewer();
    const deps = makeDeps(reviewer, {
      startReviewer: vi.fn(async () => {
        throw new Error('reviewer bootstrap failed');
      }),
    });
    registerReviewStartHandler(harness, deps);

    await expect(harness.invoke(MAKER_INVOKE.START_REVIEW, reviewRequest())).rejects.toThrow(
      'reviewer bootstrap failed',
    );
    expect(deps.publishReviewerLink).not.toHaveBeenCalled();
    expect(vi.mocked(deps.createSourceCard).mock.calls[0]?.[0].meta).not.toHaveProperty(
      'reviewerSessionId',
    );
    expect(vi.mocked(deps.updateSourceCard).mock.calls[0]?.[0].meta).not.toHaveProperty(
      'reviewerSessionId',
    );
  });
});
