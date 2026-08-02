import { describe, expect, it, vi } from 'vitest';

import { AppServerClient, detectAuthInvalidationReason } from './client.js';
import type { Logger } from '../../../interfaces/logger.js';
import type { Transport, LineHandler, StderrHandler, CloseHandler } from './transport.js';
import { Method } from './protocol.js';

class FakeTransport implements Transport {
  readonly lines: string[] = [];
  private writeError: Error | null = null;
  private readonly lineHandlers = new Set<LineHandler>();
  private readonly stderrHandlers = new Set<StderrHandler>();
  private readonly closeHandlers = new Set<CloseHandler>();

  async writeLine(line: string): Promise<void> {
    this.lines.push(line);
    if (this.writeError) throw this.writeError;
  }

  onLine(handler: LineHandler): () => void {
    this.lineHandlers.add(handler);
    return () => this.lineHandlers.delete(handler);
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  onStderr(handler: StderrHandler): () => void {
    this.stderrHandlers.add(handler);
    return () => this.stderrHandlers.delete(handler);
  }

  async close(reason = 'test close'): Promise<void> {
    for (const handler of this.closeHandlers) handler({ reason });
  }

  emitLine(value: unknown): void {
    const line = typeof value === 'string' ? value : JSON.stringify(value);
    for (const handler of this.lineHandlers) handler(line);
  }

  emitStderr(line: string): void {
    for (const handler of this.stderrHandlers) handler(line);
  }

  failWrites(error: Error): void {
    this.writeError = error;
  }
}

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: () => logger,
};

describe('detectAuthInvalidationReason', () => {
  const revokedRateLimitsError = {
    code: -32603,
    message:
      'failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized; content-type=text/plain; body={"error":{"message":"Encountered invalidated oauth token for user, failing request","code":"token_revoked"},"status":401}',
  };
  const cloudAuthError = (message: string, data: Record<string, unknown> = {}) => ({
    code: -32000,
    message,
    data: {
      reason: 'cloudRequirements',
      errorCode: 'Auth',
      ...data,
    },
  });

  it('maps provider-specific reasons inside structured cloud auth errors', () => {
    expect(
      detectAuthInvalidationReason(
        cloudAuthError('Your session has ended. Please log in again. (app_session_terminated)'),
      ),
    ).toBe('app_session_terminated');
    expect(
      detectAuthInvalidationReason(
        cloudAuthError('Your authentication token has been invalidated. (token_invalidated)'),
      ),
    ).toBe('token_invalidated');
    expect(
      detectAuthInvalidationReason(cloudAuthError('auth error code: token_revoked')),
    ).toBe('token_revoked');
    expect(
      detectAuthInvalidationReason(cloudAuthError('OAuth refresh token was already used')),
    ).toBe('refresh_token_reused');
  });

  it('uses token_invalidated for a generic structured relogin requirement', () => {
    expect(
      detectAuthInvalidationReason(
        cloudAuthError('Cloud requirements rejected the request', {
          errorCode: undefined,
          action: 'relogin',
        }),
      ),
    ).toBe('token_invalidated');
  });

  it('maps structured cloudConfigBundle auth errors from config load failures', () => {
    // codex-rs app-server config_errors.rs: thread/resume 等在配置加载阶段撞
    // 鉴权失败时返回 -32600 + reason=cloudConfigBundle (detail 带 refresh 失败句)。
    expect(
      detectAuthInvalidationReason({
        code: -32600,
        message:
          'failed to load configuration: Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.',
        data: {
          reason: 'cloudConfigBundle',
          errorCode: 'Auth',
          action: 'relogin',
          statusCode: 401,
          detail:
            'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.',
        },
      }),
    ).toBe('token_revoked');
    expect(
      detectAuthInvalidationReason({
        code: -32600,
        message: 'failed to load configuration: request failed',
        data: { reason: 'cloudConfigBundle', errorCode: 'Network' },
      }),
    ).toBeNull();
  });

  it('maps the text-only config-load token refresh failure without structured data', () => {
    expect(
      detectAuthInvalidationReason({
        code: -32600,
        message:
          'failed to load configuration: Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.',
      }),
    ).toBe('token_revoked');
    expect(
      detectAuthInvalidationReason({
        code: -32600,
        message:
          'failed to load configuration: Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.',
      }),
    ).toBe('token_invalidated');
    expect(
      detectAuthInvalidationReason({
        code: -32600,
        message:
          'failed to load configuration: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
      }),
    ).toBe('refresh_token_reused');
  });

  it('rejects config-load errors and bare refresh sentences that lack the paired signal', () => {
    // 非鉴权的配置加载失败: 不能清凭证。
    expect(
      detectAuthInvalidationReason({
        code: -32600,
        message: 'failed to load configuration: invalid TOML in config.toml',
      }),
    ).toBeNull();
    // 孤立句子没有 config-load 包装也没有结构化 provenance: 保持窄门。
    expect(
      detectAuthInvalidationReason({
        code: -32000,
        message:
          'Your access token could not be refreshed because your refresh token was revoked.',
      }),
    ).toBeNull();
  });

  it('rejects keyword matches without the structured cloud auth provenance', () => {
    expect(
      detectAuthInvalidationReason({
        code: -32000,
        message: 'tool output: source code mentions token_invalidated but no auth request failed',
      }),
    ).toBeNull();
    expect(
      detectAuthInvalidationReason({
        code: -32000,
        message: 'token_revoked',
        data: { reason: 'cloudRequirements', errorCode: 'Network' },
      }),
    ).toBeNull();
    expect(
      detectAuthInvalidationReason({
        code: -32000,
        message: 'refresh token was already used',
        data: { reason: 'toolExecution', errorCode: 'Auth', action: 'relogin' },
      }),
    ).toBeNull();
  });

  it('accepts an explicit 401 token error only for correlated account auth RPCs', () => {
    expect(
      detectAuthInvalidationReason(revokedRateLimitsError, Method.AccountRateLimitsRead),
    ).toBe('token_revoked');
    expect(
      detectAuthInvalidationReason(
        revokedRateLimitsError,
        Method.AccountRateLimitResetCreditConsume,
      ),
    ).toBe('token_revoked');
    expect(detectAuthInvalidationReason(revokedRateLimitsError, Method.ModelList)).toBeNull();
    expect(detectAuthInvalidationReason(revokedRateLimitsError)).toBeNull();
  });
});

describe('AppServerClient auth invalidation', () => {
  it('keeps stderr diagnostic-only even when it contains auth keywords', () => {
    const transport = new FakeTransport();
    const onAuthInvalidated = vi.fn();
    const client = new AppServerClient({
      createTransport: () => transport,
      logger,
      onAuthInvalidated,
    });
    client.start();

    transport.emitStderr('tool output: const code = "token_invalidated";');
    transport.emitStderr('app_session_terminated token_revoked refresh token was already used');

    expect(onAuthInvalidated).not.toHaveBeenCalled();
  });

  it('notifies once for correlated structured cloud auth response errors', async () => {
    const transport = new FakeTransport();
    const onAuthInvalidated = vi.fn();
    const client = new AppServerClient({
      createTransport: () => transport,
      logger,
      onAuthInvalidated,
    });
    client.start();

    const first = client.request('turn/start');
    const second = client.request('model/list');
    transport.emitLine({
      id: 1,
      error: {
        code: -32000,
        message: 'OAuth refresh token was already used',
        data: { reason: 'cloudRequirements', errorCode: 'Auth' },
      },
    });
    transport.emitLine({
      id: 2,
      error: {
        code: -32000,
        message: 'token_revoked',
        data: { reason: 'cloudRequirements', action: 'relogin' },
      },
    });

    await expect(first).rejects.toThrow(/refresh token was already used/i);
    await expect(second).rejects.toThrow(/token_revoked/i);
    expect(onAuthInvalidated).toHaveBeenCalledTimes(1);
    expect(onAuthInvalidated).toHaveBeenCalledWith('refresh_token_reused');
  });

  it('notifies for the account rate-limit 401 shape emitted by current codex-rs', async () => {
    const transport = new FakeTransport();
    const onAuthInvalidated = vi.fn();
    const client = new AppServerClient({
      createTransport: () => transport,
      logger,
      onAuthInvalidated,
    });
    client.start();

    const request = client.request(Method.AccountRateLimitsRead);
    transport.emitLine({
      id: 1,
      error: {
        code: -32603,
        message:
          'failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized; content-type=text/plain; body={"error":{"message":"Encountered invalidated oauth token for user, failing request","code":"token_revoked"},"status":401}',
      },
    });

    await expect(request).rejects.toThrow(/account\/rateLimits\/read.*401 Unauthorized/i);
    expect(onAuthInvalidated).toHaveBeenCalledTimes(1);
    expect(onAuthInvalidated).toHaveBeenCalledWith('token_revoked');
  });

  it('keeps auth correlation when an accepted write rejects before its response arrives', async () => {
    const transport = new FakeTransport();
    const onAuthInvalidated = vi.fn();
    const client = new AppServerClient({
      createTransport: () => transport,
      logger,
      onAuthInvalidated,
    });
    client.start();
    transport.failWrites(new Error('write callback failed after bytes were accepted'));

    const request = client.request('turn/start');
    await expect(request).rejects.toThrow(/write callback failed/i);
    expect(transport.lines).toHaveLength(1);

    transport.emitLine({
      id: 1,
      error: {
        code: -32000,
        message: 'token_revoked',
        data: { reason: 'cloudRequirements', errorCode: 'Auth' },
      },
    });

    expect(onAuthInvalidated).toHaveBeenCalledTimes(1);
    expect(onAuthInvalidated).toHaveBeenCalledWith('token_revoked');
  });

  it('does not trust structured auth errors for ids the client never issued', () => {
    const transport = new FakeTransport();
    const onAuthInvalidated = vi.fn();
    const client = new AppServerClient({
      createTransport: () => transport,
      logger,
      onAuthInvalidated,
    });
    client.start();

    transport.emitLine({
      id: 999,
      error: {
        code: -32000,
        message: 'token_invalidated',
        data: { reason: 'cloudRequirements', action: 'relogin' },
      },
    });

    expect(onAuthInvalidated).not.toHaveBeenCalled();
  });
});

describe('AppServerClient request timeout', () => {
  it('rejects and removes a pending request when the server stays connected without responding', async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      const client = new AppServerClient({
        createTransport: () => transport,
        logger,
      });
      client.start();

      const request = client.request(
        'thread/unsubscribe',
        { threadId: 'thread-1' },
        { timeoutMs: 25 },
      );
      const rejection = expect(request).rejects.toThrow(
        'codex app-server thread/unsubscribe timed out after 25ms',
      );
      await vi.advanceTimersByTimeAsync(25);

      await rejection;
      await expect(client.close()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AppServerClient server requests', () => {
  it('passes request id/method metadata to handlers and answers the original JSON-RPC request', async () => {
    const transport = new FakeTransport();
    const client = new AppServerClient({
      createTransport: () => transport,
      logger,
    });
    const handler = vi.fn(async (params, meta) => {
      expect(params).toEqual({ question: 'Pick one' });
      expect(meta).toEqual({ id: 'server-req-1', method: 'item/tool/requestUserInput' });
      return { answers: { q1: { answers: ['A'] } } };
    });

    client.setRequestHandler('item/tool/requestUserInput', handler);
    client.start();
    transport.emitLine({
      id: 'server-req-1',
      method: 'item/tool/requestUserInput',
      params: { question: 'Pick one' },
    });

    await vi.waitFor(() => {
      expect(transport.lines).toHaveLength(1);
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(JSON.parse(transport.lines[0] ?? '')).toEqual({
      id: 'server-req-1',
      result: { answers: { q1: { answers: ['A'] } } },
    });
  });
});
