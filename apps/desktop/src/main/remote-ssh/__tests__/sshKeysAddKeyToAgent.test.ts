/**
 * addKeyToAgent — 私钥路径不存在时稳定归类为 no_such_file (#1837)。
 * 只测缺失路径分支(不会真跑 ssh-add),覆盖 Windows 路径形态。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';

// mock execFile 以便断言"缺失路径时 ssh-add 不会被调用"(copilot review 指出的
// 测试意图与覆盖不一致问题)。ssh-keys.ts 用 promisify(execFile) 封装,只能在
// 模块加载前 mock node:child_process。
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

import { addKeyToAgent } from '../ssh-keys.js';

afterEach(() => {
  execFileMock.mockReset();
});

describe('addKeyToAgent — missing private key path', () => {
  // 注意:不含 UNC 路径——fs.access 对 `\\nas\...` 会真实解析网络主机,测试环境
  // 可能慢/挂起。UNC 的纯字符串形态由 maker-remote-ssh 的 expandHome 单测覆盖。
  it.each([
    ['windows-drive', String.raw`C:\Users\someone\.ssh\id_ed25519`],
    ['with-space', String.raw`C:\Users\my name\Documents\ssh keys\id_ed25519`],
    ['chinese', String.raw`D:\密钥\我的密钥\id_ed25519`],
  ])('%s', async (_label, path) => {
    const result = await addKeyToAgent({ privateKeyPath: path });
    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('no_such_file');
    // 真实路径必须出现在 hint 里,UI 才能显示"是哪个路径找不到"。
    expect(result.errorHint).toContain(path);
    expect(result.errorHint).toContain('not found');
  });

  it('classifies a missing path as no_such_file even with a passphrase', async () => {
    // 带 passphrase 走 SSH_ASKPASS 分支;缺失文件同样应在 ssh-add 之前被拦截。
    const missing = String.raw`C:\Users\someone\.ssh\id_ed25519`;
    const result = await addKeyToAgent({ privateKeyPath: missing, passphrase: 'secret' });
    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('no_such_file');
    expect(result.errorHint).toContain(missing);
  });

  it('does not spawn ssh-add for a missing file (pre-check short-circuits)', async () => {
    const missing = String.raw`C:\Users\someone\.ssh\id_ed25519`;
    const result = await addKeyToAgent({ privateKeyPath: missing });
    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('no_such_file');
    // 关键断言:缺失路径在 fs.access 就返回,execFile(ssh-add) 不被调用。
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe('addKeyToAgent — empty passphrase', () => {
  let tempDir = '';
  let privateKeyPath = '';
  let restoreTmpdir = () => {};

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-ssh-add-'));
    privateKeyPath = path.join(tempDir, 'id_ed25519');
    await fs.writeFile(privateKeyPath, 'not a real SSH key fixture');
    const tmpdirSpy = vi.spyOn(os, 'tmpdir').mockReturnValue(tempDir);
    restoreTmpdir = () => tmpdirSpy.mockRestore();
  });

  afterEach(async () => {
    restoreTmpdir();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('uses a blank askpass answer and bounds the ssh-add probe', async () => {
    let askpassScript = '';
    execFileMock.mockImplementation((...args: unknown[]) => {
      const options = args[2] as { env: NodeJS.ProcessEnv; timeout?: number };
      const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
      void fs.readFile(options.env.SSH_ASKPASS!, 'utf8').then((content) => {
        askpassScript = content;
        callback(null, '', '');
      });
      return {};
    });

    const result = await addKeyToAgent({ privateKeyPath, passphrase: '' });

    expect(result.success).toBe(true);
    expect(execFileMock).toHaveBeenCalledOnce();
    const [, args, options] = execFileMock.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv; timeout?: number },
      unknown,
    ];
    expect(args).toContain(privateKeyPath);
    expect(options.timeout).toBe(10_000);
    expect(options.env.SSH_ASKPASS_REQUIRE).toBe('force');
    expect(path.dirname(options.env.SSH_ASKPASS!)).toBe(tempDir);
    expect(askpassScript).toContain(process.platform === 'win32' ? 'echo(' : "''");
  });

  it('keeps a silent nonzero blank-probe exit in the bad-passphrase retry path', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
      const error = Object.assign(new Error('Command failed: ssh-add'), { code: 1, stderr: '' });
      callback(error, '', '');
      return {};
    });

    const result = await addKeyToAgent({ privateKeyPath, passphrase: '' });

    expect(result).toMatchObject({
      success: false,
      failureReason: 'bad_passphrase',
      errorHint: 'passphrase rejected by ssh-add',
    });
    expect(execFileMock.mock.calls[0]?.[2]).toMatchObject({ timeout: 10_000 });
  });

  it('keeps a blank-probe agent failure classified as agent unavailable', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
      const error = Object.assign(new Error('Command failed: ssh-add'), {
        code: 1,
        stderr: 'Could not open a connection to your authentication agent.',
      });
      callback(error, '', '');
      return {};
    });

    const result = await addKeyToAgent({ privateKeyPath, passphrase: '' });

    expect(result.failureReason).toBe('agent_unavailable');
  });

  it('returns a failure when ssh-add exceeds the empty-passphrase timeout', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
      const error = Object.assign(new Error('Command timed out'), {
        code: 'ETIMEDOUT',
        killed: true,
        stderr: '',
      });
      callback(error, '', '');
      return {};
    });

    const result = await addKeyToAgent({ privateKeyPath, passphrase: '' });

    expect(result).toMatchObject({
      success: false,
      failureReason: 'other',
      errorHint: 'ssh-add failed: Command timed out',
    });
    expect(execFileMock.mock.calls[0]?.[2]).toMatchObject({ timeout: 10_000 });
  });
});
