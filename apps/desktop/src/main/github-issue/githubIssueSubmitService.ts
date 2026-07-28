/**
 * githubIssueSubmitService —— submit_github_issue 工具的 main 侧业务体。
 *
 * 流程(规则 9 的代码强制点全部在此):
 *  1. 组环境信息并解析本次真实提交身份—— agent 不参与;
 *  2. await confirm(确认卡片,含真实身份)—— **唯一**通往 postIssue 的路径;
 *  3. confirmed 后以用户确认的 title/body/type 为准(用户编辑版优先);
 *  4. body 末尾附 env 块,clamp 后严格按已确认身份 POST,失败不切换身份。
 *
 * 模块保持 electron-free,全部依赖注入(规则 14),单测直接调 submitGithubIssueWithConfirm。
 */

import type { CindyRegion } from '@cindy/maker-shared/brand-identity';

import { ISSUE_REGION_CODE } from '../../shared/issueRegionCode.js';
import type {
  IssueConfirmDecision,
  IssueDraft,
  IssueEnvInfo,
  IssueSubmissionIdentity,
} from './issueConfirmBridge';

/** 与 @cindy/mcps SubmitGithubIssueDeps['submit'] 的返回契约结构一致(注入点做结构化类型检查)。 */
export type GithubIssueSubmitResult =
  | {
      ok: true;
      issueNumber: number;
      issueUrl: string;
      finalTitle: string;
      editedByUser: boolean;
    }
  | {
      ok: false;
      errorCode:
        | 'USER_CANCELLED'
        | 'CONFIRM_TIMEOUT'
        | 'HOST_NOT_READY'
        | 'AUTH_NOT_READY'
        | 'NETWORK_ERROR'
        | 'SERVER_ERROR';
      message: string;
    };

export interface SubmitIssueRequest {
  sessionId: string;
  workingDir: string;
  title: string;
  body: string;
  type: 'bug' | 'feature';
}

/** github-server 的 issue 创建 payload；userName 缺失时由服务端按 membership id 回退。 */
export interface GithubIssuePostBody {
  title: string;
  description?: string;
  type: 'bug' | 'feature';
  appVersion: string;
  userName?: string;
}

export interface GithubIssuePostResponse {
  githubIssue: { number: number; url: string };
}

export interface GithubIssueSubmitServiceDeps {
  confirm: (
    sessionId: string,
    draft: IssueDraft,
    env: IssueEnvInfo,
    submissionIdentity: IssueSubmissionIdentity,
  ) => Promise<IssueConfirmDecision>;
  /** 每次发起确认前现查；已绑定但凭证失效时应抛 AUTH_NOT_READY，不能冒充未绑定。 */
  resolveSubmissionIdentity: (workingDir: string) => Promise<IssueSubmissionIdentity>;
  /** body factory must be evaluated for each network attempt after auth refresh. */
  postIssue: (
    submissionIdentity: IssueSubmissionIdentity,
    bodyFactory: () => GithubIssuePostBody,
  ) => Promise<GithubIssuePostResponse>;
  getAppVersion: () => string;
  getOsInfo: () => { platform: string; arch: string; osVersion: string };
  /** 本构建的区域身份(构建期烘焙);同版本号的 cn / global 是两个不同的包。 */
  getRegion: () => CindyRegion;
  /** main 侧 OS locale,仅当 renderer 未回传 uiLanguage 时兜底。 */
  getFallbackLocale: () => string;
  /** 当前 Cindy membership 的展示名,仅用于 issue 正文标记提交人。 */
  getSubmitterName: () => string | undefined;
}

// server 侧 github.ts 的上限(TITLE_MAX=200 / DESC_MAX=5000),超限会被 400,这里主动 clamp。
const SERVER_TITLE_MAX = 200;
const SERVER_DESC_MAX = 5000;

export async function submitGithubIssueWithConfirm(
  deps: GithubIssueSubmitServiceDeps,
  req: SubmitIssueRequest,
): Promise<GithubIssueSubmitResult> {
  const env: IssueEnvInfo = {
    appVersion: deps.getAppVersion(),
    ...deps.getOsInfo(),
    region: deps.getRegion(),
  };

  let submissionIdentity: IssueSubmissionIdentity;
  try {
    submissionIdentity = await deps.resolveSubmissionIdentity(req.workingDir);
  } catch (err) {
    return mapSubmitError(err);
  }

  const decision = await deps.confirm(
    req.sessionId,
    { title: req.title, body: req.body, type: req.type },
    env,
    submissionIdentity,
  );

  if (!decision.confirmed) {
    if (decision.reason === 'timeout') {
      return {
        ok: false,
        errorCode: 'CONFIRM_TIMEOUT',
        message: '确认卡片超时未响应,本次未提交。告知用户可以再说一声重新发起。',
      };
    }
    return {
      ok: false,
      errorCode: 'USER_CANCELLED',
      message: '用户取消了本次 issue 提交。如实告知即可,不要换参数自动重试。',
    };
  }

  // 用户确认版优先 —— agent 传入值在这里被丢弃,代码层保证。
  const finalTitle = decision.title.slice(0, SERVER_TITLE_MAX);
  const editedByUser =
    decision.title !== req.title ||
    decision.body !== req.body ||
    decision.type !== req.type;

  const uiLanguage = decision.uiLanguage ?? deps.getFallbackLocale();
  const regionCode = ISSUE_REGION_CODE[env.region];
  const envBlock = [
    '',
    '---',
    // global 不写这一行 —— 缺失即默认区域,理由见 ISSUE_REGION_CODE(与确认卡片同源)。
    ...(regionCode ? [`**版本区域**: ${regionCode}`] : []),
    `**OS**: ${env.platform} ${env.arch} (${env.osVersion})`,
    `**界面语言**: ${uiLanguage}`,
  ].join('\n');
  // env 块必须完整保留,clamp 只裁用户正文部分。
  const bodyBudget = SERVER_DESC_MAX - envBlock.length;
  const description = decision.body.slice(0, Math.max(0, bodyBudget)) + envBlock;

  try {
    const result = await deps.postIssue(submissionIdentity, () => {
      const submitterName = deps.getSubmitterName()?.trim();
      return {
        title: finalTitle,
        description,
        type: decision.type,
        appVersion: env.appVersion,
        ...(submitterName ? { userName: submitterName } : {}),
      };
    });
    return {
      ok: true,
      issueNumber: result.githubIssue.number,
      issueUrl: result.githubIssue.url,
      finalTitle,
      editedByUser,
    };
  } catch (err) {
    return mapSubmitError(err);
  }
}

/**
 * 提交链路抛错映射。平台路径按 ServerApiError 的 statusCode 字段 duck-typing,
 * 用户路径按 issueErrorCode 映射,避免本模块 import 真实网络实现。
 */
function mapSubmitError(err: unknown): GithubIssueSubmitResult & { ok: false } {
  const issueErrorCode =
    err && typeof err === 'object' && 'issueErrorCode' in err
      ? (err as { issueErrorCode?: unknown }).issueErrorCode
      : undefined;
  if (
    issueErrorCode === 'AUTH_NOT_READY' ||
    issueErrorCode === 'NETWORK_ERROR' ||
    issueErrorCode === 'SERVER_ERROR'
  ) {
    return {
      ok: false,
      errorCode: issueErrorCode,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  const statusCode =
    err && typeof err === 'object' && 'statusCode' in err
      ? (err as { statusCode?: unknown }).statusCode
      : undefined;
  const message = err instanceof Error ? err.message : String(err);
  if (statusCode === 0) {
    return {
      ok: false,
      errorCode: 'NETWORK_ERROR',
      message: `网络不可用,issue 未提交: ${message}`,
    };
  }
  if (statusCode === 401) {
    return {
      ok: false,
      errorCode: 'AUTH_NOT_READY',
      message: `登录态失效,issue 未提交,请用户重新登录后再试: ${message}`,
    };
  }
  return {
    ok: false,
    errorCode: 'SERVER_ERROR',
    message: `服务端拒绝或异常,issue 未提交: ${message}`,
  };
}
