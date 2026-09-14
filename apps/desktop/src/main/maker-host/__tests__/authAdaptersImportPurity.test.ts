/**
 * authAdaptersImportPurity.test.ts —— auth-adapters「import 零副作用」回归守卫。
 * ---------------------------------------------------------------------------
 * 背景(2026-07-03 事故):auth-adapters 模块底部导出 import 即构造的单例,当时
 * DesktopCodexAuthAdapter 构造函数里 fire-and-forget 地建 codex-home 骨架并把
 * ~/.codex/auth.json 硬链过来。deviceLinkHostDispatch.test 把 userData mock 成
 * `process.env.TEMP ?? process.cwd()`(TEMP 是 Windows 独有变量),macOS 上回落
 * cwd = apps/desktop,于是**含真实 ChatGPT OAuth 凭证硬链的 codex-home 被整套
 * 生成进 git 仓库工作区**(untracked、未被 ignore,一次 `git add -A` 就会提交)。
 *
 * 修复后的约定(本测试固化):import auth-adapters 不允许产生任何文件系统写入 ——
 * 目录/软链/硬链/marker 一律不许出现;预热统一走显式 warmUp()(maker-host 装配时调)。
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const h = vi.hoisted(() => ({ userDataDir: '' }));

vi.mock('electron', () => ({
  app: {
    // 返回专属空目录:import 后目录必须依然是空的(存在写入即失败)。
    getPath: () => h.userDataDir,
    getAppPath: () => h.userDataDir,
    isPackaged: false,
  },
  safeStorage: { isEncryptionAvailable: () => false },
}));

// 同 providerOneShot.test:剪断 maker-core runtime 图,只保留 auth-adapters 需要的类型面。
vi.mock('@cindy/maker-core', () => ({}));

describe('auth-adapters import purity', () => {
  it('importing the module (and its singletons) must not write to the filesystem', async () => {
    h.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-auth-import-purity-'));
    const cwdCodexHome = path.join(process.cwd(), 'codex-home');
    // 本机 dev 残留可能预先存在(gitignored),不能删用户目录;快照现有条目,
    // import 后断言"没有新增条目",保住副作用检测能力。
    const preexistingEntries = fs.existsSync(cwdCodexHome)
      ? new Set(fs.readdirSync(cwdCodexHome))
      : null;
    try {
      await import('../auth-adapters.js');
      // 旧实现的副作用是构造函数里的 fire-and-forget Promise;多让几拍微任务/宏任务
      // 跑完,确保潜在的异步写盘有机会暴露。
      await new Promise((resolve) => setTimeout(resolve, 100));

      // userData 指向的目录必须原封不动(不许出现 codex-home / marker / 任何文件)。
      expect(fs.readdirSync(h.userDataDir)).toEqual([]);
      // cwd 相对路径也不许出现(事故形态:getPath 返回 '' 时 path.join('', 'codex-home')
      // 变相对路径,落到 vitest cwd = apps/desktop)。
      if (preexistingEntries === null) {
        expect(fs.existsSync(cwdCodexHome)).toBe(false);
      } else {
        const added = fs.readdirSync(cwdCodexHome).filter((e) => !preexistingEntries.has(e));
        expect(added).toEqual([]);
      }
    } finally {
      fs.rmSync(h.userDataDir, { recursive: true, force: true });
    }
  });
});
