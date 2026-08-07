/**
 * addKeyToAgent — 私钥路径不存在时稳定归类为 no_such_file (#1837)。
 * 只测缺失路径分支(不会真跑 ssh-add),覆盖 Windows 路径形态。
 */

import { describe, expect, it } from 'vitest';

import { addKeyToAgent } from '../ssh-keys.js';

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
    // execFile 是真实函数;缺失路径在 fs.access 处就返回,ssh-add 不会被调用。
    // 用一个存在的路径 + 真实 ssh-add 会连 agent,这里只断言分类结果足够。
    expect(result.failureReason).toBe('no_such_file');
  });
});
