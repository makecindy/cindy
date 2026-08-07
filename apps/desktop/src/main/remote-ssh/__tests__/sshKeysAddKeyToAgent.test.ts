/**
 * addKeyToAgent — 私钥路径不存在时稳定归类为 no_such_file (#1837)。
 * 只测缺失路径分支(不会真跑 ssh-add),覆盖 Windows 路径形态。
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

// mock execFile 以便断言"缺失路径时 ssh-add 不会被调用"(copilot review 指出的
// 测试意图与覆盖不一致问题)。ssh-keys.ts 用 promisify(execFile) 封装,只能在
// 模块加载前 mock node:child_process。
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

import { addKeyToAgent } from '../ssh-keys.js';

afterEach(() => {
  execFileMock.mockClear();
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
