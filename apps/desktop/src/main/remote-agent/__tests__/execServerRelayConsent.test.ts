/**
 * Codex exec-server 中继里的本机确认(供应商分享的受邀者任务)：凭证类操作等本机用户确认时，这条
 * 连接后面的消息按顺序排在它后面；允许才转给 exec-server，拒绝回 JSON-RPC 错误。
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawned = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: () => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill(): void;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => undefined;
    child.stdin.on('data', (chunk: Buffer) => {
      spawned.lines.push(...chunk.toString().split('\n').filter(Boolean));
    });
    return child;
  },
}));

import { ExecServerRelay } from '../controller/execServerRelay';
import type { ExecutorAction, ExecutorGateDecision } from '../executor/gate';
import { ExecutorWorkspace } from '../executor/workspace';

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-relay-consent-')));
  spawned.lines = [];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
  const workspace = new ExecutorWorkspace({ workingDir: root });
  const approved = new Set<string>();
  const pending: Array<{ action: ExecutorAction; answer(allowed: boolean): void }> = [];
  const replies: Array<Record<string, unknown>> = [];
  const isSecret = (action: ExecutorAction) => action.kind !== 'fetch' && action.kind !== 'exec' && action.path.endsWith('.env');
  const relay = new ExecServerRelay({
    codexPath: 'codex',
    cwd: root,
    workspace,
    authorize: (action): ExecutorGateDecision => {
      if (!isSecret(action)) return { ok: true };
      const key = action.kind === 'exec' || action.kind === 'fetch' ? '' : action.path;
      return approved.delete(key) ? { ok: true, elevated: true } : { ok: false, reason: 'needs confirmation' };
    },
    confirm: (action) => new Promise<boolean>((resolve) => {
      pending.push({
        action,
        answer: (allowed) => {
          if (allowed && action.kind !== 'exec' && action.kind !== 'fetch') approved.add(action.path);
          resolve(allowed);
        },
      });
    }),
    push: async (frames) => {
      for (const frame of frames) if (frame.kind === 'message' && frame.data) replies.push(JSON.parse(frame.data));
    },
  });
  relay.handle({ t: 'ws', connId: 'c1', kind: 'open', path: '/ws/exec-server' });
  const send = (message: Record<string, unknown>) =>
    relay.handle({ t: 'ws', connId: 'c1', kind: 'message', data: JSON.stringify(message) });
  const sentIds = () => spawned.lines.map((line) => (JSON.parse(line) as { id?: unknown }).id);
  return { relay, pending, replies, send, sentIds };
}

describe('exec-server relay with confirmation on this computer', () => {
  it('passes ordinary messages straight through', () => {
    const { send, sentIds, pending } = setup();
    send({ id: 1, method: 'fs/readFile', params: { path: path.join(root, 'a.txt') } });
    send({ method: 'initialized', params: {} });
    expect(sentIds()).toEqual([1, undefined]);
    expect(pending).toEqual([]);
  });

  it('checks fs/open replace as a write before allowing the handle stream', async () => {
    const { send, pending, replies } = setup();
    send({ id: 1, method: 'fs/open', params: { handleId: 'h1', mode: 'replace', path: path.join(root, '.env') } });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0].action).toEqual({ kind: 'write', path: path.join(root, '.env') });
    pending[0].answer(false);
    await vi.waitFor(() => expect(replies).toEqual([{ id: 1, error: { code: -32001, message: 'needs confirmation' } }]));
  });

  it('keeps later messages behind one that waits for the user, then forwards them in order', async () => {
    const { send, sentIds, pending } = setup();
    send({ id: 1, method: 'fs/readFile', params: { path: path.join(root, '.env') } });
    send({ id: 2, method: 'fs/readFile', params: { path: path.join(root, 'a.txt') } });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(sentIds()).toEqual([]);
    pending[0].answer(true);
    await vi.waitFor(() => expect(sentIds()).toEqual([1, 2]));
  });

  it('answers with an error when the user declines and carries on with the rest', async () => {
    const { send, sentIds, pending, replies } = setup();
    send({ id: 1, method: 'fs/readFile', params: { path: path.join(root, '.env') } });
    send({ id: 2, method: 'fs/readFile', params: { path: path.join(root, 'a.txt') } });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].answer(false);
    await vi.waitFor(() => expect(sentIds()).toEqual([2]));
    expect(replies).toEqual([{ id: 1, error: { code: -32001, message: 'needs confirmation' } }]);
  });

  it('drops what is still waiting when the connection closes', async () => {
    const { relay, send, sentIds, pending } = setup();
    send({ id: 1, method: 'fs/readFile', params: { path: path.join(root, '.env') } });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    relay.handle({ t: 'ws', connId: 'c1', kind: 'close' });
    pending[0].answer(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sentIds()).toEqual([]);
  });
});

describe('exec-server relay summary (#5764)', () => {
  function relayWith(opts: { allow: boolean; pushMs: number }) {
    let clock = 0;
    const warn = vi.fn();
    const relay = new ExecServerRelay({
      codexPath: 'codex',
      cwd: root,
      workspace: new ExecutorWorkspace({ workingDir: root }),
      authorize: (): ExecutorGateDecision => (opts.allow ? { ok: true } : { ok: false, reason: 'outside the workspace' }),
      push: async () => {
        clock += opts.pushMs;
      },
      now: () => clock,
      log: { warn },
    });
    relay.handle({ t: 'ws', connId: 'c1', kind: 'open', path: '/ws/exec-server' });
    const send = (message: Record<string, unknown>) =>
      relay.handle({ t: 'ws', connId: 'c1', kind: 'message', data: JSON.stringify(message) });
    return { relay, warn, send };
  }

  it('logs the first slow push right away and a summary with refusals when the task ends', async () => {
    const { relay, warn, send } = relayWith({ allow: false, pushMs: 2_500 });
    send({ id: 1, method: 'fs/walk', params: { path: path.join(root, '..', 'skills') } });
    await vi.waitFor(() => expect(relay.stats().pushes).toBe(1));
    expect(warn).toHaveBeenCalledWith('remote agent: exec-server push slow', { pushMs: 2_500, frames: 1 });
    relay.close();
    expect(relay.stats()).toEqual({ requests: 1, rejected: 1, pushes: 1, pushMaxMs: 2_500, pushAvgMs: 2_500, slowPushes: 1 });
    expect(warn).toHaveBeenLastCalledWith('remote agent: exec-server relay summary', relay.stats());
  });

  it('stays quiet when the link was fast and nothing was refused', () => {
    const { relay, warn, send } = relayWith({ allow: true, pushMs: 10 });
    send({ id: 1, method: 'fs/readFile', params: { path: path.join(root, 'a.txt') } });
    relay.close();
    expect(relay.stats()).toMatchObject({ requests: 1, rejected: 0, slowPushes: 0 });
    expect(warn).not.toHaveBeenCalled();
  });
});
