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
import { ghostSecretSaved } from '../secrets/providerSecretStore';
import {
  CINDY_GITHUB_GHOST_ID,
  CINDY_GITHUB_SECRET_KEY,
  type GithubUserIssueSubmitterDeps,
} from './githubUserIssueSubmitter';

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
  };
}
