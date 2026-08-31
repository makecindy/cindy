/**
 * github-issue/index.ts —— module holder + 真实依赖接线。
 *
 * register.ts 启动时注入确认桥与本轮模型解析器;mcp-providers.ts 通过
 * submitGithubIssueForSession 给 cindy_helper 注入 githubIssue 回调
 * (deferred-lookup:holder 未就绪时返回 HOST_NOT_READY,模式同 OrcaCollabService)。
 */

import os from 'node:os';

import { app } from 'electron';

import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import { activeOwnerScopeKey } from '../appSessionState.js';
import { getCurrentMembershipDisplayName } from '../authManager';
import { createLogger } from '../logger.js';
import { serverApiFetch } from '../serverApiClient';
import { getClientEndpoint } from '../clientEndpointsService';
import type { IssueConfirmBridge } from './issueConfirmBridge';
import { getAppCapabilities } from '../appCapabilities.js';
import { buildGithubUserSubmitterDeps } from './cindyGithubGhostDeps.js';
import {
  submitGithubIssueWithConfirm,
  type GithubIssueSubmitResult,
  type SubmitIssueRequest,
} from './githubIssueSubmitService';
import { invalidateMyIssuesCache } from './myIssuesRuntime.js';
import { recordSubmittedIssue } from './submittedIssueLedger.js';
import {
  postGithubIssueAsUser,
  resolveGithubIssueSubmissionChoices,
  type GithubUserIssueSubmitterDeps,
} from './githubUserIssueSubmitter';

export { IssueConfirmBridge } from './issueConfirmBridge';
export type { IssueConfirmDecision, IssueConfirmInteractionSnapshot } from './issueConfirmBridge';

const log = createLogger('github-issue');

let bridgeHolder: IssueConfirmBridge | null = null;
let getTurnModelIdHolder: ((sessionId: string) => Promise<string | undefined>) | null = null;

export function initGithubIssueSubmit(
  bridge: IssueConfirmBridge,
  getTurnModelId: (sessionId: string) => Promise<string | undefined>,
): void {
  bridgeHolder = bridge;
  getTurnModelIdHolder = getTurnModelId;
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
  const getTurnModelId = getTurnModelIdHolder;
  if (!bridge || !getTurnModelId) {
    return {
      ok: false,
      errorCode: 'HOST_NOT_READY',
      message: 'Cindy 主进程 issue 提交服务尚未就绪,请告知用户稍等几秒后重试。',
    };
  }
  const githubUserSubmitterDeps: GithubUserIssueSubmitterDeps = buildGithubUserSubmitterDeps();
  // 在**发起时**锁定账号作用域:提交要等用户确认 + 一次网络往返,期间完全可能切号。
  // 记账时拿它核对,绝不把这条提交写进另一个账号的账本(见 recordSubmittedIssue)。
  const submitScope = activeOwnerScopeKey();
  return submitGithubIssueWithConfirm(
    {
      confirm: (sessionId, draft, env, submissionChoices, suggestedPublicName) =>
        bridge.request(sessionId, draft, env, submissionChoices, suggestedPublicName),
      resolveSubmissionChoices: (workdir) =>
        resolveGithubIssueSubmissionChoices(githubUserSubmitterDeps, workdir),
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
      getTurnModelId,
      getRegion: () => CURRENT_CINDY_REGION,
      getFallbackLocale: () => app.getLocale(),
      getSubmitterName: getCurrentMembershipDisplayName,
      onSubmitted: (record) => {
        try {
          recordSubmittedIssue(record, submitScope);
        } catch (err) {
          // 账本只服务「我的 Issue」列表;写失败最多让这条不出现在列表里,
          // 绝不能影响已经成功的提交。
          log.warn('submitted issue ledger write failed', {
            issueNumber: record.number,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          // **无论记账成功与否都要失效**:这两件事互相独立 —— 平台通道就绪时,列表
          // 本来就能从服务端看到刚提交的那条,不该因为本机账本写失败而在 60s TTL 内
          // 一直看不见。(放在同一个 try 里时,记账抛错会把它一起跳过。)
          invalidateMyIssuesCache();
        }
      },
    },
    req,
  );
}
