/** Standard tier: real native control transport with in-memory CLI pipes.
 * Protects profile separation, bounded subprocess lifetime and sanitized errors, without real credentials.
 */
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  binary: '/fixture/codex' as string | null,
  spawn: vi.fn(),
  error: false,
  hold: false,
}));
vi.mock('node:child_process', () => ({ spawn: h.spawn }));
vi.mock('@cindy/maker-core', () => ({
  cleanProcessEnv: () => ({
    PATH: '/fixture/bin',
    OPENAI_API_KEY: 'fixture-key',
    CODEX_API_KEY: 'fixture-key',
    CODEX_HOME: '/wrong-profile',
  }),
}));
vi.mock('../../agent-binaries/index.js', () => ({ getReadyBinaryPath: () => h.binary }));
vi.mock('../../maker-host/claude-native-cli.js', () => ({
  refreshClaudeCliLoginStatus: vi.fn(),
  readClaudeCliPlanUsage: vi.fn(),
  runClaudeCliLogin: vi.fn(),
}));
import {
  codexAccountRpc,
  readNativeAccount,
  loginNativeAccount,
  readNativeCodexTokens,
} from '../nativeCli.js';

const children: (EventEmitter & {
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
})[] = [];
beforeEach(() => {
  h.binary = '/fixture/codex';
  h.error = false;
  h.hold = false;
  children.length = 0;
  h.spawn.mockReset().mockImplementation((_binary, args, options) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: Object.assign(new EventEmitter(), { write: vi.fn() }),
      stdout: new EventEmitter(),
      kill: vi.fn(),
    });
    child.kill.mockImplementation(() => {
      child.emit('close', null);
    });
    child.stdin.write.mockImplementation((line: string) => {
      const request = JSON.parse(line);
      if (!request.id || h.hold) return;
      queueMicrotask(() =>
        child.stdout.emit(
          'data',
          Buffer.from(
            JSON.stringify(
              request.id === 1
                ? { id: 1, result: {} }
                : h.error
                  ? { id: 2, error: { message: 'fixture-secret-must-not-leak' } }
                  : {
                      id: 2,
                      result: {
                        account: {
                          type: 'chatgpt',
                          email: options.env.CODEX_HOME + '@example.test',
                          planType: 'plus',
                        },
                      },
                    },
            ) + '\n',
          ),
        ),
      );
    });
    children.push(child);
    if (args[0] === 'login' && !h.hold) queueMicrotask(() => child.emit('close', 0));
    return child;
  });
});
afterEach(() => vi.useRealTimers());
describe('official Codex profiles', () => {
  it('expires a selected-profile dispatch proof when that profile is replaced or removed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cindy-subscription-proof-'));
    const authPath = path.join(dir, 'auth.json');
    try {
      await writeFile(
        authPath,
        JSON.stringify({
          tokens: { access_token: 'fixture-token-a', account_id: 'fixture-account-a' },
        }),
      );
      const [first, concurrent] = await Promise.all([
        readNativeCodexTokens(dir, true),
        readNativeCodexTokens(dir, true),
      ]);
      expect(h.spawn).toHaveBeenCalledTimes(1);
      expect(concurrent.accessToken).toBe(first.accessToken);
      expect(first.chatgptAccountId).toBe('fixture-account-a');
      expect(first.canDispatch()).toBe(true);
      await writeFile(
        authPath,
        JSON.stringify({
          tokens: { access_token: 'fixture-longer-token-b', account_id: 'fixture-account-b' },
        }),
      );
      expect(first.canDispatch()).toBe(false);
      const second = await readNativeCodexTokens(dir);
      expect(second.chatgptAccountId).toBe('fixture-account-b');
      await rm(authPath);
      expect(second.canDispatch()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('queries separate homes concurrently without changing process.env or passing API credentials', async () => {
    const inherited = process.env.CODEX_HOME;
    const result = await Promise.all([
      readNativeAccount('openai', '/fixture/default'),
      readNativeAccount('openai', '/fixture/second'),
    ]);
    expect(result.map((r) => r.identity)).toEqual([
      '/fixture/default@example.test',
      '/fixture/second@example.test',
    ]);
    expect(result.every((r) => r.authenticated)).toBe(true);
    expect(process.env.CODEX_HOME).toBe(inherited);
    expect(h.spawn.mock.calls.map((c) => c[2].env)).toEqual([
      { PATH: '/fixture/bin', CODEX_HOME: '/fixture/default' },
      { PATH: '/fixture/bin', CODEX_HOME: '/fixture/second' },
    ]);
    expect(children.every((c) => c.kill.mock.calls.length === 1)).toBe(true);
  });
  it('never returns CLI response details in errors and closes failed control processes', async () => {
    h.error = true;
    await expect(codexAccountRpc('/fixture/second', 'account/read', {})).rejects.toThrow(
      'Codex account request failed',
    );
    expect(children[0].kill).toHaveBeenCalledTimes(1);
  });
  it('bounds a stalled CLI read and cancels a browser login without querying another profile', async () => {
    vi.useFakeTimers();
    h.hold = true;
    const pending = expect(codexAccountRpc('/fixture/second', 'account/read', {})).rejects.toThrow(
      'timed out',
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    const abort = new AbortController();
    const login = expect(
      loginNativeAccount('openai', '/fixture/second', abort.signal),
    ).rejects.toThrow('login_cancelled');
    abort.abort();
    await login;
    expect(h.spawn.mock.calls.map((c) => c[1])).toEqual([['app-server'], ['login']]);
    expect(children.every((c) => c.kill.mock.calls.length === 1)).toBe(true);
  });
});
