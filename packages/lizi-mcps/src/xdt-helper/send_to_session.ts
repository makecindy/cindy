import { BRAND_NAME } from "@cindy/maker-shared/branding";
import { z } from "zod";

import type { XdtHelperToolRegistry } from "../lizi_xdtHelperToolRegistry.js";
import { LOCAL_AGENT_DEVICE, toHostAgentDeviceId } from "./create_worker.js";
import type {
  ControlResult,
  ControlWorkerAgent,
  ControlWorkerEngine,
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
  /** Create on this Cindy computer; omitted/local keeps existing local behavior. */
  device?: string;
  message: string;
  dispatcherSessionId?: string;
  title?: string;
  /** create 模式可选:true = 为新 session 预建独立 git worktree 并以其为 workingDir(jump 忽略)。 */
  useWorktree?: boolean;
  /** create + useWorktree 可选:worktree 的显式基线(分支、远端引用或提交);jump 不传。 */
  baseRef?: string;
  /** create 模式可选:新 session 的工作目录覆盖(绝对路径,须已存在;jump 忽略)。#811 */
  workingDir?: string;
  /** Omitted inherits source membership; null explicitly creates a projectless task. */
  projectDir?: string | null;
  /** create 模式可选:显式目标 Agent；缺省继承 dispatcher。acp = 插件引擎(需配 provider_id)。jump 忽略。 */
  agentKind?: ControlWorkerEngine;
  /** create 模式可选:显式目标模型；缺省继承 dispatcher。jump 忽略。 */
  model?: string;
  providerId?: string;
  /** create 模式可选:显式推理强度；缺省继承 dispatcher。jump 忽略。 */
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  /** create 模式可选:显式 Fast 开关；缺省继承 dispatcher。jump 忽略。 */
  fast?: boolean | 'ultrafast';
  /** create 模式可选:新任务的 Agent 所在电脑；null = 本机，缺省继承 dispatcher。jump 不传。 */
  agentDeviceId?: string | null;
}) => Promise<
  ControlResult<
    {
      targetDeviceId?: string;
      responsibilityRecorded?: false;
      targetSessionId: string;
      /** 'acp' for plugin-engine standalone tasks and plugin-engine Workers. */
      agentKind: ControlWorkerEngine;
      wakeKind: "resumed" | "already-active" | "created" | "queued";
      targetTitle: string | null;
      targetLastUserSendAt: string | null;
      /** jump 进入队列时的可寻址句柄，可用于本人编辑/撤回。 */
      queuedMessageId?: string;
      /** create + useWorktree 成功时为新 session 的 worktree 绝对路径;其余情况 host 可省略。 */
      worktreePath?: string | null;
      /** create + useWorktree:worktree 实际切出的基线;旧版本的目标电脑不回报。 */
      worktreeBaseRef?: string;
      /** 基线没能从远端刷新的原因:取自任务所在电脑上已有的副本,可能落后远端。 */
      worktreeBaseStaleReason?: string;
      /** create:模型由哪台电脑提供;null = 任务所在电脑自己。省略 = 未知(旧版本目标电脑)或不适用(SSH)。 */
      providerDeviceId?: string | null;
      /** create:供应电脑继承自来源任务,不是调用方点名的。 */
      providerDeviceInherited?: true;
      projectDir?: string | null;
      /** The project was chosen because the requested execution directory is inside it. */
      projectFromWorkingDir?: true;
      workspaceKind?: 'project' | 'dialogue';
      workingDir?: string;
      model?: string;
      effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | null;
      fastMode?: boolean | 'ultrafast';
      providerId?: string | null;
    },
    | "REMOTE_UNSUPPORTED"
    | "REMOTE_DEVICE_OFFLINE"
    | "REMOTE_DISABLED"
    | "REMOTE_UNAVAILABLE"
    | "DELIVERY_UNKNOWN"
    | "CREATED_NOT_DELIVERED"
    | "NOT_FOUND"
    | "ARCHIVED"
    | "DELETED"
    | "BUSY"
    | "AGENT_NOT_READY"
    | "UNSUPPORTED_CAPABILITY"
    | "BUDGET_MODEL_REQUIRES_API_MODE"
    | "PROVIDER_ROUTE_UNAVAILABLE"
    | "INVALID_ARGS"
    | "LEAD_NOT_SUPPORTED"
    | "WORKTREE_UNAVAILABLE"
    | "HOST_NOT_READY"
  > & { recoverySessionId?: string }
>;

/**
 * Host 注入的跨电脑投递回调:把消息交给 deviceId 那台电脑,由它投递到自己的既有任务。
 * 只有 jump 语义;结果里的错误码区分「没有发出」与「结果未知」。
 */
export type SendToRemoteSessionCallback = (params: {
  deviceId: string;
  sessionId: string;
  message: string;
  dispatcherSessionId?: string;
}) => Promise<
  ControlResult<
    {
      agentKind: ControlWorkerEngine;
      wakeKind: "resumed" | "already-active" | "queued";
      targetTitle: string | null;
      targetLastUserSendAt: string | null;
    },
    string
  >
>;

/** `deviceId::sessionId` → 两段;不含设备前缀的本机 id 返回 null。 */
export function parseQualifiedSessionId(
  value: string | undefined,
): { deviceId: string; sessionId: string } | null {
  if (!value) return null;
  const split = value.indexOf("::");
  if (split <= 0 || split >= value.length - 2) return null;
  return { deviceId: value.slice(0, split), sessionId: value.slice(split + 2) };
}

export interface SendToSessionDeps {
  /** 解析当前 MCP 调用绑定的 session ctx(取 dispatcherSessionId)。 */
  getSessionContext: () => LiziMcpSessionContext;
  /** Host 注入的 handoff 实现(jump / create 在 host 侧按 targetSessionId 有无判定)。 */
  sendToSession: SendToSessionCallback;
  /** 缺省 = host 不支持跨电脑投递;deviceId::sessionId 目标返 REMOTE_UNSUPPORTED。 */
  sendToRemoteSession?: SendToRemoteSessionCallback;
  /** Uses the signed-in user's existing guest membership, never same-account control. */
  sendToSharedTask?: (params: {
    target: string; message: string; deliveryId?: string; context: LiziMcpSessionContext;
  }) => Promise<
    | { ok: true; target_session_id: string; task_link: string; delivery_id: string;
        delivery_state: 'pending' | 'accepted'; wake_kind: 'queued' | 'accepted' }
    | { ok: false; errorCode: string; message: string; task_link?: string; delivery_id?: string }
  >;
}

// 这是 LLM 点进 handoff 类目、看到本工具后的行为说明;选类目阶段的协同规避另见
// lizi_xdtHelperMcpServer.ts 的 D_LIST_TOOLS(handoff 类目介绍)。
export const sessionDeliveryScope = (supportsRemote: boolean, supportsShared = false): string =>
  (supportsRemote ? '本机或已授权电脑' : supportsShared ? '本机' : '仅本机') + (supportsShared ? '，以及当前账号已加入的共享任务' : '');

const describeSendToSession = (supportsRemote: boolean, supportsShared: boolean) => [
  `【已有任务】发消息必须传 target_session_id（${sessionDeliveryScope(supportsRemote, supportsShared)}）；不知道 id 先用 history/list_sessions 查找。只有明确新建任务时才省略 target_session_id。新建时省略 project_path 继承来源归属，传已有项目路径切换项目，传 null 创建不绑项目的任务。`,
  ...(supportsShared ? [
    '【共享任务】别人共享给当前账号且已加入的任务：target_session_id 直接传「复制任务链接」得到的完整 Cindy 链接（与 get_shared_task_progress 相同），或该链接中 device 的完整共享引用加 ::sessionId。保留共享身份，不能改成房主 deviceId::sessionId 或裸 ID；不自动加入、不创建替代任务。仅发送显式 message，不附带本机历史、附件或工具权限；原任务保留执行者、模型、工作目录与权限。',
    '共享投递返回 task_link、delivery_id、delivery_state=pending/accepted；pending 对应 wake_kind=queued，无需重试；accepted 对应 wake_kind=accepted，仅证明原任务已接受输入，不证明仍在运行或执行成功。DELIVERY_UNKNOWN 时消息可能已入队，保留 task_link 和 delivery_id；再次调用相同 target_session_id、message 并带 delivery_id 只对账，绝不重发。unknown 不能证明未送达，不能换新 ID 重发；也可用 get_shared_task_progress 查看进展。只读、退出、移除、撤销共享、旧版或不可用均明确失败，不改走同账号远控。',
  ] : []),
  "",
  '⚠️【不要用于"开协同 / 多 worker"或内部临时子步骤】本工具 create 模式会创建用户侧边栏可见的普通独立任务（不会隐藏，也不进入 Orca 协同分组或 Lead 右侧 worker 栏）。只服务于当前任务的临时代码检查、独立复核、调研或拆分子步骤，优先用当前引擎原生 subagent；用户明确需要多 worker 协同 team 时才使用 cindy_orca。只有在确实需要独立的、用户可见的业务任务（如跟进 issue / jira / pr 或长期独立工作流）时才用本工具新建任务。',
  "",
  "把一条控制层 handoff 消息投递到一个 session。两种模式:",
  "- 传 target_session_id → jump:投递到该既有 session(已关闭会自动 resume),wake_kind 返 resumed / already-active;wake_kind=queued 仅确认已入队，消费和处理结果待核实，请勿重复投递。",
  ...(supportsRemote ? [
    "- 目标在另一台电脑:target_session_id 传 deviceId::sessionId(history 类目 list_sessions 用 device 参数查到的 id 就是这个形式),消息经远程控制通道发给那台电脑上的既有任务,对方显示来自本任务。要求对方电脑在线并已开启远程控制。",
  ] : []),
  "- 不传 target_session_id → create:新建任务并发送首条消息，可用 title 指定简短标题。本机 Agent / model / effort / Fast 缺省继承当前任务；device 指向另一台电脑时采用那台电脑的新任务默认。返回 wake_kind=created、target_session_id、project_path、实际 working_dir，以及 provider_device_id(模型实际由哪台电脑提供；local = 任务所在电脑自己)；后续消息用返回的 id。",
  "【项目】本机省略 project_path 时继承来源任务的项目。远程创建不继承来源电脑的路径；省略项目时按目标 working_dir 匹配已有项目，否则创建不绑项目的任务。list_projects(device) 查询目标电脑项目。来源本来不绑项目时：working_dir 在某个已登记且可见的项目里，就归到最近的那个项目（回执 project_note 会说明）；否则新任务也不绑项目。无法可靠确定来源归属时明确失败。也可显式复用 get_current_session_id.project_path；跨项目用 control/list_projects 选择已有项目。传 project_path:null 明确创建不绑项目的任务。临时目录、仓库子目录、worktree 都不会变成新项目。确需新增或恢复项目时，单独调用 create_project。",
  "",
  "【执行配置(仅 create 模式)】agent_kind 可选 claude-code / codex / pi / acp；model 使用宿主模型目录返回的精确 id；effort / fast 按目标模型能力校验。只改内置 Agent 却留下不属于目标 Agent 的继承模型会返 INVALID_ARGS，不会自动挑列表第一项。跨 Agent/model 时模型来源交给 host 既有默认路由解析。acp = 插件提供的执行引擎(取 list_available_models 的 plugin_engines)：provider_id 传该项 provider_id(形如 acp-plugin:…；来源本身已是插件引擎且未换引擎时可省)，model 传其 models[].id(省略或 default = 由引擎自选；有模型关闭或受限时须明确传模型 id)，effort 按该模型的 efforts 校验，不支持 fast。本机完全不传这些字段时保持原有 dispatcher 继承行为；远程创建按目标电脑默认配置。jump 模式忽略这些字段，不修改既有 session。",
  "",
  "【provider_device_id(旧名 agent_device_id，仅 create 模式)】新任务的 Agent 使用哪台电脑的远程供应商：取 list_available_models 的 locations[].provider_device_id；\"local\" 或本机设备 id 表示本机。本机缺省继承当前任务的位置；远程创建缺省使用目标电脑本机供应商，local 也相对目标电脑。本机创建时位置与当前任务不同且没传 model 时沿用当前任务的模型 id，按那台电脑的供应商重新解析来源；那台没有这个模型、离线、未开启远程控制或分享不可用 → PROVIDER_ROUTE_UNAVAILABLE；格式不对，或当前任务是 SSH 任务 → INVALID_ARGS。失败时不创建任务、不自动换电脑，由调用方决定换哪一台重试。jump 模式忽略。",
  "回执的 provider_device_id 是创建后实际生效的位置，创建后请核对：不是 local 时，模型用的是另一台电脑的供应商和账号额度，provider_note 说明它是继承来的还是点名的。目标电脑版本较旧时不回报该字段，provider_note 会说明位置未知，不能当作目标电脑自己的供应商。",
  "",
  "【远程新建】device 选择任务与文件所在电脑；先 list_machines、list_projects(device)、list_available_models(device)。旧版本不支持时不发出；DELIVERY_UNKNOWN / CREATED_NOT_DELIVERED 返回恢复用 target_session_id，先读该任务记录和队列，不能重复 create。不会建立 Worker、父子编排或自动回传；需要回信时用普通 send_to_session。",
  "【working_dir(仅 create 模式)】可选执行目录，缺省为选中或继承的项目目录；不绑项目时分配独立的托管目录。可以指定已有仓库、子目录或临时 worktree；必须为存在的绝对目录。它不改变已指定或继承的项目归属，也不登记项目。不绑项目且 use_worktree=true 时必须显式指定 working_dir 作为 Git 仓库。jump 模式忽略。",
  "",
  "【use_worktree(仅 create 模式)】use_worktree=true 时,host 会先从**新 session 的 workingDir**(即 working_dir 覆盖后的目录;未覆盖时为选中或继承的项目目录)解析出 base git 仓库,为新 session 预建一个正规 session worktree(<baseRepo>/.cindy-worktrees/<自动名> + cindy/<自动名> 分支,UI 有徽标,session 关闭时自动 stash 未提交改动后回收),新 session 的 workingDir 即该 worktree 路径,返回里带 worktree_path，项目归属保持不变，包括不绑项目的任务。历史 xdt/<自动名> 分支仍可恢复与回收。适用:新 session 要改代码 / checkout 分支,不能污染当前工作树时(如 PR 修复跟进)。workingDir 不是 git 仓库 / git 未装 / worktree 创建失败 → 返 WORKTREE_UNAVAILABLE(不静默降级);调用方可视情况去掉该参数重试(新 session 将直接使用 working_dir 或默认执行目录)。jump 模式忽略此参数。",
  "【base_ref(仅 create + use_worktree=true)】worktree 从哪里切出。省略时:本机创建且当前任务自己在 worktree 里、没换 working_dir → 跟随它当前检出的分支；其余情况(含在另一台电脑上创建) → 刚拉取的远端默认分支。项目的工作分支不是默认分支时(例如长期在 release/2.x 上开发)要显式传 base_ref，否则新任务从默认分支起步、还得自己再切一次分支。写法与 create_task_worktree 的 base_ref 相同:远端分支写 \"origin/release/2.x\"(创建前先向远端拉取这一条分支，另一台电脑刚 push 的提交也能拿到)，本地分支写 \"release/2.x\"(按任务所在电脑上现有的状态，不联网)，也可以是提交 SHA。引用解析不了 → WORKTREE_UNAVAILABLE，不回退默认分支；没传 use_worktree=true → INVALID_ARGS；远程创建时目标电脑版本不支持 → REMOTE_UNSUPPORTED；三种情况都不创建任务。回执的 worktree_base_ref 是实际切出的基线；远端分支没能拉取时仍用任务所在电脑上已有的副本创建，并返回 worktree_base_fetched=false 与 worktree_warning，要转告用户。jump 模式忽略此参数。",
  "当前 dispatcher session 不会被本工具关闭或改写,消息投递成功后立即返回。",
  "",
  "【典型场景】首次处理外部业务对象时，选择已有项目并传 project_path 新建任务，保存返回的 id；再次处理时传 target_session_id 回到原任务。",
  "",
  `【create 边界】create 依赖当前 session 上下文标明来源，本机还继承配置;未绑定具体 ${BRAND_NAME} session 的 MCP 调用会返 LEAD_NOT_SUPPORTED,skill 应静默回退普通流程。注意:传了 id 但目标不存在会返 NOT_FOUND(绝不自动新建)——只有完全不传 id 才走 create。`,
  "",
  "【失败码语义】",
  "- NOT_FOUND: 目标 session 不存在。skill 应清掉自己的绑定并回退到新建/普通流程。",
  "- ARCHIVED: 目标 session 已归档。已有恢复授权时，可先用 control/unarchive_sessions（支持 deviceId::sessionId）恢复，再发送新消息；不能自行推翻用户归档意图。",
  "- DELETED: 目标 session 已删除。skill 应清绑定并回退。",
  "- BUSY: 仅 create 模式的罕见兜底(新建 session 意外已有 turn 在跑)。jump 模式撞忙不再返 BUSY,而是入队并成功返回 wake_kind=queued。",
  "- WORKTREE_UNAVAILABLE: 仅 create + use_worktree=true:无法创建 worktree(非 git 仓库 / git 未装 / base_ref 解析不了 / git worktree add 失败,message 带具体原因)。skill 决定是改 base_ref、去掉 use_worktree 重试还是放弃。",
  "- AGENT_NOT_READY: 目标 session 恢复或投递时 agent 未能启动。skill 应告知用户稍后重试。",
  "- UNSUPPORTED_CAPABILITY: 目标 session 不接受跨任务投递（例如 host 管理的隔离 Review）。skill 不应重试或改走其它输入入口。",
  "- HOST_NOT_READY: 主进程服务尚未就绪。skill 应告知用户稍等几秒后重试。",
  "- PROVIDER_ROUTE_UNAVAILABLE: 仅 create:目标位置(agent_device_id 或继承的位置)没有提供所需模型的已连接供应商，或指定的电脑读不到供应商(离线 / 未开启远程控制 / 分享不可用)。没有创建任务；可换一台电脑或换模型重试。",
  "- INVALID_ARGS: 参数不合法(含 agent_device_id 格式不对、SSH 任务指定 agent_device_id)。没有创建任务。",
  "- REMOTE_DEVICE_OFFLINE / REMOTE_DISABLED / REMOTE_UNAVAILABLE: 目标电脑离线、未开启远程控制或暂时连不上,消息没有发出。",
  "- REMOTE_UNSUPPORTED: 目标电脑的版本不支持接收其它电脑的任务消息，或不支持本次用到的创建参数(如 base_ref)；消息没有发出、任务没有创建，需要对方升级。",
  "- DELIVERY_UNKNOWN: 请求已发往目标电脑但没有收到可信回执(含对方 Agent 没能启动),可能已送达。重发前先用 get_chat_history(deviceId::sessionId) 确认,避免重复。",
  "",
  "【重要】这不是 chat 对话工具,而是 session 间 handoff 的控制层入口。不要拿它替代普通的 user→agent 对话。",
].join("\n");

/**
 * create 模式成功返回附带的说明:明确告诉调用方「这是新建、不是投给既有任务」以及
 * 后果(本轮已触发),避免调用方漏传 target_session_id 时把 created 误读为投递成功(#4884)。
 */
export function createdNote(targetSessionId: string): string {
  return (
    `已新建任务 ${targetSessionId}(wake_kind=created),本条消息作为其首条输入,本轮已触发。` +
    "这不是投递到既有任务;若原意是发给某个已存在的任务,请用 list_sessions 找到目标 id 后带 target_session_id 重发,并停止或归档这个多出来的任务。"
  );
}

/**
 * 新建任务回执里的归属说明。只在调用方省略 project_path 时出现：归属由宿主代为决定，
 * 调用方要能看出任务落在哪里、为什么，以及下次怎样改。显式选择（路径或 null）不加说明。
 */
export function projectMembershipNote(input: {
  requested: string | null | undefined;
  resolved: string | null | undefined;
  fromWorkingDir: boolean;
}): { project_note?: string } {
  if (input.requested !== undefined) return {};
  if (input.fromWorkingDir) {
    return { project_note: "The source task has no project, so this task was placed in the project that contains working_dir. Pass project_path to choose another project, or null to keep a task out of projects." };
  }
  if (input.resolved === null) {
    return { project_note: "This task is not in any project: the source task has none, and working_dir (if given) is not inside a visible registered project. To place a task in a project, pass project_path from list_projects." };
  }
  return {};
}

const queuedNote = "消息已入队，尚未确认目标已消费或处理。请勿重复投递。";
const localQueueCheck = "用 list_session_queue 查询 target_session_id，可按返回的 queued_message_id 核对。consuming=true 表示正在投递，条目消失也不能证明处理完成。用 get_chat_history 核对对应输入和回复。";
const remoteQueueCheck = "在支持跨机历史读取时，用 get_chat_history 查询完整的 target_session_id 并核对对应输入和回复。需要查看队列时，在目标电脑上查询本机队列。";

/**
 * 新建任务回执里的供应电脑。调用方省略 provider_device_id 时位置由宿主决定(本机继承来源任务、
 * 远程用目标电脑自己的)，不回报就看不出新任务用的是哪台电脑的账号额度。不是任务所在电脑时
 * 附一句说明；目标电脑版本较旧没回报时如实说未知，不猜成 local。
 */
export function providerLocationReceipt(input: {
  providerDeviceId: string | null | undefined;
  inherited: boolean;
  remoteDestination: boolean;
}): { provider_device_id?: string; provider_note?: string } {
  if (input.providerDeviceId === undefined) {
    return input.remoteDestination
      ? { provider_note: "The destination computer runs an older version that does not report which computer provides this task's model. Do not assume it is the destination's own provider; update the destination to see it." }
      : {};
  }
  if (input.providerDeviceId === null) return { provider_device_id: LOCAL_AGENT_DEVICE };
  return {
    provider_device_id: input.providerDeviceId,
    provider_note:
      `This task's model is provided by another computer (${input.providerDeviceId}), not by the computer that holds the task, ` +
      (input.inherited
        ? "because the source task uses that provider and provider_device_id was omitted. "
        : "as requested by provider_device_id. ") +
      'Its usage counts against that computer\'s accounts. To use the task computer\'s own provider, create the task with provider_device_id="local".',
  };
}

/**
 * 新建任务回执里的 worktree 基线:实际切出的引用，以及没能从远端刷新时的提示。
 * 文案与 create_task_worktree 的 base_fetched / warning 同义。
 */
export function worktreeBaseReceipt(input: {
  baseRef: string | undefined;
  staleReason: string | undefined;
  requested: boolean;
}): { worktree_base_ref?: string; worktree_base_fetched?: false; worktree_warning?: string } {
  if (!input.baseRef) return {};
  if (!input.staleReason) return { worktree_base_ref: input.baseRef };
  return {
    worktree_base_ref: input.baseRef,
    worktree_base_fetched: false,
    worktree_warning:
      `Could not refresh ${input.requested ? 'base_ref' : 'the remote default branch'} from its remote (${input.staleReason}). ` +
      `The worktree starts from ${input.baseRef} as it exists on the task's computer and may be behind the remote. ` +
      'Tell the user, and have the new task fetch and merge the remote branch once the network is available.',
  };
}

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
    description: describeSendToSession(!!deps.sendToRemoteSession, !!deps.sendToSharedTask),
    inputShape: {
      device: z.string().trim().min(1).max(128).optional().describe(
        '仅 create：任务、目录和文件所在电脑，取 list_machines 的 machines.computers[].deviceId；省略或 local 为当前宿主。远程项目/目录按目标电脑解析；未选项目不继承本机路径，未选模型用目标默认。已有任务使用 target_session_id，不同时传 device。',
      ),
      provider_id: z.string().trim().min(1).optional().describe(
        '仅 create 模式可选：内置引擎用于本机新建任务，从 list_available_models 对应模型的 providers 选取本机连接 ID；插件引擎(agent_kind="acp")必传(来源本身已是插件引擎且未换引擎时可省)，取 list_available_models 的 plugin_engines[].provider_id(形如 acp-plugin:…)，支持本机、远程任务电脑(device)及远程/分享供应商(provider_device_id)。省略沿用原选路；jump 忽略。',
      ),
      provider_device_id: z.string().trim().min(1).max(128).optional().describe(
        '仅 create：模型供应商所在电脑，取 list_available_models 的 locations；local 表示任务所在电脑。与 device（任务和文件位置）独立。旧名 agent_device_id 兼容保留，同时填写必须一致。',
      ),
      target_session_id: z
        .string()
        .min(1)
        .optional()
        .describe(
          `目标 ${BRAND_NAME} session 的 business id(新建 desktop session 是 UUID,` +
            "历史 session 可能是 cuid 或 IM 确定性 id,一律按不透明字符串处理、不校验格式)。" +
            "要发给已有任务时必传(不知道 id 先用 list_sessions 查);提供 → jump 到该既有 session。" +
            (deps.sendToRemoteSession ? "另一台电脑上的任务用 deviceId::sessionId。" : deps.sendToSharedTask ? '本机目标用裸 ID。' : "仅支持发给本机已有任务。") +
            (deps.sendToSharedTask ? '已加入的共享任务传完整复制任务链接，或完整共享 device 引用加 ::sessionId；不要只取房主设备或裸任务 ID。' : '') +
            "省略 → create:新建用户侧边栏可见的独立任务并立刻跑一轮（不要拿它承接只服务当前任务的临时检查、复核或子步骤，这类内部步骤优先用当前引擎原生 subagent）；项目归属由 project_path 指定或继承。",
        ),
      ...(deps.sendToSharedTask ? { delivery_id: z.string().min(1).max(256).optional().describe(
        '仅共享任务：先前投递回执的 delivery_id。提供时只查询该消息是否排队/已接受，绝不再次发送；结果不明时保留原 ID。首次发送省略。',
      ) } : {}),
      message: z
        .string()
        .min(1)
        .describe(
          "要发送的消息，对方收到的就是这段原文。共享目标只接收这段文字与已验证的访客作者，不附加本机历史、附件或来源任务 ID。本机/同账号任务另附本任务的 session_id，可用 get_chat_history 读背景。当前输入属于用户请求或其转交时，对方按这段内容处理，不扩大范围或要求重复确认。自主消息、自动化通知和结果回传不代表用户。",
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
      base_ref: z
        .string()
        .trim()
        .min(1)
        .max(1024)
        .optional()
        .describe(
          '仅 create + use_worktree=true 可选:worktree 的基线，写法同 create_task_worktree 的 base_ref。远端分支如 "origin/release/2.x"(创建前先拉取这一条分支)，本地分支如 "release/2.x"(按任务所在电脑现状，不联网)，或提交 SHA。省略 = 本机创建时跟随当前任务所在 worktree 的分支，否则为刚拉取的远端默认分支。解析不了返 WORKTREE_UNAVAILABLE，不回退默认分支；未开 use_worktree 返 INVALID_ARGS。jump 模式忽略。',
        ),
      working_dir: z
        .string()
        .optional()
        .describe(
          "仅 create 模式可选:执行目录(已有绝对目录)，缺省为选中或继承的项目目录；不绑项目时分配独立托管目录。可使用子目录或临时 worktree；不改变已指定或继承的项目归属、不创建项目。jump 忽略。",
        ),
      project_path: z.string().trim().min(1).max(4096).nullable().optional().describe(
        "仅 create：字符串选择目标电脑 list_projects 中已有的可见项目；null 明确不绑项目。本机省略时继承来源归属；来源不绑项目或远程创建时，按目标 working_dir 匹配已有项目，否则不绑项目。隐藏、未登记或归属不明确时拒绝。jump 忽略。",
      ),
      agent_kind: z
        .enum(["claude-code", "codex", "pi", "acp"])
        .optional()
        .describe(
          '仅 create 模式可选:目标 Agent/harness(acp = 插件提供的执行引擎，取 list_available_models 的 plugin_engines，须配 provider_id)。本机缺省继承 dispatcher，远程采用目标默认；jump 模式忽略。',
        ),
      model: z
        .string()
        .min(1)
        .optional()
        .describe(
          "仅 create 模式可选:目标模型精确 id。本机缺省继承 dispatcher，远程采用目标默认；与目标 Agent/provider 不匹配时创建前失败，不静默降级。jump 模式忽略。",
        ),
      effort: z
        .enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
        .optional()
        .describe(
          "仅 create 模式可选:目标模型推理强度。按实际 provider+model 支持档位校验；jump 模式忽略。",
        ),
      fast: z
        .union([z.boolean(), z.literal('ultrafast')])
        .optional()
        .describe(
          "仅 create 模式可选:Fast 模式开关。目标 Agent/provider/model 不支持时创建前失败；jump 模式忽略。",
        ),
      agent_device_id: z
        .string()
        .trim()
        .min(1)
        .max(128)
        .optional()
        .describe(
          '兼容旧名；优先用 provider_device_id。仅 create 模式可选:模型供应商位置，取 list_available_models 的 locations[].provider_device_id；"local" 为任务所在电脑。本机创建缺省继承当前任务，远程缺省用目标电脑本机供应商。那台没有所需模型或连不上 → PROVIDER_ROUTE_UNAVAILABLE；jump 模式忽略。',
        ),
    },
    handler: async ({
      target_session_id,
      delivery_id,
      device,
      provider_device_id,
      provider_id,
      message,
      title,
      use_worktree,
      base_ref,
      working_dir,
      project_path,
      agent_kind,
      model,
      effort,
      fast,
      agent_device_id,
    }) => {
      if (target_session_id && device !== undefined)
        return errorPayload("INVALID_ARGS", "已有目标请只传 target_session_id；device 仅用于新建任务。");
      // 基线只对新建的 worktree 有意义。悄悄忽略会让调用方以为新任务在点名的分支上。
      if (!target_session_id && base_ref !== undefined && use_worktree !== true)
        return errorPayload("INVALID_ARGS", "base_ref 只在 use_worktree=true 时有效；请同时传 use_worktree=true，或去掉 base_ref。");
      if (!target_session_id && provider_device_id !== undefined && agent_device_id !== undefined
        && provider_device_id !== agent_device_id)
        return errorPayload("INVALID_ARGS", "provider_device_id 与旧名 agent_device_id 指向不同位置，请只选一个供应商位置。");
      const ctx = deps.getSessionContext();
      // URLs and scoped references must never reach local lookup/create or the
      // same-account remote handoff. The Host validates the full shared target.
      const sharedTarget = target_session_id && (/^[a-z][a-z0-9+.-]*:\/\//i.test(target_session_id) || target_session_id.startsWith('['));
      if (sharedTarget) {
        if (!deps.sendToSharedTask) return errorPayload('UNSUPPORTED_CAPABILITY', '当前宿主不支持向共享任务投递。');
        const result = await deps.sendToSharedTask({ target: target_session_id, message,
          deliveryId: typeof delivery_id === 'string' ? delivery_id : undefined, context: ctx });
        if (result.ok) return okPayload(result);
        return errorPayload(result.errorCode, result.message, {
          ...(result.task_link ? { task_link: result.task_link, target_session_id: result.task_link } : {}),
          ...(result.delivery_id ? { delivery_id: result.delivery_id } : {}),
        });
      }
      if (delivery_id !== undefined) return errorPayload('INVALID_ARGS', 'delivery_id 只能用于共享任务对账。');
      const qualified = parseQualifiedSessionId(target_session_id);
      // 设备目录里本机的 id 是 "local":local::<id> 就是本机任务。
      const localTargetId = qualified?.deviceId === "local" ? qualified.sessionId : target_session_id;
      if (qualified && qualified.deviceId !== "local") {
        if (!deps.sendToRemoteSession) {
          return errorPayload("REMOTE_UNSUPPORTED", "当前宿主不支持给其它电脑上的任务发消息。");
        }
        if (!ctx.sessionId && ctx.hostCaller?.kind !== 'plugin') {
          return errorPayload("LEAD_NOT_SUPPORTED", "当前调用未绑定任务,无法标明消息来源。");
        }
        const remote = await deps.sendToRemoteSession({
          deviceId: qualified.deviceId,
          sessionId: qualified.sessionId,
          message,
          dispatcherSessionId: ctx.sessionId,
        });
        if (!remote.ok) return errorPayload(remote.errorCode, remote.message);
        return okPayload({
          target_session_id,
          target_device_id: qualified.deviceId,
          agent_kind: remote.agentKind,
          wake_kind: remote.wakeKind,
          ...(remote.wakeKind === "queued" ? { note: queuedNote + remoteQueueCheck } : {}),
          target_title: remote.targetTitle,
          target_last_user_send_at: remote.targetLastUserSendAt,
        });
      }
      const result = await deps.sendToSession({
        targetSessionId: localTargetId,
        ...(device !== undefined ? { device } : {}),
        message,
        dispatcherSessionId: ctx.sessionId,
        title,
        useWorktree: use_worktree,
        // jump 不建 worktree：只在 create 时传。
        ...(localTargetId === undefined && base_ref !== undefined ? { baseRef: base_ref } : {}),
        workingDir: working_dir,
        ...(project_path !== undefined ? { projectDir: project_path } : {}),
        ...(agent_kind !== undefined ? { agentKind: agent_kind } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(localTargetId === undefined && provider_id !== undefined ? { providerId: provider_id } : {}),
        ...(effort !== undefined ? { effort } : {}),
        ...(fast !== undefined ? { fast } : {}),
        // jump 不改既有任务的位置：只在 create 时传。
        ...(localTargetId === undefined ? toHostAgentDeviceId(provider_device_id ?? agent_device_id) : {}),
      });

      if (!result.ok) {
        if (result.errorCode === "HOST_NOT_READY") {
          return errorPayload(
            "HOST_NOT_READY",
            `${BRAND_NAME} 主进程会话服务尚未就绪。请告知用户稍等几秒后重试。`,
          );
        }
        return errorPayload(result.errorCode, result.message, result.recoverySessionId ? { target_session_id: result.recoverySessionId } : {});
      }

      return okPayload({
        target_session_id: result.targetSessionId,
        ...(result.targetDeviceId ? { target_device_id: result.targetDeviceId } : {}),
        agent_kind: result.agentKind,
        wake_kind: result.wakeKind,
        ...(result.wakeKind === "queued" ? { note: queuedNote + localQueueCheck } : {}),
        ...(result.responsibilityRecorded === false ? { responsibility_recorded: false, responsibility_note: "Task creation succeeded, but the responsibility record could not be saved. Do not recreate or resend this task; reconcile the responsibility with the host." } : {}),
        ...(result.wakeKind === "created"
          ? { note: createdNote(result.targetSessionId) }
          : {}),
        target_title: result.targetTitle,
        target_last_user_send_at: result.targetLastUserSendAt,
        ...(result.queuedMessageId ? { queued_message_id: result.queuedMessageId } : {}),
        worktree_path: result.worktreePath ?? null,
        ...(result.wakeKind === "created"
          ? {
              ...worktreeBaseReceipt({
                baseRef: result.worktreeBaseRef,
                staleReason: result.worktreeBaseStaleReason,
                requested: base_ref !== undefined,
              }),
              ...providerLocationReceipt({
                providerDeviceId: result.providerDeviceId,
                inherited: result.providerDeviceInherited === true,
                remoteDestination: !!result.targetDeviceId,
              }),
            }
          : {}),
        ...(result.projectDir !== undefined ? { project_path: result.projectDir } : {}),
        ...(result.wakeKind === "created"
          ? projectMembershipNote({
              requested: project_path,
              resolved: result.projectDir,
              fromWorkingDir: result.projectFromWorkingDir === true,
            })
          : {}),
        ...(result.workspaceKind !== undefined ? { workspace_kind: result.workspaceKind } : {}),
        ...(result.workingDir !== undefined ? { working_dir: result.workingDir } : {}),
        ...(result.model !== undefined ? { model: result.model } : {}),
        ...(result.effort !== undefined ? { effort: result.effort } : {}),
        ...(result.fastMode !== undefined ? { fast_mode: result.fastMode } : {}),
        ...(result.providerId !== undefined ? { provider_id: result.providerId } : {}),
      });
    },
  });
}
