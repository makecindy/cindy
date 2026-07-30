/**
 * localCliDetect 单测 —— 纯函数 + 注入 deps,不碰真实 home / Keychain(规则 23:
 * 全内存 stub 零落盘)。claude 走跨平台 hasClaudeLogin,codex 走文件 stat。
 */

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { scanLocalCliAuth, type LocalCliScanDeps } from '../localCliDetect.js';

const HOME = join('/tmp', 'cli-detect-home');

function depsWith(
  dirs: string[],
  files: string[],
  claudeLogin = false,
  shared: (cli: string) => boolean = () => true,
): LocalCliScanDeps {
  const dirSet = new Set(dirs.map((d) => join(HOME, d)));
  const fileSet = new Set(files.map((f) => join(HOME, f)));
  return {
    homeDir: HOME,
    isDirectory: async (p) => dirSet.has(p),
    isFile: async (p) => fileSet.has(p),
    hasClaudeLogin: () => claudeLogin,
    isCredentialSharedWithCindy: (cli) => shared(cli),
  };
}

describe('scanLocalCliAuth', () => {
  it('都未安装未登录 → installed/loggedIn 全 false', async () => {
    const r = await scanLocalCliAuth(depsWith([], [], false));
    expect(r).toHaveLength(2);
    expect(r.every((d) => !d.installed && !d.loggedIn)).toBe(true);
  });

  it('claude 已登录(有目录)/ codex 仅安装未登录', async () => {
    const r = await scanLocalCliAuth(depsWith(['.claude', '.codex'], [], true));
    const claude = r.find((d) => d.cli === 'claude-cli');
    const codex = r.find((d) => d.cli === 'codex-cli');
    expect(claude).toMatchObject({ providerId: 'anthropic', installed: true, loggedIn: true });
    expect(codex).toMatchObject({ providerId: 'openai', installed: true, loggedIn: false });
  });

  it('claude 走 Keychain 登录但无 ~/.claude 目录 → 仍判已安装已登录(macOS 场景)', async () => {
    // 关键回归:Mac 用户经 Keychain 登录 Claude Code,可能没有 ~/.claude 目录,
    // 只 stat 文件会漏报;hasClaudeLogin=true 时 installed 也应为 true。
    const r = await scanLocalCliAuth(depsWith([], [], true));
    const claude = r.find((d) => d.cli === 'claude-cli');
    expect(claude).toMatchObject({ installed: true, loggedIn: true });
  });

  it('claude 未登录(hasClaudeLogin=false)→ 即使有 ~/.claude 目录也 loggedIn=false', async () => {
    const r = await scanLocalCliAuth(depsWith(['.claude'], [], false));
    const claude = r.find((d) => d.cli === 'claude-cli');
    expect(claude).toMatchObject({ installed: true, loggedIn: false });
  });

  it('codex 未安装时不探测凭证文件(同名文件顶替不误报)', async () => {
    const r = await scanLocalCliAuth(depsWith([], [join('.codex', 'auth.json')], false));
    const codex = r.find((d) => d.cli === 'codex-cli');
    expect(codex).toMatchObject({ installed: false, loggedIn: false });
  });

  it('codex 已安装已登录', async () => {
    const r = await scanLocalCliAuth(depsWith(['.codex'], [join('.codex', 'auth.json')], false));
    const codex = r.find((d) => d.cli === 'codex-cli');
    expect(codex).toMatchObject({ installed: true, loggedIn: true });
  });

  it('文件探测抛错向上传播(生产 deps 在 stat 层吞错,handler 再降级空数组)', async () => {
    const deps: LocalCliScanDeps = {
      homeDir: HOME,
      isDirectory: async () => true,
      isFile: async () => {
        throw new Error('EACCES');
      },
      hasClaudeLogin: () => false,
      isCredentialSharedWithCindy: () => true,
    };
    await expect(scanLocalCliAuth(deps)).rejects.toThrow('EACCES');
  });

  it('未登录时不探测共用性,sharedWithCindy 恒 false', async () => {
    let asked = 0;
    const r = await scanLocalCliAuth(
      depsWith([], [], false, () => {
        asked += 1;
        return true;
      }),
    );
    expect(r.every((d) => d.sharedWithCindy === false)).toBe(true);
    expect(asked).toBe(0);
  });

  it('已登录但 Cindy 用的是另一份凭证 → sharedWithCindy=false', async () => {
    // 回归 PR #1076 review:本机 codex 登录着账号 A、Cindy 的 codex-home 显式登录账号 B 时,
    // installed/loggedIn 都为 true,但 reconcile 刻意让两份凭证各管各 —— 不能据此说「已继承」。
    const r = await scanLocalCliAuth(
      depsWith(['.codex'], [join('.codex', 'auth.json')], false, (cli) => cli !== 'codex-cli'),
    );
    const codex = r.find((d) => d.cli === 'codex-cli');
    expect(codex).toMatchObject({ installed: true, loggedIn: true, sharedWithCindy: false });
  });

  it('deps 判定为「自己在 Cindy 里授权过」时不算继承', async () => {
    // 回归 PR #1076 review 第三轮：用户在 Cindy 里亲自完成 Claude.ai 授权后，token 写进
    // 与本机 CLI 相同的凭证库。共用存储只证明账号相同，证不出凭证先于 Cindy 存在 ——
    // 此时说「已沿用本机登录、无需额外授权」，而那次授权正是他刚做的。
    // 生产判据在 createLocalCliScanDeps（isNativeProviderAuthSelfAuthorized）；这里断言
    // 纯函数如实透传 deps 的结论。
    const r = await scanLocalCliAuth(depsWith(['.claude'], [], true, () => false));
    expect(r.find((d) => d.cli === 'claude-cli')).toMatchObject({
      loggedIn: true,
      sharedWithCindy: false,
    });
  });

  it('已登录且确为同一份凭证 → sharedWithCindy=true', async () => {
    const r = await scanLocalCliAuth(
      depsWith(['.codex'], [join('.codex', 'auth.json')], true, () => true),
    );
    expect(r.find((d) => d.cli === 'codex-cli')).toMatchObject({ sharedWithCindy: true });
    expect(r.find((d) => d.cli === 'claude-cli')).toMatchObject({ sharedWithCindy: true });
  });
});
