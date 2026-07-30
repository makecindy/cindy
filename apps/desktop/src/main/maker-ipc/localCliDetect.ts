/**
 * localCliDetect(main)—— 本机 agent CLI 安装 / 登录态扫描的实现。
 *
 * 纯函数 + 注入 fs 依赖(规则 14:handler body 可脱 Electron 单测)。
 * 只做存在性 stat(目录用 isDirectory、文件用 isFile,防同名文件顶替误报——
 * 见 memory: 存在性探测用 stat 而非 access),**绝不读取凭证内容**(规则 23)。
 * 任一条目探测失败按「未安装」处理(fail-quiet:检测建议是增强,不是功能依赖)。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';

import { hasClaudeAiOAuth } from '../maker-host/claude-credentials-store.js';
import { isCodexAuthInheritedFromSystemCli } from '../maker-host/auth-adapters.js';
import { isNativeProviderAuthSelfAuthorized } from '../maker-host/nativeProviderAuthBinding.js';
import {
  LOCAL_CLI_DETECT_MAP,
  type LocalCliDetection,
  type LocalCliId,
} from '../../shared/localCliDetect.js';

export interface LocalCliScanDeps {
  homeDir: string;
  /** 路径存在且是目录。 */
  isDirectory(path: string): Promise<boolean>;
  /** 路径存在且是普通文件。 */
  isFile(path: string): Promise<boolean>;
  /**
   * Claude Code 是否已登录 claude.ai(跨平台:macOS Keychain / 其它平台文件)。
   * 生产 = hasClaudeAiOAuth();只返 boolean,不暴露凭证内容(规则 23)。
   */
  hasClaudeLogin(): boolean;
  /**
   * Cindy 用的凭证是否确实就是这份本机凭证(填 `LocalCliDetection.sharedWithCindy`)。
   * 只在该 CLI 已登录时被调用;判据按 CLI 分派,见 createLocalCliScanDeps。
   */
  isCredentialSharedWithCindy(cli: LocalCliId): boolean;
}

/** 生产 deps:真实 home + fs.stat(异常一律 false)+ Claude 跨平台登录探测。 */
export function createLocalCliScanDeps(): LocalCliScanDeps {
  return {
    homeDir: homedir(),
    isDirectory: async (path) => {
      try {
        return (await stat(path)).isDirectory();
      } catch {
        return false;
      }
    },
    isFile: async (path) => {
      try {
        return (await stat(path)).isFile();
      } catch {
        return false;
      }
    },
    hasClaudeLogin: () => {
      try {
        return hasClaudeAiOAuth();
      } catch {
        return false;
      }
    },
    isCredentialSharedWithCindy: (cli) => {
      try {
        const providerId = cli === 'claude-cli' ? 'anthropic' : 'openai';
        // 用户在 Cindy 里**亲自授权过**这家 → 不是继承,无论凭证此刻是否与本机共用。
        // 少了这道判据，「在 Cindy 里点过 Claude 授权」的用户下次进新建页会被告知
        // 「已沿用本机登录、无需额外授权」，而那次授权正是他自己刚做的
        // （PR #1076 review 第三轮）。共用存储只证明账号相同，证不出凭证的来路。
        if (isNativeProviderAuthSelfAuthorized(providerId)) return false;
        // claude:Cindy 与本机 Claude Code **共用同一处凭证存储**(macOS Keychain 的
        // `Claude Code-credentials` / 其它平台 ~/.claude/.credentials.json,见
        // claude-credentials-store 顶注)。物理上就是同一份,不存在「各自登录不同账号」
        // 这种分歧,所以排除掉自己授权的那种情况后,已登录即是继承。
        if (cli === 'claude-cli') return true;
        // codex:Cindy 有自己的 codex-home,只有账号一致时 reconcile 才建硬链 ——
        // 必须实证 inode 同一性,不能由「两边都登录了」推出来。
        return isCodexAuthInheritedFromSystemCli();
      } catch {
        return false;
      }
    },
  };
}

/**
 * 按映射表扫描全部条目。登录态探测分派:
 *   - `claude-oauth`:走跨平台 hasClaudeLogin()(覆盖 macOS Keychain 登录、且可能无
 *     ~/.claude 目录的用户);已登录必然算已安装(installed = 目录存在 || 已登录)。
 *   - `file`:目录存在时再 stat 凭证文件(installed=false 时 loggedIn 恒 false)。
 */
export async function scanLocalCliAuth(deps: LocalCliScanDeps): Promise<LocalCliDetection[]> {
  const results: LocalCliDetection[] = [];
  for (const entry of LOCAL_CLI_DETECT_MAP) {
    const configDir = join(deps.homeDir, ...entry.configDirSegments);
    const dirExists = await deps.isDirectory(configDir);
    let installed = dirExists;
    let loggedIn = false;
    if (entry.credentialProbe === 'claude-oauth') {
      loggedIn = deps.hasClaudeLogin();
      // Keychain 登录的 Mac 用户可能连 ~/.claude 目录都没有——登录了就算已安装。
      installed = dirExists || loggedIn;
    } else if (dirExists && entry.credentialFileSegments) {
      loggedIn = await deps.isFile(join(deps.homeDir, ...entry.credentialFileSegments));
    }
    // 未登录时不必探测共用性(也无从谈起);已登录才问「Cindy 用的是不是这一份」。
    const sharedWithCindy = loggedIn ? deps.isCredentialSharedWithCindy(entry.cli) : false;
    results.push({
      cli: entry.cli,
      providerId: entry.providerId,
      installed,
      loggedIn,
      sharedWithCindy,
    });
  }
  return results;
}
