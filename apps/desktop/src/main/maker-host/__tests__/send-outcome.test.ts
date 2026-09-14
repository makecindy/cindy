import type { SessionSendResult } from '@cindy/maker-core';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHostSendFailure,
  HOST_SEND_FAILURE_CODES,
  observeFireAndForgetSendOutcome,
  sanitizeSendOutcomeError,
  toCompatibleMakerSendResult,
  toDesktopSessionDispatchOutcome,
} from '../send-outcome.js';

const mockState = vi.hoisted(() => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => mockState.logger,
}));

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('desktop send outcome helper', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('logs fire-and-forget accepted:false with ownership and dispatch fields', async () => {
    const result: SessionSendResult = {
      accepted: false,
      reason: 'cancelled-before-dispatch',
    };

    observeFireAndForgetSendOutcome(Promise.resolve(result), {
      owner: 'orca-worker-ready',
      entrypoint: 'CREATE_SESSION',
      sessionId: 'session-1',
      agentKind: 'codex',
      action: 'worker-ready-placeholder',
      context: 'CREATE_SESSION/session-1/worker-ready-placeholder',
    });
    await flushMicrotasks();

    expect(mockState.logger.warn).toHaveBeenCalledWith(
      'fire-and-forget send not dispatched',
      expect.objectContaining({
        owner: 'orca-worker-ready',
        entrypoint: 'CREATE_SESSION',
        sessionId: 'session-1',
        agentKind: 'codex',
        action: 'worker-ready-placeholder',
        kind: 'session-dispatch',
        source: 'fire-and-forget',
        reason: 'cancelled-before-dispatch',
        context: 'CREATE_SESSION/session-1/worker-ready-placeholder',
      }),
    );
  });

  it('logs rejected fire-and-forget sends with sanitized error metadata only', async () => {
    const err = new Error(
      'PROMPT_SECRET prompt text USER_MESSAGE file body TOKEN_VALUE should not be logged',
    ) as Error & { code?: string };
    err.name = 'UnsafePromptError';
    err.code = 'SESSION_RUNNING';

    observeFireAndForgetSendOutcome(Promise.reject(err), {
      owner: 'orca-worker-ready',
      entrypoint: 'SESSION_ENABLE_ORCA',
      sessionId: 'session-2',
      agentKind: 'claude-code',
      action: 'worker-ready-placeholder',
      context: 'SESSION_ENABLE_ORCA/session-2/worker-ready-placeholder',
    });
    await flushMicrotasks();

    expect(mockState.logger.warn).toHaveBeenCalledWith(
      'fire-and-forget send failed',
      expect.objectContaining({
        owner: 'orca-worker-ready',
        entrypoint: 'SESSION_ENABLE_ORCA',
        sessionId: 'session-2',
        agentKind: 'claude-code',
        action: 'worker-ready-placeholder',
        kind: 'session-dispatch',
        source: 'fire-and-forget',
        error: {
          errorName: 'UnsafePromptError',
          errorCode: 'SESSION_RUNNING',
          safeMessage: 'SESSION_RUNNING',
        },
      }),
    );
    const loggedPayload = JSON.stringify(mockState.logger.warn.mock.calls);
    expect(loggedPayload).not.toContain('PROMPT_SECRET');
    expect(loggedPayload).not.toContain('USER_MESSAGE');
    expect(loggedPayload).not.toContain('file body');
    expect(loggedPayload).not.toContain('TOKEN_VALUE');
  });

  it('normalizes unsafe error name and code before logging', async () => {
    const err = new Error('ordinary message') as Error & { code?: string };
    err.name = 'PROMPT_SECRET token TOKEN_VALUE file body C:\\Users\\sam\\secret.txt';
    err.code = 'SESSION_RUNNING TOKEN_VALUE C:\\Users\\sam\\secret.txt';

    observeFireAndForgetSendOutcome(Promise.reject(err), {
      owner: 'orca-worker-ready',
      entrypoint: 'SESSION_ENABLE_ORCA',
      sessionId: 'session-unsafe',
      agentKind: 'claude-code',
      action: 'worker-ready-placeholder',
      context: 'SESSION_ENABLE_ORCA/session-unsafe/worker-ready-placeholder',
    });
    await flushMicrotasks();

    expect(mockState.logger.warn).toHaveBeenCalledWith(
      'fire-and-forget send failed',
      expect.objectContaining({
        error: {
          errorName: 'Error',
          errorKind: 'unknown',
          safeMessage: 'Error',
        },
      }),
    );
    const loggedPayload = JSON.stringify(mockState.logger.warn.mock.calls);
    expect(loggedPayload).not.toContain('PROMPT_SECRET');
    expect(loggedPayload).not.toContain('TOKEN_VALUE');
    expect(loggedPayload).not.toContain('file body');
    expect(loggedPayload).not.toContain('secret.txt');
  });

  it('sanitizes non-Error rejections without stringifying the payload', async () => {
    observeFireAndForgetSendOutcome(
      Promise.reject({
        prompt: 'PROMPT_SECRET',
        token: 'TOKEN_VALUE',
        toString: () => 'USER_MESSAGE file body',
      }),
      {
        owner: 'orca-worker-ready',
        entrypoint: 'CREATE_SESSION',
        sessionId: 'session-3',
        action: 'worker-ready-placeholder',
        context: 'CREATE_SESSION/session-3/worker-ready-placeholder',
      },
    );
    await flushMicrotasks();

    const loggedPayload = JSON.stringify(mockState.logger.warn.mock.calls);
    expect(loggedPayload).toContain('"errorKind":"object"');
    expect(loggedPayload).not.toContain('PROMPT_SECRET');
    expect(loggedPayload).not.toContain('USER_MESSAGE');
    expect(loggedPayload).not.toContain('file body');
    expect(loggedPayload).not.toContain('TOKEN_VALUE');
  });

  it('creates host-send outcomes for host preflight failures', async () => {
    expect(createHostSendFailure('WORKDIR_MISSING', 'cwd missing')).toEqual({
      kind: 'host-send',
      accepted: false,
      code: 'WORKDIR_MISSING',
      message: 'cwd missing',
    });
    expect(createHostSendFailure('LAZY_CREATE_FAILED', 'lazy create failed')).toMatchObject({
      kind: 'host-send',
      accepted: false,
      code: 'LAZY_CREATE_FAILED',
    });
    expect(createHostSendFailure('REHYDRATE_FAILED', 'rehydrate failed')).toMatchObject({
      kind: 'host-send',
      accepted: false,
      code: 'REHYDRATE_FAILED',
    });
  });

  it('exports the host failure code list used for sanitizer allow-listing', async () => {
    expect(HOST_SEND_FAILURE_CODES).toEqual([
      'WORKDIR_MISSING',
      'LAZY_CREATE_FAILED',
      'REHYDRATE_FAILED',
      'SESSION_NOT_FOUND',
      'HOST_NOT_READY',
      'SESSION_RUNNING',
      'CREDENTIAL_SWITCH_BUSY',
      'SEND_FAILED',
    ]);
    for (const code of HOST_SEND_FAILURE_CODES) {
      const err = new Error(code) as Error & { code?: string };
      err.code = code;
      expect(sanitizeSendOutcomeError(err).errorCode).toBe(code);
    }
  });

  it('wraps maker dispatch outcomes separately from host outcomes', async () => {
    expect(
      toDesktopSessionDispatchOutcome(
        { accepted: false, reason: 'cancelled-before-dispatch' },
        { source: 'maker-ipc', context: 'SEND/session-4/send' },
      ),
    ).toEqual({
      kind: 'session-dispatch',
      source: 'maker-ipc',
      dispatched: false,
      reason: 'cancelled-before-dispatch',
      context: 'SEND/session-4/send',
      message: 'Session send was cancelled before vendor dispatch: SEND/session-4/send',
    });
  });

  it('preserves provider rejection through Desktop compatibility outcomes', async () => {
    const outcome = toDesktopSessionDispatchOutcome(
      { accepted: false, reason: 'provider-rejected-before-dispatch' },
      { source: 'goal', context: 'GOAL/session-4/continuation' },
    );

    expect(outcome).toEqual({
      kind: 'session-dispatch',
      source: 'goal',
      dispatched: false,
      reason: 'provider-rejected-before-dispatch',
      context: 'GOAL/session-4/continuation',
      message: 'Provider rejected the Session send before dispatch: GOAL/session-4/continuation',
    });
    expect(toCompatibleMakerSendResult(outcome)).toEqual({
      accepted: false,
      reason: 'provider-rejected-before-dispatch',
      outcome,
    });
  });

  it('keeps renderer compatibility payloads while carrying the typed outcome', async () => {
    const hostPayload = toCompatibleMakerSendResult(
      createHostSendFailure('WORKDIR_MISSING', 'cwd missing'),
    );
    expect(hostPayload).toEqual({
      accepted: false,
      reason: 'WORKDIR_MISSING',
      outcome: {
        kind: 'host-send',
        accepted: false,
        code: 'WORKDIR_MISSING',
        message: 'cwd missing',
      },
    });

    const dispatchPayload = toCompatibleMakerSendResult(
      toDesktopSessionDispatchOutcome(
        { accepted: false, reason: 'cancelled-before-dispatch' },
        { source: 'maker-ipc', context: 'SEND/session-5/send' },
      ),
    );
    expect(dispatchPayload.accepted).toBe(false);
    if (dispatchPayload.accepted) {
      throw new Error('expected dispatch payload to be a failure');
    }
    expect(dispatchPayload.reason).toBe('cancelled-before-dispatch');
    expect(dispatchPayload.outcome).toMatchObject({
      kind: 'session-dispatch',
      dispatched: false,
      reason: 'cancelled-before-dispatch',
    });
  });

  it('does not allow accepted and outcome to contradict at type level', () => {
    const diagnostics = collectTypeDiagnostics(`
      import type { DesktopMakerSendResult } from '../send-outcome.js';

      const ok: DesktopMakerSendResult = {
        accepted: true,
        outcome: { kind: 'session-dispatch', source: 'test', dispatched: true },
      };
      void ok;

      // @ts-expect-error accepted:true 不能携带 host failure。
      const hostFailureSuccess: DesktopMakerSendResult = { accepted: true, outcome: { kind: 'host-send', accepted: false, code: 'WORKDIR_MISSING', message: 'cwd missing' } };

      // @ts-expect-error accepted:true 不能携带 session dispatch failure。
      const dispatchFailureSuccess: DesktopMakerSendResult = { accepted: true, outcome: { kind: 'session-dispatch', source: 'test', dispatched: false, reason: 'cancelled-before-dispatch', message: 'not dispatched', context: 'test' } };

      // @ts-expect-error accepted:false 不能携带 dispatched:true。
      const dispatchSuccessFailure: DesktopMakerSendResult = { accepted: false, outcome: { kind: 'session-dispatch', source: 'test', dispatched: true } };
    `);

    expect(diagnostics).toEqual([]);
  }, 15_000);
});

function collectTypeDiagnostics(source: string): string[] {
  const testPath = path.resolve(__dirname, 'send-outcome-types.fixture.ts').replace(/\\/g, '/');
  const sendOutcomePath = path.resolve(__dirname, '..', 'send-outcome.ts').replace(/\\/g, '/');
  const makerCorePath = path.resolve(__dirname, 'maker-core.fixture.d.ts').replace(/\\/g, '/');
  const loggerPath = path.resolve(__dirname, '..', 'logger.fixture.d.ts').replace(/\\/g, '/');
  const files = new Map<string, string>([
    [testPath, source],
    // 这里的 maker-core fixture 只为类型互斥测试提供最小边界。
    // 如果 packages/maker-core/src/session.ts 的 SessionSendResult 新增分支，
    // 需要同步评估这里是否也要扩展，否则测试会比生产类型更窄。
    [makerCorePath, `
      export type SessionSendResult =
        | { accepted: true }
        | { accepted: false; reason: 'cancelled-before-dispatch' };

      export type SessionDispatchOutcome =
        | { dispatched: true }
        | {
            dispatched: false;
            reason: 'cancelled-before-dispatch';
            message: string;
            context: string;
          };

      export declare function assertSendDispatched(result: SessionSendResult, context: string): void;
      export declare function toSessionDispatchOutcome(result: SessionSendResult, context: string): SessionDispatchOutcome;
    `],
    [loggerPath, `
      export declare function createLogger(scope: string): {
        warn(message: string, fields?: Record<string, unknown>): void;
      };
    `],
  ]);
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  const host = ts.createCompilerHost(options, true);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (fileName) => files.has(fileName.replace(/\\/g, '/')) || originalFileExists(fileName);
  host.readFile = (fileName) => files.get(fileName.replace(/\\/g, '/')) ?? originalReadFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const normalized = fileName.replace(/\\/g, '/');
    const inMemorySource = files.get(normalized);
    if (inMemorySource !== undefined) {
      return ts.createSourceFile(fileName, inMemorySource, languageVersion, true);
    }
    return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  // 类型互斥测试只关心 send-outcome.ts 的公开类型，不需要解析 maker-core/logger
  // 的真实源码图；用虚拟声明把 Program 限到最小边界，避免全量并发时超时。
  host.resolveModuleNames = (moduleNames) =>
    moduleNames.map((moduleName) => {
      if (moduleName === '../send-outcome.js') {
        return { resolvedFileName: sendOutcomePath, extension: ts.Extension.Ts };
      }
      if (moduleName === '@cindy/maker-core') {
        return { resolvedFileName: makerCorePath, extension: ts.Extension.Dts };
      }
      if (moduleName === '../logger.js') {
        return { resolvedFileName: loggerPath, extension: ts.Extension.Dts };
      }
      return ts.resolveModuleName(moduleName, testPath, options, host).resolvedModule;
    });
  const program = ts.createProgram({
    rootNames: [testPath, sendOutcomePath],
    options,
    host,
  });
  return ts.getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file?.fileName.replace(/\\/g, '/') === testPath)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}
