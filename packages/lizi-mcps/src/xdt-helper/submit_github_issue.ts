/**
 * submit_github_issue —— 把 agent 整理好的用户反馈提交为 Cindy 官方仓库的 GitHub issue。
 *
 * 流程上的确定性约束全部由 host 侧代码保证(规则 9):
 *  - 工具被调用后 host 会在 App 内弹出系统确认卡片,用户可编辑/确认/取消,
 *    确认是通往提交的唯一路径(handler 在 main 进程挂起等待)。
 *  - agent 初稿进入确认卡前会做高置信度隐私脱敏;确认卡仍展示最终公开内容,
 *    用户编辑后的内容视为用户明确确认。
 *  - host 在确认前确定并展示真实提交身份；确认后失败也不会静默切换身份。
 *  - 环境信息由 host 自动附加为「提交时的任务环境」,agent 无法也无需填写快照字段。
 *    自动附加的 Harness / Model ID 是当前任务快照,不一定是故障环境;OS 来自提交客户端本机。agent 按反馈本身判断是否在正文补充用户说明的实际故障环境,不要默认把自动附加的当成出问题的那个,也不要复制快照。
 *    版本区域(CN / Dev;默认 global 不标注)是构建期身份,agent 更猜不到。
 *    本工具不上传图片;agent 不得声称截图已附在 GitHub issue。
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
    agentKind: 'claude-code' | 'codex' | 'pi';
    workingDir: string;
    title: string;
    body: string;
    type: 'bug' | 'feature';
  }) => Promise<SubmitGithubIssueHostResult>;
}

const DESCRIPTION = [
  `把整理好的用户反馈提交为 ${BRAND_NAME} 官方仓库的 GitHub issue。`,
  '【流程硬约束】',
  '1) 调用前先与用户对话,把这条反馈整理到足以让维护者看懂、能行动。缺什么问什么,已说过的不要重复,不够清楚不要急着调用。问什么、问多深、正文怎么组织,由你按反馈本身判断,不要套固定问卷或章节清单。普通建议不必按缺陷来问,和环境无关不必追问 Harness / 模型 / 推理强度。用户不知道的标未知,不要猜。系统自动附加的 Harness / Model ID 是当前任务的快照,不一定是出问题的那个。功能建议写用户能看见的场景和诉求;不要写仓库路径、实现方案、验收清单或内部架构推测,除非用户明确要求。',
  '2) Bug 和功能建议都遵循最小公开原则:默认概括、泛化用户提供的场景与示例,不要逐字复制用户消息、会话标题、真实姓名、账号、业务内容或其它可识别信息。只有复现问题确实需要且用户明确同意公开时,才保留最小必要片段。Bug 可以主动收集用户提供的错误摘要、经过脱敏的日志片段和必要截图说明,但先解释会公开到 GitHub,取得用户同意后再纳入正文。优先摘要而不是整段原始日志;不要提交令牌、密码、邮箱、个人路径、内部域名、私有代码或与问题无关的文件内容。本工具不能把对话里的图片传到 GitHub。禁止写「已提供截图」「截图见上」等让维护者以为 GitHub issue 里有图的话;用户给过图时,用文字描述图上可见内容。系统会在确认卡前自动隐藏部分常见敏感信息,但不能识别所有语义隐私,仍要让用户检查最终正文。',
  '3) 本工具被调用后会在 App 内弹出系统确认卡片,用户可以编辑标题/正文并确认或取消;最终提交内容以用户确认的版本为准(返回的 final_title 可能与你传入的不同)。确认前不得创建 issue。',
  '4) Cindy 官方 Bot 是默认且始终可用的提交身份,不要求用户安装插件或配置 GitHub。仅当系统实时验证到可用的 Cindy GitHub 账号时,确认卡才额外提供“用本人账号提交”的选项(受其 token 仓库权限约束)。用户确认身份后,提交失败不会静默切换身份。',
  '5) errorCode 语义: USER_CANCELLED = 用户主动取消了本次提交,如实告知即可,不要换参数自动重试; CONFIRM_TIMEOUT = 确认卡片超时无人响应(用户可能不在电脑前),告知用户可以再说一声重新发起; AUTH_NOT_READY / NETWORK_ERROR / SERVER_ERROR / HOST_NOT_READY = 提交失败,如实转告原因,不存在任何绕过确认、权限或失败的提交途径。',
  '6) 系统自动附加「提交时的任务环境」快照(客户端版本 / 版本区域 / 提交客户端 OS / 当前任务的 Harness / 模型 ID / 界面语言);GitHub 作者就是确认卡片显示的身份——这些快照字段无需也无法由你填写。系统自动附加的 Harness / Model ID 是当前任务的快照,不一定是出问题的那个;不要复制进正文。用户说明的实际故障 Harness / 模型 / 推理强度,只在真正有助于定位时写入正文。版本区域是用户装的哪个区域构建(CN / Dev,默认的 global 构建不标注),构建期烘焙,你猜不到也不要写。',
  `7) 提交成功后告诉用户 issue 编号和链接,说明 ${BRAND_NAME} 是开源软件,并询问用户是否愿意继续参与:可以协助其通过源码复现、修复 Bug、开发功能、补测试并准备 PR。`,
].join('\n');

const D_TITLE =
  '完整、自包含的 issue 标题,一句话说清问题或诉求(如「自动化任务列表的显示筛选切换后未被记住」)。' +
  '禁止截断正文凑标题,禁止「用户反馈」「一个 bug」这类空泛词。';

const D_BODY =
  'Markdown 正文,按这条反馈本身组织,不要为了凑章节而编造。' +
  '默认概括并泛化用户原话、真实场景和示例,不要逐字复制可识别的私人或业务内容。诊断信息只放用户同意公开的、经过脱敏的摘要;缺失信息写“用户未知”或省略,不要编造。' +
  '用户说明的实际故障 Harness / 模型 / 推理强度,只在真正有助于定位时写入,不要当固定栏目,也不要复制系统自动附加的当前任务快照。' +
  '功能建议不要写仓库路径、实现方案或验收清单,除非用户明确要求。禁止声称截图已附在本 issue——本工具不会上传图片。' +
  '不要填写系统会自动附加的快照字段(客户端版本 / 版本区域 / 提交客户端 OS / 当前任务的 Harness / 模型 ID / 界面语言)和提交人——系统会附加为「提交时的任务环境」。用户报告的实际故障环境应留在正文。';

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
        agentKind: ctx.agentKind,
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
