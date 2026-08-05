/**
 * github-issue/index.ts —— module holder + 真实依赖接线。
 *
 * register.ts 启动时调 initGithubIssueSubmit(bridge);mcp-providers.ts 通过
 * submitGithubIssueForSession 给 cindy_helper 注入 githubIssue 回调
 * (deferred-lookup:holder 未就绪时返回 HOST_NOT_READY,模式同 OrcaCollabService)。
 */

import os from 'node:os';

import { app } from 'electron';

import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import { getCurrentMembershipDisplayName } from '../authManager';
import { getGhostManager, getGhostPipeDispatcher } from '../cindy-brain';
import { isGhostDisabledForWorkdir } from '../cindy-brain/ghostWorkdirPrefs.js';
import { ghostSecretSaved } from '../secrets/providerSecretStore';
import { serverApiFetch } from '../serverApiClient';
import { getClientEndpoint } from '../clientEndpointsService';
import type { IssueConfirmBridge } from './issueConfirmBridge';
import { getAppCapabilities } from '../appCapabilities.js';
import {
  submitGithubIssueWithConfirm,
  type GithubIssueSubmitResult,
  type SubmitIssueRequest,
} from './githubIssueSubmitService';
import {
  CINDY_GITHUB_GHOST_ID,
  CINDY_GITHUB_SECRET_KEY,
  postGithubIssueAsUser,
  resolveGithubIssueSubmissionIdentity,
  type GithubUserIssueSubmitterDeps,
} from './githubUserIssueSubmitter';

export { IssueConfirmBridge } from './issueConfirmBridge';
export type { IssueConfirmDecision } from './issueConfirmBridge';

let bridgeHolder: IssueConfirmBridge | null = null;

export function initGithubIssueSubmit(bridge: IssueConfirmBridge): void {
  bridgeHolder = bridge;
}

export async function submitGithubIssueForSession(
  req: SubmitIssueRequest,
): Promise<GithubIssueSubmitResult> {
  if (!getAppCapabilities().canUseCindyAccountServices) {
    return {
      ok: false,
      errorCode: 'AUTH_NOT_READY',
      message: '提交官方反馈需要登录 Cindy 账号。',
    };
  }
  const bridge = bridgeHolder;
  if (!bridge) {
    return {
      ok: false,
      errorCode: 'HOST_NOT_READY',
      message: 'Cindy 主进程 issue 提交服务尚未就绪,请告知用户稍等几秒后重试。',
    };
  }
  const githubUserSubmitterDeps: GithubUserIssueSubmitterDeps = {
    isGithubGhostEnabled: () =>
      getGhostManager()
        .list()
        .some((ghost) => ghost.manifest.id === CINDY_GITHUB_GHOST_ID && ghost.enabled),
    isGithubCredentialSaved: () => ghostSecretSaved(CINDY_GITHUB_GHOST_ID, CINDY_GITHUB_SECRET_KEY),
    isGithubGhostDisabledForWorkdir: (workdir) =>
      isGhostDisabledForWorkdir(CINDY_GITHUB_GHOST_ID, workdir),
    callGhostTool: (request) => getGhostPipeDispatcher().callGhostTool(request),
  };
  return submitGithubIssueWithConfirm(
    {
      confirm: (sessionId, draft, env, submissionIdentity, suggestedPublicName) =>
        bridge.request(sessionId, draft, env, submissionIdentity, suggestedPublicName),
      resolveSubmissionIdentity: (workdir) =>
        resolveGithubIssueSubmissionIdentity(githubUserSubmitterDeps, workdir),
      postIssue: (submissionIdentity, bodyFactory) => {
        if (submissionIdentity.kind === 'github-user') {
          return postGithubIssueAsUser(githubUserSubmitterDeps, submissionIdentity, bodyFactory());
        }
        return serverApiFetch<{ githubIssue: { number: number; url: string } }>(
          '/api/github/issues',
          {
            method: 'POST',
            bodyFactory,
            // 独立部署的 github-server(服务端仓);登录 JWT 验签与
            // auth-server 同侧。bodyFactory 随 401 refresh 重建,确保账号切换后
            // userName、区域端点与最终 Bearer membership 一致。
            baseUrl: () => getClientEndpoint('githubApiBaseUrl'),
          },
        );
      },
      getAppVersion: () => app.getVersion(),
      getOsInfo: () => ({
        platform: process.platform,
        arch: process.arch,
        osVersion: os.release(),
      }),
      getRegion: () => CURRENT_CINDY_REGION,
      getFallbackLocale: () => app.getLocale(),
      getSubmitterName: getCurrentMembershipDisplayName,
    },
    req,
  );
}
