import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IMHost } from '@cindy/im';
import { encryptWechatContextToken } from '../contextCrypto';
import type { ImSessionRow } from '../../../im/shared/sessionRepo';
import {
  WechatIlinkError,
  type WechatCredentials,
  type WechatTransport,
} from '@cindy/wechat-ilink';

import type { DbClient } from '../../../localDb/client/DbClient';
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

  it('uses the shared empty-output copy after filtering the final text', () => {
    expect(__testing.normalizeFinalOutputText('')).toBe('✅ (本轮无文本输出)');
    expect(__testing.normalizeFinalOutputText('hello')).toBe('hello');
  });

  it('escalates send rejections only after repeated SEND_REJECTED failures within the window', () => {
    const rejected = new WechatIlinkError('SEND_REJECTED', 'send rejected', false);
    const health = new __testing.SendRejectionHealth();

    expect(health.recordFailure('binding-a', rejected, 0)).toBe(false);
    expect(health.recordFailure('binding-a', rejected, 1)).toBe(false);
    expect(health.recordFailure('binding-a', rejected, 2)).toBe(true);
  });

  it('resets the send rejection counter after a successful send', () => {
    const rejected = new WechatIlinkError('SEND_REJECTED', 'send rejected', false);
    const health = new __testing.SendRejectionHealth();

    expect(health.recordFailure('binding-a', rejected, 0)).toBe(false);
    health.recordSuccess('binding-a');
    expect(health.recordFailure('binding-a', rejected, 1)).toBe(false);
  });

  it('ignores send rejections once the failure window has expired', () => {
    const rejected = new WechatIlinkError('SEND_REJECTED', 'send rejected', false);
    const health = new __testing.SendRejectionHealth();

    expect(health.recordFailure('binding-a', rejected, 0)).toBe(false);
    expect(health.recordFailure('binding-a', rejected, 5 * 60 * 1000 + 1)).toBe(false);
  });

  it('tracks send rejection failures independently per binding', () => {
    const rejected = new WechatIlinkError('SEND_REJECTED', 'send rejected', false);
    const health = new __testing.SendRejectionHealth();

    expect(health.recordFailure('binding-a', rejected, 0)).toBe(false);
    expect(health.recordFailure('binding-a', rejected, 1)).toBe(false);
    expect(health.recordFailure('binding-b', rejected, 2)).toBe(false);
    expect(health.recordFailure('binding-b', rejected, 3)).toBe(false);
    expect(health.recordFailure('binding-b', rejected, 4)).toBe(true);
  });

  it('does not count non-rejection failures toward send rejection escalation', () => {
    const rejected = new WechatIlinkError('SEND_REJECTED', 'send rejected', false);
    const network = new WechatIlinkError('NETWORK_ERROR', 'network down', true);
    const health = new __testing.SendRejectionHealth();

    expect(health.recordFailure('binding-a', network, 0)).toBe(false);
    expect(health.recordFailure('binding-a', network, 1)).toBe(false);
    expect(health.recordFailure('binding-a', network, 2)).toBe(false);
    expect(health.recordFailure('binding-a', rejected, 3)).toBe(false);
  });

  it('distinguishes agent-unsupported from permission-mode-unsupported pre-dispatch failures', () => {
    // Agent 未声明 turnPermissionPolicy(如 Pi):换权限模式无效,文案引导换 Agent。
    expect(
      __testing.wechatPreDispatchFailureText('TURN_PERMISSION_POLICY_UNSUPPORTED:agent:ask'),
    ).toContain('换成 Claude Code 或 Codex');
    expect(
      __testing.wechatPreDispatchFailureText('TURN_PERMISSION_POLICY_UNSUPPORTED:agent:auto'),
    ).not.toContain('权限模式');
    // 当前权限模式若是换 Agent 后仍不兼容的档位(bypassPermissions / acceptEdits),
    // 换 Agent 指引应附带 /permission 提示,避免新 Agent 再次命中权限模式错误。
    expect(
      __testing.wechatPreDispatchFailureText(
        'TURN_PERMISSION_POLICY_UNSUPPORTED:agent:bypassPermissions',
      ),
    ).toContain('/permission');
    expect(
      __testing.wechatPreDispatchFailureText(
        'TURN_PERMISSION_POLICY_UNSUPPORTED:agent:acceptEdits',
      ),
    ).toContain('/permission');
    expect(
      __testing.wechatPreDispatchFailureText('TURN_PERMISSION_POLICY_UNSUPPORTED:agent:ask'),
    ).not.toContain('/permission');
    // 权限模式在 unsupportedPermissionModes 里(如 bypassPermissions):文案引导调权限模式。
    expect(
      __testing.wechatPreDispatchFailureText(
        'TURN_PERMISSION_POLICY_UNSUPPORTED:mode:bypassPermissions',
      ),
    ).toContain('权限模式');
    // 旧格式 / 渠道侧 unsupported_turn_permission 兼容分支:同样按权限模式处理。
    expect(
      __testing.wechatPreDispatchFailureText('TURN_PERMISSION_POLICY_UNSUPPORTED:ask'),
    ).toContain('权限模式');
    expect(__testing.wechatPreDispatchFailureText('unsupported_turn_permission')).toContain(
      '权限模式',
    );
    expect(__testing.wechatPreDispatchFailureText('missing_auth')).toContain('模型服务');
    expect(__testing.wechatPreDispatchFailureText('boom')).toContain('稍后重试');
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
    const activeTasks = new Map<string, { routeSessionId?: string; task: { sessionId: string } }>([
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
    expect([
      ...__testing.acceptedPollTaskIds({
        committed: false,
        reason: 'stale-cursor',
        activeBindingEpoch: 'binding-1',
        currentCursor: 'newer',
      }),
    ]).toEqual([]);
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
    await __testing.stopActiveWechatTurns({ stopActiveTurn } as never, 'bot-1', [
      'peer-1',
      'peer-1',
      'peer-2',
    ]);
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

    expect(
      im.cancelTextInteraction('peer-1', 'request-stale', {
        kind: 'permission',
        behavior: 'deny',
        reason: 'stale_route',
      }),
    ).toBe(false);
    expect(
      im.cancelTextInteraction('peer-1', 'request-current', {
        kind: 'permission',
        behavior: 'deny',
        reason: 'interaction_route_released',
      }),
    ).toBe(true);
    await expect(pending).resolves.toEqual({
      kind: 'permission',
      behavior: 'deny',
      reason: 'interaction_route_released',
    });
  });

  it('投递失败时用稳定系统码收口，不把 Error.message 当成拒绝原因', async () => {
    const im = new WechatIM(deps());
    vi.spyOn(im, 'sendText').mockRejectedValue(new Error('socket hang up'));

    await expect(
      im.handleTextInteraction('peer-1', {
        kind: 'permission',
        requestId: 'request-send-failed',
        toolName: 'bash',
        input: { command: 'pnpm test' },
      }),
    ).resolves.toEqual({
      kind: 'permission',
      behavior: 'deny',
      reason: 'wechat_interaction_send_failed',
    });
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

  it('drops late authorization credentials after a compatibility revision changes', async () => {
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
    await im.setCompatibilityDisabled(true);
    resolveCredentials({
      token: 'late-token',
      botId: 'late-bot',
      userId: 'late-user',
      baseUrl: 'https://ilinkai.weixin.qq.com',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(createTransport).toHaveBeenCalledOnce();
    expect(testHost.secrets.write).not.toHaveBeenCalled();
    expect(im.getState()).toMatchObject({ phase: 'disabled_by_policy', bound: false });
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
    expect(testHost.secrets.remove).toHaveBeenCalledWith(`wechat_credentials_${newBindingEpoch}`);
    expect(createTransport).toHaveBeenCalledOnce();
    await im.dispose();
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

  it('reports upload failure and needs_reauth when uploadMedia hits a replaced authorization', async () => {
    const dataKey = Buffer.alloc(32, 4);
    let activeBindingEpoch = '';
    const dir = await mkdtemp(join(tmpdir(), 'wechat-upload-'));
    const filePath = join(dir, 'upload.bin');
    try {
      await writeFile(filePath, 'x');

      const db = fakeDb({
        queryOne: vi.fn(async (sql: string) => {
          if (sql.includes('FROM wechat_sync_state')) return null;
          if (sql.includes('COUNT(*) AS count')) return { count: 0 };
          if (sql.includes('context_nonce')) {
            const encrypted = encryptWechatContextToken(
              'ctx-upload',
              dataKey,
              activeBindingEpoch,
              'task-upload',
            );
            return {
              taskId: 'task-upload',
              sessionId: 'wechat-session-upload',
              contextNonce: encrypted.nonce,
              contextCiphertext: encrypted.ciphertext,
              contextTag: encrypted.tag,
            };
          }
          return null;
        }) as DbClient['queryOne'],
        tx: vi.fn(async (name: string, args: Record<string, unknown>) => {
          if (name === 'wechatActivateBindingEpoch') {
            activeBindingEpoch = String(args.bindingEpoch);
            return {
              activated: true,
              previousActiveEpoch: null,
              activeBindingEpoch,
            };
          }
          if (name === 'wechatLeaseNextTask') return null;
          if (name === 'wechatCloseBindingEpoch') return { closed: true };
          if (name === 'wechatUnbindCleanup')
            return { deletedTasks: 0, deletedMediaRefs: 0, filePaths: [] };
          return null;
        }),
      });

      const testHost = host({
        secretRead: (name: string) =>
          name === 'wechat_data_key_v1' ? dataKey.toString('base64') : null,
      });

      const authTransport = authorizationTransportReturning({
        token: 'new-token',
        botId: 'upload-bot',
        userId: 'new-user',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      });

      const liveTransport = {
        notifyStart: vi.fn(async () => undefined),
        notifyStop: vi.fn(async () => undefined),
        poll: vi.fn(
          (_cursor: string, signal: AbortSignal) =>
            new Promise((_resolve, reject) => {
              if (signal.aborted) {
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                return;
              }
              signal.addEventListener(
                'abort',
                () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
                { once: true },
              );
            }),
        ),
        uploadMedia: vi.fn(async () => {
          throw new WechatIlinkError('AUTH_REPLACED', 'authorization replaced', false);
        }),
        sendMedia: vi.fn(async () => ({ ok: true })),
      } as unknown as WechatTransport;

      const createTransport = vi
        .fn()
        .mockReturnValueOnce(authTransport)
        .mockReturnValueOnce(liveTransport);

      const im = new WechatIM(deps({ host: testHost, getDbClient: () => db, createTransport }));

      await im.authorize();
      await vi.waitFor(() => expect(im.getState().phase).toBe('connected'));

      const result = await im.sendFile('peer-upload', filePath);

      expect(result).toEqual({ ok: false, reason: 'UPLOAD_FAIL' });
      expect(im.getState()).toMatchObject({
        phase: 'needs_reauth',
        errorCode: 'auth_replaced',
      });
      expect(liveTransport.uploadMedia).toHaveBeenCalledTimes(1);
      expect(liveTransport.sendMedia).not.toHaveBeenCalled();

      await im.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not clear final-send rejection evidence when uploads succeed', async () => {
    const dataKey = Buffer.alloc(32, 6);
    let activeBindingEpoch = '';
    const dir = await mkdtemp(join(tmpdir(), 'wechat-upload-success-'));
    const filePath = join(dir, 'upload-success.bin');
    try {
      await writeFile(filePath, 'x');

      const db = fakeDb({
        queryOne: vi.fn(async (sql: string) => {
          if (sql.includes('FROM wechat_sync_state')) return null;
          if (sql.includes('COUNT(*) AS count')) return { count: 0 };
          if (sql.includes('context_nonce')) {
            const encrypted = encryptWechatContextToken(
              'ctx-upload',
              dataKey,
              activeBindingEpoch,
              'task-upload',
            );
            return {
              taskId: 'task-upload',
              sessionId: 'wechat-session-upload',
              contextNonce: encrypted.nonce,
              contextCiphertext: encrypted.ciphertext,
              contextTag: encrypted.tag,
            };
          }
          return null;
        }) as DbClient['queryOne'],
        tx: vi.fn(async (name: string, args: Record<string, unknown>) => {
          if (name === 'wechatActivateBindingEpoch') {
            activeBindingEpoch = String(args.bindingEpoch);
            return {
              activated: true,
              previousActiveEpoch: null,
              activeBindingEpoch,
            };
          }
          if (name === 'wechatLeaseNextTask') return null;
          if (name === 'wechatCloseBindingEpoch') return { closed: true };
          if (name === 'wechatUnbindCleanup')
            return { deletedTasks: 0, deletedMediaRefs: 0, filePaths: [] };
          return null;
        }),
      });

      const testHost = host({
        secretRead: (name: string) =>
          name === 'wechat_data_key_v1' ? dataKey.toString('base64') : null,
      });

      const authTransport = authorizationTransportReturning({
        token: 'new-token',
        botId: 'upload-bot',
        userId: 'new-user',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      });

      const liveTransport = {
        notifyStart: vi.fn(async () => undefined),
        notifyStop: vi.fn(async () => undefined),
        poll: vi.fn(
          (_cursor: string, signal: AbortSignal) =>
            new Promise((_resolve, reject) => {
              if (signal.aborted) {
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                return;
              }
              signal.addEventListener(
                'abort',
                () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
                { once: true },
              );
            }),
        ),
        uploadMedia: vi.fn(async () => ({ mediaId: 'media-ok' })),
        sendMedia: vi.fn(async () => {
          throw new WechatIlinkError('SEND_REJECTED', 'send rejected', false);
        }),
      } as unknown as WechatTransport;

      const createTransport = vi
        .fn()
        .mockReturnValueOnce(authTransport)
        .mockReturnValueOnce(liveTransport);

      const im = new WechatIM(deps({ host: testHost, getDbClient: () => db, createTransport }));

      await im.authorize();
      await vi.waitFor(() => expect(im.getState().phase).toBe('connected'));

      for (let i = 0; i < 3; i += 1) {
        const result = await im.sendFile('peer-upload', filePath);
        expect(result).toEqual({ ok: false, reason: 'SEND_FAIL' });
      }

      expect(im.getState()).toMatchObject({
        phase: 'needs_reauth',
        errorCode: 'send_rejected',
      });
      expect(liveTransport.uploadMedia).toHaveBeenCalledTimes(3);
      expect(liveTransport.sendMedia).toHaveBeenCalledTimes(3);

      await im.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('records a terminal outbox failure when uploadMedia hits a replaced authorization', async () => {
    const dataKey = Buffer.alloc(32, 5);
    let activeBindingEpoch = '';
    const dir = await mkdtemp(join(tmpdir(), 'wechat-outbox-media-'));
    const filePath = join(dir, 'outbox-media.bin');
    try {
      await writeFile(filePath, 'x');
      const failures: Array<Record<string, unknown>> = [];
      let dueOutboxReturned = false;
      const db = fakeDb({
        query: vi.fn(async (sql: string) =>
          sql.includes('FROM wechat_outbox')
            ? dueOutboxReturned
              ? []
              : (() => {
                  dueOutboxReturned = true;
                  const encrypted = encryptWechatContextToken(
                    'ctx-upload',
                    dataKey,
                    activeBindingEpoch,
                    'task-upload',
                  );
                  return [
                    {
                      id: 'outbox-upload',
                      bindingEpoch: activeBindingEpoch,
                      taskId: 'task-upload',
                      clientId: 'outbox-client',
                      kind: 'final',
                      chunkIndex: 0,
                      text: '',
                      mediaJson: JSON.stringify([
                        { absPath: filePath, clientId: 'media-client' },
                      ]),
                      attempts: 0,
                      contextNonce: encrypted.nonce,
                      contextCiphertext: encrypted.ciphertext,
                      contextTag: encrypted.tag,
                    },
                  ];
                })()
            : [],
        ) as DbClient['query'],
        queryOne: vi.fn(async (sql: string) => {
          if (sql.includes('FROM wechat_sync_state')) return null;
          if (sql.includes('COUNT(*) AS count')) return { count: 0 };
          if (sql.includes('FROM wechat_inbox')) return { peerId: 'peer-upload' };
          return null;
        }) as DbClient['queryOne'],
        exec: vi.fn(async () => ({ changes: 1, lastInsertRowid: 0 })),
        tx: vi.fn(async (name: string, args: Record<string, unknown>) => {
          if (name === 'wechatActivateBindingEpoch') {
            activeBindingEpoch = String(args.bindingEpoch);
            return { activated: true, previousActiveEpoch: null, activeBindingEpoch };
          }
          if (name === 'wechatLeaseNextTask') return null;
          if (name === 'wechatRecordOutboxFailure') {
            failures.push(args);
            return { recorded: true };
          }
          if (name === 'wechatCloseBindingEpoch') return { closed: true };
          if (name === 'wechatUnbindCleanup')
            return { deletedTasks: 0, deletedMediaRefs: 0, filePaths: [] };
          return null;
        }),
      });

      const testHost = host({
        secretRead: (name: string) =>
          name === 'wechat_data_key_v1' ? dataKey.toString('base64') : null,
      });
      const authTransport = authorizationTransportReturning({
        token: 'new-token',
        botId: 'outbox-bot',
        userId: 'new-user',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      });
      const liveTransport = {
        notifyStart: vi.fn(async () => undefined),
        notifyStop: vi.fn(async () => undefined),
        poll: vi.fn(
          (_cursor: string, signal: AbortSignal) =>
            new Promise((_resolve, reject) => {
              if (signal.aborted) {
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                return;
              }
              signal.addEventListener(
                'abort',
                () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
                { once: true },
              );
            }),
        ),
        uploadMedia: vi.fn(async () => {
          throw new WechatIlinkError('AUTH_REPLACED', 'authorization replaced', false);
        }),
        sendMedia: vi.fn(async () => ({ ok: true })),
      } as unknown as WechatTransport;
      const createTransport = vi
        .fn()
        .mockReturnValueOnce(authTransport)
        .mockReturnValueOnce(liveTransport);

      const im = new WechatIM(deps({ host: testHost, getDbClient: () => db, createTransport }));
      await im.authorize();
      await vi.waitFor(() => expect(im.getState().phase).toBe('connected'));
      await vi.waitFor(() => expect(failures).toHaveLength(1), { timeout: 2_000 });
      await vi.waitFor(() =>
        expect(im.getState()).toMatchObject({
          phase: 'needs_reauth',
          errorCode: 'auth_replaced',
        }),
      );

      expect(liveTransport.uploadMedia).toHaveBeenCalledTimes(1);
      expect(liveTransport.sendMedia).not.toHaveBeenCalled();
      expect(failures[0]).toMatchObject({
        outboxId: 'outbox-upload',
        terminal: true,
        errorCode: 'AUTH_REPLACED',
      });

      await im.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats the whole outbox item as the success boundary for send rejection evidence', async () => {
    const dataKey = Buffer.alloc(32, 7);
    let activeBindingEpoch = '';
    const dir = await mkdtemp(join(tmpdir(), 'wechat-outbox-mixed-'));
    const filePath = join(dir, 'outbox-mixed.bin');
    try {
      await writeFile(filePath, 'x');
      const failures: Array<Record<string, unknown>> = [];
      let dueOutboxReturned = false;
      const db = fakeDb({
        query: vi.fn(async (sql: string) =>
          sql.includes('FROM wechat_outbox')
            ? dueOutboxReturned
              ? []
              : (() => {
                  dueOutboxReturned = true;
                  const encrypted = encryptWechatContextToken(
                    'ctx-mixed',
                    dataKey,
                    activeBindingEpoch,
                    'task-mixed',
                  );
                  return [
                    {
                      id: 'outbox-mixed',
                      bindingEpoch: activeBindingEpoch,
                      taskId: 'task-mixed',
                      clientId: 'outbox-client',
                      kind: 'final',
                      chunkIndex: 0,
                      text: 'hello with media',
                      mediaJson: JSON.stringify([
                        { absPath: filePath, clientId: 'media-client' },
                      ]),
                      attempts: 0,
                      contextNonce: encrypted.nonce,
                      contextCiphertext: encrypted.ciphertext,
                      contextTag: encrypted.tag,
                    },
                  ];
                })()
            : [],
        ) as DbClient['query'],
        queryOne: vi.fn(async (sql: string) => {
          if (sql.includes('FROM wechat_sync_state')) return null;
          if (sql.includes('COUNT(*) AS count')) return { count: 0 };
          if (sql.includes('FROM wechat_inbox')) return { peerId: 'peer-mixed' };
          return null;
        }) as DbClient['queryOne'],
        exec: vi.fn(async () => ({ changes: 1, lastInsertRowid: 0 })),
        tx: vi.fn(async (name: string, args: Record<string, unknown>) => {
          if (name === 'wechatActivateBindingEpoch') {
            activeBindingEpoch = String(args.bindingEpoch);
            return { activated: true, previousActiveEpoch: null, activeBindingEpoch };
          }
          if (name === 'wechatLeaseNextTask') return null;
          if (name === 'wechatRecordOutboxFailure') {
            failures.push(args);
            return { recorded: true };
          }
          if (name === 'wechatCloseBindingEpoch') return { closed: true };
          if (name === 'wechatUnbindCleanup')
            return { deletedTasks: 0, deletedMediaRefs: 0, filePaths: [] };
          return null;
        }),
      });

      const testHost = host({
        secretRead: (name: string) =>
          name === 'wechat_data_key_v1' ? dataKey.toString('base64') : null,
      });
      const authTransport = authorizationTransportReturning({
        token: 'new-token',
        botId: 'mixed-bot',
        userId: 'new-user',
        baseUrl: 'https://ilinkai.weixin.qq.com',
      });
      const liveTransport = {
        notifyStart: vi.fn(async () => undefined),
        notifyStop: vi.fn(async () => undefined),
        poll: vi.fn(
          (_cursor: string, signal: AbortSignal) =>
            new Promise((_resolve, reject) => {
              if (signal.aborted) {
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                return;
              }
              signal.addEventListener(
                'abort',
                () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
                { once: true },
              );
            }),
        ),
        sendMessage: vi.fn(async () => ({ ok: true })),
        uploadMedia: vi.fn(async () => ({ mediaId: 'media-ok' })),
        sendMedia: vi.fn(async () => {
          throw new WechatIlinkError('SEND_REJECTED', 'send rejected', true);
        }),
      } as unknown as WechatTransport;
      const createTransport = vi
        .fn()
        .mockReturnValueOnce(authTransport)
        .mockReturnValueOnce(liveTransport);

      const im = new WechatIM(deps({ host: testHost, getDbClient: () => db, createTransport }));
      await im.authorize();
      await vi.waitFor(() => expect(im.getState().phase).toBe('connected'));
      await vi.waitFor(() => expect(failures).toHaveLength(3), { timeout: 2_000 });
      await vi.waitFor(() =>
        expect(im.getState()).toMatchObject({
          phase: 'needs_reauth',
          errorCode: 'send_rejected',
        }),
      );

      expect(liveTransport.sendMessage).toHaveBeenCalledTimes(3);
      expect(liveTransport.uploadMedia).toHaveBeenCalledTimes(3);
      expect(liveTransport.sendMedia).toHaveBeenCalledTimes(3);
      for (const failure of failures) {
        expect(failure).toMatchObject({
          outboxId: 'outbox-mixed',
          terminal: false,
          errorCode: 'SEND_REJECTED',
        });
      }

      await im.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not republish connected when startup queue counting loses the epoch', async () => {
    let resolveCountStarted!: () => void;
    let releaseCount!: (value: { count: number }) => void;
    let activeBindingEpoch = '';
    const countStarted = new Promise<void>((resolve) => {
      resolveCountStarted = resolve;
    });
    const countResultPromise = new Promise<{ count: number }>((resolve) => {
      releaseCount = resolve;
    });

    const previous = {
      bindingEpoch: 'epoch-0',
      botId: 'old-bot',
      userId: 'old-user',
      baseUrl: 'https://old.example.com',
    };

    const db = fakeDb({
      queryOne: vi.fn(async (sql: string) => {
        if (sql.includes('FROM wechat_sync_state')) {
          return previous;
        }
        if (sql.includes('COUNT(*) AS count')) {
          resolveCountStarted();
          return await countResultPromise;
        }
        if (sql.includes('context_nonce')) {
          const encrypted = encryptWechatContextToken(
            'ctx-startup',
            Buffer.alloc(32, 4),
            activeBindingEpoch,
            'task-startup',
          );
          return {
            taskId: 'task-startup',
            sessionId: 'wechat-session-startup',
            contextNonce: encrypted.nonce,
            contextCiphertext: encrypted.ciphertext,
            contextTag: encrypted.tag,
          };
        }
        return null;
      }) as DbClient['queryOne'],
      tx: vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === 'wechatActivateBindingEpoch') {
          activeBindingEpoch = String(args.bindingEpoch);
          return {
            activated: true,
            previousActiveEpoch: previous.bindingEpoch,
            activeBindingEpoch,
          };
        }
        if (name === 'wechatCloseBindingEpoch') {
          return { closed: true };
        }
        if (name === 'wechatUnbindCleanup') {
          return {};
        }
        if (name === 'wechatLeaseNextTask') {
          return null;
        }
        return null;
      }),
    });

    const testHost = host({
      secretRead: (name) =>
        name === 'wechat_data_key_v1' ? Buffer.alloc(32, 4).toString('base64') : null,
    });

    const authTransport = authorizationTransportReturning({
      token: 'new-token',
      botId: 'startup-bot',
      userId: 'new-user',
      baseUrl: 'https://ilinkai.weixin.qq.com',
    });

    const liveTransport = {
      notifyStart: vi.fn(async () => {}),
      notifyStop: vi.fn(async () => {}),
      poll: vi.fn(
        (_opts: unknown, signal: AbortSignal) =>
          new Promise((_resolve, reject) => {
            if (signal.aborted) {
              reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
              return;
            }
            signal.addEventListener('abort', () => {
              reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
            });
          }),
      ),
      sendMessage: vi.fn(async () => {
        throw new WechatIlinkError('AUTH_REPLACED', 'authorization replaced', false);
      }),
    } as unknown as WechatTransport;

    const createTransport = vi
      .fn()
      .mockReturnValueOnce(authTransport)
      .mockReturnValueOnce(liveTransport);

    const im = new WechatIM(deps({ host: testHost, getDbClient: () => db, createTransport }));

    await im.authorize();
    await countStarted;
    await vi.waitFor(() => expect(createTransport).toHaveBeenCalledTimes(2));

    await expect(im.sendText('peer-startup', 'hello')).rejects.toThrow('authorization replaced');

    expect(im.getState()).toMatchObject({ phase: 'needs_reauth', errorCode: 'auth_replaced' });

    const stateBroadcast = vi.mocked(testHost.ipc.broadcast);
    const calls = stateBroadcast.mock.calls;
    let lastNeedsReauthIndex = -1;
    for (let i = calls.length - 1; i >= 0; i--) {
      const payload = calls[i][1] as { phase?: string };
      if (payload?.phase === 'needs_reauth') {
        lastNeedsReauthIndex = i;
        break;
      }
    }
    expect(lastNeedsReauthIndex).toBeGreaterThanOrEqual(0);

    releaseCount({ count: 0 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(im.getState()).toMatchObject({ phase: 'needs_reauth', errorCode: 'auth_replaced' });

    const callsAfter = stateBroadcast.mock.calls.slice(lastNeedsReauthIndex + 1);
    for (const call of callsAfter) {
      const payload = call[1] as { phase?: string };
      expect(payload?.phase).not.toBe('connected');
    }

    await im.dispose();
  });
  it('keeps needs_reauth when an in-flight poll batch completes after a send rejection aborts the epoch', async () => {
    const previous = { bindingEpoch: 'binding-previous', cursor: 'cursor-previous' };
    let activeBindingEpoch = '';
    const db = fakeDb({
      queryOne: vi.fn(async (sql: string) => {
        if (sql.includes('FROM wechat_sync_state')) return previous;
        if (sql.includes('COUNT(*) AS count')) return { count: 0 };
        if (sql.includes('context_nonce')) {
          const encrypted = encryptWechatContextToken(
            'ctx-1',
            Buffer.alloc(32, 3),
            activeBindingEpoch,
            'task-1',
          );
          return {
            taskId: 'task-1',
            sessionId: 'wechat-session-1',
            contextNonce: encrypted.nonce,
            contextCiphertext: encrypted.ciphertext,
            contextTag: encrypted.tag,
          };
        }
        if (sql.includes('COALESCE')) return { conversationEpoch: 0 };
        return undefined;
      }) as DbClient['queryOne'],
      tx: vi.fn(async (name: string, args: Record<string, unknown>) => {
        switch (name) {
          case 'wechatActivateBindingEpoch':
            activeBindingEpoch = String(args.bindingEpoch);
            return {
              activated: true,
              previousActiveEpoch: previous.bindingEpoch,
              activeBindingEpoch: String(args.bindingEpoch),
            };
          case 'wechatCloseBindingEpoch':
            return { closed: true };
          case 'wechatUnbindCleanup':
            return { deletedTasks: 0, deletedMediaRefs: 0, filePaths: [] };
          case 'wechatCommitPollBatch':
            return {
              committed: true,
              insertedTaskIds: [
                String((args.messages as Array<{ id?: unknown }> | undefined)?.[0]?.id ?? 'task-1'),
              ],
              duplicateTaskIds: [],
              rejectedTaskIds: [],
            };
          case 'wechatLeaseNextTask':
            return null;
          default:
            return null;
        }
      }),
    });
    const testHost = host({
      secretRead: (name) =>
        name === 'wechat_data_key_v1' ? Buffer.alloc(32, 3).toString('base64') : null,
    });
    const authTransport = authorizationTransportReturning({
      token: 'new-token',
      botId: 'new-bot',
      userId: 'new-user',
      baseUrl: 'https://ilinkai.weixin.qq.com',
    });
    let releasePoll!: () => void;
    const liveTransport = {
      notifyStart: vi.fn(async () => undefined),
      notifyStop: vi.fn(async () => undefined),
      poll: vi.fn(
        () =>
          new Promise((resolve) => {
            releasePoll = () =>
              resolve({
                cursor: 'cursor-next',
                messages: [
                  {
                    messageId: 'msg-1',
                    senderId: 'peer-1',
                    contextToken: 'ctx-1',
                    text: 'hello',
                    media: [],
                  },
                ],
              });
          }),
      ),
      sendMessage: vi.fn(async () => {
        throw new WechatIlinkError('AUTH_REPLACED', 'authorization replaced', false);
      }),
    } as unknown as WechatTransport;
    const reauthTransport = {
      beginAuthorization: vi.fn(async () => ({
        id: 'reauth-challenge',
        qrCodeUrl: 'https://ilinkai.weixin.qq.com/qr/reauth',
        createdAt: 2,
      })),
      waitAuthorization: vi.fn((_challenge: unknown, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          if (signal.aborted) {
            reject(new WechatIlinkError('ABORTED', 'authorization aborted', true));
            return;
          }
          signal.addEventListener(
            'abort',
            () => reject(new WechatIlinkError('ABORTED', 'authorization aborted', true)),
            { once: true },
          );
        }),
      ),
    } as unknown as WechatTransport;
    const createTransport = vi
      .fn()
      .mockReturnValueOnce(authTransport)
      .mockReturnValueOnce(liveTransport)
      .mockReturnValueOnce(reauthTransport);
    const sessionRow = { id: 'wechat-session-1' } as ImSessionRow;
    const im = new WechatIM(
      deps({
        host: testHost,
        getDbClient: () => db,
        createTransport,
      }),
    );
    im.attachTurnRuntime({
      runner: {
        dispatchAgentTurn: vi.fn(async () => ({
          kind: 'accepted',
          terminal: Promise.resolve({}),
        })),
        stopActiveTurn: vi.fn(async () => ({ stopped: true })),
      } as never,
      repo: {
        prepareNewSession: vi.fn(async () => sessionRow),
        findActiveSession: vi.fn(async () => sessionRow),
        createSession: vi.fn(async () => sessionRow),
      } as never,
      config: {} as never,
      resetSessionToDefaults: vi.fn(async () => undefined),
    });

    await im.authorize();
    await vi.waitFor(() => expect(im.getState().phase).toBe('connected'));
    await vi.waitFor(() => expect(liveTransport.poll).toHaveBeenCalledOnce());

    // The concurrent direct send hits the replaced authorization and aborts
    // the epoch with needs_reauth while the poll is still unresolved.
    await expect(im.sendText('peer-1', 'outbound')).rejects.toThrow('authorization replaced');
    expect(im.getState()).toMatchObject({ phase: 'needs_reauth', errorCode: 'auth_replaced' });

    await im.authorize();
    await vi.waitFor(() => expect(im.getState().phase).toBe('waiting_confirmation'));
    im.cancelAuthorization();
    expect(im.getState()).toMatchObject({ phase: 'needs_reauth', bound: true });

    releasePoll();
    await vi.waitFor(() =>
      expect(db.tx).toHaveBeenCalledWith('wechatCommitPollBatch', expect.anything()),
    );
    expect(im.getState()).toMatchObject({ phase: 'needs_reauth', bound: true });
    await im.dispose();
  });

  it('settles active work on auth rejection without waiting for the epoch drain', async () => {
    const dataKey = Buffer.alloc(32, 5);
    let activeBindingEpoch = '';
    let leased = false;

    const db = fakeDb({
      query: vi.fn(async () => []),
      queryOne: vi.fn(async (sql: string) => {
        if (sql.includes('FROM wechat_sync_state')) return null;
        if (sql.includes('COUNT(*) AS count')) return { count: 0 };
        if (sql.includes('COALESCE')) return { conversationEpoch: 0 };
        return undefined;
      }) as DbClient['queryOne'],
      tx: vi.fn(async (name: string, args: Record<string, unknown>) => {
        switch (name) {
          case 'wechatActivateBindingEpoch':
            activeBindingEpoch = String(args.bindingEpoch);
            return { activated: true, previousActiveEpoch: null, activeBindingEpoch };
          case 'wechatLeaseNextTask':
            if (!leased) {
              leased = true;
              return {
                id: 'task-active',
                bindingEpoch: activeBindingEpoch,
                peerId: 'peer-1',
                sessionId: 'wechat-session-1',
                conversationEpoch: 0,
                payloadJson: JSON.stringify({
                  text: 'hello',
                  attachments: [],
                  unsupportedMedia: [],
                }),
                context: encryptWechatContextToken(
                  'ctx-active',
                  dataKey,
                  activeBindingEpoch,
                  'task-active',
                ),
                attempts: 0,
                receivedAt: 100,
                expiresAt: 100_000,
              };
            }
            return null;
          case 'wechatMarkAccepted':
            return true;
          case 'wechatCommitInterrupted':
            return true;
          case 'wechatCloseBindingEpoch':
            return { closed: true };
          case 'wechatUnbindCleanup':
            return { deletedTasks: 0, deletedMediaRefs: 0, filePaths: [] };
          default:
            return null;
        }
      }),
    });

    const testHost = host({
      secretRead: (name: string) =>
        name === 'wechat_data_key_v1' ? dataKey.toString('base64') : null,
    });

    const authTransport = authorizationTransportReturning({
      token: 'new-token',
      botId: 'active-bot',
      userId: 'new-user',
      baseUrl: 'https://ilinkai.weixin.qq.com',
    });

    let sendMessageCalls = 0;
    const liveTransport = {
      notifyStart: vi.fn(async () => true),
      notifyStop: vi.fn(async () => true),
      poll: vi.fn(async (_cursor: string, signal: AbortSignal) => {
        await new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      }),
      getTypingTicket: vi.fn(async () => 'ticket'),
      setTyping: vi.fn(async () => true),
      sendMessage: vi.fn(async () => {
        sendMessageCalls += 1;
        if (sendMessageCalls === 1) return {};
        if (sendMessageCalls === 2)
          throw new WechatIlinkError('AUTH_REPLACED', 'authorization replaced', false);
        return {};
      }),
    } as unknown as WechatTransport;

    const createTransport = vi
      .fn()
      .mockReturnValueOnce(authTransport)
      .mockReturnValueOnce(liveTransport);

    let resolveTerminal!: (value: {
      kind: 'aborted';
      text: string;
      completedAt: number;
      errorCode: string;
    }) => void;
    const terminal = new Promise<{
      kind: 'aborted';
      text: string;
      completedAt: number;
      errorCode: string;
    }>((resolve) => {
      resolveTerminal = resolve;
    });

    const dispatchAgentTurn = vi.fn(async (args: { beforeProviderStart: () => Promise<void> }) => {
      await args.beforeProviderStart();
      return { kind: 'accepted', sessionId: 'wechat-session-1', acceptedAt: 100, terminal };
    });
    const stopActiveTurn = vi.fn(async () => ({ stopped: true, droppedQueued: 0 }));

    const im = new WechatIM(deps({ host: testHost, getDbClient: () => db, createTransport }));
    im.attachTurnRuntime({
      runner: { dispatchAgentTurn, stopActiveTurn } as never,
      repo: {
        prepareNewSession: vi.fn(async () => ({ id: 'wechat-session-1' }) as ImSessionRow),
        findActiveSession: vi.fn(async () => ({ id: 'wechat-session-1' }) as ImSessionRow),
        createSession: vi.fn(async () => ({ id: 'wechat-session-1' }) as ImSessionRow),
      } as never,
      config: {} as never,
      resetSessionToDefaults: vi.fn(async () => undefined),
    });

    await im.authorize();
    await vi.waitFor(() => expect(im.getState().phase).toBe('connected'));
    await vi.waitFor(() => expect(dispatchAgentTurn).toHaveBeenCalledTimes(1));

    const pendingInteraction = im.handleTextInteraction(
      'peer-1',
      {
        kind: 'permission' as const,
        requestId: 'request-active',
        toolName: 'bash',
        input: { command: 'pnpm test' },
      },
      { timeoutMs: 60_000 },
    );

    await vi.waitFor(() => expect(liveTransport.sendMessage).toHaveBeenCalledTimes(1));

    await expect(im.sendText('peer-1', 'outbound')).rejects.toThrow('authorization replaced');

    expect(im.getState()).toMatchObject({ phase: 'needs_reauth', errorCode: 'auth_replaced' });
    expect(stopActiveTurn).toHaveBeenCalledWith({ botContextId: 'active-bot', userId: 'peer-1' });

    await expect(pendingInteraction).resolves.toEqual({
      kind: 'permission',
      behavior: 'deny',
      reason: 'wechat_binding_stopped',
    });

    resolveTerminal({ kind: 'aborted', text: '', completedAt: 100, errorCode: 'auth_replaced' });
    await vi.waitFor(() =>
      expect(db.tx).toHaveBeenCalledWith('wechatCommitInterrupted', expect.anything()),
    );
    await im.dispose();
  });

  it('releases a leased task and dispatches nothing when a send rejection aborts the epoch mid-lease', async () => {
    const dataKey = Buffer.alloc(32, 7);
    let activeBindingEpoch = '';
    let releaseLease!: () => void;

    const db = fakeDb({
      query: vi.fn(async () => []),
      queryOne: vi.fn(async (sql: string) => {
        if (sql.includes('FROM wechat_sync_state')) return null;
        if (sql.includes('COUNT(*) AS count')) return { count: 0 };
        if (sql.includes('context_nonce')) {
          const encrypted = encryptWechatContextToken(
            'ctx-send',
            dataKey,
            activeBindingEpoch,
            'task-lease',
          );
          return {
            taskId: 'task-lease',
            sessionId: 'wechat-session-1',
            contextNonce: encrypted.nonce,
            contextCiphertext: encrypted.ciphertext,
            contextTag: encrypted.tag,
          };
        }
        if (sql.includes('COALESCE')) return { conversationEpoch: 0 };
        return undefined;
      }) as DbClient['queryOne'],
      tx: vi.fn(async (name: string, args: Record<string, unknown>) => {
        switch (name) {
          case 'wechatActivateBindingEpoch':
            activeBindingEpoch = String(args.bindingEpoch);
            return { activated: true, previousActiveEpoch: null, activeBindingEpoch };
          case 'wechatLeaseNextTask':
            // Resolve only after the send rejection has aborted the epoch,
            // interleaving: pump awaits the lease, rejection aborts, lease
            // resolves with a real task.
            await new Promise<void>((resolve) => {
              releaseLease = () => resolve();
            });
            return {
              id: 'task-lease',
              bindingEpoch: activeBindingEpoch,
              peerId: 'peer-1',
              sessionId: 'wechat-session-1',
              conversationEpoch: 0,
              payloadJson: JSON.stringify({
                text: 'hello after abort',
                attachments: [],
                unsupportedMedia: [],
              }),
              context: encryptWechatContextToken(
                'ctx-lease',
                dataKey,
                activeBindingEpoch,
                'task-lease',
              ),
              attempts: 0,
              receivedAt: 100,
              expiresAt: 100_000,
            };
          case 'wechatCloseBindingEpoch':
            return { closed: true };
          case 'wechatUnbindCleanup':
            return { deletedTasks: 0, deletedMediaRefs: 0, filePaths: [] };
          default:
            return null;
        }
      }),
    });

    const testHost = host({
      secretRead: (name: string) =>
        name === 'wechat_data_key_v1' ? dataKey.toString('base64') : null,
    });

    const authTransport = authorizationTransportReturning({
      token: 'new-token',
      botId: 'lease-bot',
      userId: 'new-user',
      baseUrl: 'https://ilinkai.weixin.qq.com',
    });

    const liveTransport = {
      notifyStart: vi.fn(async () => undefined),
      notifyStop: vi.fn(async () => undefined),
      poll: vi.fn(async (_cursor: string, signal: AbortSignal) => {
        // Long-poll that only ends when the epoch is aborted.
        await new Promise<void>((_, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      }),
      sendMessage: vi.fn(async () => {
        throw new WechatIlinkError('AUTH_REPLACED', 'authorization replaced', false);
      }),
    } as unknown as WechatTransport;

    const createTransport = vi
      .fn()
      .mockReturnValueOnce(authTransport)
      .mockReturnValueOnce(liveTransport);

    const dispatchAgentTurn = vi.fn(
      async () =>
        ({ kind: 'accepted', terminal: Promise.resolve({}) }) as never,
    );

    const im = new WechatIM(deps({ host: testHost, getDbClient: () => db, createTransport }));
    im.attachTurnRuntime({
      runner: {
        dispatchAgentTurn,
        stopActiveTurn: vi.fn(async () => ({ stopped: true })),
      } as never,
      repo: {
        prepareNewSession: vi.fn(async () => ({ id: 'wechat-session-1' }) as ImSessionRow),
        findActiveSession: vi.fn(async () => ({ id: 'wechat-session-1' }) as ImSessionRow),
        createSession: vi.fn(async () => ({ id: 'wechat-session-1' }) as ImSessionRow),
      } as never,
      config: {} as never,
      resetSessionToDefaults: vi.fn(async () => undefined),
    });

    await im.authorize();
    await vi.waitFor(() => expect(im.getState().phase).toBe('connected'));
    // The pump has called leaseNextTask and is now suspended inside the lease.
    await vi.waitFor(() =>
      expect(db.tx).toHaveBeenCalledWith(
        'wechatLeaseNextTask',
        expect.objectContaining({ bindingEpoch: activeBindingEpoch }),
      ),
    );
    // The concurrent direct send hits the replaced authorization and aborts
    // the epoch before the lease resolves.
    await expect(im.sendText('peer-1', 'outbound')).rejects.toThrow('authorization replaced');
    expect(im.getState()).toMatchObject({ phase: 'needs_reauth', errorCode: 'auth_replaced' });

    // The lease now resolves with a task for the just-aborted binding.
    releaseLease();

    // The stale pump must release the leased work instead of dispatching it.
    await vi.waitFor(() =>
      expect(db.tx).toHaveBeenCalledWith(
        'wechatReleaseDispatch',
        expect.objectContaining({ bindingEpoch: activeBindingEpoch, taskId: 'task-lease' }),
      ),
    );
    expect(dispatchAgentTurn).not.toHaveBeenCalled();

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
