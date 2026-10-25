import os from 'node:os';
import { RemoteTerminalHost, type PtySpawnFn } from '@cindy/terminal-core';
import { claudeNativeEnv, nativeCommand, nativeLoginCommand } from '../engines/native.js';
import type { TerminalClaudeLogin } from './claude-login.js';
import type { ProviderLoginState } from './login.js';

type Login = { state: ProviderLoginState; current(): void; ticket?: string; timer?: NodeJS.Timeout; work?: Promise<void>; finishing?: Promise<void> };
export type ProviderTerminalFrame = { chunks: Array<{ sequence: number; data: string }>; cursor: number; gap?: boolean; more?: boolean; exit?: { code: number | null } | null; state: ProviderLoginState };

/** Runs only the original Claude CLI, in its normal credential directory.
 * PTY bytes are confined to the initiating protected settings transaction. */
export class TerminalClaudeAuthorization {
  private closed = false;
  private readonly entries = new Map<string, Login>();
  private readonly terminals: RemoteTerminalHost;
  constructor(private readonly options: {
    auth: TerminalClaudeLogin;
    binary(): Promise<string | null>;
    assertCurrent(): void;
    spawn?: PtySpawnFn;
  }) {
    this.terminals = new RemoteTerminalHost({ getScope: () => { try { this.current(); return 'native-claude'; } catch { return null; } }, spawn: options.spawn, logger: { info() {}, warn() {} } });
  }
  private current() { if (this.closed) throw new Error('OWNER_CHANGED'); this.options.assertCurrent(); }
  begin(id: string, current: () => void, deadline: number): ProviderLoginState {
    this.current(); current();
    if (this.entries.has(id)) return this.state(id);
    if ([...this.entries.values()].some(entry => entry.state.status === 'pending')) throw new Error('PROVIDER_LOGIN_BUSY');
    const entry: Login = { state: { status: 'pending', expiresAt: deadline }, current: () => { this.current(); current(); if (entry.state.status !== 'pending') throw new Error('PROVIDER_LOGIN_STALE'); } };
    this.entries.set(id, entry);
    entry.timer = setTimeout(() => this.cancel(id, 'expired'), Math.max(0, deadline - Date.now())); entry.timer.unref();
    entry.work = (async () => {
      const ticket = await this.options.auth.begin(); entry.current(); entry.ticket = ticket.id;
      if (!ticket.needsLogin) { await this.finish(entry); return; }
      const binary = await this.options.binary(); entry.current();
      if (!binary) throw new Error('ENGINE_NOT_INSTALLED');
      const command = nativeCommand(binary, nativeLoginCommand('claude-code', 'login').args, claudeNativeEnv());
      const env = { ...Object.fromEntries(Object.keys(process.env).map(key => [key, undefined])), ...command.env };
      await this.terminals.invoke({ version: 1, op: 'create', id, cwd: os.homedir() }, { controller: id, assertCurrent: entry.current }, { program: { command: command.command, args: command.args, displayName: 'Claude Code' }, env });
      entry.current(); entry.state = { ...entry.state, terminal: true };
    })().catch(() => { if (entry.state.status === 'pending') entry.state = { status: 'error' }; clearTimeout(entry.timer); void this.closeTerminal(id); });
    return { ...entry.state };
  }
  state(id: string): ProviderLoginState { this.current(); const entry = this.entries.get(id); if (!entry) throw new Error('PROVIDER_LOGIN_STALE'); return { ...entry.state }; }
  private async finish(entry: Login) {
    entry.finishing ??= (async () => {
      entry.current();
      await this.options.auth.finish(entry.ticket!, entry.current);
      entry.state = { status: 'success' }; clearTimeout(entry.timer);
    })();
    await entry.finishing;
  }
  async exchange(id: string, input: unknown): Promise<ProviderTerminalFrame> {
    this.current(); const entry = this.entries.get(id);
    if (!entry) throw new Error('PROVIDER_LOGIN_STALE');
    entry.current(); await entry.work; entry.current();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_TERMINAL_ARGUMENT');
    const value = input as Record<string, unknown>;
    if (!['read', 'write', 'resize'].includes(String(value.op))) throw new Error('INVALID_TERMINAL_ARGUMENT');
    const frame = await this.terminals.invoke({ ...value, version: 1, id }, { controller: id, assertCurrent: entry.current }) as Omit<ProviderTerminalFrame, 'state'>;
    entry.current();
    if (value.op === 'read' && frame.exit) {
      try { if (frame.exit.code === 0) await this.finish(entry); else entry.state = { status: 'error' }; }
      catch { entry.state = { status: 'error' }; }
      clearTimeout(entry.timer);
    }
    return { ...frame, state: { ...entry.state } };
  }
  private async closeTerminal(id: string) { await this.terminals.invoke({ version: 1, op: 'close', id }, { controller: id, assertCurrent: () => this.current() }).catch(() => {}); }
  cancel(id: string, status: 'cancelled' | 'expired' = 'cancelled') {
    const entry = this.entries.get(id); if (!entry) return;
    clearTimeout(entry.timer);
    if (entry.state.status === 'pending') entry.state = { status };
    void this.closeTerminal(id);
  }
  async close() {
    this.closed = true;
    for (const entry of this.entries.values()) { clearTimeout(entry.timer); if (entry.state.status === 'pending') entry.state = { status: 'cancelled' }; }
    this.terminals.close();
    await Promise.allSettled([...this.entries.values()].flatMap(entry => [entry.work, entry.finishing]));
  }
}
