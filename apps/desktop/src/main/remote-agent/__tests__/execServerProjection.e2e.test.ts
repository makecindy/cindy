import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ExecServerRelay } from '../controller/execServerRelay';
import { ExecutorWorkspace } from '../executor/workspace';
import type { ExecutorAction } from '../executor/gate';

const REPO = path.resolve(__dirname, '../../../../../..');
const CODEX = path.join(REPO, 'apps', 'codex-package-bin', process.platform + '-' + process.arch, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');

describe.skipIf(!fs.existsSync(CODEX))('native exec-server workspace projection', () => {
  // 测试价值：生产入口 ExecServerRelay → 原生 exec-server 必须能从含空格的别名目录
  // 启动程序。#6743 的旧实现把 argv[0] 当 Shell 文本引用，Windows 实际报 os error 123；
  // 现有 E2E 只使用未映射的 process.execPath。最小失败输入是一个程序目录别名，e2e tier。
  it('starts an executable through an alias without adding shell quoting', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-exec-argv-')));
    const programs = path.join(root, 'Program Files');
    const executableName = process.platform === 'win32' ? 'node.exe' : 'node';
    const executable = path.join(programs, executableName);
    fs.mkdirSync(programs);
    if (process.platform === 'win32') {
      fs.copyFileSync(process.execPath, executable);
    } else {
      fs.symlinkSync(process.execPath, executable);
    }
    const virtual = '/agent/programs';
    const workspace = new ExecutorWorkspace({ workingDir: root, aliases: [{ from: virtual, to: programs }] });
    const messages: Array<Record<string, any>> = [];
    const actions: ExecutorAction[] = [];
    let parts = '';
    const relay = new ExecServerRelay({
      codexPath: CODEX,
      cwd: root,
      workspace,
      authorize: (action) => { actions.push(action); return { ok: true }; },
      push: async (frames) => {
        for (const frame of frames) {
          if (frame.kind !== 'message') continue;
          parts += frame.data;
          if (!frame.more) { messages.push(JSON.parse(parts)); parts = ''; }
        }
      },
    });
    const send = (message: unknown) => relay.handle({
      t: 'ws', connId: 'argv', kind: 'message', data: JSON.stringify(message),
    });
    try {
      relay.handle({ t: 'ws', connId: 'argv', kind: 'open', path: '/ws/exec-server' });
      send({ id: 1, method: 'initialize', params: { clientName: 'cindy-test', clientVersion: '1' } });
      await expect.poll(() => messages.find((item) => item.id === 1), { timeout: 5000 }).toBeDefined();
      expect(messages.find((item) => item.id === 1)?.error).toBeUndefined();
      send({ method: 'initialized', params: {} });
      send({ id: 2, method: 'process/start', params: {
        processId: 'argv',
        argv: [`${virtual}/${executableName}`, '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'space in argument', 'literal "quotes"'],
        cwd: pathToFileURL(root).href,
        env: { PATH: programs, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir() } : {}) },
        tty: false,
      } });
      await expect.poll(() => messages.find((item) => item.id === 2), { timeout: 5000 }).toBeDefined();
      expect(messages.find((item) => item.id === 2)?.error).toBeUndefined();
      await expect.poll(() => messages.find((item) => item.method === 'process/exited'), { timeout: 5000 }).toBeDefined();
      expect(messages.find((item) => item.method === 'process/exited')?.params.exitCode).toBe(0);
      const output = messages.filter((item) => item.method === 'process/output')
        .map((item) => Buffer.from(item.params.chunk, 'base64').toString()).join('');
      expect(JSON.parse(output)).toEqual(['space in argument', 'literal "quotes"']);
      expect(actions).toEqual([expect.objectContaining({ kind: 'exec', cwd: root })]);
    } finally {
      relay.close();
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('initializes and executes with virtual paths while the file and authorization stay on this computer', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-exec-projection-')));
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    const virtual = '/Users/agent/workspace';
    const workspace = new ExecutorWorkspace({ workingDir: project, aliases: [{ from: virtual, to: project }] });
    workspace.setVirtualRoot('/Users/agent');
    const messages: Array<Record<string, any>> = [];
    const actions: ExecutorAction[] = [];
    let parts = '';
    const relay = new ExecServerRelay({
      codexPath: CODEX,
      cwd: project,
      workspace,
      authorize: (action) => { actions.push(action); return { ok: true }; },
      push: async (frames) => {
        for (const frame of frames) {
          if (frame.kind !== 'message') continue;
          parts += frame.data;
          if (!frame.more) { messages.push(JSON.parse(parts)); parts = ''; }
        }
      },
    });
    const send = (message: unknown) => relay.handle({ t: 'ws', connId: 'c1', kind: 'message', data: JSON.stringify(message) });
    try {
      relay.handle({ t: 'ws', connId: 'c1', kind: 'open', path: '/ws/exec-server' });
      send({ id: 1, method: 'initialize', params: { clientName: 'cindy-test', clientVersion: '1' } });
      await expect.poll(() => messages.find((item) => item.id === 1), { timeout: 5000 }).toBeDefined();
      const init = messages.find((item) => item.id === 1)!;
      expect(init.result.environmentInfo.cwd).toBe('file:///Users/agent/workspace');
      expect(init.result.environmentInfo.userHomeDir).not.toBe(pathToFileURL(os.homedir()).href);
      send({ method: 'initialized', params: {} });
      send({ id: 2, method: 'process/start', params: {
        processId: 'p1',
        argv: [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], "correct computer"); console.log(process.cwd());', virtual + '/made.txt'],
        cwd: 'file:///Users/agent/workspace',
        env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir() } : {},
        tty: false,
      } });
      await expect.poll(() => messages.some((item) => item.method === 'process/closed'), { timeout: 5000 }).toBe(true);
      expect(messages.find((item) => item.id === 2)?.error).toBeUndefined();
      expect(fs.readFileSync(path.join(project, 'made.txt'), 'utf8')).toBe('correct computer');
      const output = messages.filter((item) => item.method === 'process/output')
        .map((item) => Buffer.from(item.params.chunk, 'base64').toString()).join('');
      expect(output.trim()).toBe(virtual);
      expect(actions).toEqual([expect.objectContaining({ kind: 'exec', cwd: project })]);
      expect(JSON.stringify(messages)).not.toContain(project.replace(/\\/g, '\\\\'));

      // Pinned Codex 0.159.2 writes through fs/writeFile (dataBase64), not fs/writeBlock.
      // Exercise its real wire contract and verify an edit keeps the file's original path spelling.
      const target = path.join(project, 'paths.json');
      const original = { out: path.join(project, 'build', 'out.txt'), label: 'before' };
      fs.writeFileSync(target, JSON.stringify(original));
      send({ id: 3, method: 'fs/writeFile', params: {
        path: 'file://' + virtual + '/paths.json',
        dataBase64: Buffer.from(JSON.stringify({ out: virtual + '/build/out.txt', label: 'after' })).toString('base64'),
      } });
      await expect.poll(() => messages.find((item) => item.id === 3), { timeout: 5000 }).toBeDefined();
      expect(messages.find((item) => item.id === 3)?.error).toBeUndefined();
      expect(fs.readFileSync(target, 'utf8')).toBe(JSON.stringify({ ...original, label: 'after' }));
      expect(actions.at(-1)).toEqual({ kind: 'write', path: target });
    } finally {
      relay.close();
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

// Codex 的后台终端在本机 exec-server 里：还有进程在跑时中继算忙，连接池不能让出名额
// (对方 Codex 一退出，本机 exec-server 随连接关闭，后台终端就没了)。
describe.skipIf(!fs.existsSync(CODEX) || process.platform === 'win32')('exec-server relay busy tracking', () => {
  it('is busy while a started process runs, idle after it closes or its connection is dropped, and reset drops the exec-server', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-exec-busy-')));
    const workspace = new ExecutorWorkspace({ workingDir: root });
    const messages: Array<{ id?: number; method?: string; params?: { processId?: string }; error?: unknown }> = [];
    let parts = '';
    let ended = 0;
    // 模拟交付链路断开：下一次推送失败，中继会丢掉未发帧并从本机这侧关掉全部连接。
    let failNextPush = false;
    const relay = new ExecServerRelay({
      codexPath: CODEX,
      cwd: root,
      workspace,
      authorize: (action) => (action.kind === 'exec' && action.command.includes('denied') ? { ok: false, reason: 'no' } : { ok: true }),
      // 最后一个进程结束 = 一次活动(连接池的闲置从这时算起)。
      onProcessesEnded: () => {
        ended += 1;
      },
      push: async (frames) => {
        if (failNextPush) {
          failNextPush = false;
          throw new Error('link down');
        }
        for (const frame of frames) {
          if (frame.kind !== 'message') continue;
          parts += frame.data;
          if (!frame.more) { messages.push(JSON.parse(parts)); parts = ''; }
        }
      },
    });
    const send = (message: unknown) => relay.handle({ t: 'ws', connId: 'c1', kind: 'message', data: JSON.stringify(message) });
    const start = (id: number, processId: string, script: string) => send({ id, method: 'process/start', params: {
      processId, argv: ['/bin/sh', '-c', script], cwd: pathToFileURL(root).href, env: {}, tty: false,
    } });
    try {
      relay.handle({ t: 'ws', connId: 'c1', kind: 'open', path: '/ws/exec-server' });
      expect(relay.busy()).toBe(false);
      send({ id: 1, method: 'initialize', params: { clientName: 'cindy-test', clientVersion: '1' } });
      await expect.poll(() => messages.find((item) => item.id === 1), { timeout: 5000 }).toBeDefined();
      send({ method: 'initialized', params: {} });

      // 闸门拒绝的启动不会留下进程。
      start(2, 'denied', 'echo denied');
      await expect.poll(() => messages.find((item) => item.id === 2)?.error, { timeout: 5000 }).toBeDefined();
      await expect.poll(() => relay.busy(), { timeout: 5000 }).toBe(false);
      expect(ended).toBe(0);

      // 短命令跑完就不忙。
      start(3, 'short', 'exit 0');
      await expect.poll(() => messages.some((item) => item.method === 'process/closed' && item.params?.processId === 'short'), { timeout: 5000 }).toBe(true);
      await expect.poll(() => relay.busy(), { timeout: 5000 }).toBe(false);
      expect(ended).toBe(1);

      // 还在跑的(如 Codex 的后台终端)算忙。
      start(4, 'long', 'sleep 30');
      await expect.poll(() => messages.some((item) => item.id === 4), { timeout: 5000 }).toBe(true);
      expect(relay.busy()).toBe(true);
      expect(ended).toBe(1);
      send({ id: 5, method: 'process/terminate', params: { processId: 'long' } });
      await expect.poll(() => messages.some((item) => item.method === 'process/closed' && item.params?.processId === 'long'), { timeout: 5000 }).toBe(true);
      await expect.poll(() => relay.busy(), { timeout: 5000 }).toBe(false);
      // closed / exited 可能都会来，只算一次。
      expect(ended).toBe(2);

      // 本机这侧断开(推送失败、exec-server 异常退出)：先排进关闭帧再删连接，带着的工作同样算一次由忙转闲。
      // 用对方不认识的方法只换来一条错误回复，进程仍在跑，不会经 process/closed 先报一次。
      start(6, 'local', 'sleep 30');
      await expect.poll(() => messages.some((item) => item.id === 6), { timeout: 5000 }).toBe(true);
      expect(relay.busy()).toBe(true);
      failNextPush = true;
      send({ id: 7, method: 'cindy/test-ping', params: {} });
      await expect.poll(() => ended, { timeout: 5000 }).toBe(3);

      // 对方关闭 WebSocket：连接带着还在跑的进程被整条删掉，同样算一次。
      relay.handle({ t: 'ws', connId: 'c1', kind: 'open', path: '/ws/exec-server' });
      send({ id: 8, method: 'initialize', params: { clientName: 'cindy-test', clientVersion: '1' } });
      await expect.poll(() => messages.find((item) => item.id === 8), { timeout: 5000 }).toBeDefined();
      send({ method: 'initialized', params: {} });
      start(10, 'dropped', 'sleep 30');
      await expect.poll(() => messages.some((item) => item.id === 10), { timeout: 5000 }).toBe(true);
      expect(relay.busy()).toBe(true);
      relay.handle({ t: 'ws', connId: 'c1', kind: 'close' });
      await expect.poll(() => relay.busy(), { timeout: 5000 }).toBe(false);
      expect(ended).toBe(4);

      // 让出名额后关掉 exec-server，中继本身还能接新的连接。
      relay.reset();
      expect(relay.busy()).toBe(false);
      relay.handle({ t: 'ws', connId: 'c2', kind: 'open', path: '/ws/exec-server' });
      relay.handle({ t: 'ws', connId: 'c2', kind: 'message', data: JSON.stringify({ id: 9, method: 'initialize', params: { clientName: 'cindy-test', clientVersion: '1' } }) });
      await expect.poll(() => messages.find((item) => item.id === 9), { timeout: 5000 }).toBeDefined();

      // 启动失败(exec-server 回 JSON-RPC 错误)不会留下进程，同样算一次由忙转闲。
      const sendC2 = (message: unknown) => relay.handle({ t: 'ws', connId: 'c2', kind: 'message', data: JSON.stringify(message) });
      sendC2({ method: 'initialized', params: {} });
      sendC2({ id: 11, method: 'process/start', params: {
        processId: 'missing-binary', argv: [path.join(root, 'no-such-binary')], cwd: pathToFileURL(root).href, env: {}, tty: false,
      } });
      await expect.poll(() => messages.find((item) => item.id === 11), { timeout: 5000 }).toBeDefined();
      expect(messages.find((item) => item.id === 11)?.error).toBeDefined();
      await expect.poll(() => ended, { timeout: 5000 }).toBe(5);
    } finally {
      relay.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
