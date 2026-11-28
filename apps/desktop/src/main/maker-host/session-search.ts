/**
 * apps/desktop/src/main/maker-host/session-search.ts
 *
 * Desktop 端 messages FTS5 搜索能力实现, 通过 cindy_memory MCP 的 session_search tool
 * 暴露给 LLM。数据源是 0017_add_messages_fts 创建的 messages_fts 虚拟表 (跟 messages
 * 表通过触发器同步; 0066 起仅索引 user / assistant / ask_user / plan_review 四类
 * role, tool_result / tool_use / thinking 等工具输出不进索引)。
 *
 * 跟 maker-core 的关系:
 *  - maker-core 完全不知道 messages 表存在 (那是 chat history 持久化, 不属于 memory 范畴)
 *  - host 在装配 cindy_memory provider 时把 searchSessions 函数注入, MCP server
 *    的 session_search tool 调用时 dispatch 到这里
 *
 * 失败原则:
 *  - DB 没就绪 (logout / 切账号 reset window) → 抛 Error, MCP server 翻成 INTERNAL
 *  - FTS5 query 语法错 → 静默返空, 让 LLM 改写 query 重试 (跟 memory_search 同策略)
 */

import type { SessionSearchOptions, SessionSearchHit, SessionSearchFn } from '@cindy/mcps';

import { getDeviceId } from '../authManager.js';
import { searchSessionsWithBotScopeCore } from './sessionSearchCore.js';

export const searchSessionsFn: SessionSearchFn = async (
  query: string,
  opts: SessionSearchOptions = {},
): Promise<SessionSearchHit[]> => searchSessionsWithBotScope(query, opts, { botAccountWide: false });

/**
 * `botAccountWide`：宿主已判定这是伙伴主任务里主人本人（或主人事先安排）的一轮，可以搜全部任务。
 * 其余伙伴调用只搜这个伙伴自己的会话与它开的后台任务。检索本身在 sessionSearchCore.ts。
 */
export async function searchSessionsWithBotScope(
  query: string,
  opts: SessionSearchOptions,
  scopeOptions: { botAccountWide: boolean },
): Promise<SessionSearchHit[]> {
  return searchSessionsWithBotScopeCore(query, opts, { ...scopeOptions, readDeviceId: getDeviceId });
}
