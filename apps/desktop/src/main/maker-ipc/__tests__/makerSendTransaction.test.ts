import {
  CodexResumePreparationBlockedError,
  type AgentKind,
  type SessionSendOptions,
  type SessionSendResult,
  type UserMessage,
} from '@cindy/maker-core';
import { CODEX_RESUME_NOT_READY_WIRE_MESSAGE } from '@cindy/maker-shared/agent-input-projection';
import { describe, expect, it, vi } from 'vitest';
import {
  createMakerSendTransaction,
  type MakerSendTransactionDeps,
  type MakerSendTransactionSession,
} from '../makerSendTransaction';
import type { MakerSessionCreateOpts } from '../sessionRequest';
import { CredentialModeSwitchBusyError } from '../../maker-host/codex-credential-switch';

function createSession(overrides: Partial<MakerSendTransactionSession> = {}): MakerSendTransactionSession {
  return {
    id: 'session-1',
    agentKind: 'codex',
    workDir: 'C:\\repo',
    remoteHostId: null,
    isTurnRunning: vi.fn(() => false),
    send: vi.fn(async (
      _message: UserMessage | string,
      opts?: SessionSendOptions,
    ) => {
      await opts?.onAccepted?.();
      await opts?.onTranscriptUserEntry?.('pi-user-entry');
      opts?.onDispatching?.();
      return { accepted: true } satisfies SessionSendResult;
    }),
    ...overrides,
  };
}

function createDeps(overrides: Partial<MakerSendTransactionDeps> = {}) {
  const session = createSession();
  const deps: MakerSendTransactionDeps = {
    getSession: vi.fn((sessionId: string) => (sessionId === session.id ? session : undefined)),
    closeSession: vi.fn(async () => {}),
    getSessionMeta: vi.fn(async () => ({ title: '现有会话' })),
    ensureRemoteReadyForSessionStart: vi.fn(async () => {}),
    checkWorkDirExists: vi.fn(async () => true),
    isOrcaMcpHydrated: vi.fn(() => true),
    buildCreateOptsWithStderr: vi.fn((opts: MakerSessionCreateOpts) => opts),
    synthesizeOrcaVendorOptionsFromDb: vi.fn(async () => false),
    readSessionExtraDirsFromDb: vi.fn(async () => []),
    readSessionWorkingDirFromDb: vi.fn(async () => null),
    withRehydrateCloseSuppressed: vi.fn(async (_sessionId, fn) => await fn()),
    bootstrapSession: vi.fn(async (opts: MakerSessionCreateOpts) => ({
      session: createSession({
        id: opts.id ?? session.id,
        agentKind: opts.agentKind as AgentKind,
        workDir: opts.workingDir,
        remoteHostId: opts.remoteHostId ?? null,
      }),
      didInjectOrcaInstructions: false,
      didInjectProjectContext: false,
    })),
    markOrcaRoleIfNeeded: vi.fn(async () => {}),
    broadcastSessionCreated: vi.fn(),
    prepareSendUserMessage: vi.fn(async (_sessionId, message) => message as UserMessage | string),
    createDbMessage: vi.fn(async () => {}),
    linkPiUserEntry: vi.fn(async () => true),
    previewUserPrompt: vi.fn(),
    dispatchUserPromptPreview: vi.fn(),
    commitUserPromptPreview: vi.fn(),
    rollbackUserPromptPreview: vi.fn(),
    isSessionRunningError: vi.fn(() => false),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    ...overrides,
  };
  return { deps, session };
}

describe('maker SEND transaction', () => {
  it('rejects invalid sessionId before touching transaction dependencies', async () => {
    const { deps } = createDeps();
    const transaction = createMakerSendTransaction(deps);

    await expect(transaction.sendToAgentAccepted(undefined, 'hello')).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    expect(deps.getSession).not.toHaveBeenCalled();
    expect(deps.ensureRemoteReadyForSessionStart).not.toHaveBeenCalled();
  });

  it('sends to an existing session and persists the user message in the accepted hook', async () => {
    const beforeDispatchDirectUserTurn = vi.fn();
    const { deps, session } = createDeps({ beforeDispatchDirectUserTurn });
    const transaction = createMakerSendTransaction(deps);
    const shouldBroadcast = vi.fn(() => true);
    const onPersisting = vi.fn();
    const onPersisted = vi.fn();

    await expect(
      transaction.sendToAgentAccepted(
        'session-1',
        { type: 'user', content: 'hello' },
        undefined,
        {
          messageUuid: 'message-uuid',
          userName: 'Lizi',
          persistUserMessage: {
            clientId: 'client-1',
            content: 'hello',
            sdkSessionId: 'sdk-1',
            delivery: 'turn',
            shouldBroadcast,
            onPersisting,
            onPersisted,
          },
        },
      ),
    ).resolves.toEqual({
      accepted: true,
      outcome: { kind: 'session-dispatch', source: 'maker-ipc', dispatched: true },
    });

    expect(deps.ensureRemoteReadyForSessionStart).toHaveBeenCalledWith({ session, createOpts: undefined });
    expect(deps.prepareSendUserMessage).toHaveBeenCalledWith('session-1', { type: 'user', content: 'hello' });
    expect(session.send).toHaveBeenCalledWith(
      { type: 'user', content: 'hello' },
      expect.objectContaining({
        logTitle: '现有会话',
        messageUuid: 'message-uuid',
        userName: 'Lizi',
      }),
    );
    expect(onPersisting).toHaveBeenCalled();
    expect(beforeDispatchDirectUserTurn).not.toHaveBeenCalled();
    expect(deps.previewUserPrompt).toHaveBeenCalledWith(
      session,
      'hello',
      {
        source: 'maker_send:onPersisting',
        clientId: 'client-1',
      },
    );
    expect(deps.createDbMessage).toHaveBeenCalledWith(
      'session-1',
      {
        clientId: 'client-1',
        role: 'user',
        content: 'hello',
        agentMeta: {
          uuid: 'message-uuid',
          sdkSessionId: 'sdk-1',
          delivery: 'turn',
        },
      },
      { shouldBroadcast },
    );
    expect(onPersisted).toHaveBeenCalled();
    expect(deps.dispatchUserPromptPreview).toHaveBeenCalledWith('session-1', 'client-1');
    expect(deps.commitUserPromptPreview).toHaveBeenCalledWith('session-1', 'client-1');
    expect(deps.rollbackUserPromptPreview).not.toHaveBeenCalled();
  });

  it('links attachment messages to the accepted Pi transcript entry only for Pi attachments', async () => {
    const { deps, session } = createDeps();
    session.agentKind = 'pi';
    const transaction = createMakerSendTransaction(deps);

    await transaction.sendToAgentAccepted(
      'session-1',
      { type: 'user', content: 'Review the image' },
      undefined,
      {
        messageUuid: 'host-message',
        persistUserMessage: {
          clientId: 'attachment-client',
          content: JSON.stringify({
            text: 'Review the image',
            images: [{ url: 'cindy-media://blobs/image.webp' }],
          }),
        },
      },
    );

    expect(deps.linkPiUserEntry).toHaveBeenCalledWith(
      'session-1',
      'attachment-client',
      'pi-user-entry',
    );

    await transaction.sendToAgentAccepted(
      'session-1',
      { type: 'user', content: 'Plain text' },
      undefined,
      {
        messageUuid: 'plain-message',
        persistUserMessage: {
          clientId: 'plain-client',
          content: JSON.stringify({ text: 'Plain text', images: [], files: [] }),
        },
      },
    );
    expect(deps.linkPiUserEntry).toHaveBeenCalledTimes(1);
  });

  it('threads scheduler origin into session.send opts and persisted agentMeta', async () => {
    // scheduler 排队消息经 coordinator drain 透传 origin(见 AgentInputSendOpts.origin):
    // 既打到本轮 turnOrigin(session.send opts),也合进落库 agentMeta(自动化标签)。
    const { deps, session } = createDeps();
    const transaction = createMakerSendTransaction(deps);
    const origin = { kind: 'scheduler', scheduleId: 'sch-1', scheduleName: 'PR 心跳' } as const;

    await transaction.sendToAgentAccepted(
      'session-1',
      { type: 'user', content: 'hb prompt' },
      undefined,
      {
        messageUuid: 'message-uuid',
        origin,
        persistUserMessage: {
          clientId: 'client-1',
          content: 'hb prompt',
          sdkSessionId: 'sdk-1',
          delivery: 'turn',
        },
      },
    );

    expect(session.send).toHaveBeenCalledWith(
      { type: 'user', content: 'hb prompt' },
      expect.objectContaining({ origin }),
    );
    expect(deps.createDbMessage).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        agentMeta: expect.objectContaining({ origin }),
      }),
      undefined,
    );
  });

  it('persists Orca queue origin without sending the unsupported origin to maker-core', async () => {
    const { deps, session } = createDeps();
    const transaction = createMakerSendTransaction(deps);
    const origin = { kind: 'orca', senderLabel: 'Lead', displayText: 'hello' } as const;

    await transaction.sendToAgentAccepted(
      'session-1',
      { type: 'user', content: 'orca prompt' },
      undefined,
      {
        messageUuid: 'message-uuid',
        persistUserMessage: {
          clientId: 'client-1',
          content: 'orca prompt',
          delivery: 'turn',
          origin,
        },
      },
    );

    expect(session.send).toHaveBeenCalledWith(
      { type: 'user', content: 'orca prompt' },
      expect.not.objectContaining({ origin }),
    );
    expect(deps.createDbMessage).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        agentMeta: expect.objectContaining({ origin }),
      }),
      undefined,
    );
  });

  it('threads the autoResume flag into persisted agentMeta', async () => {
    // 中断自动续跑补发的「继续」经 coordinator drain 透传 autoResume(见
    // AgentInputQueuedMessage.autoResume)。它必须落进 agentMeta:renderer 靠它隐藏气泡,
    // host 的 createDbMessage 靠它跳过额度充值(不跳就是自我充值 → 死循环)。
    const { deps } = createDeps();
    const transaction = createMakerSendTransaction(deps);

    await transaction.sendToAgentAccepted(
      'session-1',
      { type: 'user', content: 'continue' },
      undefined,
      {
        messageUuid: 'message-uuid',
        turnAttemptToken: 7,
        persistUserMessage: {
          clientId: 'client-1',
          content: 'continue',
          sdkSessionId: 'sdk-1',
          delivery: 'turn',
          autoResume: true,
          autoResumeInfo: { attempt: 1, maxAttempts: 5, sessionTotal: 7 },
        },
      },
    );

    expect(deps.createDbMessage).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        agentMeta: expect.objectContaining({ autoResume: true }),
      }),
      undefined,
    );
    expect(
      (deps.getSession('session-1')?.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[1],
    ).toEqual(expect.objectContaining({ turnAttemptToken: 7 }));
  });

  it('persists the shared recovery checkpoint for manual retries too', async () => {
    const { deps } = createDeps();
    const transaction = createMakerSendTransaction(deps);
    const checkpoint = {
      version: 1,
      source: 'manual',
      mode: 'checkpoint',
      attempt: 2,
      failedUserClientId: 'failed-1',
      rootUserClientId: 'failed-0',
      contextTokens: 180_000,
      contextWindow: 200_000,
      contextRatio: 0.9,
      progressCount: 4,
      createdAt: '2026-08-04T00:00:00.000Z',
      recentProgress: [],
    };

    await transaction.sendToAgentAccepted(
      'session-1',
      { type: 'user', content: '[UI_ACTION_TRIGGER] continue' },
      undefined,
      {
        messageUuid: 'message-uuid',
        persistUserMessage: {
          clientId: 'client-2',
          content: '[UI_ACTION_TRIGGER] continue',
          delivery: 'turn',
          recoveryCheckpoint: checkpoint,
        },
      },
    );

    expect(deps.createDbMessage).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ agentMeta: expect.objectContaining({ recoveryCheckpoint: checkpoint }) }),
      undefined,
    );
  });

  it('omits autoResume for ordinary user sends', async () => {
    const { deps } = createDeps();
    const transaction = createMakerSendTransaction(deps);

    await transaction.sendToAgentAccepted(
      'session-1',
      { type: 'user', content: 'hello' },
      undefined,
      {
        messageUuid: 'message-uuid',
        persistUserMessage: { clientId: 'client-1', content: 'hello', delivery: 'turn' },
      },
    );

    const persisted = vi.mocked(deps.createDbMessage).mock.calls[0]?.[1] as
      | { agentMeta?: Record<string, unknown> }
      | undefined;
    expect(persisted?.agentMeta).not.toHaveProperty('autoResume');
  });

  it('awaits the direct-send baseline hook before vendor dispatch', async () => {
    const events: string[] = [];
    const beforeDispatchDirectUserTurn = vi.fn(async () => {
      events.push('baseline');
    });
    const session = createSession({
      send: vi.fn(async () => {
        events.push('send');
        return { accepted: true } satisfies SessionSendResult;
      }),
    });
    const { deps } = createDeps({
      getSession: vi.fn(() => session),
      beforeDispatchDirectUserTurn,
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(transaction.sendToAgentAccepted('session-1', 'hello')).resolves.toMatchObject({
      accepted: true,
    });

    expect(events).toEqual(['baseline', 'send']);
    expect(beforeDispatchDirectUserTurn).toHaveBeenCalledWith('session-1');
  });

  it('materializes direct OSS attachments after session/workdir preflight', async () => {
    const events: string[] = [];
    const materializeDirectSendOssAttachments = vi.fn(async (
      _sessionId: string,
      message: unknown,
      sendOpts: unknown,
    ) => {
      events.push('materialize');
      return {
        message: { ...(message as object), materialized: true },
        sendOpts: { ...(sendOpts as object), materialized: true },
      };
    });
    const session = createSession({
      send: vi.fn(async (message) => {
        events.push('send');
        expect(message).toMatchObject({ materialized: true });
        return { accepted: true } satisfies SessionSendResult;
      }),
    });
    const { deps } = createDeps({
      getSession: vi.fn(() => session),
      materializeDirectSendOssAttachments,
    });
    deps.prepareSendUserMessage = vi.fn(async (_sessionId, message) => {
      events.push('normalize');
      return message as UserMessage;
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(
      transaction.sendToAgentAccepted('session-1', { type: 'user', content: 'hello' }, undefined, { marker: true }),
    ).resolves.toMatchObject({ accepted: true });

    expect(events).toEqual(['materialize', 'normalize', 'send']);
    expect(materializeDirectSendOssAttachments).toHaveBeenCalledWith(
      'session-1',
      { type: 'user', content: 'hello' },
      { marker: true },
    );
  });

  it('cleans direct OSS materializations when normalization rejects before acceptance', async () => {
    const cleanupBeforeAcceptance = vi.fn(async () => {});
    const materializeDirectSendOssAttachments = vi.fn(async () => ({
      message: { type: 'user', content: 'materialized' },
      sendOpts: undefined,
      cleanupBeforeAcceptance,
    }));
    const { deps } = createDeps({ materializeDirectSendOssAttachments });
    deps.prepareSendUserMessage = vi.fn(async () => {
      throw new Error('normalize failed');
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(transaction.sendToAgentAccepted('session-1', 'hello')).rejects.toThrow('normalize failed');
    expect(cleanupBeforeAcceptance).toHaveBeenCalledTimes(1);
  });

  it('cleans direct OSS materializations when vendor send is rejected before dispatch', async () => {
    const cleanupBeforeAcceptance = vi.fn(async () => {});
    const materializeDirectSendOssAttachments = vi.fn(async () => ({
      message: { type: 'user', content: 'materialized' },
      sendOpts: undefined,
      cleanupBeforeAcceptance,
    }));
    const session = createSession({
      send: vi.fn(async () => ({
        accepted: false,
        reason: 'cancelled-before-dispatch',
      } satisfies SessionSendResult)),
    });
    const { deps } = createDeps({
      getSession: vi.fn(() => session),
      materializeDirectSendOssAttachments,
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(transaction.sendToAgentAccepted('session-1', 'hello')).resolves.toMatchObject({
      accepted: false,
    });
    expect(cleanupBeforeAcceptance).toHaveBeenCalledTimes(1);
  });

  it('preserves local media when onAccepted persisted the row before a late abort returns accepted=false', async () => {
    const cleanupBeforeAcceptance = vi.fn(async () => {});
    const cleanupAfterAcceptance = vi.fn();
    const materializeDirectSendOssAttachments = vi.fn(async () => ({
      message: { type: 'user', content: 'materialized' },
      sendOpts: undefined,
      cleanupBeforeAcceptance,
      cleanupAfterAcceptance,
    }));
    const session = createSession({
      send: vi.fn(async (_message, opts) => {
        await opts?.onAccepted?.();
        return {
          accepted: false,
          reason: 'cancelled-before-dispatch',
        } satisfies SessionSendResult;
      }),
    });
    const { deps } = createDeps({
      getSession: vi.fn(() => session),
      materializeDirectSendOssAttachments,
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(
      transaction.sendToAgentAccepted(
        'session-1',
        { type: 'user', content: 'hello' },
        undefined,
        {
          persistUserMessage: {
            clientId: 'client-1',
            content: 'hello',
          },
        },
      ),
    ).resolves.toMatchObject({ accepted: false });

    expect(deps.createDbMessage).toHaveBeenCalledTimes(1);
    expect(cleanupBeforeAcceptance).not.toHaveBeenCalled();
    expect(cleanupAfterAcceptance).toHaveBeenCalledTimes(1);
  });

  it('rewinds a persisted user row when clear wins during onPersisted before dispatch', async () => {
    let clearBoundaryCurrent = true;
    let observedGeneration: number | undefined;
    const rewindPersistedUserMessageAfterClear = vi.fn(async () => {});
    const onPersisted = vi.fn(async () => {
      clearBoundaryCurrent = false;
      throw new Error('[SEND_CANCELLED_BEFORE_DISPATCH] clear won before dispatch');
    });
    const session = createSession({
      send: vi.fn(async (_message, opts) => {
        await opts?.onAccepted?.();
        return { accepted: true } satisfies SessionSendResult;
      }),
    });
    const { deps } = createDeps({
      getSession: vi.fn(() => session),
      isClearBoundaryCurrent: vi.fn((_sessionId, _expectedBoundary, expectedGeneration) => {
        observedGeneration = expectedGeneration;
        return clearBoundaryCurrent;
      }),
      rewindPersistedUserMessageAfterClear,
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(
      transaction.sendToAgentAccepted('session-1', 'hello', undefined, {
        persistUserMessage: {
          clientId: 'client-clear-race',
          content: 'hello',
          expectedClearBoundaryMs: null,
          expectedInputGeneration: 7,
          onPersisted,
        },
      }),
    ).rejects.toThrow('clear won before dispatch');

    expect(deps.createDbMessage).toHaveBeenCalledTimes(1);
    expect(onPersisted).toHaveBeenCalledTimes(1);
    expect(observedGeneration).toBe(7);
    expect(rewindPersistedUserMessageAfterClear).toHaveBeenCalledWith(
      'session-1',
      'client-clear-race',
    );
  });

  it('cleans direct OSS materializations when vendor send throws before dispatch', async () => {
    const cleanupBeforeAcceptance = vi.fn(async () => {});
    const materializeDirectSendOssAttachments = vi.fn(async () => ({
      message: { type: 'user', content: 'materialized' },
      sendOpts: undefined,
      cleanupBeforeAcceptance,
    }));
    const session = createSession({
      send: vi.fn(async () => {
        throw new Error('vendor send failed');
      }),
    });
    const { deps } = createDeps({
      getSession: vi.fn(() => session),
      materializeDirectSendOssAttachments,
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(transaction.sendToAgentAccepted('session-1', 'hello')).rejects.toThrow(
      'vendor send failed',
    );
    expect(cleanupBeforeAcceptance).toHaveBeenCalledTimes(1);
  });

  it('keeps local OSS materializations after accepted vendor dispatch', async () => {
    const cleanupAfterAcceptance = vi.fn();
    const cleanupBeforeAcceptance = vi.fn(async () => {});
    const cleanupLocalMaterialization = vi.fn(async () => {});
    const materializeDirectSendOssAttachments = vi.fn(async () => ({
      message: { type: 'user', content: 'materialized' },
      sendOpts: undefined,
      cleanupAfterAcceptance,
      cleanupBeforeAcceptance,
      cleanupLocalMaterialization,
    }));
    const { deps } = createDeps({ materializeDirectSendOssAttachments });
    const transaction = createMakerSendTransaction(deps);

    await expect(
      transaction.sendToAgentAccepted('session-1', 'hello', undefined, {
        persistUserMessage: {
          clientId: 'client-1',
          content: 'hello',
        },
      }),
    ).resolves.toMatchObject({ accepted: true });
    expect(cleanupAfterAcceptance).toHaveBeenCalledTimes(1);
    expect(cleanupBeforeAcceptance).not.toHaveBeenCalled();
    expect(cleanupLocalMaterialization).not.toHaveBeenCalled();
  });

  it('cleans local OSS materializations after accepted direct sends without persistence', async () => {
    const cleanupAfterAcceptance = vi.fn();
    const cleanupBeforeAcceptance = vi.fn(async () => {});
    const cleanupLocalMaterialization = vi.fn(async () => {});
    const materializeDirectSendOssAttachments = vi.fn(async () => ({
      message: { type: 'user', content: 'materialized' },
      sendOpts: undefined,
      cleanupAfterAcceptance,
      cleanupBeforeAcceptance,
      cleanupLocalMaterialization,
    }));
    const { deps } = createDeps({ materializeDirectSendOssAttachments });
    const transaction = createMakerSendTransaction(deps);

    await expect(transaction.sendToAgentAccepted('session-1', 'hello')).resolves.toMatchObject({
      accepted: true,
    });

    expect(cleanupAfterAcceptance).toHaveBeenCalledTimes(1);
    expect(cleanupBeforeAcceptance).not.toHaveBeenCalled();
    expect(cleanupLocalMaterialization).toHaveBeenCalledTimes(1);
  });

  it('does not materialize direct OSS attachments when workdir preflight rejects', async () => {
    const materializeDirectSendOssAttachments = vi.fn();
    const { deps } = createDeps({
      checkWorkDirExists: vi.fn(async () => false),
      materializeDirectSendOssAttachments,
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(
      transaction.sendToAgentAccepted('session-1', { type: 'user', content: 'hello' }),
    ).resolves.toMatchObject({ accepted: false });

    expect(materializeDirectSendOssAttachments).not.toHaveBeenCalled();
  });

  it('consumes the direct-send baseline when vendor dispatch is not accepted', async () => {
    const beforeDispatchDirectUserTurn = vi.fn(async () => {});
    const onUndispatchedDirectUserTurn = vi.fn();
    const session = createSession({
      send: vi.fn(async () => (
        { accepted: false, reason: 'cancelled-before-dispatch' } satisfies SessionSendResult
      )),
    });
    const { deps } = createDeps({
      getSession: vi.fn(() => session),
      beforeDispatchDirectUserTurn,
      onUndispatchedDirectUserTurn,
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(transaction.sendToAgentAccepted('session-1', 'hello')).resolves.toMatchObject({
      accepted: false,
      reason: 'cancelled-before-dispatch',
    });

    expect(beforeDispatchDirectUserTurn).toHaveBeenCalledWith('session-1');
    expect(onUndispatchedDirectUserTurn).toHaveBeenCalledWith('session-1');
  });

  it('consumes the direct-send baseline when vendor dispatch throws before acceptance', async () => {
    const beforeDispatchDirectUserTurn = vi.fn(async () => {});
    const onUndispatchedDirectUserTurn = vi.fn();
    const session = createSession({
      send: vi.fn(async () => {
        throw new Error('start failed');
      }),
    });
    const { deps } = createDeps({
      getSession: vi.fn(() => session),
      beforeDispatchDirectUserTurn,
      onUndispatchedDirectUserTurn,
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(transaction.sendToAgentAccepted('session-1', 'hello')).rejects.toThrow('start failed');

    expect(beforeDispatchDirectUserTurn).toHaveBeenCalledWith('session-1');
    expect(onUndispatchedDirectUserTurn).toHaveBeenCalledWith('session-1');
  });

  it('acks an interrupted turn with the executor clock only after direct dispatch is accepted', async () => {
    const ackInterruptedTurnDispatched = vi.fn(async () => {});
    const session = createSession({
      send: vi.fn(async () => {
        expect(ackInterruptedTurnDispatched).not.toHaveBeenCalled();
        return { accepted: true } satisfies SessionSendResult;
      }),
    });
    const { deps } = createDeps({
      getSession: vi.fn(() => session),
      ackInterruptedTurnDispatched,
    });
    const now = vi.spyOn(Date, 'now').mockReturnValue(50_000);
    const transaction = createMakerSendTransaction(deps);

    try {
      await expect(
        transaction.sendToAgentAccepted('session-1', 'continue', undefined, {
          ackInterruptedTurnOnDispatch: true,
        }),
      ).resolves.toMatchObject({ accepted: true });
    } finally {
      now.mockRestore();
    }

    expect(ackInterruptedTurnDispatched).toHaveBeenCalledWith('session-1', 49_999);
    expect(vi.mocked(session.send).mock.invocationCallOrder[0]).toBeLessThan(
      ackInterruptedTurnDispatched.mock.invocationCallOrder[0]!,
    );
  });

  it('does not ack an interrupted turn when direct dispatch is rejected', async () => {
    const ackInterruptedTurnDispatched = vi.fn(async () => {});
    const session = createSession({
      send: vi.fn(async () => (
        { accepted: false, reason: 'cancelled-before-dispatch' } satisfies SessionSendResult
      )),
    });
    const { deps } = createDeps({
      getSession: vi.fn(() => session),
      ackInterruptedTurnDispatched,
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(
      transaction.sendToAgentAccepted('session-1', 'continue', undefined, {
        ackInterruptedTurnOnDispatch: true,
      }),
    ).resolves.toMatchObject({ accepted: false });

    expect(ackInterruptedTurnDispatched).not.toHaveBeenCalled();
  });

  it('keeps an accepted direct dispatch successful when interrupted-turn ack persistence fails', async () => {
    const ackError = new Error('ack write failed');
    const ackInterruptedTurnDispatched = vi.fn(async () => {
      throw ackError;
    });
    const { deps } = createDeps({ ackInterruptedTurnDispatched });
    const transaction = createMakerSendTransaction(deps);

    await expect(
      transaction.sendToAgentAccepted('session-1', 'continue', undefined, {
        ackInterruptedTurnOnDispatch: true,
      }),
    ).resolves.toMatchObject({ accepted: true });

    expect(deps.log.warn).toHaveBeenCalledWith(
      'send: interrupted-turn dispatch ack failed',
      expect.objectContaining({
        sessionId: 'session-1',
        err: ackError.message,
      }),
    );
  });

  it('rejects a non-boolean interrupted-turn dispatch ack option before vendor dispatch', async () => {
    const materializeDirectSendOssAttachments = vi.fn();
    const { deps, session } = createDeps({ materializeDirectSendOssAttachments });
    const transaction = createMakerSendTransaction(deps);

    await expect(
      transaction.sendToAgentAccepted('session-1', 'continue', undefined, {
        ackInterruptedTurnOnDispatch: 'yes',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });

    expect(session.send).not.toHaveBeenCalled();
    expect(materializeDirectSendOssAttachments).not.toHaveBeenCalled();
  });

  it('rolls back the prompt preview if accepted persistence fails before dispatch', async () => {
    const { deps, session } = createDeps({
      createDbMessage: vi.fn(async () => {
        throw new Error('write failed');
      }),
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(
      transaction.sendToAgentAccepted(
        'session-1',
        { type: 'user', content: 'hello' },
        undefined,
        {
          persistUserMessage: {
            clientId: 'client-1',
            content: 'hello',
          },
        },
      ),
    ).rejects.toThrow('write failed');

    expect(session.send).toHaveBeenCalled();
    expect(deps.previewUserPrompt).toHaveBeenCalledWith(
      session,
      'hello',
      {
        source: 'maker_send:onPersisting',
        clientId: 'client-1',
      },
    );
    expect(deps.commitUserPromptPreview).not.toHaveBeenCalled();
    expect(deps.rollbackUserPromptPreview).toHaveBeenCalledWith(
      'session-1',
      'client-1',
      'maker_send:failed-before-dispatch',
    );
  });

  it('returns host-send failure before dispatch when the existing session workdir is missing', async () => {
    const { deps, session } = createDeps({
      checkWorkDirExists: vi.fn(async () => false),
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(transaction.sendToAgentAccepted('session-1', 'hello')).resolves.toEqual({
      accepted: false,
      reason: 'WORKDIR_MISSING',
      outcome: {
        kind: 'host-send',
        accepted: false,
        code: 'WORKDIR_MISSING',
        message: 'working directory is missing for session session-1',
      },
    });

    expect(deps.checkWorkDirExists).toHaveBeenCalledWith('session-1', 'C:\\repo', 'codex', null);
    expect(session.send).not.toHaveBeenCalled();
  });

  it('rebuilds an error session through lazy bootstrap before dispatch', async () => {
    const failedSession = createSession({
      getStatus: vi.fn(() => 'error' as const),
    });
    const recoveredSession = createSession({ id: 'session-1', workDir: 'C:\\repo' });
    const createOpts: MakerSessionCreateOpts = {
      id: 'session-1',
      agentKind: 'codex',
      workingDir: 'C:\\repo',
      model: 'gpt-5.4',
    };
    const { deps } = createDeps({
      getSession: vi.fn(() => failedSession),
      bootstrapSession: vi.fn(async () => ({
        session: recoveredSession,
        didInjectOrcaInstructions: false,
        didInjectProjectContext: false,
      })),
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(transaction.sendToAgentAccepted('session-1', 'hello', createOpts)).resolves.toMatchObject({
      accepted: true,
      outcome: { kind: 'session-dispatch', dispatched: true },
    });

    expect(failedSession.send).not.toHaveBeenCalled();
    expect(deps.bootstrapSession).toHaveBeenCalledWith(createOpts);
    expect(recoveredSession.send).toHaveBeenCalled();
  });

  it('lazy-create adopts the DB working_dir when the caller-provided one is stale', async () => {
    // 场景:输入队列崩溃快照回放,createOpts 内嵌启动 sweep 改写前的老路径。
    const staleDir = '/data/xdt-maker/dialogues/2026-06-22/lazy-1';
    const dbDir = '/data/Cindy/dialogues/2026-06-22/lazy-1';
    const checkWorkDirExists = vi.fn(async (_sid: string, dir: string | undefined | null) => dir === dbDir);
    const { deps } = createDeps({
      getSession: vi.fn(() => undefined),
      checkWorkDirExists,
      readSessionWorkingDirFromDb: vi.fn(async () => dbDir),
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(
      transaction.sendToAgentAccepted('lazy-1', 'hello', {
        agentKind: 'codex',
        model: 'gpt-5.5',
        workingDir: staleDir,
      }),
    ).resolves.toMatchObject({ accepted: true });

    // 首检拿 caller 值且静默(有 DB 兜底候选);兜底检拿 DB 值正常广播语义。
    expect(checkWorkDirExists).toHaveBeenNthCalledWith(1, 'lazy-1', staleDir, 'codex', undefined, {
      suppressMissingBroadcast: true,
    });
    expect(checkWorkDirExists).toHaveBeenNthCalledWith(2, 'lazy-1', dbDir, 'codex', undefined);
    // bootstrap 用采纳后的 DB 路径 spawn。
    expect(deps.bootstrapSession).toHaveBeenCalledWith(expect.objectContaining({ workingDir: dbDir }));
  });

  it('lazy-create still fails with WORKDIR_MISSING when caller and DB workdirs are both gone', async () => {
    const { deps } = createDeps({
      getSession: vi.fn(() => undefined),
      checkWorkDirExists: vi.fn(async () => false),
      readSessionWorkingDirFromDb: vi.fn(async () => '/db/also-gone'),
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(
      transaction.sendToAgentAccepted('lazy-2', 'hello', {
        agentKind: 'codex',
        model: 'gpt-5.5',
        workingDir: '/stale/gone',
      }),
    ).resolves.toMatchObject({ accepted: false, reason: 'WORKDIR_MISSING' });
    expect(deps.bootstrapSession).not.toHaveBeenCalled();
  });

  it('rejects missing sessions when create opts are not provided', async () => {
    const { deps } = createDeps({
      getSession: vi.fn(() => undefined),
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(transaction.sendToAgentAccepted('missing-session', 'hello')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(deps.ensureRemoteReadyForSessionStart).toHaveBeenCalledWith({
      session: undefined,
      createOpts: undefined,
    });
    expect(deps.bootstrapSession).not.toHaveBeenCalled();
  });

  it('lazy-creates a missing session before sending and broadcasts the created session', async () => {
    const lazySession = createSession({ id: 'lazy-session', workDir: 'D:\\lazy' });
    const { deps } = createDeps({
      getSession: vi.fn(() => undefined),
      bootstrapSession: vi.fn(async () => ({
        session: lazySession,
        didInjectOrcaInstructions: true,
        didInjectProjectContext: true,
      })),
    });
    const transaction = createMakerSendTransaction(deps);
    const createOpts: MakerSessionCreateOpts = {
      id: 'lazy-session',
      agentKind: 'claude-code',
      workingDir: 'D:\\lazy',
      model: 'claude-opus-4-7',
    };

    await expect(transaction.sendToAgentAccepted('lazy-session', 'hello', createOpts)).resolves.toMatchObject({
      accepted: true,
      outcome: { kind: 'session-dispatch', dispatched: true },
    });

    expect(deps.checkWorkDirExists).toHaveBeenCalledWith('lazy-session', 'D:\\lazy', 'claude-code', undefined);
    expect(deps.synthesizeOrcaVendorOptionsFromDb).toHaveBeenCalledWith('lazy-session', createOpts);
    expect(deps.bootstrapSession).toHaveBeenCalledWith(createOpts);
    expect(deps.markOrcaRoleIfNeeded).toHaveBeenCalledWith('lazy-session', undefined);
    expect(deps.broadcastSessionCreated).toHaveBeenCalledWith('lazy-session');
    expect(lazySession.send).toHaveBeenCalled();
  });

  it('returns lazy-create failure without dispatching when bootstrap fails', async () => {
    const { deps } = createDeps({
      getSession: vi.fn(() => undefined),
      bootstrapSession: vi.fn(async () => {
        throw new Error('bootstrap exploded');
      }),
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(
      transaction.sendToAgentAccepted('lazy-session', 'hello', {
        id: 'lazy-session',
        agentKind: 'codex',
        workingDir: 'D:\\lazy',
        model: 'gpt-5.4',
      }),
    ).resolves.toEqual({
      accepted: false,
      reason: 'LAZY_CREATE_FAILED',
      outcome: {
        kind: 'host-send',
        accepted: false,
        code: 'LAZY_CREATE_FAILED',
        message: 'bootstrap exploded',
      },
    });
    expect(deps.broadcastSessionCreated).not.toHaveBeenCalled();
  });

  it('projects a stable marker with a safe fallback when lazy-create Codex resume preparation is blocked', async () => {
    const diagnostic = 'Codex thread private-id is not safe to resume yet';
    const { deps } = createDeps({
      getSession: vi.fn(() => undefined),
      bootstrapSession: vi.fn(async () => {
        throw new CodexResumePreparationBlockedError(diagnostic);
      }),
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(
      transaction.sendToAgentAccepted('lazy-session', 'hello', {
        id: 'lazy-session',
        agentKind: 'codex',
        workingDir: 'D:\\lazy',
        model: 'gpt-5.4',
      }),
    ).resolves.toEqual({
      accepted: false,
      reason: 'LAZY_CREATE_FAILED',
      outcome: {
        kind: 'host-send',
        accepted: false,
        code: 'LAZY_CREATE_FAILED',
        message: CODEX_RESUME_NOT_READY_WIRE_MESSAGE,
      },
    });
    expect(deps.log.warn).toHaveBeenCalledWith(
      'send: Codex resume preparation blocked during lazy create',
      { sessionId: 'lazy-session', error: diagnostic },
    );
  });

  it('maps lazy-create credential busy to CREDENTIAL_SWITCH_BUSY without dispatching', async () => {
    const { deps } = createDeps({
      getSession: vi.fn(() => undefined),
      bootstrapSession: vi.fn(async () => {
        throw new CredentialModeSwitchBusyError(['busy-session']);
      }),
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(
      transaction.sendToAgentAccepted('lazy-session', 'hello', {
        id: 'lazy-session',
        agentKind: 'codex',
        workingDir: 'D:\\lazy',
        model: 'gpt-5.4',
      }),
    ).resolves.toMatchObject({
      accepted: false,
      reason: 'CREDENTIAL_SWITCH_BUSY',
      outcome: {
        kind: 'host-send',
        code: 'CREDENTIAL_SWITCH_BUSY',
      },
    });
    expect(deps.broadcastSessionCreated).not.toHaveBeenCalled();
    expect(deps.prepareSendUserMessage).not.toHaveBeenCalled();
  });

  it('rehydrates an active Orca session before sending when MCP vendor options are stale', async () => {
    const oldSession = createSession({ id: 'orca-session', workDir: 'C:\\repo' });
    const newSession = createSession({ id: 'orca-session', workDir: 'C:\\repo' });
    const { deps } = createDeps({
      getSession: vi.fn(() => oldSession),
      isOrcaMcpHydrated: vi.fn(() => false),
      synthesizeOrcaVendorOptionsFromDb: vi.fn(async () => true),
      readSessionExtraDirsFromDb: vi.fn(async () => ['C:\\shared']),
      bootstrapSession: vi.fn(async () => ({
        session: newSession,
        didInjectOrcaInstructions: true,
        didInjectProjectContext: false,
      })),
    });
    const transaction = createMakerSendTransaction(deps);
    const createOpts: MakerSessionCreateOpts = {
      id: 'orca-session',
      agentKind: 'codex',
      workingDir: 'C:\\repo',
      model: 'gpt-5.4',
      orcaRole: 'lead',
    };

    await expect(transaction.sendToAgentAccepted('orca-session', 'hello', createOpts)).resolves.toMatchObject({
      accepted: true,
    });

    expect(deps.withRehydrateCloseSuppressed).toHaveBeenCalledWith('orca-session', expect.any(Function));
    expect(deps.closeSession).toHaveBeenCalledWith('orca-session');
    expect(deps.bootstrapSession).toHaveBeenCalledWith(expect.objectContaining({
      extraDirs: ['C:\\shared'],
    }));
    expect(deps.markOrcaRoleIfNeeded).toHaveBeenCalledWith('orca-session', 'lead');
    expect(oldSession.send).not.toHaveBeenCalled();
    expect(newSession.send).toHaveBeenCalled();
  });

  it('returns rehydrate failure without sending when active Orca rehydrate fails', async () => {
    const oldSession = createSession({ id: 'orca-session', workDir: 'C:\\repo' });
    const { deps } = createDeps({
      getSession: vi.fn(() => oldSession),
      isOrcaMcpHydrated: vi.fn(() => false),
      synthesizeOrcaVendorOptionsFromDb: vi.fn(async () => true),
      withRehydrateCloseSuppressed: vi.fn(async () => {
        throw new Error('rehydrate exploded');
      }),
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(
      transaction.sendToAgentAccepted('orca-session', 'hello', {
        id: 'orca-session',
        agentKind: 'codex',
        workingDir: 'C:\\repo',
        model: 'gpt-5.4',
      }),
    ).resolves.toEqual({
      accepted: false,
      reason: 'REHYDRATE_FAILED',
      outcome: {
        kind: 'host-send',
        accepted: false,
        code: 'REHYDRATE_FAILED',
        message: 'rehydrate exploded',
      },
    });

    expect(oldSession.send).not.toHaveBeenCalled();
  });

  it('projects a stable marker with a safe fallback when rehydrate Codex resume preparation is blocked', async () => {
    const diagnostic = 'Codex thread private-id still has a live rollout writer';
    const oldSession = createSession({ id: 'orca-session', workDir: 'C:\\repo' });
    const { deps } = createDeps({
      getSession: vi.fn(() => oldSession),
      isOrcaMcpHydrated: vi.fn(() => false),
      synthesizeOrcaVendorOptionsFromDb: vi.fn(async () => true),
      withRehydrateCloseSuppressed: vi.fn(async () => {
        throw new CodexResumePreparationBlockedError(diagnostic);
      }),
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(
      transaction.sendToAgentAccepted('orca-session', 'hello', {
        id: 'orca-session',
        agentKind: 'codex',
        workingDir: 'C:\\repo',
        model: 'gpt-5.4',
      }),
    ).resolves.toEqual({
      accepted: false,
      reason: 'REHYDRATE_FAILED',
      outcome: {
        kind: 'host-send',
        accepted: false,
        code: 'REHYDRATE_FAILED',
        message: CODEX_RESUME_NOT_READY_WIRE_MESSAGE,
      },
    });
    expect(deps.log.warn).toHaveBeenCalledWith(
      'send: Codex resume preparation blocked during rehydrate',
      { sessionId: 'orca-session', error: diagnostic },
    );
    expect(oldSession.send).not.toHaveBeenCalled();
  });

  it('maps rehydrate credential busy to CREDENTIAL_SWITCH_BUSY without sending', async () => {
    const oldSession = createSession({ id: 'orca-session', workDir: 'C:\\repo' });
    const { deps } = createDeps({
      getSession: vi.fn(() => oldSession),
      isOrcaMcpHydrated: vi.fn(() => false),
      synthesizeOrcaVendorOptionsFromDb: vi.fn(async () => true),
      withRehydrateCloseSuppressed: vi.fn(async () => {
        throw new CredentialModeSwitchBusyError(['busy-session']);
      }),
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(
      transaction.sendToAgentAccepted('orca-session', 'hello', {
        id: 'orca-session',
        agentKind: 'codex',
        workingDir: 'C:\\repo',
        model: 'gpt-5.4',
      }),
    ).resolves.toMatchObject({
      accepted: false,
      reason: 'CREDENTIAL_SWITCH_BUSY',
      outcome: {
        kind: 'host-send',
        code: 'CREDENTIAL_SWITCH_BUSY',
      },
    });

    expect(oldSession.send).not.toHaveBeenCalled();
    expect(deps.prepareSendUserMessage).not.toHaveBeenCalled();
  });

  it('does not rehydrate stale Orca sessions while a turn is running', async () => {
    const runningSession = createSession({
      id: 'orca-session',
      isTurnRunning: vi.fn(() => true),
    });
    const { deps } = createDeps({
      getSession: vi.fn(() => runningSession),
      isOrcaMcpHydrated: vi.fn(() => false),
      synthesizeOrcaVendorOptionsFromDb: vi.fn(async () => true),
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(
      transaction.sendToAgentAccepted('orca-session', 'hello', {
        id: 'orca-session',
        agentKind: 'codex',
        workingDir: 'C:\\repo',
        model: 'gpt-5.4',
      }),
    ).rejects.toMatchObject({ code: 'SESSION_RUNNING' });

    expect(deps.checkWorkDirExists).not.toHaveBeenCalled();
    expect(deps.ensureRemoteReadyForSessionStart).not.toHaveBeenCalled();
    expect(deps.synthesizeOrcaVendorOptionsFromDb).not.toHaveBeenCalled();
    expect(deps.withRehydrateCloseSuppressed).not.toHaveBeenCalled();
    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.prepareSendUserMessage).not.toHaveBeenCalled();
    expect(runningSession.send).not.toHaveBeenCalled();
  });

  it('maps a running error thrown by send to SESSION_RUNNING', async () => {
    const runningError = Object.assign(new Error('SESSION_RUNNING: race'), {
      code: 'SESSION_RUNNING',
    });
    const session = createSession({
      send: vi.fn(async () => {
        throw runningError;
      }),
    });
    const { deps } = createDeps({
      getSession: vi.fn(() => session),
      isSessionRunningError: vi.fn((err) => err === runningError),
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(transaction.sendToAgentAccepted('session-1', 'hello')).rejects.toMatchObject({
      code: 'SESSION_RUNNING',
    });
  });

  it('maps cancelled-before-dispatch send results to accepted false', async () => {
    const session = createSession({
      send: vi.fn(async () => (
        { accepted: false, reason: 'cancelled-before-dispatch' } satisfies SessionSendResult
      )),
    });
    const { deps } = createDeps({
      getSession: vi.fn(() => session),
    });
    const transaction = createMakerSendTransaction(deps);

    await expect(transaction.sendToAgentAccepted('session-1', 'hello')).resolves.toEqual({
      accepted: false,
      reason: 'cancelled-before-dispatch',
      outcome: {
        kind: 'session-dispatch',
        source: 'maker-ipc',
        dispatched: false,
        reason: 'cancelled-before-dispatch',
        context: 'SEND/session-1/send',
        message: 'Session send was cancelled before vendor dispatch: SEND/session-1/send',
      },
    });
  });

  it('ignores caller-provided persisted message createdAt', async () => {
    const { deps } = createDeps();
    const transaction = createMakerSendTransaction(deps);

    await transaction.sendToAgentAccepted('session-1', 'hello', undefined, {
      persistUserMessage: {
        clientId: 'client-1',
        content: 'hello',
        createdAt: 'not-a-date',
      },
    });

    const persistedMessage = vi.mocked(deps.createDbMessage).mock.calls[0]?.[1];
    expect(persistedMessage).not.toHaveProperty('createdAt');
  });
});

describe('mobile client prompt note', () => {
  it('keeps ordinary mobile messages annotated on the wire but persists the original text', async () => {
    const session = createSession({ agentKind: 'claude-code' });
    const { deps } = createDeps({
      getSession: vi.fn(() => session),
      isMobileClientInvoke: vi.fn(() => true),
    });
    const transaction = createMakerSendTransaction(deps);

    await transaction.sendToAgentAccepted('session-1', 'hello', undefined, {
      persistUserMessage: { clientId: 'mobile-1', content: 'hello' },
    });

    const sent = vi.mocked(session.send).mock.calls[0]?.[0];
    expect(sent).toEqual(expect.stringMatching(/^\[客户端说明\]/));
    expect(sent).toEqual(expect.stringMatching(/\n\nhello$/));
    expect(vi.mocked(deps.createDbMessage).mock.calls[0]?.[1].content).toBe('hello');
  });

  it('sends mobile Claude Code /compact commands without a prepended note', async () => {
    const session = createSession({ agentKind: 'claude-code' });
    const { deps } = createDeps({
      getSession: vi.fn(() => session),
      isMobileClientInvoke: vi.fn(() => true),
    });
    const transaction = createMakerSendTransaction(deps);

    await transaction.sendToAgentAccepted('session-1', '/compact focus on decisions');

    expect(session.send).toHaveBeenCalledWith('/compact focus on decisions', expect.anything());
  });

  it('keeps the mobile note for /compact text sent to a non-Claude agent', async () => {
    const session = createSession({ agentKind: 'pi' });
    const { deps } = createDeps({
      getSession: vi.fn(() => session),
      isMobileClientInvoke: vi.fn(() => true),
    });
    const transaction = createMakerSendTransaction(deps);

    await transaction.sendToAgentAccepted('session-1', '/compact');

    const sent = vi.mocked(session.send).mock.calls[0]?.[0];
    expect(sent).toEqual(expect.stringMatching(/^\[客户端说明\]/));
  });

  it('applies the same command bypass to coordinator-drained mobile messages', async () => {
    const session = createSession({ agentKind: 'claude-code' });
    const { deps } = createDeps({
      getSession: vi.fn(() => session),
      isMobileClientInvoke: vi.fn(() => false),
    });
    const transaction = createMakerSendTransaction(deps);

    await transaction.sendToAgentAccepted(
      'session-1',
      { type: 'user', content: '/compact' },
      undefined,
      { fromMobileClient: true },
    );

    expect(session.send).toHaveBeenCalledWith(
      { type: 'user', content: '/compact' },
      expect.anything(),
    );
  });
});

describe('session-agent-switch handoff injection', () => {
  it('pending 命中时 wire payload 前置交接段,落库内容保持用户原文,accepted 后 consume', async () => {
    const consumePendingHandoff = vi.fn();
    const { deps, session } = createDeps({
      peekPendingHandoff: vi.fn(async () => 'HANDOFF-TEXT'),
      consumePendingHandoff,
    });
    const transaction = createMakerSendTransaction(deps);

    await transaction.sendToAgentAccepted('session-1', { type: 'user', content: '新消息' }, undefined, {
      persistUserMessage: { clientId: 'client-1', content: '{"text":"新消息","images":[],"files":[]}' },
    });

    // wire:前缀注入
    expect(session.send).toHaveBeenCalledWith(
      { type: 'user', content: 'HANDOFF-TEXT\n\n新消息' },
      expect.anything(),
    );
    // 落库:用户原文,不带交接段(display 与 sent 分离)
    const persisted = vi.mocked(deps.createDbMessage).mock.calls[0]?.[1];
    expect(persisted?.content).toBe('{"text":"新消息","images":[],"files":[]}');
    expect(consumePendingHandoff).toHaveBeenCalledWith('session-1');
  });

  it('dispatch 未 accepted 时不 consume(pending 保留下次重试)', async () => {
    const consumePendingHandoff = vi.fn();
    const session = createSession({
      send: vi.fn(async () => ({ accepted: false, reason: 'cancelled-before-dispatch' }) as SessionSendResult),
    });
    const { deps } = createDeps({
      getSession: vi.fn(() => session),
      peekPendingHandoff: vi.fn(async () => 'HANDOFF-TEXT'),
      consumePendingHandoff,
    });
    const transaction = createMakerSendTransaction(deps);

    await transaction.sendToAgentAccepted('session-1', 'hi', undefined, {});
    expect(consumePendingHandoff).not.toHaveBeenCalled();
  });

  it('无 pending 时 wire payload 原样透传', async () => {
    const consumePendingHandoff = vi.fn();
    const { deps, session } = createDeps({
      peekPendingHandoff: vi.fn(async () => null),
      consumePendingHandoff,
    });
    const transaction = createMakerSendTransaction(deps);

    await transaction.sendToAgentAccepted('session-1', { type: 'user', content: '新消息' }, undefined, {});
    expect(session.send).toHaveBeenCalledWith({ type: 'user', content: '新消息' }, expect.anything());
    expect(consumePendingHandoff).not.toHaveBeenCalled();
  });

  it('计划对账段命中时前置进 wire payload,落库内容保持用户原文', async () => {
    const { deps, session } = createDeps({
      peekPlanReconcileNote: vi.fn(async () => 'RECONCILE-NOTE'),
    });
    const transaction = createMakerSendTransaction(deps);

    await transaction.sendToAgentAccepted('session-1', { type: 'user', content: '新消息' }, undefined, {
      persistUserMessage: { clientId: 'client-1', content: '{"text":"新消息","images":[],"files":[]}' },
    });

    expect(session.send).toHaveBeenCalledWith(
      { type: 'user', content: 'RECONCILE-NOTE\n\n新消息' },
      expect.anything(),
    );
    const persisted = vi.mocked(deps.createDbMessage).mock.calls[0]?.[1];
    expect(persisted?.content).toBe('{"text":"新消息","images":[],"files":[]}');
  });

  it('计划对账在交接段外层(对账在前、交接在后)', async () => {
    const { deps, session } = createDeps({
      peekPendingHandoff: vi.fn(async () => 'HANDOFF-TEXT'),
      consumePendingHandoff: vi.fn(),
      peekPlanReconcileNote: vi.fn(async () => 'RECONCILE-NOTE'),
    });
    const transaction = createMakerSendTransaction(deps);

    await transaction.sendToAgentAccepted('session-1', { type: 'user', content: '新消息' }, undefined, {
      persistUserMessage: { clientId: 'client-1', content: '{"text":"新消息","images":[],"files":[]}' },
    });
    expect(session.send).toHaveBeenCalledWith(
      { type: 'user', content: 'RECONCILE-NOTE\n\nHANDOFF-TEXT\n\n新消息' },
      expect.anything(),
    );
  });

  it('内部派发(scheduler / 自动续跑)不注入对账', async () => {
    const peekPlanReconcileNote = vi.fn(async () => 'RECONCILE-NOTE');
    const { deps, session } = createDeps({ peekPlanReconcileNote });
    const transaction = createMakerSendTransaction(deps);

    // scheduler 定时消息(顶层 origin)
    await transaction.sendToAgentAccepted('session-1', { type: 'user', content: '定时活' }, undefined, {
      origin: { kind: 'scheduler', scheduleId: 's1', scheduleName: 'n' },
    });
    expect(session.send).toHaveBeenLastCalledWith(
      { type: 'user', content: '定时活' },
      expect.anything(),
    );

    // 自动续跑(persistUserMessage.autoResume)
    await transaction.sendToAgentAccepted('session-1', { type: 'user', content: '继续' }, undefined, {
      persistUserMessage: { clientId: 'c2', content: '继续', autoResume: true },
    });
    expect(session.send).toHaveBeenLastCalledWith(
      { type: 'user', content: '继续' },
      expect.anything(),
    );

    // /compact 等斜杠控制消息(落库是 stringifyUserContent 信封,判据须解开信封)
    await transaction.sendToAgentAccepted('session-1', { type: 'user', content: '/compact' }, undefined, {
      persistUserMessage: { clientId: 'c3', content: '{"text":"/compact","images":[],"files":[]}' },
    });
    expect(session.send).toHaveBeenLastCalledWith(
      { type: 'user', content: '/compact' },
      expect.anything(),
    );

    // coordinator 的合成续跑指令([UI_ACTION_TRIGGER] 前缀,信封形态)
    await transaction.sendToAgentAccepted('session-1', { type: 'user', content: '[UI_ACTION_TRIGGER]Continue' }, undefined, {
      persistUserMessage: { clientId: 'c4', content: '{"text":"[UI_ACTION_TRIGGER]Continue"}' },
    });
    expect(session.send).toHaveBeenLastCalledWith(
      { type: 'user', content: '[UI_ACTION_TRIGGER]Continue' },
      expect.anything(),
    );

    // 不落可显示 user 行的派发(无 persistUserMessage)
    await transaction.sendToAgentAccepted('session-1', { type: 'user', content: '内部控制' }, undefined, {});
    expect(session.send).toHaveBeenLastCalledWith(
      { type: 'user', content: '内部控制' },
      expect.anything(),
    );

    // 内部派发路径不应触发对账查询
    expect(peekPlanReconcileNote).not.toHaveBeenCalled();
  });

  it('按信封里的 slash 范围区分控制指令与绝对路径开头的真实提问', async () => {
    const peekPlanReconcileNote = vi.fn(async () => 'RECONCILE-NOTE');
    const { deps, session } = createDeps({ peekPlanReconcileNote });
    const transaction = createMakerSendTransaction(deps);

    // `/tmp/build.log 为什么失败` 是普通提问:Composer 写了空的 slashCommandRanges
    // (= 确认没有指令),不能因首字符 '/' 就绕过对账(review P2)。
    await transaction.sendToAgentAccepted(
      'session-1',
      { type: 'user', content: '/tmp/build.log 为什么失败' },
      undefined,
      {
        persistUserMessage: {
          clientId: 'c-path',
          content: '{"text":"/tmp/build.log 为什么失败","images":[],"files":[],"slashCommandRanges":[]}',
        },
      },
    );
    expect(session.send).toHaveBeenLastCalledWith(
      { type: 'user', content: 'RECONCILE-NOTE\n\n/tmp/build.log 为什么失败' },
      expect.anything(),
    );

    // 真正的控制指令带起点为 0 的范围:照旧排除。
    await transaction.sendToAgentAccepted(
      'session-1',
      { type: 'user', content: '/compact' },
      undefined,
      {
        persistUserMessage: {
          clientId: 'c-cmd',
          content: '{"text":"/compact","images":[],"files":[],"slashCommandRanges":[{"start":0,"end":8}]}',
        },
      },
    );
    expect(session.send).toHaveBeenLastCalledWith(
      { type: 'user', content: '/compact' },
      expect.anything(),
    );

    // 正文中段出现的指令形态(范围起点非 0)仍是真实提问。
    await transaction.sendToAgentAccepted(
      'session-1',
      { type: 'user', content: '解释一下 /compact 做了什么' },
      undefined,
      {
        persistUserMessage: {
          clientId: 'c-mid',
          content: '{"text":"解释一下 /compact 做了什么","images":[],"files":[],"slashCommandRanges":[{"start":5,"end":13}]}',
        },
      },
    );
    expect(session.send).toHaveBeenLastCalledWith(
      { type: 'user', content: 'RECONCILE-NOTE\n\n解释一下 /compact 做了什么' },
      expect.anything(),
    );
  });

  it('计划对账覆盖仅附件轮次(正文空,带图片/文件)', async () => {
    const peekPlanReconcileNote = vi.fn(async () => 'RECONCILE-NOTE');
    const { deps, session } = createDeps({ peekPlanReconcileNote });
    const transaction = createMakerSendTransaction(deps);

    await transaction.sendToAgentAccepted(
      'session-1',
      { type: 'user', content: [{ type: 'image', source: 'img-1' }] },
      undefined,
      {
        persistUserMessage: {
          clientId: 'att-1',
          content: '{"text":"","images":["img-1"],"files":[]}',
        },
      },
    );

    expect(peekPlanReconcileNote).toHaveBeenCalledWith('session-1');
  });

  it('对账读取抛错时静默跳过,不挡发送', async () => {
    const { deps, session } = createDeps({
      peekPlanReconcileNote: vi.fn(async () => {
        throw new Error('db unavailable');
      }),
    });
    const transaction = createMakerSendTransaction(deps);

    await transaction.sendToAgentAccepted('session-1', { type: 'user', content: '新消息' }, undefined, {});
    expect(session.send).toHaveBeenCalledWith({ type: 'user', content: '新消息' }, expect.anything());
  });

  it('lazy-create 前调用 reconcileCreateOptsWithDb 以 DB 行校正 createOpts', async () => {
    const reconcile = vi.fn(async (_sessionId: string, co: MakerSessionCreateOpts) => {
      co.agentKind = 'codex';
      co.resumeSessionId = undefined;
    });
    const { deps } = createDeps({
      getSession: vi.fn(() => undefined),
      reconcileCreateOptsWithDb: reconcile,
    });
    const transaction = createMakerSendTransaction(deps);

    await transaction.sendToAgentAccepted(
      'session-1',
      'hi',
      { agentKind: 'claude-code', workingDir: '/tmp/w', resumeSessionId: 'stale-sdk' },
      {},
    );
    expect(reconcile).toHaveBeenCalledTimes(1);
    const bootstrapOpts = vi.mocked(deps.bootstrapSession).mock.calls[0][0];
    expect(bootstrapOpts.agentKind).toBe('codex');
    expect(bootstrapOpts.resumeSessionId).toBeUndefined();
  });

  it('排队 drain 端到端:切换在派发时刻落实(关旧引擎)→ createOpts 按 DB 对齐新引擎 → 交接注入新引擎首条 + scheduler origin 透传', async () => {
    // 复刻 coordinator drain 一条排队 scheduler 心跳时对 sendToAgentAccepted 的调用:
    // 入队的是裸 prompt(不含交接)+ 旧引擎(claude-code)createOpts。drain 时会话已
    // 空闲 → applyPendingAgentSwitch 落实切换关掉旧引擎 live session(getSession 为空)
    // → reconcileCreateOptsWithDb 把 createOpts 对齐到新引擎(codex)→ lazy-create 出新
    // 引擎 → pending 交接前缀注入发往新引擎的首条消息。证明排队路径不跳过交接。
    const callOrder: string[] = [];
    const consumePendingHandoff = vi.fn(() => {
      callOrder.push('consume');
    });
    let newEngineSession: MakerSendTransactionSession | null = null;
    const { deps } = createDeps({
      // 切换已关闭旧引擎 live session → drain 时拿不到,走 lazy-create。
      getSession: vi.fn(() => {
        callOrder.push('getSession');
        return undefined;
      }),
      applyPendingAgentSwitch: vi.fn(async () => {
        callOrder.push('applySwitch');
      }),
      // DB 真源:切换后 agentKind=codex,旧引擎原生会话 id 作废。
      reconcileCreateOptsWithDb: vi.fn(async (_sid: string, co: MakerSessionCreateOpts) => {
        callOrder.push('reconcile');
        co.agentKind = 'codex';
        co.resumeSessionId = undefined;
      }),
      bootstrapSession: vi.fn(async (opts: MakerSessionCreateOpts) => {
        newEngineSession = createSession({
          id: opts.id ?? 'session-1',
          agentKind: opts.agentKind as AgentKind,
          workDir: opts.workingDir,
        });
        return { session: newEngineSession, didInjectOrcaInstructions: false, didInjectProjectContext: false };
      }),
      peekPendingHandoff: vi.fn(async () => '[切换交接] 之前在 claude-code 的进展摘要'),
      consumePendingHandoff,
    });
    const transaction = createMakerSendTransaction(deps);

    const schedulerOrigin = {
      kind: 'scheduler',
      scheduleId: 's1',
      scheduleName: 'PR #193 心跳',
      runId: 'r1',
    } as const;
    await transaction.sendToAgentAccepted(
      'session-1',
      { type: 'user', content: 'PR #193 heartbeat prompt' },
      // 入队时刻捕获的旧引擎 createOpts(stale)。
      { agentKind: 'claude-code', workingDir: '/tmp/w', resumeSessionId: 'stale-claude-sdk' },
      {
        origin: schedulerOrigin,
        persistUserMessage: { clientId: 'q-client-1', content: 'PR #193 heartbeat prompt' },
      },
    );

    // 1. 切换在拿 session 之前落实(关旧引擎),而非发送后才切。
    expect(callOrder.indexOf('applySwitch')).toBeGreaterThanOrEqual(0);
    expect(callOrder.indexOf('applySwitch')).toBeLessThan(callOrder.indexOf('getSession'));
    // 2. lazy-create 前按 DB 对齐 → 新引擎是 codex、旧原生会话 id 作废。
    const bootstrapOpts = vi.mocked(deps.bootstrapSession).mock.calls[0][0];
    expect(bootstrapOpts.agentKind).toBe('codex');
    expect(bootstrapOpts.resumeSessionId).toBeUndefined();
    // 3. 交接前缀注入发往新引擎的首条 wire 消息,且 scheduler origin 透传。
    expect(newEngineSession).not.toBeNull();
    const newSend = vi.mocked((newEngineSession as unknown as MakerSendTransactionSession).send);
    expect(newSend).toHaveBeenCalledTimes(1);
    const [sentMessage, sentOpts] = newSend.mock.calls[0];
    expect((sentMessage as { content: string }).content.startsWith('[切换交接]')).toBe(true);
    expect((sentMessage as { content: string }).content).toContain('PR #193 heartbeat prompt');
    expect((sentOpts as { origin?: unknown })?.origin).toEqual(schedulerOrigin);
    // 4. 落库是用户原文,不含交接段(display 与 sent 分离)。
    const persisted = vi.mocked(deps.createDbMessage).mock.calls[0]?.[1];
    expect(persisted?.content).toBe('PR #193 heartbeat prompt');
    // 5. accepted 之后才消费交接(未派发则保留下次重试)。
    expect(consumePendingHandoff).toHaveBeenCalledWith('session-1');
  });
});
