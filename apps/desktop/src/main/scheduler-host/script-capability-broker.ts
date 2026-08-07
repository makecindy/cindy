import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

import type { Schedule, ScriptCapability } from '@cindy/maker-scheduler';

import type { GhostToolCallResult } from '../../shared/ghost.js';
import { getGhostCardService, getGhostPipeDispatcher } from '../cindy-brain/index.js';
import { validateFsRelPath } from '../cindy-brain/fsSlot.js';
import { tryGetOrcaCollabService } from '../maker-ipc/register.js';
import type { ScriptCapabilityBroker, ScriptCapabilityCall } from './script-runner';
// model 兜底与 runner 同源(2026-06 曾因多份拷贝不同步导致 UI 显示与实跑模型不一致)
import { defaultModelFor } from './model-defaults.js';

type DispatchEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

interface BrokerError extends Error {
  code: string;
}

function fail(code: string, message: string): never {
  const error = new Error(message) as BrokerError;
  error.code = code;
  throw error;
}

function requireCapability(
  granted: ReadonlySet<ScriptCapability>,
  capability: ScriptCapability,
): void {
  if (!granted.has(capability)) fail('CAPABILITY_DENIED', `capability not granted: ${capability}`);
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_ARGS', `${key} is required`);
  return value;
}

function optionalStringArray(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail('INVALID_ARGS', `${key} must be a string array`);
  }
  return value as string[];
}

function rejectHostOwnedParams(params: Record<string, unknown>, keys: string[]): void {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      fail('INVALID_ARGS', `${key} is host-owned and cannot be set by scripts`);
    }
  }
}

/**
 * 脚本通道的意识调用包装(2026-08-04):自铸 callId 并向 cardService 登记
 * scriptWorkdir(= schedule.workingDir)——意识在调用内经 fs 槽 root:'workdir'
 * 泄洪落盘(如大结果 out_file)时,主机凭这个 callId 把写入钳在该目录内;
 * 交卷后 finalize 记账,条目随宽限窗+懒清扫失效(在途有效、用完即废,与
 * 会话通道同一本账)。不 finalize 的话条目永驻,callId 永久有效——绝不允许。
 *
 * active 登记簿(runId → 在途 callId):供 runner 在本轮 fire 终结(放弃等待
 * 在途调用)时按 run finalize——否则 runner 的 30s drain 截止后,调用要等
 * pipeDispatcher 超时(上限 GHOST_PIPE_CALL_MAX_TOTAL_MS = 30min)才交卷,
 * 这段 gap 里旧 callId 仍有写权而下一轮 fire 可能已开始(review P1)。
 * runId 缺省(非 runner 调用方)归入共享桶,保持原行为。
 */
async function callGhostForScript(
  request: { ghostId: string; tool: string; args: Record<string, unknown> },
  schedule: Pick<Schedule, 'workingDir'>,
  runId: string,
  active: Map<string, Set<string>>,
  writePath: string | null,
): Promise<GhostToolCallResult> {
  const callId = randomUUID();
  // 登记值与 script-runner 的 spawn cwd 严格同源(同一字符串,不 trim 改写):
  // POSIX 允许首尾空白的目录名,trim 后登记会让授权根与脚本实际 cwd 分叉
  // (review)。trim 只用于「全空白 = 未配置」判空;相对/畸形按 null 登记
  // (fs 槽会以「脚本通道未配置有效的工作目录」拒写,查询本身不受影响)。
  // writePath(= 脚本显式声明的 out_file)是唯一可写目标:只有显式带 out_file
  // 的调用才挂写窗,且 fs 槽只放行恰好等于它的路径——调用在途期间插件也
  // 写不了根内其它文件(经四轮 review 收敛的最小授权口径)。纯写方法
  // (add_comment)与无 out_file 契约的 feishu 方法传 null:不挂写窗;读调用
  // 不带 out_file 时若触发插件自动泄洪,只是回落 truncated,无回归。
  const rawWorkdir = typeof schedule.workingDir === 'string' ? schedule.workingDir : '';
  const scriptWorkdir = writePath !== null && rawWorkdir.trim() && isAbsolute(rawWorkdir) ? rawWorkdir : null;
  const cardService = getGhostCardService();
  cardService.registerCall(callId, {
    ghostId: request.ghostId,
    toolUseId: null,
    sessionId: null,
    scriptWorkdir,
    scriptWritePath: scriptWorkdir === null ? null : writePath,
    channel: 'script',
  });
  let bucket = active.get(runId);
  if (!bucket) {
    bucket = new Set();
    active.set(runId, bucket);
  }
  bucket.add(callId);
  try {
    return await getGhostPipeDispatcher().callGhostTool({ ...request, callId });
  } finally {
    bucket.delete(callId);
    if (bucket.size === 0) active.delete(runId);
    cardService.finalizeCall(callId);
  }
}

/**
 * out_file 可选参数校验:脚本指定的大结果落盘相对路径(相对 schedule 工作
 * 目录)。与 fs 槽同一口径(validateFsRelPath),拒绝原因原样回给脚本。
 */
function optionalOutFile(params: Record<string, unknown>): string | undefined {
  const value = params.out_file;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_ARGS', 'out_file must be a non-empty string');
  const reason = validateFsRelPath(value);
  if (reason) fail('INVALID_ARGS', `out_file ${reason}`);
  return value;
}

/**
 * 飞书能力走 xd-feishu 意识 ghost pipe(2026-07-17 起,与 callJira 同套路):
 * 主机飞书 token 链已随 refresh-feishu 退役,工具真身与凭证(OAuth broker)
 * 都在意识侧。意识 call_tool 的交付形状是 { data } 包裹(超大结果为
 * saved_to / truncated 形态)——这里解开 data,保持脚本可见形状与老
 * registry 直调一致;非 data 形态原样透传(自带 hint,脚本能看懂)。
 */
async function callFeishu(
  name: string,
  args: Record<string, unknown>,
  schedule: Pick<Schedule, 'workingDir'>,
  runId: string,
  active: Map<string, Set<string>>,
): Promise<unknown> {
  const result = await callGhostForScript(
    { ghostId: 'xd-feishu', tool: 'call_tool', args: { name, args } },
    schedule,
    runId,
    active,
    // feishu 方法没有 out_file 契约,不挂写窗(收窄口径见 callGhostForScript
    // 头注释;插件若自动泄洪会回落 truncated,与未挂写窗前的行为一致)。
    null,
  );
  if (!result.ok) fail(result.errorCode, result.message);
  const payload = result.result as { data?: unknown } | null | undefined;
  return payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload;
}

async function callJira(
  args: Record<string, unknown>,
  schedule: Pick<Schedule, 'workingDir'>,
  runId: string,
  active: Map<string, Set<string>>,
  writePath: string | null,
): Promise<unknown> {
  const result = await callGhostForScript(
    { ghostId: 'xd-atlassian', tool: 'jira_issues', args },
    schedule,
    runId,
    active,
    writePath,
  );
  if (!result.ok) fail(result.errorCode, result.message);
  return result.result;
}

/**
 * 方法目录(单一来源):host.capabilities 的自省输出,脚本靠它"先发现再调用"。
 * 新增方法时同步补一行——目录漏登记 = 脚本发现不了(broker case 才是执行真身)。
 */
const SCRIPT_METHOD_CATALOG: ReadonlyArray<{
  method: string;
  capability: ScriptCapability | null;
  params: string;
  description: string;
}> = [
  { method: 'host.capabilities', capability: null, params: '{}', description: '自省:返回协议版本、本任务已授予的能力、可用方法目录' },
  { method: 'jira.get', capability: 'jira.read', params: '{issue_key, fields?, out_file?}', description: '按 key 读单条 Jira issue(out_file = 结果落盘到工作目录的相对路径)' },
  { method: 'jira.search_jql', capability: 'jira.read', params: '{jql, fields?, max_results?≤100, next_page_token?, out_file?}', description: 'JQL 搜索(大结果集用 next_page_token 分页,或 out_file 落盘后自行读回)' },
  { method: 'jira.add_comment', capability: 'jira.comment', params: '{issue_key, body_text | body_adf}', description: '向 Jira issue 添加评论;body_text 纯文本与 body_adf(ADF 文档对象,支持 @mention)恰好二选一' },
  { method: 'feishu.recent_chats', capability: 'feishu.read', params: '{count?≤50}', description: '按活跃时间倒序列最近飞书会话' },
  { method: 'feishu.recent_messages', capability: 'feishu.read', params: '{chat_id, count?≤50, start_time?}', description: '拉指定飞书会话最近消息(新→旧,start_time 增量)' },
  { method: 'sessions.dispatch', capability: 'sessions.dispatch', params: '{message, title?, target_session_id?}', description: '创建或唤醒 Cindy 会话并投递消息' },
];

/**
 * Narrow host capability broker for scheduler scripts. It maps stable script
 * methods to current host APIs and rejects every method/action not listed here.
 */
export class SchedulerScriptCapabilityBroker implements ScriptCapabilityBroker {
  /** 在途脚本通道调用登记簿:runId → callId 集(runner 按 run 收口用)。 */
  private readonly activeScriptCallIds = new Map<string, Set<string>>();

  constructor(private readonly deps: {
    resolveDefaultModelRoute?: (
      agent: Schedule['agentKind'],
      preferredProviderId?: string | null,
    ) => Promise<{ model: string; providerId: string } | null>;
  } = {}) {}

  /**
   * runner 判定本轮 fire 终结(drain 截止/abort/超时放弃等待在途调用)时调用:
   * 让**本 run** 的残留脚本通道 callId 立即失去写盘授权,不等 pipeDispatcher
   * 超时(上限 30min)——runId 维度隔离:broker 是单例而 scheduler 可并发跑
   * 多个 schedule(DEFAULT_MAX_CONCURRENT_RUNS=8),误清并发 run 的在途 callId
   * 会把别家插件的合法写盘拒成「已过期」(review P1 第二轮)。
   * cardService.finalizeCall 幂等:被提前 finalize 的调用之后正常交卷不受影响
   * (dispatcher 配对账本独立)。
   */
  finalizeActiveCalls(runId: string): void {
    const bucket = this.activeScriptCallIds.get(runId);
    if (!bucket || bucket.size === 0) return;
    const cardService = getGhostCardService();
    for (const callId of bucket) cardService.finalizeCall(callId);
    this.activeScriptCallIds.delete(runId);
  }

  async call(
    request: ScriptCapabilityCall,
    granted: ReadonlySet<ScriptCapability>,
    context: { schedule: Schedule; runId?: string },
  ): Promise<unknown> {
    const params = request.params;
    // runId 维度隔离:scheduler 并发跑多个 schedule 时,broker 单例的在途
    // 登记簿按 run 分桶,finalizeActiveCalls 只收本 run(缺省进共享桶)。
    const runId = context.runId ?? '';
    switch (request.method) {
      case 'host.capabilities':
        // 元方法,免授权(纯自省、无副作用、不触达外部系统):脚本先 list 再决定怎么 call。
        return {
          protocol: 'cindy-script/1',
          granted: [...granted].sort(),
          methods: SCRIPT_METHOD_CATALOG.map((entry) => ({
            ...entry,
            available: entry.capability === null || granted.has(entry.capability),
          })),
        };
      case 'jira.get': {
        requireCapability(granted, 'jira.read');
        const fields = optionalStringArray(params, 'fields');
        const outFile = optionalOutFile(params);
        return callJira({
          action: 'get',
          issue_key: requireString(params, 'issue_key'),
          ...(fields ? { fields } : {}),
          ...(outFile ? { out_file: outFile } : {}),
        }, context.schedule, runId, this.activeScriptCallIds, outFile ?? null);
      }
      case 'jira.search_jql': {
        requireCapability(granted, 'jira.read');
        const maxResults = params.max_results;
        if (
          maxResults !== undefined &&
          (typeof maxResults !== 'number' || !Number.isInteger(maxResults) || maxResults <= 0 || maxResults > 100)
        ) {
          fail('INVALID_ARGS', 'max_results must be an integer between 1 and 100');
        }
        const nextPageToken = params.next_page_token;
        if (nextPageToken !== undefined && (typeof nextPageToken !== 'string' || !nextPageToken.trim())) {
          fail('INVALID_ARGS', 'next_page_token must be a non-empty string');
        }
        const fields = optionalStringArray(params, 'fields');
        const outFile = optionalOutFile(params);
        return callJira({
          action: 'search_jql',
          jql: requireString(params, 'jql'),
          ...(fields ? { fields } : {}),
          ...(maxResults === undefined ? {} : { max_results: maxResults }),
          // 大结果集意识侧会整包截断(deliver 50K chars),脚本靠分页拿全量;
          // 或传 out_file 让意识把整包落盘到 schedule 工作目录,脚本自己读回。
          ...(nextPageToken === undefined ? {} : { next_page_token: nextPageToken }),
          ...(outFile ? { out_file: outFile } : {}),
        }, context.schedule, runId, this.activeScriptCallIds, outFile ?? null);
      }
      case 'jira.add_comment': {
        requireCapability(granted, 'jira.comment');
        const issueKey = requireString(params, 'issue_key');
        // body_text / body_adf 恰好二选一。body_adf 校验「非 null、非数组的
        // object」:经 JSONL 协议到达的 object 必为 plain object(JSON.parse
        // 产物,Date/Map/class 实例穿不过协议边界),无需更严;文档结构由
        // Jira 侧把关(下游 xd-atlassian add_comment 本就支持 body_adf)。
        const hasBodyText = params.body_text !== undefined;
        const hasBodyAdf = params.body_adf !== undefined;
        if (hasBodyText === hasBodyAdf) {
          fail('INVALID_ARGS', 'provide exactly one of body_text or body_adf (both or neither given)');
        }
        if (hasBodyAdf) {
          const bodyAdf = params.body_adf;
          if (typeof bodyAdf !== 'object' || bodyAdf === null || Array.isArray(bodyAdf)) {
            fail('INVALID_ARGS', 'body_adf must be an ADF document object');
          }
          return callJira({ action: 'add_comment', issue_key: issueKey, body_adf: bodyAdf }, context.schedule, runId, this.activeScriptCallIds, null);
        }
        return callJira({
          action: 'add_comment',
          issue_key: issueKey,
          body_text: requireString(params, 'body_text'),
        }, context.schedule, runId, this.activeScriptCallIds, null);
      }
      case 'feishu.recent_chats': {
        // 按活跃时间倒序列最近会话(群/单聊)。配合 feishu.recent_messages 的
        // start_time 可拼出"扫最近发给我的任意新消息"的 bot 入口轮询:
        // recent_chats → 逐会话增量拉取 → 本地游标去重 → 匹配关键指令。
        requireCapability(granted, 'feishu.read');
        const chatCount = params.count;
        if (
          chatCount !== undefined &&
          (typeof chatCount !== 'number' || !Number.isInteger(chatCount) || chatCount <= 0 || chatCount > 50)
        ) {
          fail('INVALID_ARGS', 'count must be an integer between 1 and 50');
        }
        return callFeishu('im_list_chats', {
          sort_type: 'ByActiveTimeDesc',
          page_size: chatCount ?? 20,
        }, context.schedule, runId, this.activeScriptCallIds);
      }
      case 'feishu.recent_messages': {
        // 拉某个飞书会话(群/单聊)最近 N 条消息,新→旧;实现走 xd-feishu 意识
        // 的 im_read_messages(含 sender_name 解析),供轮询型脚本按消息驱动后续动作。
        requireCapability(granted, 'feishu.read');
        const count = params.count;
        if (
          count !== undefined &&
          (typeof count !== 'number' || !Number.isInteger(count) || count <= 0 || count > 50)
        ) {
          fail('INVALID_ARGS', 'count must be an integer between 1 and 50');
        }
        const startTime = params.start_time;
        if (startTime !== undefined && typeof startTime !== 'string' && typeof startTime !== 'number') {
          fail('INVALID_ARGS', 'start_time must be a Unix timestamp or ISO string');
        }
        return callFeishu('im_read_messages', {
          container_id: requireString(params, 'chat_id'),
          ...(count === undefined ? {} : { page_size: count }),
          // 增量扫描游标:只取该时刻之后的消息(配本地已处理游标去重)
          ...(startTime === undefined ? {} : { start_time: String(startTime) }),
        }, context.schedule, runId, this.activeScriptCallIds);
      }
      case 'sessions.dispatch': {
        requireCapability(granted, 'sessions.dispatch');
        rejectHostOwnedParams(params, [
          'agent_kind',
          'dispatcher_session_id',
          'effort',
          'fast_mode',
          'model',
          'permission_mode',
          'provider_id',
          'use_worktree',
          'working_dir',
        ]);
        const service = tryGetOrcaCollabService();
        if (!service) fail('HOST_NOT_READY', 'session dispatch service is not ready');
        const schedule = context.schedule;
        const explicitProviderId = schedule.providerId?.trim() || null;
        const dynamicDefaultRoute = !schedule.model?.trim() && schedule.agentKind === 'pi'
          ? await this.deps.resolveDefaultModelRoute?.(
              schedule.agentKind,
              explicitProviderId,
            ) ?? null
          : null;
        const model = schedule.model?.trim()
          || dynamicDefaultRoute?.model
          || defaultModelFor(schedule.agentKind);
        if (!model) fail('PRECONDITION_FAILED', 'Pi has no connected model source');
        const result = await service.sendToSession({
          targetSessionId:
            typeof params.target_session_id === 'string' && params.target_session_id.trim()
              ? params.target_session_id
              : undefined,
          message: requireString(params, 'message'),
          title: typeof params.title === 'string' ? params.title : undefined,
          useWorktree: false,
          createDefaults: {
            agentKind: schedule.agentKind,
            model,
            providerId: explicitProviderId ?? dynamicDefaultRoute?.providerId ?? null,
            effort: schedule.effort as DispatchEffort | undefined,
            fastMode: !!schedule.fastMode,
            workingDir: schedule.workingDir ?? '',
            workspaceKind: 'project',
            permissionMode: 'bypassPermissions',
          },
        });
        if (!result.ok) fail(result.errorCode, result.message);
        return {
          target_session_id: result.targetSessionId,
          agent_kind: result.agentKind,
          wake_kind: result.wakeKind,
          target_title: result.targetTitle,
          target_last_user_send_at: result.targetLastUserSendAt,
          worktree_path: result.worktreePath,
        };
      }
      default:
        fail('METHOD_NOT_FOUND', `script capability method not available: ${request.method}`);
    }
  }
}
