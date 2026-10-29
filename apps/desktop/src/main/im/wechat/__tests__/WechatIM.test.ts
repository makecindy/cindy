import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IMHost } from '@cindy/im';
import {
  WechatIlinkError,
  type WechatCredentials,
  type WechatTransport,
} from '@cindy/wechat-ilink';

import type { DbClient } from '../../../localDb/client/DbClient';
import {
  beginInteractionRoute, installDesktopInteractionHandler, requestHostInteraction,
} from '../../../maker-ipc/interactionRouter';
import type { SharedPermission } from '../../../maker-ipc/sharedPermission';
import { encryptWechatContextToken } from '../contextCrypto';
import { __testing, sessionIdFor, WechatIM, type WechatIMDeps } from '../WechatIM';

const mediaMocks = vi.hoisted(() => ({
  removeReleasedWechatFiles: vi.fn(async () => undefined),
}));

vi.mock('../mediaStaging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mediaStaging')>();
  return {
    ...actual,
    removeReleasedWechatFiles: mediaMocks.removeReleasedWechatFiles,
  };
});

describe('WechatIM host boundary', () => {
  it('clears reconnecting after an empty successful poll', async () => {
    vi.useFakeTimers();
    const { im, transport, db } = restoredConnection(() => 0);
    const poll = vi.spyOn(transport, 'poll');
    poll.mockRejectedValueOnce(new WechatIlinkError('NETWORK_ERROR', 'offline', true));
    poll.mockResolvedValueOnce({ cursor: 'recovered', messages: [] });
    vi.mocked(db.tx).mockImplementation((async (name: string) =>
      name === 'wechatCommitPollBatch' ? {
        committed: true, insertedTaskIds: [], duplicateTaskIds: [], rejectedTaskIds: [],
      } : null) as DbClient['tx']);
    try {
      await im.init();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(poll).toHaveBeenCalledTimes(3);
      expect(im.getState().phase).toBe('connected');
      expect(im.getState().errorCode).toBeUndefined();
    } finally {
      await im.dispose();
      vi.useRealTimers();
    }
  });

  // Exercise the durable inbox through the public host lifecycle. Only the
  // credential-verified owner can request native permissions on a resolved companion route.
  it.each([
    { companion: true, peer: 'owner' },
    { companion: true, peer: 'guest' },
    { companion: true, peer: '' },
    { companion: false, peer: 'owner' },
  ])('preserves the permission boundary: %j', async ({ companion, peer }) => {
    const { im, db } = restoredConnection(() => 0);
    let leased = false;
    vi.mocked(db.tx).mockImplementation((async (name: string) => {
      if (name !== 'wechatLeaseNextTask' || leased) return null;
      leased = true;
      return {
        id: 'permission-task', bindingEpoch: 'epoch', peerId: peer,
        sessionId: 'permission-session', conversationEpoch: 1,
        payloadJson: JSON.stringify({ text: 'hello', attachments: [], unsupportedMedia: [] }),
        context: encryptWechatContextToken('context', Buffer.alloc(32, 3), 'epoch', 'permission-task'),
        attempts: 0, receivedAt: 1, expiresAt: Date.now() + 60_000,
      };
    }) as DbClient['tx']);
    const dispatchAgentTurn = vi.fn(async (_input: {
      turnPermissionPolicy?: { confirmationSurface: string }; requesterIsOwner?: boolean;
      inheritCompanionOwnerPermissions?: boolean;
      groupHistoryAccess?: { access: string; lane: { chatId: string; threadId: string } };
    }) => {
      void _input;
      return { kind: 'accepted', terminal: Promise.resolve({ kind: 'done' }) };
    });
    im.attachTurnRuntime({ runner: {
      companionBotIdFor: () => companion ? 'cindy' : undefined,
      dispatchAgentTurn,
    } } as never);
    await im.init();
    try {
      await vi.waitFor(() => expect(dispatchAgentTurn).toHaveBeenCalledOnce());
      const input = dispatchAgentTurn.mock.calls[0]![0];
      expect(input.inheritCompanionOwnerPermissions).toBe(true);
      expect(input.requesterIsOwner).toBe(companion ? peer === 'owner' : undefined);
      expect(input.turnPermissionPolicy?.confirmationSurface).toBe('channel');
      expect(input.groupHistoryAccess).toMatchObject({ access: 'lane', lane: { chatId: peer, threadId: '' } });
    } finally { await im.dispose(); }
  });

  it.each([
    { text: '解释这张图', delivered: true },
    { text: '', delivered: true },
    { text: '解释这张图', delivered: false },
  ])('keeps quoted media records separate from delivery facts: %j', ({ text, delivered }) => {
    const replyContext = __testing.formatWechatQuote({
      messageId: 'reply-1', senderId: 'peer-1', contextToken: 'context', text, media: [],
      quote: { text: '原图', media: [{ kind: 'image' }] },
    });
    const turn = __testing.prepareWechatTaskTurn(__testing.parseTaskPayload(JSON.stringify({
      text, replyContext,
      attachments: delivered ? [{
        kind: 'image', storage: 'cindy-media', absPath: 'quoted-image.png',
        originalName: 'quoted-image.png', mimeType: 'image/png',
      }] : [],
      unsupportedMedia: delivered ? [] : ['image:download-failed'],
    })));
    expect(turn.text).toBe(text);
    expect(turn.agentText).toContain('原消息记录含 1 个附件');
    expect(turn.agentText).not.toContain('见本轮消息说明');
    expect(turn.contextSnapshot?.replyMessageCount).toBe(1);
    if (text && delivered) {
      expect(turn.agentText).not.toContain('[消息说明]');
    } else if (delivered) {
      expect(turn.agentText).toContain('本轮实际提供了 1 个附件');
    } else {
      expect(turn.agentText).toContain('image:download-failed');
      expect(turn.agentText).not.toContain('本轮实际提供了');
    }
  });

  it('keeps quote and unavailable-media facts out of the original user text', () => {
    const payload = __testing.parseTaskPayload(JSON.stringify({
      text: '', replyContext: '这张图是什么意思？', attachments: [],
      unsupportedMedia: ['image:download-failed'],
    }));
    const turn = __testing.prepareWechatTaskTurn(payload);
    expect(turn.text).toBe('');
    expect(turn.agentText).toContain('这张图是什么意思？');
    expect(turn.agentText).toContain('image:download-failed');
    expect(turn.agentText).not.toMatch(/请检查|本轮仅处理文字|实际提供了/);
    expect(turn.contextSnapshot?.replyMessageCount).toBe(1);
  });

  it('reads an old queued payload without changing its text or requiring migration', () => {
    const payload = __testing.parseTaskPayload(JSON.stringify({
      text: '[引用：旧消息] 原话', attachments: [], unsupportedMedia: [],
    }));
    expect(__testing.prepareWechatTaskTurn(payload)).toEqual({
      text: '[引用：旧消息] 原话', agentText: '[引用：旧消息] 原话',
    });
  });
  beforeEach(() => {
    mediaMocks.removeReleasedWechatFiles.mockClear();
  });

  it('derives a stable session id without exposing either platform identifier', () => {
    const first = sessionIdFor('bot-secret-id', 'peer-secret-id');
    expect(first).toBe(sessionIdFor('bot-secret-id', 'peer-secret-id'));
    expect(first).toMatch(/^wechat_[a-f0-9]{32}$/);
    expect(first).not.toContain('bot-secret-id');
    expect(first).not.toContain('peer-secret-id');
  });

  it('fails closed before starting authorization when safeStorage is unavailable', async () => {
    const createTransport = vi.fn();
    const im = new WechatIM(
      deps({
        host: host({ secretAvailable: false }),
        createTransport,
      }),
    );

    await expect(im.authorize()).rejects.toThrow('WECHAT_SAFE_STORAGE_UNAVAILABLE');
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('never emulates rich cards for the chunked-text WeChat channel', async () => {
    const im = new WechatIM(deps());

    await expect(im.sendInteractiveCard()).rejects.toThrow('WECHAT_RICH_OUTPUT_UNSUPPORTED');
    await expect(im.updateInteractiveCard()).rejects.toThrow('WECHAT_RICH_OUTPUT_UNSUPPORTED');
    await expect(im.patchMarkdownCard()).rejects.toThrow('WECHAT_RICH_OUTPUT_UNSUPPORTED');
    await expect(im.startStreamingText('peer')).rejects.toThrow('WECHAT_RICH_OUTPUT_UNSUPPORTED');
  });

  it('preserves empty output after filtering the final text', () => {
    expect(__testing.normalizeFinalOutputText('')).toBe('');
    expect(__testing.normalizeFinalOutputText(' \n ')).toBe('');
    expect(__testing.normalizeFinalOutputText('hello')).toBe('hello');
  });

  it('distinguishes agent-unsupported from permission-mode-unsupported pre-dispatch failures', () => {
    // 未声明 turnPermissionPolicy 的 Agent：换权限模式无效。
    expect(__testing.wechatPreDispatchFailureText('TURN_PERMISSION_POLICY_UNSUPPORTED:agent:ask')).toContain(
      '换成 Claude Code 或 Codex',
    );
    expect(__testing.wechatPreDispatchFailureText('TURN_PERMISSION_POLICY_UNSUPPORTED:agent:auto')).not.toContain(
      '权限模式',
    );
    // 当前权限模式若是换 Agent 后仍不兼容的档位(bypassPermissions / acceptEdits),
    // 换 Agent 指引应附带 /permission 提示,避免新 Agent 再次命中权限模式错误。
    expect(
      __testing.wechatPreDispatchFailureText(
        'TURN_PERMISSION_POLICY_UNSUPPORTED:agent:bypassPermissions',
      ),
    ).toContain('/permission');
    expect(
      __testing.wechatPreDispatchFailureText('TURN_PERMISSION_POLICY_UNSUPPORTED:agent:acceptEdits'),
    ).toContain('/permission');
    expect(__testing.wechatPreDispatchFailureText('TURN_PERMISSION_POLICY_UNSUPPORTED:agent:ask')).not.toContain(
      '/permission',
    );
    // 权限模式在 unsupportedPermissionModes 里(如 bypassPermissions):文案引导调权限模式。
    expect(
      __testing.wechatPreDispatchFailureText('TURN_PERMISSION_POLICY_UNSUPPORTED:mode:bypassPermissions'),
    ).toContain('权限模式');
    // 旧格式 / 渠道侧 unsupported_turn_permission 兼容分支:同样按权限模式处理。
    expect(__testing.wechatPreDispatchFailureText('TURN_PERMISSION_POLICY_UNSUPPORTED:ask')).toContain(
      '权限模式',
    );
    expect(__testing.wechatPreDispatchFailureText('unsupported_turn_permission')).toContain('权限模式');
    expect(__testing.wechatPreDispatchFailureText('missing_auth')).toContain('模型服务');
    expect(__testing.wechatPreDispatchFailureText('boom')).toContain('稍后重试');
    // Linked companions inherit their runtime: the personal-channel settings and
    // /permission advice cannot fix their configuration (PR #6492, unit).
    const companionFailure = __testing.wechatPreDispatchFailureText(
      'TURN_PERMISSION_POLICY_UNSUPPORTED:agent:bypassPermissions', true,
    );
    expect(companionFailure).toContain('伙伴设置');
    expect(companionFailure).toContain('对话输入框下方');
    expect(companionFailure).toContain('默认权限或自动审批');
    expect(companionFailure).not.toContain('/permission');
  });

  it('dispatches attachment-only WeChat messages to the agent', () => {
    expect(__testing.hasWechatTaskContent('', [])).toBe(false);
    expect(
      __testing.hasWechatTaskContent('', [
        {
          kind: 'image',
          absPath: 'wechat-image.png',
          storage: 'cindy-media',
        },
      ] as never),
    ).toBe(true);
  });

  it('排队等待 provider 受理时按 task session 回退微信 peer', () => {
    const activeTasks = new Map<
      string,
      { routeSessionId?: string; task: { sessionId: string } }
    >([
      ['peer-queued', { task: { sessionId: 'wechat-task-session' } }],
      ['peer-other', { task: { sessionId: 'other-session' } }],
    ]);

    expect(__testing.activePeerIdForSession(activeTasks, 'wechat-task-session')).toBe(
      'peer-queued',
    );

    activeTasks.get('peer-queued')!.routeSessionId = 'accepted-route-session';
    expect(__testing.activePeerIdForSession(activeTasks, 'wechat-task-session')).toBeNull();
    expect(__testing.activePeerIdForSession(activeTasks, 'accepted-route-session')).toBe(
      'peer-queued',
    );
  });

  it('keeps staged files only for accepted poll tasks', () => {
    const accepted = __testing.acceptedPollTaskIds({
      committed: true,
      insertedTaskIds: ['accepted', 'overload'],
      duplicateTaskIds: ['duplicate'],
      rejectedTaskIds: ['overload'],
    });
    expect([...accepted]).toEqual(['accepted']);
    expect(
      [...__testing.acceptedPollTaskIds({
        committed: false,
        reason: 'stale-cursor',
        activeBindingEpoch: 'binding-1',
        currentCursor: 'newer',
      })],
    ).toEqual([]);
  });

  it('marks permanent local outbox failures terminal while retaining transport retries', () => {
    expect(
      __testing.classifyOutboxSendError(
        Object.assign(new Error('missing attachment'), { code: 'ENOENT' }),
      ),
    ).toEqual({ code: 'ENOENT', retryable: false });
    expect(
      __testing.classifyOutboxSendError(
        new WechatIlinkError('NETWORK_ERROR', 'temporary network failure', true),
      ),
    ).toEqual({ code: 'NETWORK_ERROR', retryable: true });
  });

  it('stops every active peer before an epoch can finish shutting down', async () => {
    const stopActiveTurn = vi.fn(async () => ({ stopped: true }));
    await __testing.stopActiveWechatTurns(
      { stopActiveTurn } as never,
      'bot-1',
      ['peer-1', 'peer-1', 'peer-2'],
    );
    expect(stopActiveTurn).toHaveBeenCalledTimes(2);
    expect(stopActiveTurn).toHaveBeenCalledWith({
      botContextId: 'bot-1',
      userId: 'peer-1',
    });
    expect(stopActiveTurn).toHaveBeenCalledWith({
      botContextId: 'bot-1',
      userId: 'peer-2',
    });
  });

  it('returns to needs_reauth when cancelling an authorization for an existing binding', () => {
    expect(__testing.authorizationCancelPhase(false, true)).toBe('needs_reauth');
    expect(__testing.authorizationCancelPhase(false, false)).toBe('disconnected');
    expect(__testing.authorizationCancelPhase(true, true)).toBe('connected');
  });

  it('parses one-shot permission and question replies from plain WeChat text', () => {
    const permission = __testing.parseWechatInteractionReply(
      { kind: 'permission', requestId: 'r1', toolName: 'Bash', input: {} },
      '允许',
    );
    expect(permission).toEqual({ kind: 'permission', behavior: 'allow' });

    const question = __testing.parseWechatInteractionReply(
      {
        kind: 'ask_user_question',
        requestId: 'r2',
        questions: [
          {
            question: '选择环境',
            options: [{ label: '测试' }, { label: '生产' }],
          },
        ],
      },
      '2',
    );
    expect(question).toEqual({
      kind: 'ask_user_question',
      answers: { 选择环境: '生产' },
    });
  });

  it('确认提示显示要执行的具体操作和审核原因', () => {
    const prompt = __testing.formatWechatInteractionPrompt({
      kind: 'permission',
      requestId: 'request-2',
      toolName: 'mcp:cindy_browser:call_tool',
      input: { name: 'browser', args: { action: 'click', selector: '[data-testid="tweetButton"]' } },
      metadata: { autoReviewReason: '这会公开发帖。' },
    });
    expect(prompt).toContain('操作：\nclick {"selector":"[data-testid=\\"tweetButton\\"]"}');
    expect(prompt).toContain('自动审批需要你决定：这会公开发帖。');
  });

  it('自动审批故障时在微信确认提示里写明原因', () => {
    const ordinary = __testing.formatWechatInteractionPrompt({
      kind: 'permission',
      requestId: 'r-ordinary',
      toolName: 'Bash',
      input: {},
    });
    expect(ordinary).toContain('需要确认工具“Bash”');
    expect(ordinary).not.toContain('自动审批没完成');

    const unavailable = __testing.formatWechatInteractionPrompt({
      kind: 'permission',
      requestId: 'r-unavailable',
      toolName: 'Bash',
      input: {},
      metadata: { autoReviewUnavailable: true },
    });
    expect(unavailable).toContain('自动审批没完成，请确认要不要允许这次操作。');
    expect(unavailable).toContain('回复“允许”执行一次');
  });

  it('cancels only the matching one-shot interaction when its central route closes', async () => {
    const im = new WechatIM(deps());
    vi.spyOn(im, 'sendText').mockResolvedValue({ messageId: 'interaction-prompt' });
    const request = {
      kind: 'permission' as const,
      requestId: 'request-current',
      toolName: 'bash',
      input: { command: 'pnpm test' },
    };
    const pending = im.handleTextInteraction('peer-1', request, { timeoutMs: 60_000 });
    await Promise.resolve();

    expect(im.cancelTextInteraction('peer-1', 'request-stale', {
      kind: 'permission',
      behavior: 'deny',
      reason: 'stale_route',
    })).toBe(false);
    expect(im.cancelTextInteraction('peer-1', 'request-current', {
      kind: 'permission',
      behavior: 'deny',
      reason: 'interaction_route_released',
    })).toBe(true);
    await expect(pending).resolves.toEqual({
      kind: 'permission',
      behavior: 'deny',
      reason: 'interaction_route_released',
    });
  });

  it('投递失败时用稳定系统码收口，不把 Error.message 当成拒绝原因', async () => {
    const im = new WechatIM(deps());
    vi.spyOn(im, 'sendText').mockRejectedValue(new Error('socket hang up'));

    await expect(im.handleTextInteraction('peer-1', {
      kind: 'permission',
      requestId: 'request-send-failed',
      toolName: 'bash',
      input: { command: 'pnpm test' },
    })).resolves.toEqual({
      kind: 'permission',
      behavior: 'deny',
      reason: 'wechat_interaction_send_failed',
    });
  });

  // PR #6492 security regression (unit): existing text parser tests did not exercise
  // a companion guest asking for a tool permission. Use the real router + adapter:
  // no guest prompt/reply slot, owner decision wins, missing owner surface times out.
  it.each([true, false])('keeps guest tool approval on the owner surface (available=%s)', async (hasDesktop) => {
    const im = new WechatIM(deps());
    im.attachTurnRuntime({ runner: { companionBotIdFor: () => 'cindy' } } as never);
    const send = vi.spyOn(im, 'sendText').mockResolvedValue({ messageId: 'prompt' });
    const session = { id: 'guest-lane', setInteractionListener: vi.fn() };
    const request = { kind: 'permission' as const, requestId: 'guest-write',
      toolName: 'Write', input: { file_path: '/tmp/guest-write', content: 'guest input' } };
    let ownerPermission: SharedPermission | undefined;
    if (hasDesktop) installDesktopInteractionHandler(session, async (_request, shared) => {
      ownerPermission = shared;
      return shared!.result;
    });
    const lease = beginInteractionRoute(session, {
      route: { sessionId: session.id, turnId: 'turn', origin: { kind: 'im', channel: 'wechat' },
        interactionSurface: 'channel-card', requesterAuthority: 'guest', timeoutMs: 1_000 },
      handle: (req, sharedPermission) => im.handleTextInteraction('guest', req, { sharedPermission }),
    });
    vi.useFakeTimers();
    try {
      const pending = requestHostInteraction(session, request, new AbortController().signal);
      expect(send).not.toHaveBeenCalled();
      expect(im.cancelTextInteraction('guest', request.requestId,
        { kind: 'permission', behavior: 'allow' })).toBe(false);
      if (hasDesktop) {
        ownerPermission!.decide({ kind: 'permission', behavior: 'allow' });
        await expect(pending).resolves.toEqual({ kind: 'permission', behavior: 'allow' });
      } else {
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(pending).resolves.toMatchObject({ kind: 'permission', behavior: 'deny', reason: 'interaction_timeout' });
        await expect(im.handleTextInteraction('guest', request)).resolves.toMatchObject({
          kind: 'permission', behavior: 'deny', reason: 'desktop_confirmation_not_installed',
        });
      }
      expect(send).not.toHaveBeenCalled();
    } finally { lease.release(); vi.useRealTimers(); await im.dispose(); }
  });

  it('retains companion owner WeChat approvals and guest ordinary questions', async () => {
    const { im } = restoredConnection(() => 0);
    im.attachTurnRuntime({ runner: { companionBotIdFor: () => 'cindy' } } as never);
    const send = vi.spyOn(im, 'sendText').mockResolvedValue({ messageId: 'prompt' });
    await im.init();
    try {
      const permission = { kind: 'permission' as const, requestId: 'owner-write', toolName: 'Write', input: {} };
      const ownerResult = im.handleTextInteraction('owner', permission);
      expect(send).toHaveBeenCalledWith('owner', expect.stringContaining('允许'));
      expect(im.cancelTextInteraction('owner', permission.requestId, { kind: 'permission', behavior: 'allow' })).toBe(true);
      await expect(ownerResult).resolves.toEqual({ kind: 'permission', behavior: 'allow' });
      const question = { kind: 'ask_user_question' as const, requestId: 'guest-question',
        questions: [{ question: '选择格式', options: [{ label: '文本' }] }] };
      const guestResult = im.handleTextInteraction('guest', question);
      expect(send).toHaveBeenCalledWith('guest', expect.stringContaining('选择格式'));
      const answer = { kind: 'ask_user_question' as const, answers: { 选择格式: '文本' } };
      expect(im.cancelTextInteraction('guest', question.requestId, answer)).toBe(true);
      await expect(guestResult).resolves.toEqual(answer);
    } finally { await im.dispose(); }
  });

  it('fails closed before authorization when the signed compatibility policy disables it', async () => {
    const createTransport = vi.fn();
    const im = new WechatIM(
      deps({
        createTransport,
        isCompatibilityDisabled: () => true,
      }),
    );

    await expect(im.authorize()).rejects.toThrow('WECHAT_DISABLED_BY_POLICY');
    expect(im.getState()).toMatchObject({
      phase: 'disabled_by_policy',
      bound: false,
    });
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('applies and clears a runtime compatibility disable without starting a transport', async () => {
    let disabled = false;
    const im = new WechatIM(
      deps({
        isCompatibilityDisabled: () => disabled,
      }),
    );

    disabled = true;
    await im.setCompatibilityDisabled(true);
    expect(im.getState()).toMatchObject({ phase: 'disabled_by_policy', bound: false });

    disabled = false;
    await im.setCompatibilityDisabled(false);
    expect(im.getState()).toMatchObject({ phase: 'disconnected', bound: false });
  });

  // #6492 r4318608094, unit: existing policy-cancel coverage missed teammate
  // deletion during QR confirmation. Public lifecycle must cancel, finish cleanup,
  // and ignore a late authorization result without writing shared credentials.
  it.each(['policy', 'companion-deletion'])('drops late authorization credentials after %s cancellation', async (reason) => {
    const testHost = host();
    let resolveCredentials!: (credentials: WechatCredentials) => void;
    const waitAuthorization = vi.fn(
      () =>
        new Promise<WechatCredentials>((resolve) => {
          resolveCredentials = resolve;
        }),
    );
    const authorizationTransport = {
      beginAuthorization: vi.fn(async () => ({
        id: 'challenge',
        qrCodeUrl: 'https://ilinkai.weixin.qq.com/qr/challenge',
        createdAt: 1,
      })),
      waitAuthorization,
    } as unknown as WechatTransport;
    const createTransport = vi.fn(() => authorizationTransport);
    const im = new WechatIM(deps({ host: testHost, createTransport }));

    await im.authorize();
    await vi.waitFor(() => expect(waitAuthorization).toHaveBeenCalledOnce());
    if (reason === 'policy') await im.setCompatibilityDisabled(true);
    else {
      const update = vi.fn();
      await expect(im.updateCompanionBinding(update)).rejects.toThrow('WECHAT_CONNECTION_BUSY');
      await im.updateCompanionBinding(update, { cancelPendingIf: () => false });
      expect(im.getState().phase).toBe('waiting_confirmation');
      expect(update).not.toHaveBeenCalled();
      await im.updateCompanionBinding(update, { cancelPendingIf: () => true });
      expect(update).toHaveBeenCalledOnce();
      expect(vi.mocked(authorizationTransport.waitAuthorization).mock.calls[0]![1].aborted).toBe(true);
    }
    resolveCredentials({
      token: 'late-token',
      botId: 'late-bot',
      userId: 'late-user',
      baseUrl: 'https://ilinkai.weixin.qq.com',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(createTransport).toHaveBeenCalledOnce();
    expect(testHost.secrets.write).not.toHaveBeenCalled();
    expect(im.getState()).toMatchObject({ phase: reason === 'policy' ? 'disabled_by_policy' : 'disconnected', bound: false });
    await im.dispose();
  });

  it('rolls back a newly activated binding when the account generation becomes stale', async () => {
    const previous = { bindingEpoch: 'binding-previous', cursor: 'cursor-previous' };
    let activationFinished = false;
    let newBindingEpoch = '';
    const activateCalls: Array<Record<string, unknown>> = [];
    const db = fakeDb({
      queryOne: vi.fn(async (sql: string) =>
        sql.includes('FROM wechat_sync_state') ? previous : undefined,
      ) as DbClient['queryOne'],
      tx: vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name !== 'wechatActivateBindingEpoch') return null;
        activateCalls.push(args);
        if (activateCalls.length === 1) {
          newBindingEpoch = String(args.bindingEpoch);
          activationFinished = true;
          return {
            activated: true,
            previousActiveEpoch: previous.bindingEpoch,
            activeBindingEpoch: newBindingEpoch,
          };
        }
        return {
          activated: true,
          previousActiveEpoch: newBindingEpoch,
          activeBindingEpoch: previous.bindingEpoch,
        };
      }),
    });
    const testHost = host({
      secretRead: (name) =>
        name === 'wechat_data_key_v1' ? Buffer.alloc(32, 1).toString('base64') : null,
    });
    const authorizationTransport = authorizationTransportReturning({
      token: 'new-token',
      botId: 'new-bot',
      userId: 'new-user',
      baseUrl: 'https://ilinkai.weixin.qq.com',
    });
    const createTransport = vi.fn(() => authorizationTransport);
    const im = new WechatIM(
      deps({
        host: testHost,
        getDbClient: () => db,
        createTransport,
        isAccountGenerationCurrent: () => !activationFinished,
      }),
    );

    await im.authorize();
    await vi.waitFor(() => expect(activateCalls).toHaveLength(2));

    expect(activateCalls[1]).toMatchObject({
      bindingEpoch: previous.bindingEpoch,
      expectedActiveEpoch: newBindingEpoch,
      initialCursor: previous.cursor,
    });
    expect(testHost.secrets.remove).toHaveBeenCalledWith(
      `wechat_credentials_${newBindingEpoch}`,
    );
    expect(createTransport).toHaveBeenCalledOnce();
    await im.dispose();
  });

  // Regression: changing a teammate must retain credentials and cannot reroute queued messages.
  // tier: unit; exercise the public lifecycle with a restored authorization and real task store.
  it('switches an idle connection without reauthorizing and refuses queued work', async () => {
    let queued = 0;
    const { im, transport, testHost } = restoredConnection(() => queued);
    let release!: () => void;
    let entered!: () => void;
    const disposing = new Promise<void>((resolve) => { entered = resolve; });
    const disposed = new Promise<void>((resolve) => { release = resolve; });
    const disposeAllSessions = vi.fn(() => { entered(); return disposed; });
    im.attachTurnRuntime({ runner: { disposeAllSessions },
      repo: {}, config: {}, resetSessionToDefaults: vi.fn() } as never);
    await im.init();
    try {
      expect(im.isOwner('owner')).toBe(true);
      expect(im.isOwner('guest')).toBe(false);
      const update = vi.fn();
      queued = 1;
      await expect(im.updateCompanionBinding(update)).rejects.toThrow('WECHAT_CONNECTION_BUSY');
      expect(update).not.toHaveBeenCalled();
      expect(transport.notifyStop).not.toHaveBeenCalled();
      expect(disposeAllSessions).not.toHaveBeenCalled();
      queued = 0;
      const changing = im.updateCompanionBinding(update);
      // r4318350746: old background-output listeners must be gone before routing
      // changes or polling restarts. Exercise the public lifecycle, tier: unit.
      await Promise.race([disposing, changing]);
      expect(disposeAllSessions).toHaveBeenCalledOnce();
      expect(update).not.toHaveBeenCalled();
      expect(transport.notifyStart).toHaveBeenCalledOnce();
      release();
      await changing;
      expect(update).toHaveBeenCalledOnce();
      expect(im.getState().phase).toBe('connected');
      expect(transport.notifyStart).toHaveBeenCalledTimes(2);
      expect(testHost.secrets.write).not.toHaveBeenCalled();
      expect(testHost.secrets.remove).not.toHaveBeenCalled();
    } finally { await im.dispose(); }
  });

  // #6492 unit regression: disabling polling must not allow persisted input to
  // switch owners, including a cold start where no credential-backed store exists.
  it.each([false, true])('protects the policy-disabled inbox (cold start=%s)', async (cold) => {
    let queued = 1;
    const { im, transport, testHost } = restoredConnection(() => queued, cold);
    await im.init();
    if (!cold) await im.setCompatibilityDisabled(true);
    try {
      const update = vi.fn();
      await expect(im.updateCompanionBinding(update)).rejects.toThrow('WECHAT_CONNECTION_BUSY');
      expect(update).not.toHaveBeenCalled();
      queued = 0;
      await im.updateCompanionBinding(update);
      expect(update).toHaveBeenCalledOnce();
      expect(im.getState().phase).toBe('disabled_by_policy');
      expect(transport.notifyStart).toHaveBeenCalledTimes(cold ? 0 : 1);
      expect(testHost.secrets.write).not.toHaveBeenCalled();
      expect(testHost.secrets.remove).not.toHaveBeenCalled();
    } finally { await im.dispose(); }
  });

  // PR #6492: idle-switch coverage missed a poll response arriving during abort.
  // Unit: public binding switch + real task-store boundary must retain the owner
  // task and original bot context, then reject switching once that task is queued.
  it('retains the old owner identity while draining a late poll response', async () => {
    let queued = 0;
    const { im, transport, db } = restoredConnection(() => queued);
    vi.mocked(transport.poll).mockImplementationOnce((_cursor, signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ cursor: 'next', messages: [{
        senderId: 'owner', messageId: 'late-owner', text: 'hello', contextToken: 'context', media: [],
      }] }), { once: true });
    }));
    const resolveRouteTarget = vi.fn(async (_bot: string, peer: string) => ({
      row: { id: im.isOwner(peer) ? 'companion-owner' : 'companion-guest' },
    }));
    im.attachTurnRuntime({ runner: { companionBotIdFor: () => 'cindy', resolveRouteTarget },
      repo: {}, config: {}, resetSessionToDefaults: vi.fn() } as never);
    vi.mocked(db.tx).mockImplementation(async (name, args) => {
      if (name !== 'wechatCommitPollBatch') return null;
      queued += 1;
      const batch = args as { messages: Array<{ id: string }> };
      return { committed: true, insertedTaskIds: batch.messages.map((message) => message.id),
        duplicateTaskIds: [], rejectedTaskIds: [] };
    });
    await im.init();
    try {
      const update = vi.fn();
      await expect(im.updateCompanionBinding(update)).rejects.toThrow('WECHAT_CONNECTION_BUSY');
      expect(update).not.toHaveBeenCalled();
      expect(resolveRouteTarget).toHaveBeenCalledWith('wechat-bot', 'owner');
      expect(db.tx).toHaveBeenCalledWith('wechatCommitPollBatch', expect.objectContaining({
        messages: [expect.objectContaining({ peerId: 'owner', sessionId: 'companion-owner' })],
      }));
      expect(im.isOwner('owner')).toBe(true);
      expect(im.getState().phase).toBe('connected');
    } finally { await im.dispose(); }
  });

  // #6492 unit regression: deletion must include the late poll batch in its
  // cancellation, preserve authorization, and never restart after settlement failure.
  // r4318071189: one released file must reach the bounded file cleanup before
  // ownership changes; the previous regression only checked database settlement.
  it.each([false, true])('settles deletion after poll drain (failure=%s)', async (fail) => {
    const { im, transport, db, testHost } = restoredConnection(() => 1);
    const order: string[] = [];
    const released = '/isolated/im-attachments/wechat/sessions/companion-owner/queued.pdf';
    vi.mocked(db.query).mockImplementation(async (sql, params) => {
      if (!sql.includes('FROM wechat_file_attachments')) return [];
      expect(order).toContain('cancel');
      expect(sql).toContain("status = 'released'");
      expect(params).toEqual(['epoch']);
      return [{ absPath: released }];
    });
    if (!fail) mediaMocks.removeReleasedWechatFiles.mockImplementationOnce(async () => { order.push('files'); });
    im.attachTurnRuntime({ runner: { companionBotIdFor: () => 'cindy',
      resolveRouteTarget: async () => ({ row: { id: 'companion-owner' } }),
      disposeAllSessions: async () => { order.push('dispose'); } },
      repo: {}, config: {}, resetSessionToDefaults: vi.fn() } as never);
    vi.mocked(transport.poll).mockImplementationOnce((_cursor, signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ cursor: 'next', messages: [{
        senderId: 'owner', messageId: 'late-owner', text: 'hello', contextToken: 'context', media: [],
      }] }), { once: true });
    }));
    vi.mocked(db.tx).mockImplementation(async (name, args) => {
      if (name === 'wechatCommitPollBatch') {
        order.push('batch');
        return { committed: true, insertedTaskIds: [], duplicateTaskIds: [], rejectedTaskIds: [] };
      }
      if (name === 'wechatStopAll' && (args as { cancelPending?: boolean }).cancelPending) {
        order.push('cancel');
        if (fail) throw new Error('DRAIN_FAILED');
      }
      return null;
    });
    await im.init();
    try {
      const update = vi.fn(() => { order.push('update'); });
      const changing = im.updateCompanionBinding(update, { cancelPendingIf: () => true });
      if (fail) await expect(changing).rejects.toThrow('DRAIN_FAILED');
      else await changing;
      expect(order).toEqual(fail ? ['batch', 'cancel'] : ['batch', 'cancel', 'files', 'dispose', 'update']);
      if (fail) expect(mediaMocks.removeReleasedWechatFiles).not.toHaveBeenCalled();
      else expect(mediaMocks.removeReleasedWechatFiles).toHaveBeenCalledWith([released]);
      expect(transport.notifyStart).toHaveBeenCalledTimes(fail ? 1 : 2);
      expect(testHost.secrets.write).not.toHaveBeenCalled();
      expect(testHost.secrets.remove).not.toHaveBeenCalled();
    } finally { await im.dispose(); }
  });

  it('settles a stored inbox without starting an offline transport and skips a changed owner', async () => {
    const { im, transport, db } = restoredConnection(() => 1);
    const update = vi.fn();
    await im.updateCompanionBinding(update, { cancelPendingIf: () => false });
    expect(db.tx).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    await im.updateCompanionBinding(update, { cancelPendingIf: () => true });
    expect(db.tx).toHaveBeenCalledWith('wechatStopAll', expect.objectContaining({
      bindingEpoch: 'epoch', cancelPending: true, errorCode: 'COMPANION_DELETED',
    }));
    expect(update).toHaveBeenCalledOnce();
    expect(transport.notifyStart).not.toHaveBeenCalled();
  });

  // Regression: the durable inbox used to claim a personal session even for companion messages.
  // tier: unit; feed transport ingress and inspect the real task-store transaction boundary.
  it('persists companion ingress against the resolved task before dispatch', async () => {
    const { im, transport, db } = restoredConnection(() => 0);
    let receive!: (result: Awaited<ReturnType<WechatTransport['poll']>>) => void;
    vi.mocked(transport.poll).mockImplementationOnce(() => new Promise((resolve) => { receive = resolve; }));
    const resolveRouteTarget = vi.fn(async (_bot: string, peer: string) => ({ row: { id: `companion-${peer}` } }));
    const prepareNewSession = vi.fn();
    im.attachTurnRuntime({
      runner: { companionBotIdFor: () => 'cindy', resolveRouteTarget },
      repo: { prepareNewSession }, config: {}, resetSessionToDefaults: vi.fn(),
    } as never);
    await im.init();
    try {
      receive({ cursor: 'next', messages: ['owner', 'guest'].map((senderId) => ({
        senderId, messageId: senderId, text: 'hello', contextToken: 'context', media: [],
      })) });
      await vi.waitFor(() => expect(db.tx).toHaveBeenCalledWith('wechatCommitPollBatch', expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ peerId: 'owner', sessionId: 'companion-owner' }),
          expect.objectContaining({ peerId: 'guest', sessionId: 'companion-guest' }),
        ]),
      })));
      expect(prepareNewSession).not.toHaveBeenCalled();
      expect(resolveRouteTarget).toHaveBeenCalledTimes(2);
    } finally { await im.dispose(); }
  });

  it('removes staged files returned while replacing the previous binding', async () => {
    const previous = { bindingEpoch: 'binding-previous', cursor: 'cursor-previous' };
    const released = ['C:\\wechat-staged\\old-file.pdf'];
    const db = fakeDb({
      query: vi.fn(async () => []),
      queryOne: vi.fn(async (sql: string) => {
        if (sql.includes('FROM wechat_sync_state')) return previous;
        if (sql.includes('COUNT(*) AS count')) return { count: 0 };
        return undefined;
      }) as DbClient['queryOne'],
      tx: vi.fn(async (name: string, args: Record<string, unknown>) => {
        switch (name) {
          case 'wechatActivateBindingEpoch':
            return {
              activated: true,
              previousActiveEpoch: previous.bindingEpoch,
              activeBindingEpoch: String(args.bindingEpoch),
            };
          case 'wechatCloseBindingEpoch':
            return { closed: true };
          case 'wechatUnbindCleanup':
            return { deletedTasks: 1, deletedMediaRefs: 0, filePaths: released };
          case 'wechatLeaseNextTask':
            return null;
          default:
            return null;
        }
      }),
    });
    const testHost = host({
      secretRead: (name) =>
        name === 'wechat_data_key_v1' ? Buffer.alloc(32, 2).toString('base64') : null,
    });
    const authTransport = authorizationTransportReturning({
      token: 'new-token',
      botId: 'new-bot',
      userId: 'new-user',
      baseUrl: 'https://ilinkai.weixin.qq.com',
    });
    const liveTransport = blockingLiveTransport();
    const createTransport = vi
      .fn()
      .mockReturnValueOnce(authTransport)
      .mockReturnValueOnce(liveTransport);
    const im = new WechatIM(
      deps({
        host: testHost,
        getDbClient: () => db,
        createTransport,
      }),
    );

    await im.authorize();
    await vi.waitFor(() =>
      expect(mediaMocks.removeReleasedWechatFiles).toHaveBeenCalledWith(released),
    );
    await vi.waitFor(() => expect(im.getState().phase).toBe('connected'));

    await im.dispose();
  });
});

function deps(overrides: Partial<WechatIMDeps> & { host?: IMHost } = {}): WechatIMDeps {
  return {
    host: overrides.host ?? host(),
    getDbClient: overrides.getDbClient ?? (() => fakeDb()),
    createTransport:
      overrides.createTransport ??
      (() => {
        throw new Error('transport should not be created');
      }),
    openAuthorizationUrl: overrides.openAuthorizationUrl ?? vi.fn(),
    captureAccountGeneration: overrides.captureAccountGeneration ?? (() => 1),
    isAccountGenerationCurrent:
      overrides.isAccountGenerationCurrent ?? ((generation) => generation === 1),
    isCompatibilityDisabled: overrides.isCompatibilityDisabled ?? (() => false),
    now: overrides.now ?? (() => 100),
  };
}

function host(
  options: {
    secretAvailable?: boolean;
    secretRead?: (name: string) => string | null;
  } = {},
): IMHost {
  return {
    secrets: {
      isAvailable: () => options.secretAvailable ?? true,
      read: vi.fn(options.secretRead ?? (() => null)),
      write: vi.fn(() => true),
      remove: vi.fn(),
    },
    ipc: {
      throwIpcError: (code, message) => {
        throw new Error(`[${code}] ${message}`);
      },
      handle: vi.fn(),
      broadcast: vi.fn(),
    },
    paths: {
      feishuMediaDir: 'unused',
    },
    httpPostForm: vi.fn(),
  };
}

function fakeDb(overrides: Partial<DbClient> = {}): DbClient {
  return {
    tx: overrides.tx ?? vi.fn(),
    query: overrides.query ?? vi.fn(),
    queryOne: overrides.queryOne ?? vi.fn(),
    exec: overrides.exec ?? vi.fn(),
    drizzle: {} as DbClient['drizzle'],
    vecAvailable: false,
    dispose: overrides.dispose ?? vi.fn(),
  };
}

function authorizationTransportReturning(credentials: WechatCredentials): WechatTransport {
  return {
    beginAuthorization: vi.fn(async () => ({
      id: 'challenge',
      qrCodeUrl: 'https://ilinkai.weixin.qq.com/qr/challenge',
      createdAt: 1,
    })),
    waitAuthorization: vi.fn(async () => credentials),
  } as unknown as WechatTransport;
}

function blockingLiveTransport(): WechatTransport {
  return {
    notifyStart: vi.fn(async () => undefined),
    notifyStop: vi.fn(async () => undefined),
    poll: vi.fn(
      (_cursor: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true },
          );
        }),
    ),
  } as unknown as WechatTransport;
}

function restoredConnection(queued: () => number, policyDisabled = false) {
  const credentials = { bindingEpoch: 'epoch', botToken: 'test-token', ilinkBotId: 'wechat-bot',
    userId: 'owner', baseUrl: 'https://ilinkai.weixin.qq.com', boundAt: 1 };
  const testHost = host({ secretRead: (name) => name === 'wechat_data_key_v1'
    ? Buffer.alloc(32, 3).toString('base64') : name === 'wechat_credentials_epoch' ? JSON.stringify(credentials) : null });
  const db = fakeDb({
    queryOne: vi.fn(async (sql: string) => sql.includes('FROM wechat_sync_state')
      ? { bindingEpoch: 'epoch', cursor: '' } : sql.includes('COUNT(*)') ? { count: queued() } : undefined) as DbClient['queryOne'],
    query: vi.fn(async () => []),
    tx: vi.fn(async (name: string) => name === 'wechatCommitPollBatch'
      ? { committed: false, reason: 'stale-cursor' } : null),
  });
  const transport = blockingLiveTransport();
  const im = new WechatIM(deps({ host: testHost, getDbClient: () => db, createTransport: () => transport,
    isCompatibilityDisabled: () => policyDisabled }));
  return { im, transport, db, testHost };
}
