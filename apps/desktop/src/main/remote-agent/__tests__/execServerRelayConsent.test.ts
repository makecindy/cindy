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

const spawned = vi.hoisted(() => ({ lines: [] as string[], outputs: [] as PassThrough[], close: [] as Array<() => void> }));

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
    spawned.outputs.push(child.stdout);
    spawned.close.push(() => { child.emit('close', 0, null); });
    child.kill = () => undefined;
    child.stdin.on('data', (chunk: Buffer) => {
      spawned.lines.push(...chunk.toString().split('\n').filter(Boolean));
    });
    return child;
  },
}));

import { ExecServerRelay } from '../controller/execServerRelay';
import type { ManagedSkillOverlay } from '../controller/managedSkillOverlay';
import { RemoteExecutor } from '../executor/executor';
import { ExecutorGate, type ExecutorAction, type ExecutorGateDecision } from '../executor/gate';
import { ExecutorWorkspace } from '../executor/workspace';

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-relay-consent-')));
  spawned.lines = [];
  spawned.outputs = [];
  spawned.close = [];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function setup(
  authorize?: (action: ExecutorAction) => ExecutorGateDecision,
  managed?: { aliases: Array<{ from: string; to: string }>; overlays: ManagedSkillOverlay[] },
) {
  const workspace = new ExecutorWorkspace({ workingDir: root, aliases: managed?.aliases });
  const approved = new Set<string>();
  const pending: Array<{ action: ExecutorAction; answer(allowed: boolean): void }> = [];
  const replies: Array<Record<string, unknown>> = [];
  const isSecret = (action: ExecutorAction) => action.kind !== 'fetch' && action.kind !== 'exec' && action.path.endsWith('.env');
  const relay = new ExecServerRelay({
    codexPath: 'codex',
    cwd: root,
    workspace,
    authorize: authorize ?? ((action): ExecutorGateDecision => {
      if (!isSecret(action)) return { ok: true };
      const key = action.kind === 'exec' || action.kind === 'fetch' ? '' : action.path;
      return approved.delete(key) ? { ok: true, elevated: true } : { ok: false, reason: 'needs confirmation' };
    }),
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
    ...(managed ? { managedSkillOverlays: () => managed.overlays } : {}),
  });
  relay.handle({ t: 'ws', connId: 'c1', kind: 'open', path: '/ws/exec-server' });
  const send = (message: Record<string, unknown>) =>
    relay.handle({ t: 'ws', connId: 'c1', kind: 'message', data: JSON.stringify(message) });
  const sentIds = () => spawned.lines.map((line) => (JSON.parse(line) as { id?: unknown }).id);
  return { relay, workspace, pending, replies, send, sentIds };
}

// 测试价值：异步 realpath 后，真实 stdout 入口必须保序、背压，关闭/重连不能收到旧回复，退出不丢尾部。
// 旧用例只覆盖入站授权；最小输入是两个 JSON-RPC 输出和一次暂停的路径准备。unit，手动释放 Promise。
describe('exec-server asynchronous output projection', () => {
  it('identifies the executing computer for an unenforceable sandbox and preserves other RPC errors', async () => {
    const { relay, replies, sentIds } = setup();
    const message = 'sandbox intent cannot be enforced on this executor';
    const failure = { id: 1, error: { code: -32602, message, data: { reason: 'unsupported' } } };
    const other = { id: 2, error: { code: -32602, message: 'invalid cwd' } };
    try {
      for (const reply of [failure, other]) spawned.outputs[0].write(JSON.stringify(reply) + '\n');
      await vi.waitFor(() => expect(replies).toHaveLength(2));
      expect(replies[0]).toEqual({ ...failure, error: { ...failure.error,
        message: expect.stringContaining('Check sandbox support and the Codex version on the executing computer'),
      } });
      expect(replies[1]).toEqual(other);
      expect(sentIds()).toEqual([]);
    } finally { relay.close(); }
  });

  function holdProjection(workspace: ExecutorWorkspace) {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const prepare = workspace.prepareAgentProjection.bind(workspace);
    const pending: Array<Promise<Awaited<ReturnType<typeof prepare>>>> = [];
    const spy = vi.spyOn(workspace, 'prepareAgentProjection').mockImplementation(() => {
      const result = waiting.then(prepare);
      pending.push(result);
      return result;
    });
    return { release, spy, pending };
  }

  it('holds output in order without blocking other connections while path resolution is waiting', async () => {
    const { relay, workspace, replies } = setup();
    const held = holdProjection(workspace);
    try {
      spawned.outputs[0].write('{"id":1,"result":"first"}\n{"id":2,"result":"second"}\n');
      await vi.waitFor(() => expect(held.pending).toHaveLength(1));
      expect(replies).toEqual([]);
      expect(relay.busy()).toBe(true);
      expect(spawned.outputs[0].isPaused()).toBe(true);
      // 另一条连接有自己的输出队列，不被这条连接的磁盘读取挡住。
      held.spy.mockRestore();
      relay.handle({ t: 'ws', connId: 'c2', kind: 'open', path: '/ws/exec-server' });
      spawned.outputs[1].write('{"id":3,"result":"other"}\n');
      await vi.waitFor(() => expect(replies.map((item) => item.id)).toEqual([3]));
      held.release();
      await vi.waitFor(() => expect(replies.map((item) => item.id)).toEqual([3, 1, 2]));
      await vi.waitFor(() => expect(relay.busy()).toBe(false));
      expect(spawned.outputs[0].isPaused()).toBe(false);
    } finally {
      held.release();
      held.spy.mockRestore();
      relay.close();
    }
  });

  it.each(['close', 'reset'] as const)('discards old output after %s and reusing the connection id', async (action) => {
    const { relay, workspace, replies } = setup();
    const held = holdProjection(workspace);
    try {
      spawned.outputs[0].write('{"id":1,"result":"old"}\n');
      await vi.waitFor(() => expect(held.pending).toHaveLength(1));
      if (action === 'reset') relay.reset();
      else relay.handle({ t: 'ws', connId: 'c1', kind: 'close' });
      held.spy.mockRestore();
      relay.handle({ t: 'ws', connId: 'c1', kind: 'open', path: '/ws/exec-server' });
      spawned.outputs[1].write('{"id":2,"result":"new"}\n');
      held.release();
      await Promise.all(held.pending);
      await vi.waitFor(() => expect(replies).toEqual([{ id: 2, result: 'new' }]));
    } finally {
      held.release();
      held.spy.mockRestore();
      relay.close();
    }
  });

  it('finishes projecting the final reply before closing an exited exec-server connection', async () => {
    const { relay, workspace, replies } = setup();
    const held = holdProjection(workspace);
    try {
      spawned.outputs[0].write('{"id":1,"result":"last"}\n');
      await vi.waitFor(() => expect(held.pending).toHaveLength(1));
      spawned.close[0]();
      expect(relay.busy()).toBe(true);
      held.release();
      await vi.waitFor(() => expect(replies).toEqual([{ id: 1, result: 'last' }]));
      await vi.waitFor(() => expect(relay.busy()).toBe(false));
    } finally {
      held.release();
      held.spy.mockRestore();
      relay.close();
    }
  });

  it('closes only the failed connection without sending an unprojected reply', async () => {
    const { relay, workspace, replies, send, sentIds } = setup();
    const prepare = vi.spyOn(workspace, 'prepareAgentProjection').mockRejectedValueOnce(new Error('path preparation failed'));
    try {
      relay.handle({ t: 'ws', connId: 'c2', kind: 'open', path: '/ws/exec-server' });
      spawned.outputs[0].write('{"id":1,"result":"local path"}\n');
      spawned.outputs[1].write('{"id":2,"result":"other"}\n');
      await vi.waitFor(() => expect(replies).toEqual([{ id: 2, result: 'other' }]));
      send({ id: 3, method: 'fs/exists', params: { path: root } });
      expect(sentIds()).toEqual([]);
    } finally {
      prepare.mockRestore();
      relay.close();
    }
  });
});

describe('exec-server relay with confirmation on this computer', () => {
  it.skipIf(process.platform === 'win32')('replies to an invalid Windows path and continues the next request', async () => {
    const { relay, replies, send, sentIds } = setup();
    try {
      send({ id: 1, method: 'fs/writeFile', params: { path: 'C:/Agent/Temp/claude/scratchpad/marker.txt', dataBase64: '' } });
      send({ id: 2, method: 'fs/readFile', params: { path: path.join(root, 'normal.txt') } });
      await vi.waitFor(() => expect(replies).toEqual([{ id: 1, error: { code: -32602, message: 'Windows absolute paths must be mapped before use' } }]));
      expect(sentIds()).toContain(2);
    } finally {
      relay.close();
    }
  });

  it('uses an explicit session consent for subsequent Codex credential requests', async () => {
    const workspace = new ExecutorWorkspace({ workingDir: root });
    const gate = new ExecutorGate(workspace, 'full', Date.now, { confirmCredentials: true });
    const confirm = vi.fn(async () => 'session' as const);
    const executor = new RemoteExecutor({ workspace, gate, rgPath: 'unused', confirm });
    const relay = new ExecServerRelay({
      codexPath: 'codex', cwd: root, workspace,
      authorize: (action) => executor.check(action),
      confirm: (action) => executor.confirm(action),
      push: async () => undefined,
    });
    try {
      relay.handle({ t: 'ws', connId: 'credentials', kind: 'open', path: '/ws/exec-server' });
      for (const [id, file] of [[1, '.env'], [2, '.env.production']] as const) {
        relay.handle({
          t: 'ws', connId: 'credentials', kind: 'message',
          data: JSON.stringify({ id, method: 'fs/readFile', params: { path: path.join(root, file) } }),
        });
      }
      await vi.waitFor(() => expect(spawned.lines.map((line) => JSON.parse(line).id)).toEqual([1, 2]));
      expect(confirm).toHaveBeenCalledTimes(1);
    } finally {
      relay.close();
      await executor.close();
    }
  });
  it('passes ordinary messages straight through', () => {
    const { send, sentIds, pending } = setup();
    send({ id: 1, method: 'fs/readFile', params: { path: path.join(root, 'a.txt') } });
    send({ method: 'initialized', params: {} });
    expect(sentIds()).toEqual([1, undefined]);
    expect(pending).toEqual([]);
  });

  it('does not read old file content while a write is awaiting consent or after it is denied', async () => {
    const target = path.join(root, 'denied.txt');
    fs.writeFileSync(target, 'old content');
    const { relay, send, pending, replies, sentIds } = setup(() => ({ ok: false, reason: 'write denied' }));
    const read = vi.spyOn(fs, 'readFileSync');
    try {
      send({ id: 1, method: 'fs/writeFile', params: { path: target, dataBase64: Buffer.from('new content').toString('base64') } });
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      expect(read).not.toHaveBeenCalledWith(target);
      pending[0].answer(false);
      await vi.waitFor(() => expect(replies).toEqual([{ id: 1, error: { code: -32001, message: 'write denied' } }]));
      expect(read).not.toHaveBeenCalledWith(target);
      expect(sentIds()).toEqual([]);
    } finally {
      read.mockRestore();
      relay.close();
    }
  });

  it('reads old content only after the earlier confirmation has released the queued write', async () => {
    const target = path.join(root, 'queued.txt');
    fs.writeFileSync(target, 'old content');
    const { relay, send, pending, sentIds } = setup();
    const read = vi.spyOn(fs, 'readFileSync');
    try {
      send({ id: 1, method: 'fs/readFile', params: { path: path.join(root, '.env') } });
      send({ id: 2, method: 'fs/writeFile', params: { path: target, dataBase64: Buffer.from('new content').toString('base64') } });
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      expect(read).not.toHaveBeenCalledWith(target);
      pending[0].answer(true);
      await vi.waitFor(() => expect(sentIds()).toEqual([1, 2]));
      expect(read).toHaveBeenCalledWith(target);
    } finally {
      read.mockRestore();
      relay.close();
    }
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

// 测试价值：对方的 Codex 经执行环境找项目 Skill(`.agents/skills` 先 getMetadata，再 canonicalize、walk)，
// 托管 Skill 只有逐个目录的路径映射，修复前上级目录在项目里不存在就整个看不到(#13718)。入口是中继的
// 真实收发；最小输入是三条 NotFound 回包与一条带项目 Skill 的 walk 回包。unit，exec-server 用内存假进程。
describe('managed Skills in the agent project Skill directory (#13718)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
  function managedSetup() {
    const shadow = '/agent/runs/task-1/workspace';
    // 托管 Skill 在项目之外(这台电脑的插件目录)；工作目录就是项目。
    const skill = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-relay-skill-'))), 'learn');
    cleanups.push(() => fs.rmSync(path.dirname(skill), { recursive: true, force: true }));
    fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: learn\n---\n');
    fs.writeFileSync(path.join(skill, 'scripts', 'run.sh'), 'echo hi\n');
    // 文件名里的 `%41` 不能被对方解成 `A`。
    fs.writeFileSync(path.join(skill, 'scripts', '50%41.md'), '');
    const agentDir = `${shadow}/.agents/skills/cindy-learn`;
    const project = root;
    const context = setup(undefined, {
      aliases: [{ from: agentDir, to: skill }, { from: shadow, to: project }],
      overlays: [{ agentDir, localDir: skill }],
    });
    // 虚拟工作区：回包里的本机路径投影回对方的路径。
    context.workspace.setVirtualRoot('/agent/runs/task-1');
    const reply = async (id: number, line: Record<string, unknown>) => {
      spawned.outputs[0].write(JSON.stringify({ id, ...line }) + '\n');
      await vi.waitFor(() => expect(context.replies.some((item) => item.id === id)).toBe(true));
      return context.replies.find((item) => item.id === id)!;
    };
    return { ...context, shadow, project, reply, uri: (agentPath: string) => `file://${agentPath}` };
  }
  const notFound = { error: { code: -32004, message: 'No such file or directory (os error 2)' } };

  it('answers for the Skill directory when the project has none, and leaves other directories alone', async () => {
    const { relay, send, reply, shadow, uri } = managedSetup();
    try {
      send({ id: 1, method: 'fs/getMetadata', params: { path: uri(`${shadow}/.agents/skills`) } });
      expect((await reply(1, notFound)).result).toMatchObject({ isDirectory: true, isFile: false });
      send({ id: 2, method: 'fs/canonicalize', params: { path: uri(`${shadow}/.agents/skills`) } });
      expect((await reply(2, notFound)).result).toEqual({ path: uri(`${shadow}/.agents/skills`) });
      send({ id: 3, method: 'fs/walk', params: { path: uri(`${shadow}/.agents/skills`), options: { maxDepth: 6, maxEntries: 100, pruneHiddenDirectories: true } } });
      expect((await reply(3, notFound)).result).toEqual({
        entries: [
          { path: uri(`${shadow}/.agents/skills/cindy-learn`), kind: 'directory' },
          { path: uri(`${shadow}/.agents/skills/cindy-learn/SKILL.md`), kind: 'file' },
          { path: uri(`${shadow}/.agents/skills/cindy-learn/scripts`), kind: 'directory' },
          { path: uri(`${shadow}/.agents/skills/cindy-learn/scripts/50%2541.md`), kind: 'file' },
          { path: uri(`${shadow}/.agents/skills/cindy-learn/scripts/run.sh`), kind: 'file' },
        ],
        errors: [],
        truncated: false,
      });
      // 只补 `.agents/skills` 这一层：上一层与其他目录的回包原样转回。
      send({ id: 4, method: 'fs/getMetadata', params: { path: uri(`${shadow}/.agents`) } });
      expect(await reply(4, notFound)).toEqual({ id: 4, ...notFound });
      send({ id: 5, method: 'fs/walk', params: { path: uri(shadow), options: { maxDepth: 6, maxEntries: 100, pruneHiddenDirectories: false } } });
      expect(await reply(5, notFound)).toEqual({ id: 5, ...notFound });
    } finally { relay.close(); }
  });

  it('adds the managed Skills next to the project ones and replaces a same-named project directory', async () => {
    const { relay, send, reply, shadow, project, uri } = managedSetup();
    try {
      send({ id: 1, method: 'fs/walk', params: { path: uri(`${shadow}/.agents/skills`), options: { maxDepth: 1, maxEntries: 100, pruneHiddenDirectories: true } } });
      const local = (relative: string) => `file://${path.join(project, '.agents', 'skills', relative)}`;
      const result = (await reply(1, { result: { entries: [
        { path: local('release'), kind: 'directory' },
        { path: local('release/SKILL.md'), kind: 'file' },
        { path: local('cindy-learn'), kind: 'directory' },
        { path: local('cindy-learn/OTHER.md'), kind: 'file' },
      ], errors: [], truncated: false } })).result as { entries: Array<{ path: string }> };
      expect(result.entries.map((entry) => entry.path)).toEqual([
        uri(`${shadow}/.agents/skills/release`),
        uri(`${shadow}/.agents/skills/release/SKILL.md`),
        uri(`${shadow}/.agents/skills/cindy-learn`),
        uri(`${shadow}/.agents/skills/cindy-learn/SKILL.md`),
        // maxDepth 1：再下一层不列。
        uri(`${shadow}/.agents/skills/cindy-learn/scripts`),
      ]);
    } finally { relay.close(); }
  });
});
