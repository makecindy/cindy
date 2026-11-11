/**
 * 对话里别人也能说话的任务 (群聊等), 启动时不把主人账号级记忆的索引写进系统提示词
 * (docs/product-rules/cindy-memory.md §7)。
 *
 * 索引是随任务启动写进提示词的, 之后每一轮都看得见 —— 包括访客发起的轮次; 逐轮的权限
 * 策略管不到它。所以在任务启动这一处决定: 登记过「别人也能说话」的任务, 账号级那一份
 * 只留一句说明, 项目那一份照常。记忆本身仍可用工具读写 (访客轮次要主人确认)。
 *
 * 所有启动入口 (渠道、桌面端接着聊、定时任务、重启恢复) 都经过 maker-host 的启动钩子,
 * 这里是它调用的那一步。
 */

import { resolveMemoryScopeKey, type MakerMemoryManager } from '@cindy/maker-core';

export interface SharedConversationMemoryOpts {
  workingDir?: string;
  remoteHostId?: string | null;
  makerMemoryScopeKey?: string;
  makerMemoryIndexSnapshot?: string;
}

export async function withholdAccountMemoryIndexInSharedConversation(
  sessionId: string,
  opts: SharedConversationMemoryOpts,
  deps: {
    isSharedSession(sessionId: string): boolean;
    manager: Pick<MakerMemoryManager, 'getPromptIndex'>;
    warn(message: string, fields?: Record<string, unknown>): void;
  },
): Promise<void> {
  // 已经给了快照的 (伙伴用自己的记忆) 不动; 伙伴的记忆不是账号级记忆。
  if (opts.makerMemoryIndexSnapshot !== undefined) return;
  if (opts.makerMemoryScopeKey?.startsWith('bot:')) return;
  if (!opts.workingDir || !deps.isSharedSession(sessionId)) return;
  try {
    const scopeKey = opts.makerMemoryScopeKey
      ?? await resolveMemoryScopeKey(opts.workingDir, opts.remoteHostId ?? undefined);
    opts.makerMemoryIndexSnapshot = await deps.manager.getPromptIndex(scopeKey, { withholdUser: true });
  } catch (error) {
    // 取不到 (记忆已关闭、账号正在切换): 给空快照, 不能让引擎回落去读完整的索引。
    opts.makerMemoryIndexSnapshot = '';
    deps.warn('shared conversation memory index unavailable; starting without an index', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
