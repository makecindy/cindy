/**
 * claude-setup-token —— 代用户跑一次官方 `claude setup-token`,拿到约一年有效的长期令牌。
 *
 * 官方命令只把令牌显示在终端里、不保存到任何地方,所以由本模块在后台的伪终端里运行它:
 * 浏览器授权仍由官方 CLI 打开、在 Anthropic 的页面上完成;授权后从还原出的终端屏幕上
 * 读出令牌,交给调用方写进该账号的 Claude 配置目录。令牌只在这一次调用里经手,
 * 不写日志、不进数据库、不发给界面或其他电脑(2026-11-24 用户裁决,见
 * docs/dev-rules/credentials-and-local-storage.md「Claude 订阅只经 Claude Code 自己的登录」)。
 *
 * 没有终端时该命令什么都不输出(实测),所以必须用伪终端;界面是增量刷新的,
 * 必须先还原屏幕再读(见 terminal-screen.ts)。
 */

import { TerminalScreen } from './terminal-screen.js';

/** The slice of a pseudo-terminal process this flow needs (node-pty's IPty satisfies it). */
export interface SetupTokenTerminal {
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number }) => void): unknown;
  kill(signal?: string): void;
}

export type SpawnSetupTokenTerminal = (
  binary: string,
  args: string[],
  options: { cols: number; rows: number; env: Record<string, string>; cwd: string; name: string },
) => SetupTokenTerminal;

export type ClaudeSetupTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'login_cancelled' | 'timeout' | 'local_unavailable' | 'login_failed' | 'token_not_permitted' };

// Wide enough that neither the sign-in address nor the token wraps.
const COLS = 2000;
const ROWS = 60;
/** The shape the official command prints: `sk-ant-oat01-…`, about 108 characters. */
const TOKEN = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{80,}$/;
const CREATED = /token created successfully/i;
/** Rendered below the token, so the token line above it is complete. */
const AFTER_TOKEN = /Store this token securely/i;
/** An organization policy forbids subscription tokens; the CLI says so and stops. */
const NOT_PERMITTED = /does not permit/i;
/** The same screen has to be read twice this far apart before the token is taken. */
const SETTLE_MS = 250;

/** The token shown on the success screen, or null while that screen is not complete. */
export function readSetupTokenScreen(lines: readonly string[]): string | null {
  if (!lines.some(line => CREATED.test(line)) || !lines.some(line => AFTER_TOKEN.test(line))) return null;
  const tokens = lines.map(line => line.trim()).filter(line => TOKEN.test(line));
  return tokens.length === 1 ? tokens[0] : null;
}

export function runClaudeSetupToken(options: {
  binary: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  spawn: SpawnSetupTokenTerminal;
}): Promise<ClaudeSetupTokenResult> {
  if (options.signal.aborted) return Promise.resolve({ ok: false, reason: 'login_cancelled' });
  const env: Record<string, string> = { TERM: 'xterm-256color' };
  for (const [key, value] of Object.entries(options.env)) if (typeof value === 'string') env[key] = value;
  let terminal: SetupTokenTerminal;
  try {
    terminal = options.spawn(options.binary, ['setup-token'], {
      cols: COLS, rows: ROWS, env, cwd: options.cwd, name: 'xterm-256color',
    });
  } catch {
    return Promise.resolve({ ok: false, reason: 'local_unavailable' });
  }
  return new Promise((resolve) => {
    const screen = new TerminalScreen(COLS, ROWS);
    let settled = false;
    let candidate: string | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: ClaudeSetupTokenResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(settleTimer);
      options.signal.removeEventListener('abort', onAbort);
      try { terminal.kill(); } catch { /* already exited */ }
      resolve(result);
    };
    const onAbort = () => finish({ ok: false, reason: 'login_cancelled' });
    const timeout = setTimeout(() => finish({ ok: false, reason: 'timeout' }), options.timeoutMs);
    options.signal.addEventListener('abort', onAbort, { once: true });
    const inspect = () => {
      if (settled) return;
      const lines = screen.lines();
      const token = readSetupTokenScreen(lines);
      if (!token) {
        candidate = null;
        if (lines.some(line => NOT_PERMITTED.test(line))) finish({ ok: false, reason: 'token_not_permitted' });
        return;
      }
      // Take the token only once two reads of a settled screen agree on it.
      if (candidate === token) finish({ ok: true, token });
      else {
        candidate = token;
        clearTimeout(settleTimer);
        settleTimer = setTimeout(inspect, SETTLE_MS);
      }
    };
    terminal.onData((data) => {
      if (settled) return;
      screen.write(data);
      const token = readSetupTokenScreen(screen.lines());
      if (token !== candidate) candidate = null;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(inspect, SETTLE_MS);
    });
    terminal.onExit(() => {
      if (settled) return;
      const lines = screen.lines();
      const token = readSetupTokenScreen(lines);
      if (token) finish({ ok: true, token });
      else finish({ ok: false, reason: lines.some(line => NOT_PERMITTED.test(line)) ? 'token_not_permitted' : 'login_failed' });
    });
  });
}
