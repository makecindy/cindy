import { BRAND_NAME } from "@cindy/maker-shared/branding";
import { z } from "zod";

import type { XdtHelperToolRegistry } from "../lizi_xdtHelperToolRegistry.js";
import type {
  ControlResult,
  ControlWorkerAgent,
  LiziMcpSessionContext,
} from "../types.js";
import { errorPayload, okPayload } from "./_payload.js";

/**
 * Host 注入的 session handoff 回调。把一条控制层消息投递到一个 session:
 *  - 传 targetSessionId → jump(投递到既有 session,必要时自动 resume)
 *  - 不传 targetSessionId → create(为业务对象新建一个专属 session)
 *
 * 从 lizi_xdtHelperMcpServer.ts 随 send_to_session 工具一起迁来(顶层注册 → registry
 * 注册,归 handoff 类目)。注:`ControlDispatchOutcome` 仍留在原文件——它被
 * create_worker / orca server 引用,与本工具无关,不随迁。
 */
export type SendToSessionCallback = (params: {
  targetSessionId?: string;
  message: string;
  dispatcherSessionId?: string;
  title?: string;
  /** create 模式可选:true = 为新 session 预建独立 git worktree 并以其为 workingDir(jump 忽略)。 */
  useWorktree?: boolean;
  /** create 模式可选:新 session 的工作目录覆盖(绝对路径,须已存在;jump 忽略)。#811 */
  workingDir?: string;
  /** create 模式可选:显式目标 Agent；缺省继承 dispatcher。jump 忽略。 */
  agentKind?: ControlWorkerAgent;
  /** create 模式可选:显式目标模型；缺省继承 dispatcher。jump 忽略。 */
  model?: string;
  /** create 模式可选:显式推理强度；缺省继承 dispatcher。jump 忽略。 */
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  /** create 模式可选:显式 Fast 开关；缺省继承 dispatcher。jump 忽略。 */
  fast?: boolean;
}) => Promise<
  ControlResult<
    {
      targetSessionId: string;
      agentKind: ControlWorkerAgent;
      wakeKind: "resumed" | "already-active" | "created" | "queued";
      targetTitle: string | null;
      targetLastUserSendAt: string | null;
      /** create + useWorktree 成功时为新 session 的 worktree 绝对路径;其余情况 host 可省略。 */
      worktreePath?: string | null;
      model?: string;
      effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | null;
      fastMode?: boolean;
      providerId?: string | null;
    },
    | "NOT_FOUND"
    | "ARCHIVED"
    | "DELETED"
    | "BUSY"
    | "AGENT_NOT_READY"
    | "BUDGET_MODEL_REQUIRES_API_MODE"
    | "PROVIDER_ROUTE_UNAVAILABLE"
    | "INVALID_ARGS"
    | "LEAD_NOT_SUPPORTED"
    | "WORKTREE_UNAVAILABLE"
    | "HOST_NOT_READY"
  >
>;

export interface SendToSessionDeps {
  /** 解析当前 MCP 调用绑定的 session ctx(取 dispatcherSessionId)。 */
  getSessionContext: () => LiziMcpSessionContext;
  /** Host 注入的 handoff 实现(jump / create 在 host 侧按 targetSessionId 有无判定)。 */
  sendToSession: SendToSessionCallback;
}

// 这是 LLM 点进 handoff 类目、看到本工具后的行为说明;选类目阶段的协同规避另见
// lizi_xdtHelperMcpServer.ts 的 D_LIST_TOOLS(handoff 类目介绍)。
const DESCRIPTION = [
  '⚠️【不要用于"开协同 / 多 worker"】本工具 create 模式产出的是普通独立 session,不进入 Orca 协同分组或 Lead 右侧 worker 栏。用户明确要协同 team/worker 时才使用 cindy_orca；外部业务对象(issue / jira / pr)需要独立项目 session 时使用本工具。',
  "",
  "把一条控制层 handoff 消息投递到一个 session。两种模式:",
  "- 传 target_session_id → jump:投递到该既有 session(已关闭会自动 resume),wake_kind 返 resumed / already-active;目标正在跑 turn 时消息进入其输入队列、当前 turn 结束后自动派发,wake_kind 返 queued(无需重试)。",
  "- 不传 target_session_id → create:为业务对象新建一个专属 session。workingDir / Agent / model / effort / Fast 缺省继承当前 session；可用 agent_kind / model / effort / fast 显式覆盖目标执行配置。host 会在创建前按目标 Agent 的模型能力校验，非法组合结构化失败，不静默换模型。wake_kind 返 created,并回传 target_session_id 供调用方建立绑定。",
  "",
  "【执行配置(仅 create 模式)】agent_kind 可选 claude-code / codex / pi；model 使用宿主模型目录返回的精确 id；effort / fast 按目标模型能力校验。只改 Agent 却留下不属于目标 Agent 的继承模型会返 INVALID_ARGS，不会自动挑列表第一项。跨 Agent/model 时模型来源交给 host 既有默认路由解析。完全不传这些字段时保持原有 dispatcher 继承行为。jump 模式忽略这些字段，不修改既有 session。",
  "",
  "【working_dir(仅 create 模式)】缺省新 session 继承当前 session 的 workingDir;传 working_dir(绝对路径,目录须已存在)可把新 session 直接落到另一个项目目录——「从项目 A 的对话把任务 handoff 到项目 B 的全新对话」一次调用完成,无需先在 B 里找一个旧对话中转。与 use_worktree 组合时,worktree 的 base git 仓库从 working_dir 解析。路径不是绝对路径 / 不存在 / 不是目录 → 返 INVALID_ARGS(message 带原因)。jump 模式忽略此参数。",
  "",
  "【use_worktree(仅 create 模式)】use_worktree=true 时,host 会先从**新 session 的 workingDir**(即 working_dir 覆盖后的目录;未覆盖时为当前 workingDir,此时 session 自己在 worktree 里跑也能正确反推主仓库)解析出 base git 仓库,为新 session 预建一个正规 session worktree(<baseRepo>/.cindy-worktrees/<自动名> + cindy/<自动名> 分支,UI 有徽标,session 关闭时自动 stash 未提交改动后回收),新 session 的 workingDir 即该 worktree 路径,返回里带 worktree_path。历史 xdt/<自动名> 分支仍可恢复与回收。适用:新 session 要改代码 / checkout 分支,不能污染当前工作树时(如 PR 修复跟进)。workingDir 不是 git 仓库 / git 未装 / worktree 创建失败 → 返 WORKTREE_UNAVAILABLE(不静默降级);调用方可视情况去掉该参数重试(新 session 将直接共享当前 workingDir)。jump 模式忽略此参数。",
  "当前 dispatcher session 不会被本工具关闭或改写,消息投递成功后立即返回。",
  "",
  "【典型场景】skill 把某个外部业务对象(issue / jira / pr / 任意自定义 key)绑定到一个 session:首次处理时不传 id 让工具新建并拿回 id 写绑定;二次处理同一对象时传 id 把新消息路由回那个 session,保留完整上下文。",
  "",
  `【create 边界】create 依赖当前 session 上下文继承配置;未绑定具体 ${BRAND_NAME} session 的 MCP 调用会返 LEAD_NOT_SUPPORTED,skill 应静默回退普通流程。注意:传了 id 但目标不存在会返 NOT_FOUND(绝不自动新建)——只有完全不传 id 才走 create。`,
  "",
  "【失败码语义】",
  "- NOT_FOUND: 目标 session 不存在。skill 应清掉自己的绑定并回退到新建/普通流程。",
  "- ARCHIVED: 目标 session 已归档。skill 应决定是清绑定、回退新流程,还是等未来的 unarchive 工具。",
  "- DELETED: 目标 session 已删除。skill 应清绑定并回退。",
  "- BUSY: 仅 create 模式的罕见兜底(新建 session 意外已有 turn 在跑)。jump 模式撞忙不再返 BUSY,而是入队并成功返回 wake_kind=queued。",
  "- WORKTREE_UNAVAILABLE: 仅 create + use_worktree=true:无法创建 worktree(非 git 仓库 / git 未装 / git worktree add 失败,message 带具体原因)。skill 决定是去掉 use_worktree 重试还是放弃。",
  "- AGENT_NOT_READY: 目标 session 恢复或投递时 agent 未能启动。skill 应告知用户稍后重试。",
  "- HOST_NOT_READY: 主进程服务尚未就绪。skill 应告知用户稍等几秒后重试。",
  "",
  "【重要】这不是 chat 对话工具,而是 session 间 handoff 的控制层入口。不要拿它替代普通的 user→agent 对话。",
].join("\n");

/**
 * 注册 send_to_session 到 XdtHelperToolRegistry(handoff 类目),经 call_tool 调用。
 * 范式对齐 set_current_session_title.ts:host 通过 deps 注入 getSessionContext +
 * sendToSession 回调,工具层只做 ctx 解析 + 结果整形,不持有业务逻辑。
 */
export function registerSendToSessionTool(
  registry: XdtHelperToolRegistry,
  deps: SendToSessionDeps,
): void {
  registry.register({
    name: "send_to_session",
    category: "handoff",
    description: DESCRIPTION,
    inputShape: {
      target_session_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          `目标 ${BRAND_NAME} session 的 business id(UUID)。` +
            "省略 → create:新建一个专属 session 并在返回里回传新建 id;提供 → jump 到该既有 session。",
        ),
      message: z
        .string()
        .min(1)
        .describe(
          "要 handoff 给目标 session 的消息正文(create 模式下作为新 session 的首条消息)。",
        ),
      title: z
        .string()
        .optional()
        .describe(
          '仅 create 模式可选:新建 session 的标题(建议用业务对象命名,如 "issue #123")。省略则用消息首行兜底。',
        ),
      use_worktree: z
        .boolean()
        .optional()
        .describe(
          "仅 create 模式可选:true = 为新 session 预建独立 git worktree(自动从新 session 的 workingDir 解析 base 仓库)并以其为 workingDir,返回带 worktree_path;失败返 WORKTREE_UNAVAILABLE 不静默降级。新 session 要改代码 / checkout 分支时建议开。jump 模式忽略。",
        ),
      working_dir: z
        .string()
        .optional()
        .describe(
          "仅 create 模式可选:新 session 的工作目录(绝对路径,目录须已存在)。缺省继承当前 session 的 workingDir;用于把任务 handoff 到另一个项目目录的全新对话。不合法返 INVALID_ARGS。jump 模式忽略。",
        ),
      agent_kind: z
        .enum(["claude-code", "codex", "pi"])
        .optional()
        .describe(
          "仅 create 模式可选:目标 Agent/harness。缺省继承 dispatcher；jump 模式忽略。",
        ),
      model: z
        .string()
        .min(1)
        .optional()
        .describe(
          "仅 create 模式可选:目标模型精确 id。缺省继承 dispatcher；与目标 Agent/provider 不匹配时创建前失败，不静默降级。jump 模式忽略。",
        ),
      effort: z
        .enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
        .optional()
        .describe(
          "仅 create 模式可选:目标模型推理强度。按实际 provider+model 支持档位校验；jump 模式忽略。",
        ),
      fast: z
        .boolean()
        .optional()
        .describe(
          "仅 create 模式可选:Fast 模式开关。目标 Agent/provider/model 不支持时创建前失败；jump 模式忽略。",
        ),
    },
    handler: async ({
      target_session_id,
      message,
      title,
      use_worktree,
      working_dir,
      agent_kind,
      model,
      effort,
      fast,
    }) => {
      const ctx = deps.getSessionContext();
      const result = await deps.sendToSession({
        targetSessionId: target_session_id,
        message,
        dispatcherSessionId: ctx.sessionId,
        title,
        useWorktree: use_worktree,
        workingDir: working_dir,
        ...(agent_kind !== undefined ? { agentKind: agent_kind } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(effort !== undefined ? { effort } : {}),
        ...(fast !== undefined ? { fast } : {}),
      });

      if (!result.ok) {
        if (result.errorCode === "HOST_NOT_READY") {
          return errorPayload(
            "HOST_NOT_READY",
            `${BRAND_NAME} 主进程会话服务尚未就绪。请告知用户稍等几秒后重试。`,
          );
        }
        return errorPayload(result.errorCode, result.message);
      }

      return okPayload({
        target_session_id: result.targetSessionId,
        agent_kind: result.agentKind,
        wake_kind: result.wakeKind,
        target_title: result.targetTitle,
        target_last_user_send_at: result.targetLastUserSendAt,
        worktree_path: result.worktreePath ?? null,
        ...(result.model !== undefined ? { model: result.model } : {}),
        ...(result.effort !== undefined ? { effort: result.effort } : {}),
        ...(result.fastMode !== undefined ? { fast_mode: result.fastMode } : {}),
        ...(result.providerId !== undefined ? { provider_id: result.providerId } : {}),
      });
    },
  });
}
