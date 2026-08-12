import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IMHost } from '@cindy/im';
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

  it('distinguishes agent-unsupported from permission-mode-unsupported pre-dispatch failures', () => {
    // Agent 未声明 turnPermissionPolicy(如 Pi):换权限模式无效,文案引导换 Agent。
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
    expect(testHost.secrets.remove).toHaveBeenCalledWith(
      `wechat_credentials_${newBindingEpoch}`,
    );
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
