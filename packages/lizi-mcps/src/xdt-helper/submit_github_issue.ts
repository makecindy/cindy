/**
 * submit_github_issue —— 把 agent 整理好的用户反馈提交为 Cindy 官方仓库的 GitHub issue。
 *
 * 流程上的确定性约束全部由 host 侧代码保证(规则 9):
 *  - 工具被调用后 host 会在 App 内弹出系统确认卡片,用户可编辑/确认/取消,
 *    确认是通往提交的唯一路径(handler 在 main 进程挂起等待)。
 *  - agent 初稿进入确认卡前会做高置信度隐私脱敏;确认卡仍展示最终公开内容,
 *    用户编辑后的内容视为用户明确确认。
 *  - host 在确认前确定并展示真实提交身份；确认后失败也不会静默切换身份。
 *  - 环境信息(客户端版本 / 版本区域 / OS / 界面语言)由 host 自动附加,agent 无法也
 *    无需填写。版本区域(CN / Dev;默认 global 不标注)是构建期身份,agent 更猜不到。
 *  - 成功返回 issue 链接及开源协作提示,让 agent 可以继续帮助用户从源码参与修复。
 * 本文件只承载工具 schema + 描述(对 LLM 的流程指引)和 host 回调的 payload 整形。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { errorPayload, okPayload } from './_payload.js';

/** host 确认 + 提交成功后的返回。 */
export interface SubmitGithubIssueHostOk {
  ok: true;
  issueNumber: number;
  issueUrl: string;
  /** 用户在确认卡片里最终确认的标题(可能与 agent 传入的不同)。 */
  finalTitle: string;
  /** 用户在确认卡片里改过 title/body/type 时为 true。 */
  editedByUser: boolean;
  /** agent 初稿进入确认卡前是否命中过常见敏感信息并被自动替换。 */
  privacyRedacted?: boolean;
}

export type SubmitGithubIssueHostErrorCode =
  | 'USER_CANCELLED'
  | 'CONFIRM_TIMEOUT'
  | 'HOST_NOT_READY'
  | 'AUTH_NOT_READY'
  | 'NETWORK_ERROR'
  | 'SERVER_ERROR';

export interface SubmitGithubIssueHostErr {
  ok: false;
  errorCode: SubmitGithubIssueHostErrorCode;
  message: string;
}

export type SubmitGithubIssueHostResult =
  | SubmitGithubIssueHostOk
  | SubmitGithubIssueHostErr;

export interface SubmitGithubIssueDeps {
  getSessionContext: () => {
    sessionId?: string;
    agentKind: 'claude-code' | 'codex' | 'pi';
    workingDir: string;
  };
  /** host 回调:弹确认卡片 → 用户确认后提交到 server。 */
  submit: (req: {
    sessionId: string;
    workingDir: string;
    title: string;
    body: string;
    type: 'bug' | 'feature';
  }) => Promise<SubmitGithubIssueHostResult>;
}

const DESCRIPTION = [
  `把整理好的用户反馈提交为 ${BRAND_NAME} 官方仓库的 GitHub issue。`,
  '【流程硬约束】',
  '1) 调用前必须先与用户对话澄清,只针对缺失或含糊的信息提问,不要重复已回答的问题,也不要急着调用。bug 至少确认:现象、复现步骤、期望行为、实际行为、复现频率、已尝试的解决办法;feature 至少确认:使用场景、当前痛点或替代方案、期望结果和建议范围。用户不知道的内容标记为未知,不要猜。',
  '2) Bug 可以主动收集用户提供的错误摘要、经过脱敏的日志片段和必要截图说明,但先解释会公开到 GitHub,取得用户同意后再纳入正文。优先摘要而不是整段原始日志;不要提交令牌、密码、邮箱、个人路径、内部域名、私有代码或与问题无关的文件内容。系统会在确认卡前自动隐藏常见密钥、个人路径和邮箱,但仍要让用户检查最终正文。',
  '3) 本工具被调用后会在 App 内弹出系统确认卡片,用户可以编辑标题/正文并确认或取消;最终提交内容以用户确认的版本为准(返回的 final_title 可能与你传入的不同)。确认前不得创建 issue。',
  '4) Cindy 官方 Bot 是默认且始终可用的提交身份,不要求用户安装插件或配置 GitHub。仅当系统实时验证到可用的 Cindy GitHub 账号时,确认卡才额外提供“用本人账号提交”的选项(受其 token 仓库权限约束)。用户确认身份后,提交失败不会静默切换身份。',
  '5) errorCode 语义: USER_CANCELLED = 用户主动取消了本次提交,如实告知即可,不要换参数自动重试; CONFIRM_TIMEOUT = 确认卡片超时无人响应(用户可能不在电脑前),告知用户可以再说一声重新发起; AUTH_NOT_READY / NETWORK_ERROR / SERVER_ERROR / HOST_NOT_READY = 提交失败,如实转告原因,不存在任何绕过确认、权限或失败的提交途径。',
  '6) 环境信息(客户端版本 / 版本区域 / OS / 界面语言)由系统自动附加;GitHub 作者就是确认卡片显示的身份——都无需也无法由你填写。版本区域是用户装的哪个区域构建(CN / Dev,默认的 global 构建不标注),构建期烘焙,你猜不到也不要写。',
  `7) 提交成功后告诉用户 issue 编号和链接,说明 ${BRAND_NAME} 是开源软件,并询问用户是否愿意继续参与:可以协助其通过源码复现、修复 Bug、开发功能、补测试并准备 PR。`,
].join('\n');

const D_TITLE =
  '完整、自包含的 issue 标题,一句话说清问题或诉求(如「自动化任务列表的显示筛选切换后未被记住」)。' +
  '禁止截断正文凑标题,禁止「用户反馈」「一个 bug」这类空泛词。';

const D_BODY =
  'Markdown 正文。bug 优先用「## 现象 / ## 复现步骤 / ## 期望行为 / ## 实际行为 / ## 复现频率 / ## 已尝试」结构;' +
  'feature 优先用「## 使用场景 / ## 当前痛点 / ## 诉求 / ## 建议方案」结构,信息来自与用户的对话。' +
  '诊断信息只放用户同意公开的、经过脱敏的摘要;缺失信息写“用户未知”或省略,不要编造。' +
  '不要写环境信息(客户端版本 / 版本区域 / OS / 界面语言)和提交人——系统会自动附加。';

const D_TYPE = 'bug=缺陷, feature=功能建议。决定 GitHub label。';

const OPEN_SOURCE_FOLLOW_UP = {
  repository_url: 'https://github.com/makecindy/cindy',
  license: 'Apache-2.0',
  invitation:
    'Cindy is open source. If the user is interested, offer help with reproducing the issue, editing the source, adding tests, and preparing a pull request.',
} as const;

export function registerSubmitGithubIssueTool(
  registry: XdtHelperToolRegistry,
  deps: SubmitGithubIssueDeps,
): void {
  registry.register({
    name: 'submit_github_issue',
    category: 'feedback',
    description: DESCRIPTION,
    inputShape: {
      title: z.string().min(8).max(120).describe(D_TITLE),
      body: z.string().min(20).max(4000).describe(D_BODY),
      type: z.enum(['bug', 'feature']).describe(D_TYPE),
    },
    handler: async ({ title, body, type }) => {
      const ctx = deps.getSessionContext();
      if (!ctx.sessionId) {
        return errorPayload(
          'NO_SESSION_CONTEXT',
          `当前 MCP 调用没有绑定 ${BRAND_NAME} session,无法弹出确认卡片。请告知用户在具体会话里发起 issue 提交。`,
        );
      }

      const result = await deps.submit({
        sessionId: ctx.sessionId,
        workingDir: ctx.workingDir,
        title: title.trim(),
        body: body.trim(),
        type,
      });

      if (!result.ok) {
        return errorPayload(result.errorCode, result.message);
      }

      return okPayload({
        issue_number: result.issueNumber,
        issue_url: result.issueUrl,
        final_title: result.finalTitle,
        edited_by_user: result.editedByUser,
        privacy_redacted: result.privacyRedacted === true,
        open_source: OPEN_SOURCE_FOLLOW_UP,
      });
    },
  });
}
