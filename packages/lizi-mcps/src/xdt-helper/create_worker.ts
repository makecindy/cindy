/**
 * xdt-helper/create_worker.ts —— 在 active workflow 内创建新 worker session。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlDispatchOutcome, ControlResult, ControlWorkerAgent } from '../lizi_xdtHelperMcpServer.js';
import { okPayload, errorPayload } from './_payload.js';

const WORKER_LABEL_PATTERN = /^[a-z0-9_-]+$/i;

/** Worker 数量闸的结构化快照；批量编排据此生成稳定汇总。 */
export interface WorkerLimitSnapshot {
  workerHardLimit: number;
  occupiedSlots: number;
  remainingSlots: number;
}

type CreateWorkerErrorCode =
  | 'INVALID_PARAMS'
  | 'NOT_FOUND'
  | 'WORKER_LIMIT_HARD_EXCEEDED'
  | 'DUPLICATE_LABEL'
  | 'WORKER_CREATION_IN_PROGRESS'
  | 'BUDGET_MODEL_REQUIRES_API_MODE'
  | 'NO_PROVIDER_FOR_AGENT'
  | 'PROVIDER_ROUTE_UNAVAILABLE'
  | 'REMOTE_AGENT_DEVICE_UNREACHABLE'
  | 'REMOTE_AGENT_SHARE_PAUSED'
  | 'REMOTE_AGENT_SHARE_REMOVED'
  | 'REMOTE_AGENT_SHARE_UNAVAILABLE'
  | 'UNSUPPORTED_CAPABILITY';

/** agent_device_id 里表示「这台电脑」(任务所在电脑)的取值。 */
export const LOCAL_AGENT_DEVICE = 'local';

/** MCP 的 agent_device_id → host 的 agentDeviceId：`local` = null(任务所在电脑)，省略 = 不带(跟 Lead)。 */
export function toHostAgentDeviceId(value: string | undefined): { agentDeviceId?: string | null } {
  if (value === undefined) return {};
  return { agentDeviceId: value === LOCAL_AGENT_DEVICE ? null : value };
}

export interface WorkerCreationResolved {
  agent: ControlWorkerAgent;
  model: string;
  providerId: string | null;
  agentDeviceId?: string | null;
  remoteHostId?: string | null;
  effort: string | null;
  fastMode: boolean | 'ultrafast';
}
export interface WorkerCreationDefaults {
  source: 'memory' | 'original-policy' | 'explicit';
  fallbackReason?: string;
}
export interface CreateWorkerSuccessData {
  worktreeSource?: { sourceBranch: string; source: 'memory' | 'current' | 'explicit'; fallbackReason?: string };
  resolved?: WorkerCreationResolved;
  defaults?: WorkerCreationDefaults;
  executionDeviceId?: string;
  workerId: string;
  workerSessionId: string;
  workingDir?: string;
  worktree?: { path: string; branch: string };
  softLimitExceeded?: boolean;
  dispatched?: boolean;
  dispatchOutcome?: ControlDispatchOutcome;
  queuedMessageId?: string;
}

export type CreateWorkerControlResult = ControlResult<CreateWorkerSuccessData, CreateWorkerErrorCode> & {
  limit?: WorkerLimitSnapshot;
};

export interface CreateWorkerDeps {
  sessionId: string | undefined;
  vendorOptions?: Record<string, unknown>;
  getSessionContext?: () => {
    sessionId?: string;
    vendorOptions?: Record<string, unknown>;
  };
  createWorker: (params: {
    leadSessionId: string;
    role: string;
    agent?: ControlWorkerAgent;
    model?: string;
    providerId?: string;
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
    fast?: boolean | 'ultrafast';
    label: string;
    workingDir?: string;
    worktree?: { sourceBranch?: string };
    executionDeviceId?: string;
    /** Worker 的 Agent 所在位置：null = 任务所在电脑；省略 = 跟 Lead。 */
    agentDeviceId?: string | null;
    initialTask?: string;
    initialTaskImages?: string[];
  }) => Promise<CreateWorkerControlResult>;
}

/**
 * 图片地址列表的共享形状（send_to_worker / create_worker / create_workers 共用）。
 * 要求扁平字符串数组；实测两类误传形态自愈而不是报参数错（glm 等 openai-completions 兼容层
 * 把数组参数序列化成 <item> 重复标签，单元素时会折叠成标量）：
 * 1. 多套一层：[[a],[b]] → 拍平；
 * 2. XML 风格包装：{item:[a,b]} → 取 item；单元素折叠 {item:a} → [a]；裸标量 a → [a]。
 */
export const imagesListSchema = z.preprocess(
  (value) => {
    if (Array.isArray(value)) {
      return value.some((item) => Array.isArray(item)) ? (value as unknown[]).flat(1) : value;
    }
    if (value && typeof value === 'object') {
      const item = (value as { item?: unknown }).item;
      if (item === undefined) return value;
      value = item;
      if (Array.isArray(value)) {
        return value.some((x) => Array.isArray(x)) ? (value as unknown[]).flat(1) : value;
      }
    }
    if (typeof value === 'string' && value.trim().length > 0) return [value];
    return value;
  },
  z.array(z.string().min(1)).max(8),
);

/** 单个 worker 的稳定输入 schema；create_worker/create_workers 共用。 */
export const createWorkerSpecSchema = z.object({
  role: z
    .string()
    .min(1)
    .max(32)
    .describe('worker 角色: developer / reviewer / tester / merger 或自定义 string'),
  agent: z
    .enum(['claude-code', 'codex', 'pi'])
    .optional()
    .describe('可选，省略按用户在创建 Worker 面板手工提交过的组合；没选过需指定 agent。记忆不可用且无法确定 agent 时，指定 agent 后重试。'),
  model: z
    .string()
    .optional()
    .describe('可选，Worker 模型 id；不传优先使用适用的手工组合，否则走原默认策略。有适用的手工组合时，只传 model 可按目录推断 agent，歧义时须指定 agent；没有适用组合时需同时指定 agent。'),
  provider_id: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .optional()
    .describe('可选, 模型来源 provider id; 应使用 list_available_models 返回的 provider_id, 不传使用适用的手工组合，否则由 host 按原策略解析'),
  effort: z
    .enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    .optional()
    .describe('可选, reasoning/thinking 强度。Codex GPT worker 支持 low/medium/high/xhigh，部分模型(如 GPT-5.6 Sol)还支持 max/ultra；Claude 支持到 max。显式传入时必须匹配所选 model 能力；当前 worker 模型都不把 minimal 作为可选档。'),
  fast: z
    .union([z.boolean(), z.literal('ultrafast')])
    .optional()
    .describe('可选, 是否给 worker 开启 Fast 模式。对 codex 与 pi worker 生效(且需所选模型支持 Fast); claude-code 忽略。不传则继承默认。'),
  label: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(WORKER_LABEL_PATTERN)
    .describe('worker 短标识, 1-32 chars, 只能含字母、数字、-、_, 同 workflow 内唯一'),
  initial_task: z
    .string()
    .min(1)
    .optional()
    .describe('可选, 创建后立即派给 worker 的第一条消息'),
  images: imagesListSchema
    .optional()
    .describe('可选, 随 initial_task 发给 worker 的图片(png/jpeg/gif/webp, 最多 8 张); 必须是扁平字符串数组, 每张图一个字符串, 如 ["cindy-media://...png"]; 仅本机 worker 支持, SSH 远端 worker 会拒绝; 不传 initial_task 时忽略。地址两类: (a) 用户在对话里贴的图 — 把上下文 <cindy-host-image-references> 里的 uri 原样传入; (b) Lead 自己落盘的本机绝对路径'),
  working_dir: z.string().min(1).max(4096).refine((value) => value.trim().length > 0).optional()
    .describe('可选，Worker 所在主机上已存在的绝对目录。省略时继承 Lead 任务记录的工作目录（启动时的目录），不会跟随之后 cd 进入的 worktree。希望共用你当前的 worktree（含 git worktree add 自建的）时，请显式传其绝对路径；需要独立的新 worktree 时用 new_worktree。显式 working_dir / new_worktree 按会话权限审批。指定 execution_device_id 时目录属于那台电脑，省略由那台分配；校验失败不回退。'),
  new_worktree: z.object({
    source_branch: z.string().min(1).max(1024)
      .refine((value) => value.trim().length > 0 && !value.startsWith('-') && !Array.from(value).some((character) => character.charCodeAt(0) < 32))
      .optional()
      .describe('可选，源分支或提交；省略时：与 Lead 同一仓库时使用目标目录当前分支或提交；其他仓库优先使用该仓库的新任务源分支记忆，没有记忆再使用当前分支或提交。'),
  }).strict().optional()
    .describe('可选，为 Worker 新建自有 Git worktree，传 {} 使用默认源分支。仅支持本机有提交的 Git 项目；不支持 SSH 或 execution_device_id。working_dir 指定源项目，返回 working_dir 才是 Worker 实际目录。此选项按会话权限审批。归档 Worker 时按普通任务规则回收该 worktree，未提交改动先快照。'),
  execution_device_id: z.string().trim().min(1).max(128).optional()
    .describe('可选，运行设备：同账号另一台电脑的设备 id，只能取 get_workspace_info 返回的 execution_devices 中 supported=true 的 device_id。指定后 Worker 的任务、目录、命令与文件都在那台电脑；省略则与 Lead 同一台。那台离线、未开启远程控制或版本过旧时创建失败，不会回退到本机。'),
  agent_device_id: z.string().trim().min(1).max(128).optional()
    .describe('可选，Worker 的 Agent 位置：取 list_available_models 的 locations[].agent_device_id；"local" 为 Worker 工作电脑。指定 execution_device_id 时省略用那台的默认；否则优先使用适用的手工组合，没有适用记忆时跟 Lead。'),
}).strict();

export type CreateWorkerSpec = z.infer<typeof createWorkerSpecSchema>;

/** MCP payload 使用 snake_case，host 内部继续使用 camelCase。 */
export function toWorkerLimitPayload(limit: WorkerLimitSnapshot | undefined): Record<string, number> | undefined {
  if (!limit) return undefined;
  return {
    hard_limit: limit.workerHardLimit,
    occupied_slots: limit.occupiedSlots,
    remaining_slots: limit.remainingSlots,
  };
}

const DESCRIPTION = [
  '在当前 workflow 内创建新 worker session。',
  '注:create_worker 建的是 Orca worker(session 级、持久、UI 可见),不是 subagent。若用户要的是 subagent(一次性、用完即弃),请用你自己的原生 subagent 机制(如 Codex 的 spawn_agent、Claude Code 的 Task 工具),不要用 create_worker。' +
  'Orca worker 永远不是 subagent 的替代品;你没有原生 subagent 机制时,如实告知用户并请他决定,不要拿 worker 顶替。',
  '用户一次要求创建 2 个及以上 Worker 时必须改用 create_workers；不要并行或连续多次调用 create_worker。',
  '',
  '参数:',
  '- role: worker 角色 (developer / reviewer / tester / merger 或自定义 string)',
  '- agent: 可选 (codex / claude-code / pi)。不传按用户在创建 Worker 面板手工提交过的组合；没有适用记忆时需指定 agent。记忆整条不可用且未能确定 agent 时返回 INVALID_PARAMS，指定 agent 后重试即可。显式来源或位置完全禁用记忆，agent/model/effort/fast 都走原策略。',
  '- model: 可选，Worker 模型 id；不传优先使用适用的手工组合，否则走原默认策略。有适用的手工组合时，只传 model 可按目录推断 agent，歧义时须指定 agent；没有适用组合时需同时指定 agent。',
  '- provider_id: 可选, 模型来源 provider id。优先使用 list_available_models 对应模型返回的 provider_id；显式传入后 host 会严格校验该来源已连接且提供所选模型。',
  '- effort: 可选, reasoning/thinking 强度 (low / medium / high / xhigh / max / ultra)。Codex: 映射 OpenAI reasoning effort(max/ultra 仅部分模型如 GPT-5.6 Sol 支持); Claude Code: 映射 extended thinking token 预算(无 ultra,自动降级为 max)。显式传入时必须匹配所选 model 能力；当前 worker 模型都不把 minimal 作为可选思考档。',
  '- fast: 可选 boolean 或 "ultrafast"（仅支持该档位的 Codex 模型）, 是否给 worker 开启 Fast 模式 (更快输出)。用户明确说「fast / 快速 / 开/关 fast」时显式传。对 codex 与 pi worker 生效 (且需所选模型声明 supportsFastMode; 否则自动降级为关); claude-code worker 忽略此参数 (其 fast mode 在 agent 层为 no-op)。不传优先用适用的手工组合，否则按原策略用 New Maker 面板默认或 Lead 的 fastMode。',
  '- label: worker 短标识, 1-32 chars, 只能含字母、数字、-、_, 同 workflow 内唯一, 用于 switch_focus 定位',
  '- working_dir: 可选，Worker 所在主机上已存在的绝对目录。省略时继承 Lead 任务记录的工作目录（启动时的目录），不会跟随之后 cd 进入的 worktree。希望共用你当前的 worktree（含 git worktree add 自建的）时，请显式传其绝对路径；需要独立的新 worktree 时用 new_worktree。显式 working_dir / new_worktree 按会话权限审批。指定 execution_device_id 时目录属于那台电脑，省略由那台分配；校验失败不回退。',
  '- new_worktree: 可选对象，为 Worker 新建自有 worktree；source_branch 可省略，与 Lead 同一仓库时默认目标目录当前分支或提交，其他仓库优先使用该仓库的新任务源分支记忆，再回退当前分支或提交。仅本机有提交的 Git 项目可用；SSH / execution_device_id 不支持，对话 Lead 需显式指定其他项目。返回 working_dir 为实际启动目录，worktree 包含自有检出目录和新分支；worktree_source 返回实际源分支与记忆失效/读取失败时的回退原因。归档按普通任务规则回收，未提交改动先快照。',
  '- execution_device_id: 可选，运行设备(同账号另一台电脑)的 device_id，只能取 get_workspace_info 的 execution_devices 里 supported=true 的值；指定后 Worker 的任务、目录、命令与文件都在那台电脑，结果仍自动回报给你。用户没有要求放到别的电脑时不要传。',
  '- agent_device_id: 可选，Agent 使用哪台电脑的远程供应商；"local" 为 Worker 工作电脑。指定 execution_device_id 时先用同参数的 list_available_models 查 model / provider_id / locations；省略位置优先使用适用的手工组合，否则按原策略跟 Lead（运行设备使用工作电脑默认）。',
  "- initial_task: 可选, 创建后立即派给 worker 的第一条消息；dispatch_outcome.wakeKind=queued 表示首条任务已成功入队(此时回传 queued_message_id, 被消费前可用 get_worker_queue_status / update_queued_message / cancel_queued_message / merge_queued_messages 管理)；dispatch_outcome.kind='session-dispatch' 且 dispatched=false，或 kind='host-send' 且 accepted=false，表示 worker 已创建但首条任务未送达 / 派发失败",
  "- images: 可选, 随 initial_task 发的图片(最多 8 张, 仅本机 worker)。用户在对话里贴的图, 把上下文 <cindy-host-image-references> 里的 uri 原样传入; Lead 自己落盘的文件传本机绝对路径。",
  '',
  '【硬边界】',
  '- worker 数量达软上限 → 创建仍成功, payload.warning = WORKER_LIMIT_SOFT_EXCEEDED',
  '- worker 数量达硬上限 → 返 WORKER_LIMIT_HARD_EXCEEDED (拒绝创建)',
  '- label 在同 workflow 内重复 → 返 DUPLICATE_LABEL',
  '- 同 label 的另一个 Worker 正在创建 → 返 WORKER_CREATION_IN_PROGRESS',
  '- 当前 lead session 不存在或没有 active team → 返 NOT_FOUND',
  '- role / label / model 等参数不合法 → 返 INVALID_PARAMS',
  '- 选了 tier=budget (openai-codex/ 或 codex/ 前缀模型) 但当前 Codex 不在 API key 模式 → 返 BUDGET_MODEL_REQUIRES_API_MODE: 应如实告知用户「该模型需切换到 API key 模式才能使用」, 不要擅自改用官方版顶替 (除非用户明确同意)。',
  '- 该 agent 没有任何已连接的模型供应商 (provider) → 返 NO_PROVIDER_FOR_AGENT: 应如实把 message 转告用户 (去「设置 → 模型供应商」连接一个支持该 agent 的供应商), 或按 message 建议改用「已连接供应商的另一个 agent」创建 worker; 不要反复重试同一 agent。',
  '- Worker 解析出的精确 provider + model 路由当前不可用 → 返 PROVIDER_ROUTE_UNAVAILABLE: 应如实把 message 转告用户并调整模型或供应商; 不要按“完全没有供应商”处理，也不要反复重试同一路由。',
  '- 指定的运行设备或 agent_device_id 那台离线 / 未开启远程控制 → 返 REMOTE_AGENT_DEVICE_UNREACHABLE(分享来的供应商不可用 → REMOTE_AGENT_SHARE_*)；运行设备版本过旧 → 返 UNSUPPORTED_CAPABILITY。都不会改在本机创建：如实告知用户，由用户决定换设备或改在本机。',
].join('\n');

export function registerCreateWorkerTool(
  registry: XdtHelperToolRegistry,
  deps: CreateWorkerDeps,
): void {
  registry.register({
    name: 'create_worker',
    category: 'control',
    description: DESCRIPTION,
    inputShape: createWorkerSpecSchema.shape,
    handler: async ({ role, agent, model, provider_id, effort, fast, label, initial_task, images, working_dir, new_worktree, execution_device_id, agent_device_id }) => {
      const ctx = deps.getSessionContext?.() ?? deps;
      if (!ctx.sessionId) {
        return errorPayload('LEAD_NOT_SUPPORTED', '当前 session 类型不支持作为 Lead。');
      }
      if (ctx.vendorOptions?.orcaRole === 'worker') {
        return errorPayload(
          'WORKER_CANNOT_NEST',
          'create_worker 是 Orca Lead 创建 worker session 的入口,不是 subagent 入口。若用户明确要求 subagent / 子代理,请使用你自己的原生 subagent 机制(如 Codex 的 spawn_agent、Claude Code 的 Task/Agent 工具),不要使用 Orca create_worker / start_team。没有原生 subagent 机制时如实告知用户,Orca worker 不是它的替代品。',
        );
      }
      const result = await deps.createWorker({
        leadSessionId: ctx.sessionId,
        role,
        agent,
        model,
        providerId: provider_id,
        effort,
        fast,
        label,
        ...(working_dir !== undefined ? { workingDir: working_dir } : {}),
        ...(images ? { initialTaskImages: images } : {}),
        ...(new_worktree !== undefined ? { worktree: new_worktree.source_branch === undefined ? {} : { sourceBranch: new_worktree.source_branch } } : {}),
        ...(execution_device_id !== undefined ? { executionDeviceId: execution_device_id } : {}),
        ...toHostAgentDeviceId(agent_device_id),
        initialTask: initial_task,
      });
      if (!result.ok) {
        if (result.errorCode === 'HOST_NOT_READY') {
          return errorPayload('HOST_NOT_READY', `${BRAND_NAME} 主进程协同服务尚未就绪。`);
        }
        return errorPayload(result.errorCode, result.message, {
          ...(result.limit ? { limit: toWorkerLimitPayload(result.limit) } : {}),
        });
      }
      return okPayload({
        worker_id: result.workerId,
        worker_session_id: result.workerSessionId,
        ...(result.workingDir !== undefined ? { working_dir: result.workingDir } : {}),
        ...(result.worktree ? { worktree: result.worktree } : {}),
        role,
        ...workerCreationRoutePayload(result, agent),
        label,
        ...(result.dispatched !== undefined ? { dispatched: result.dispatched } : {}),
        ...(result.dispatchOutcome ? { dispatch_outcome: result.dispatchOutcome } : {}),
        ...(result.queuedMessageId ? { queued_message_id: result.queuedMessageId } : {}),
        ...(result.softLimitExceeded ? { warning: 'WORKER_LIMIT_SOFT_EXCEEDED' } : {}),
        ...(result.limit ? { limit: toWorkerLimitPayload(result.limit) } : {}),
      });
    },
  });
}

/** Both tools expose the host's actual route, never echo a guessed model or Agent. */
export function workerCreationRoutePayload(result: CreateWorkerSuccessData, requestedAgent?: ControlWorkerAgent) {
  return {
    agent: result.resolved?.agent ?? requestedAgent,
    ...(result.worktreeSource ? { worktree_source: { source_branch: result.worktreeSource.sourceBranch,
      source: result.worktreeSource.source,
      ...(result.worktreeSource.fallbackReason ? { fallback_reason: result.worktreeSource.fallbackReason } : {}) } } : {}),
    ...(result.resolved ? { model: result.resolved.model, provider_id: result.resolved.providerId,
      agent_device_id: result.resolved.agentDeviceId ?? LOCAL_AGENT_DEVICE,
      ...(result.resolved.remoteHostId ? { remote_host_id: result.resolved.remoteHostId } : {}),
      effort: result.resolved.effort, fast: result.resolved.fastMode } : {}),
    ...(result.executionDeviceId ? { execution_device_id: result.executionDeviceId } : {}),
    ...(result.defaults ? { defaults: { source: result.defaults.source,
      ...(result.defaults.fallbackReason ? { fallback_reason: result.defaults.fallbackReason } : {}) } } : {}),
  };
}
