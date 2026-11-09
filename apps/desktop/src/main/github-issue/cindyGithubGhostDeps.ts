/**
 * Cindy GitHub 插件通道的真实依赖构造。
 *
 * 提交路径(githubUserIssueSubmitter)与「我的 Issue」查询路径(myIssuesRuntime)共用
 * 同一份判定与同一条管子,保证两边看到的 GitHub 身份口径一致 —— 插件未装、未启用、
 * 当前 workdir 被停用或未配凭证时,两边都必须同样认为「不可用」。
 *
 * 独立成文件而不是放在 index.ts 里:index.ts 需要在提交成功后调 myIssuesRuntime
 * 让列表缓存失效,而 myIssuesRuntime 又需要这份 deps,放一起会形成循环 import。
 */

import { getGhostManager, getGhostPipeDispatcher } from '../cindy-brain';
import { isGhostDisabledForWorkdir } from '../cindy-brain/ghostWorkdirPrefs.js';
import {
  installedGhostStoragePart,
  resolveInstalledGhost,
} from '../../shared/pluginIdentity.js';
import { createLogger } from '../logger.js';
import { ghostSecretSaved } from '../secrets/providerSecretStore';
import {
  CINDY_GITHUB_GHOST_ID,
  CINDY_GITHUB_SECRET_KEY,
  type GithubUserIssueSubmitterDeps,
} from './githubUserIssueSubmitter';
import type { InstalledGhost } from '../../shared/ghost.js';

let sharedDeps: GithubUserIssueSubmitterDeps | null = null;
const log = createLogger('github-issue/github-user');

/**
 * 共享实例 —— 同一次「我的 Issue」查询里,身份解析与随后的搜索用同一个对象,
 * 不必各建一份(模式同 git-context 的 getSharedGhCliTokenSource)。
 *
 * 单例安全的原因:下面每个成员都是**惰性闭包**,不捕获任何状态,都是被调用的那一刻
 * 才去查插件启用状态 / 凭证 / 管子。也正因如此,复用同一实例**并不构成**「一致快照」——
 * 真正的不一致来自两次**调用**之间插件被停用或换了凭证,而那种情况的正确行为已经
 * 定好:搜索失败 → 静默降级为「这次没有增强」(见 myIssuesService 的可选增强口径)。
 */
export function getSharedGithubUserSubmitterDeps(): GithubUserIssueSubmitterDeps {
  if (!sharedDeps) sharedDeps = buildGithubUserSubmitterDeps();
  return sharedDeps;
}

/** 一次解析出的目标实例；enabled / 凭证 / workdir / 派发全部由它派生。 */
export interface CindyGithubInstance {
  instanceKey: string;
  enabled: boolean;
}

/**
 * 锁定唯一的 cindy-github 实例并返回它的 instanceKey。
 *
 * 设置页按 installedGhostStoragePart(ghost) 作 storeId 写凭证、workdir 偏好也
 * 存这个键；新版 root 命名空间安装得到 `_root__cindy-github`，旧版扁平安装是裸
 * `cindy-github`。只认裸 ghostId 会让新安装的用户明明填了 PAT，确认卡仍只剩
 * 官方 Bot(#9546)。
 *
 * 同名多实例时返回 null(fail-closed)：否则启用状态、凭证和调用目标可能拼自
 * 不同实例，或把请求派给已被目录禁用的那个。纯函数，不读凭证库、不碰 Electron。
 */
export function resolveCindyGithubInstance(
  ghosts: readonly InstalledGhost[],
): CindyGithubInstance | null {
  try {
    // 按 ghostId 锁定唯一实例：同名多实例（root + 企业 / 新旧布局并存）
    // 一律 fail-closed，避免四处判定各取一个实例拼出不一致的目标。
    const resolved = resolveInstalledGhost(ghosts, CINDY_GITHUB_GHOST_ID);
    if (resolved.status !== 'unique') return null;
    return {
      instanceKey: installedGhostStoragePart(resolved.ghost),
      enabled: resolved.ghost.enabled,
    };
  } catch {
    // 安装目录 / namespace 形态异常时无法可靠锁定实例，宁可隐藏可选身份。
    return null;
  }
}

export function buildGithubUserSubmitterDeps(): GithubUserIssueSubmitterDeps {
  // 四处判定共用同一次实例解析；每个成员仍是惰性闭包，不缓存状态。
  const instance = () => resolveCindyGithubInstance(getGhostManager().list());
  return {
    resolveInstanceId: () => instance()?.instanceKey ?? null,
    isGithubGhostEnabled: () => instance()?.enabled === true,
    isGithubCredentialSaved: () => {
      const resolved = instance();
      return resolved !== null && ghostSecretSaved(resolved.instanceKey, CINDY_GITHUB_SECRET_KEY);
    },
    isGithubGhostDisabledForWorkdir: (workdir) => {
      const resolved = instance();
      if (resolved === null) return false;
      // 新版偏好写 instanceKey；旧版偏好可能仍存裸 ghostId，两者都认，
      // 但都指向同一个已锁定的实例，不会拼到别的实例上。
      return (
        isGhostDisabledForWorkdir(resolved.instanceKey, workdir) ||
        (resolved.instanceKey !== CINDY_GITHUB_GHOST_ID &&
          isGhostDisabledForWorkdir(CINDY_GITHUB_GHOST_ID, workdir))
      );
    },
    callGhostTool: (request) => getGhostPipeDispatcher().callGhostTool(request),
    logger: log,
  };
}
