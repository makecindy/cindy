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
import { createLogger } from '../logger.js';
import { ghostSecretSaved } from '../secrets/providerSecretStore';
import {
  CINDY_GITHUB_GHOST_ID,
  CINDY_GITHUB_SECRET_KEY,
  type GithubUserIssueSubmitterDeps,
} from './githubUserIssueSubmitter';

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

export function buildGithubUserSubmitterDeps(): GithubUserIssueSubmitterDeps {
  return {
    isGithubGhostEnabled: () =>
      getGhostManager()
        .list()
        .some((ghost) => ghost.manifest.id === CINDY_GITHUB_GHOST_ID && ghost.enabled),
    isGithubCredentialSaved: () => ghostSecretSaved(CINDY_GITHUB_GHOST_ID, CINDY_GITHUB_SECRET_KEY),
    isGithubGhostDisabledForWorkdir: (workdir) =>
      isGhostDisabledForWorkdir(CINDY_GITHUB_GHOST_ID, workdir),
    callGhostTool: (request) => getGhostPipeDispatcher().callGhostTool(request),
    logger: log,
  };
}
