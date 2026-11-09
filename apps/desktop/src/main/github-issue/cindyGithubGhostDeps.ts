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
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';
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

/**
 * 凭证键必须与插件设置页写入时用的 instanceKey 一致。
 * 设置页以 installedGhostStoragePart(ghost) 作 storeId；新版 root 命名空间
 * 安装(_ns/_root/cindy-github)得到 `_root__cindy-github`，旧版扁平安装则是裸
 * `cindy-github`。只认裸 ghostId 会让新安装的用户明明填了 PAT，/issue 确认卡
 * 仍只剩官方 Bot(见 #9546)。两种键都保留，覆盖新旧安装与企业命名空间实例。
 *
 * 导出供回归测试：这里只做键推导，不读凭证库、不碰 Electron。
 */
export function githubCredentialInstanceKeys(ghosts: readonly InstalledGhost[]): string[] {
  const keys = new Set<string>([CINDY_GITHUB_GHOST_ID]);
  for (const ghost of ghosts) {
    if (ghost.manifest.id !== CINDY_GITHUB_GHOST_ID) continue;
    try {
      keys.add(installedGhostStoragePart(ghost));
    } catch {
      // 安装目录形态异常时保留裸 ghostId 兜底，不让反馈入口挂掉。
    }
  }
  return [...keys];
}

export function buildGithubUserSubmitterDeps(): GithubUserIssueSubmitterDeps {
  return {
    isGithubGhostEnabled: () =>
      getGhostManager()
        .list()
        .some((ghost) => ghost.manifest.id === CINDY_GITHUB_GHOST_ID && ghost.enabled),
    isGithubCredentialSaved: () =>
      githubCredentialInstanceKeys(getGhostManager().list()).some((instanceKey) =>
        ghostSecretSaved(instanceKey, CINDY_GITHUB_SECRET_KEY),
      ),
    isGithubGhostDisabledForWorkdir: (workdir) =>
      isGhostDisabledForWorkdir(CINDY_GITHUB_GHOST_ID, workdir),
    callGhostTool: (request) => getGhostPipeDispatcher().callGhostTool(request),
    logger: log,
  };
}
