import type { Schedule, ScriptCapability } from '@cindy/maker-scheduler';

import { getGhostPipeDispatcher } from '../cindy-brain/index.js';
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
 * 飞书能力走 xd-feishu 意识 ghost pipe(2026-07-17 起,与 callJira 同套路):
 * 主机飞书 token 链已随 refresh-feishu 退役,工具真身与凭证(OAuth broker)
 * 都在意识侧。意识 call_tool 的交付形状是 { data } 包裹(超大结果为
 * saved_to / truncated 形态)——这里解开 data,保持脚本可见形状与老
 * registry 直调一致;非 data 形态原样透传(自带 hint,脚本能看懂)。
 */
async function callFeishu(name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await getGhostPipeDispatcher().callGhostTool({
    ghostId: 'xd-feishu',
    tool: 'call_tool',
    args: { name, args },
  });
  if (!result.ok) fail(result.errorCode, result.message);
  const payload = result.result as { data?: unknown } | null | undefined;
  return payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload;
}

async function callJira(args: Record<string, unknown>): Promise<unknown> {
  const result = await getGhostPipeDispatcher().callGhostTool({
    ghostId: 'xd-atlassian',
    tool: 'jira_issues',
    args,
  });
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
  { method: 'jira.get', capability: 'jira.read', params: '{issue_key, fields?}', description: '按 key 读单条 Jira issue' },
  { method: 'jira.search_jql', capability: 'jira.read', params: '{jql, fields?, max_results?≤100, next_page_token?}', description: 'JQL 搜索(大结果集用 next_page_token 分页)' },
  { method: 'jira.add_comment', capability: 'jira.comment', params: '{issue_key, body_text}', description: '向 Jira issue 添加评论' },
  { method: 'feishu.recent_chats', capability: 'feishu.read', params: '{count?≤50}', description: '按活跃时间倒序列最近飞书会话' },
  { method: 'feishu.recent_messages', capability: 'feishu.read', params: '{chat_id, count?≤50, start_time?}', description: '拉指定飞书会话最近消息(新→旧,start_time 增量)' },
  { method: 'sessions.dispatch', capability: 'sessions.dispatch', params: '{message, title?, target_session_id?}', description: '创建或唤醒 Cindy 会话并投递消息' },
];

/**
 * Narrow host capability broker for scheduler scripts. It maps stable script
 * methods to current host APIs and rejects every method/action not listed here.
 */
export class SchedulerScriptCapabilityBroker implements ScriptCapabilityBroker {
  constructor(private readonly deps: {
    resolveDefaultModelRoute?: (
      agent: Schedule['agentKind'],
      preferredProviderId?: string | null,
    ) => Promise<{ model: string; providerId: string } | null>;
  } = {}) {}

  async call(
    request: ScriptCapabilityCall,
    granted: ReadonlySet<ScriptCapability>,
    context: { schedule: Schedule },
  ): Promise<unknown> {
    const params = request.params;
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
        return callJira({
          action: 'get',
          issue_key: requireString(params, 'issue_key'),
          ...(fields ? { fields } : {}),
        });
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
        return callJira({
          action: 'search_jql',
          jql: requireString(params, 'jql'),
          ...(fields ? { fields } : {}),
          ...(maxResults === undefined ? {} : { max_results: maxResults }),
          // 大结果集意识侧会整包截断(deliver 50K chars),脚本靠分页拿全量。
          ...(nextPageToken === undefined ? {} : { next_page_token: nextPageToken }),
        });
      }
      case 'jira.add_comment':
        requireCapability(granted, 'jira.comment');
        return callJira({
          action: 'add_comment',
          issue_key: requireString(params, 'issue_key'),
          body_text: requireString(params, 'body_text'),
        });
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
        });
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
        });
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
