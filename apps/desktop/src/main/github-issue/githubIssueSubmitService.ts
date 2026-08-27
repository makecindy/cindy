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

import { CINDY_REGION_CODE } from '../../shared/regionCode.js';
import { normalizeIssuePublicName } from '../../shared/issuePublicName.js';
import {
  issueHarnessForAgentKind,
  normalizeIssueModelId,
  type IssueAgentKind,
} from '../../shared/issueRuntimeMetadata.js';
import type { SubmittedIssueRecord } from '../../shared/myIssues.js';
import { myIssueUrl } from '../../shared/myIssues.js';
import { redactSensitive } from '../learn-host/redaction';
import type {
  IssueConfirmDecision,
  IssueDraft,
  IssueEnvInfo,
  IssueSubmissionChoices,
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
      /** agent 初稿进入确认卡前是否命中过常见敏感信息并被自动替换。 */
      privacyRedacted: boolean;
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
  agentKind: IssueAgentKind;
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
    submissionChoices: IssueSubmissionChoices,
    suggestedPublicName?: string,
  ) => Promise<IssueConfirmDecision>;
  /** 平台身份必有；仅当实时验证到可用账号时附加 GitHub 用户身份。 */
  resolveSubmissionChoices: (workingDir: string) => Promise<IssueSubmissionChoices>;
  /** body factory must be evaluated for each network attempt after auth refresh. */
  postIssue: (
    submissionIdentity: IssueSubmissionIdentity,
    bodyFactory: () => GithubIssuePostBody,
  ) => Promise<GithubIssuePostResponse>;
  getAppVersion: () => string;
  getOsInfo: () => { platform: string; arch: string; osVersion: string };
  /** 返回 /issue 所在轮开始时冻结的 Cindy 模型 ID；读取失败不得阻断反馈提交。 */
  getTurnModelId: (sessionId: string) => Promise<string | undefined>;
  /** 本构建的区域身份(构建期烘焙);同版本号的 cn / global 是两个不同的包。 */
  getRegion: () => CindyRegion;
  /** main 侧 OS locale,仅当 renderer 未回传 uiLanguage 时兜底。 */
  getFallbackLocale: () => string;
  /** 当前 Cindy membership 的展示名,仅用于 issue 正文标记提交人。 */
  getSubmitterName: () => string | undefined;
  /**
   * 提交成功后记账(「我的 Issue」列表靠它认出平台代发的那一半)。
   * 只在 postIssue 真正成功后调用一次,抛错由本模块吞掉 —— 记账失败绝不能把一次
   * 已经成功的提交翻成失败,那会诱导用户重复提交。
   */
  onSubmitted?: (record: SubmittedIssueRecord) => void;
}

// server 侧 github.ts 的上限(TITLE_MAX=200 / DESC_MAX=5000),超限会被 400,这里主动 clamp。
const SERVER_TITLE_MAX = 200;
const SERVER_DESC_MAX = 5000;

/** Keep provider-controlled model IDs inert when they are appended to public GitHub Markdown. */
function markdownCodeSpan(value: string): string {
  let fence = '`';
  for (const match of value.matchAll(/`+/g)) {
    if (match[0].length >= fence.length) {
      fence = '`'.repeat(match[0].length + 1);
    }
  }
  return `${fence} ${value} ${fence}`;
}

export async function submitGithubIssueWithConfirm(
  deps: GithubIssueSubmitServiceDeps,
  req: SubmitIssueRequest,
): Promise<GithubIssueSubmitResult> {
  let modelId = 'unknown';
  try {
    modelId = normalizeIssueModelId(await deps.getTurnModelId(req.sessionId)) ?? 'unknown';
  } catch {
    // Runtime metadata is supplemental. A failed local lookup must not block issue submission.
  }
  const env: IssueEnvInfo = {
    appVersion: deps.getAppVersion(),
    ...deps.getOsInfo(),
    harness: issueHarnessForAgentKind(req.agentKind),
    modelId,
    region: deps.getRegion(),
  };

  let submissionChoices: IssueSubmissionChoices;
  try {
    submissionChoices = await deps.resolveSubmissionChoices(req.workingDir);
  } catch (err) {
    return mapSubmitError(err);
  }

  const suggestedPublicName = normalizeIssuePublicName(deps.getSubmitterName()) ?? undefined;
  const preparedDraft = redactIssueDraft(req);
  const decision = await deps.confirm(
    req.sessionId,
    preparedDraft.draft,
    env,
    submissionChoices,
    suggestedPublicName,
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

  const submissionIdentity = decision.submissionIdentity ?? submissionChoices.platform;
  const confirmedPublicName =
    submissionIdentity.kind === 'platform' ? normalizeIssuePublicName(decision.publicName) : null;
  if (submissionIdentity.kind === 'platform' && !confirmedPublicName) {
    return {
      ok: false,
      errorCode: 'USER_CANCELLED',
      message: '公开署名未确认，本次 issue 未提交。请重新发起并确认署名。',
    };
  }

  // 用户确认版优先 —— agent 传入值在这里被丢弃,代码层保证。
  const finalTitle = decision.title.slice(0, SERVER_TITLE_MAX);
  const editedByUser =
    decision.title !== preparedDraft.draft.title ||
    decision.body !== preparedDraft.draft.body ||
    decision.type !== preparedDraft.draft.type;

  const uiLanguage = decision.uiLanguage ?? deps.getFallbackLocale();
  const regionCode = CINDY_REGION_CODE[env.region];
  const envBlock = [
    '',
    '---',
    // global 不写这一行 —— 缺失即默认区域,理由见 CINDY_REGION_CODE(与确认卡片同源)。
    ...(regionCode ? [`**版本区域**: ${regionCode}`] : []),
    `**OS**: ${env.platform} ${env.arch} (${env.osVersion})`,
    `**Harness**: ${env.harness}`,
    `**Model ID**: ${markdownCodeSpan(env.modelId)}`,
    `**界面语言**: ${uiLanguage}`,
  ].join('\n');
  // env 块必须完整保留,clamp 只裁用户正文部分。
  const bodyBudget = SERVER_DESC_MAX - envBlock.length;
  const description = decision.body.slice(0, Math.max(0, bodyBudget)) + envBlock;

  try {
    const result = await deps.postIssue(submissionIdentity, () => ({
      title: finalTitle,
      description,
      type: decision.type,
      appVersion: env.appVersion,
      ...(confirmedPublicName ? { userName: confirmedPublicName } : {}),
    }));
    recordSubmission(deps, submissionIdentity, {
      number: result.githubIssue.number,
      title: finalTitle,
      type: decision.type,
      publicName: confirmedPublicName,
    });
    return {
      ok: true,
      issueNumber: result.githubIssue.number,
      issueUrl: result.githubIssue.url,
      finalTitle,
      editedByUser,
      privacyRedacted: preparedDraft.privacyRedacted,
    };
  } catch (err) {
    return mapSubmitError(err);
  }
}

/**
 * Agent 可能把用户粘贴的日志、错误和路径直接带进初稿。先过高置信度脱敏，再交给
 * 用户确认；用户在确认卡里主动编辑的内容视为明确确认，不在这里静默改写。
 */
function redactIssueDraft(req: SubmitIssueRequest): {
  draft: Pick<SubmitIssueRequest, 'title' | 'body' | 'type'>;
  privacyRedacted: boolean;
} {
  const title = redactSensitive(req.title);
  const body = redactSensitive(req.body);
  return {
    draft: {
      title: title.text.trim(),
      body: body.text.trim(),
      type: req.type,
    },
    privacyRedacted: title.hitCount > 0 || body.hitCount > 0,
  };
}

/** 记账是 best-effort:任何异常只吞掉,不影响已经成功的提交结果。 */
function recordSubmission(
  deps: GithubIssueSubmitServiceDeps,
  submissionIdentity: IssueSubmissionIdentity,
  submitted: {
    number: number;
    title: string;
    type: 'bug' | 'feature';
    publicName: string | null;
  },
): void {
  if (!deps.onSubmitted) return;
  try {
    deps.onSubmitted({
      number: submitted.number,
      // 派生而不是存 postIssue 返回的原值:账本**读取**侧用 isMyIssueUrl 强校验
      // (必须指向本仓这一号 issue)。写入侧存原值就会两侧口径不一 —— 返回的是 API
      // 链接或别的 host 时,这条记录写得进去、读出来却被当坏数据过滤掉,平台读接口
      // 未就绪 / 离线时用户看不到自己刚提交的那条。url 在系统里只有这一个产出方式。
      url: myIssueUrl(submitted.number),
      title: submitted.title,
      type: submitted.type,
      submittedAt: new Date().toISOString(),
      identity: submissionIdentity.kind === 'github-user' ? 'github-user' : 'platform',
      ...(submissionIdentity.kind === 'github-user'
        ? { githubLogin: submissionIdentity.login }
        : {}),
      ...(submitted.publicName ? { publicName: submitted.publicName } : {}),
    });
  } catch {
    // 交给注入方记日志;这里连 rethrow 都不做。
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
