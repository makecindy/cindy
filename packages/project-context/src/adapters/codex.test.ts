import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as processes from 'node:child_process';
import spawn from 'cross-spawn';
import { makeAdapter } from './factory.js';
import { mergeConfig } from '../config.js';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
const body = '# 示例\n\n## 是什么\n\n源码中的示例模块。\n\n## 模块边界\n\n仅依赖本地文件。\n';
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
  vi.mocked(processes.spawn).mockReset();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeProcess(pid?: number) {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
    pid,
  });
}

describe('Codex 项目知识维护', () => {
  it('通过现有配置选择 Codex，同时保留 Claude 默认值', () => {
    expect(makeAdapter(mergeConfig({ agent: 'codex' })).name).toBe('codex');
    expect(makeAdapter(mergeConfig({})).name).toBe('claude-code');
  });

  it('等待成功终态和进程结束，只接收最终文件中的正文', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pctx-codex-test-'));
    dirs.push(cwd);
    const child = fakeProcess();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const pending = makeAdapter(mergeConfig({ agent: 'codex' })).refreshKnowledge({
      cwd,
      oldContent: body,
      instruction: '更新项目知识',
      contextHint: 'src/**',
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const [, args, options] = vi.mocked(spawn).mock.calls[0];
    expect(options?.cwd).toBe(cwd);
    expect(args).toEqual(expect.arrayContaining(['exec', '--sandbox', 'read-only', '--json', '-']));
    const outputPath = args![args!.indexOf('--output-last-message') + 1];
    fs.writeFileSync(outputPath, body);
    child.stdout.write(
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: '我先查看源码' },
      }) + '\n',
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    child.stdout.write('{"type":"turn.completed"}\n');
    child.emit('close', 0);
    await expect(pending).resolves.toBe(body);
    expect(fs.existsSync(path.dirname(outputPath))).toBe(false);
  });

  it('拒绝丢失既有章节的最终正文', async () => {
    const child = fakeProcess();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const pending = makeAdapter(mergeConfig({ agent: 'codex' })).refreshKnowledge({
      cwd: os.tmpdir(),
      oldContent: body,
      instruction: '刷新',
      contextHint: 'src/**',
    });
    const assertion = expect(pending).rejects.toThrow('章节');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const args = vi.mocked(spawn).mock.calls[0][1]!;
    fs.writeFileSync(
      args[args.indexOf('--output-last-message') + 1],
      '# 示例\n\n## 是什么\n描述。',
    );
    child.stdout.write('{"type":"turn.completed"}\n');
    child.emit('close', 0);
    await assertion;
  });

  it.each([
    ['空正文', '', 'turn.completed', 0],
    ['带 frontmatter', '---\nid: injected\n---\n' + body, 'turn.completed', 0],
    ['全文代码围栏', '```markdown\n' + body + '```', 'turn.completed', 0],
    ['空摘要', '# 示例\n## 是什么\n## 模块边界\n边界', 'turn.completed', 0],
    ['TOC 不支持的摘要标题', body.replace('## 是什么', '## 是什么 ##'), 'turn.completed', 0],
    [
      '首个摘要为空',
      '# 示例\n## 是什么\n\n## 是什么\n描述。\n## 模块边界\n边界',
      'turn.completed',
      0,
    ],
    ['错误终态', body, 'turn.failed', 0],
    ['非零退出', body, 'turn.completed', 1],
    ['没有成功终态', body, 'item.completed', 0],
    ['缺失文件', null, 'turn.completed', 0],
  ])('%s 时拒绝返回正文并清理临时文件', async (_name, content, event, code) => {
    const child = fakeProcess();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const pending = makeAdapter(mergeConfig({ agent: 'codex' })).rewriteKnowledge({
      cwd: os.tmpdir(),
      oldContent: body,
      instruction: '更新',
      diff: '+ changed',
    });
    const assertion = expect(pending).rejects.toThrow('codex adapter:');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const args = vi.mocked(spawn).mock.calls[0][1]!;
    const output = args[args.indexOf('--output-last-message') + 1];
    if (content !== null) fs.writeFileSync(output, content);
    child.stderr.write('sensitive diagnostic');
    child.stdout.write(JSON.stringify({ type: event }));
    child.emit('close', code);
    await assertion;
    expect(fs.existsSync(path.dirname(output))).toBe(false);
  });

  it('通过 stdin 传递请求，支持命令路径与模型，忽略代码块内的伪章节', async () => {
    const child = fakeProcess();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const pending = makeAdapter(
      mergeConfig({
        agent: 'codex',
        agent_options: {
          command: 'C:/custom tools/codex.cmd',
          model: 'configured-model',
        },
      }),
    ).rewriteKnowledge({
      cwd: os.tmpdir(),
      oldContent: '---\nid: example\n---\n' + body + '\n```md\n## 不是章节\n```',
      instruction: '更新',
      diff: '+ "$(literal)" 中文',
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const [command, args] = vi.mocked(spawn).mock.calls[0];
    expect(command).toBe('C:/custom tools/codex.cmd');
    expect(args).toEqual(
      expect.arrayContaining(['--model', 'configured-model', 'approval_policy="never"']),
    );
    expect(child.stdin.read().toString()).toContain('+ "$(literal)" 中文');
    fs.writeFileSync(args![args!.indexOf('--output-last-message') + 1], body);
    child.stdout.write('{"type":"turn.comp');
    child.stdout.write('leted"}');
    child.emit('close', 0);
    await expect(pending).resolves.toBe(body);
  });

  it.each(['refresh', 'update'] as const)('%s 超时会终止本次进程并清理产物', async (mode) => {
    const child = fakeProcess();
    child.kill.mockImplementation(() => {
      child.emit('close', null);
    });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const adapter = makeAdapter(
      mergeConfig({
        agent: 'codex',
        agent_options: {
          timeout: mode === 'update' ? 0.15 : 10,
          refreshTimeout: mode === 'refresh' ? 0.15 : 10,
        },
      }),
    );
    const input = {
      cwd: os.tmpdir(),
      oldContent: body,
      instruction: '维护',
      contextHint: 'src/**',
      diff: '+ changed',
    };
    const assertion = expect(
      mode === 'refresh' ? adapter.refreshKnowledge(input) : adapter.rewriteKnowledge(input),
    ).rejects.toThrow('执行超时');
    await assertion;
    expect(child.kill).toHaveBeenCalledOnce();
    const args = vi.mocked(spawn).mock.calls[0][1]!;
    expect(fs.existsSync(path.dirname(args[args.indexOf('--output-last-message') + 1]))).toBe(
      false,
    );
  });

  it.each(['error', 'protocol', 'stdin'] as const)('%s 故障不会泄露底层诊断内容', async (kind) => {
    const child = fakeProcess();
    child.kill.mockImplementation(() => {
      child.emit('close', null);
    });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const pending = makeAdapter(mergeConfig({ agent: 'codex' })).refreshKnowledge({
      cwd: os.tmpdir(),
      oldContent: body,
      instruction: '刷新',
      contextHint: 'src/**',
    });
    const assertion = expect(pending).rejects.toThrow(/^codex adapter:(?!.*sensitive)/u);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    if (kind === 'error')
      child.emit('error', Object.assign(new Error('sensitive'), { code: 'ENOENT' }));
    else if (kind === 'protocol') child.stdout.write('sensitive\n');
    else child.stdin.emit('error', new Error('sensitive'));
    await assertion;
  });
});

it('父进程先退出而管道未关闭时仍尝试按本次进程组或进程树回收', async () => {
  const child = Object.assign(fakeProcess(12345), { exitCode: 0 });
  const killer = new EventEmitter();
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const nativeSpawn = vi
    .mocked(processes.spawn)
    .mockReturnValue(killer as ReturnType<typeof processes.spawn>);
  const killGroup = vi.spyOn(process, 'kill').mockReturnValue(true);
  const pending = makeAdapter(
    mergeConfig({ agent: 'codex', agent_options: { refreshTimeout: 0.15 } }),
  ).refreshKnowledge({
    cwd: os.tmpdir(),
    oldContent: body,
    instruction: '刷新',
    contextHint: 'src/**',
  });
  const assertion = expect(pending).rejects.toThrow('超时');
  await vi.waitFor(() => {
    if (process.platform === 'win32')
      expect(nativeSpawn).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '12345', '/T', '/F'],
        expect.objectContaining({ windowsHide: true }),
      );
    else expect(killGroup).toHaveBeenCalledWith(-12345, 'SIGKILL');
  });
  child.emit('close', 0);
  await assertion;
});
