/**
 * Cindy 记忆「需要时才整理」的触发点 (规则见 docs/product-rules/cindy-memory.md)。
 *
 * 不是定时任务: 只有任务在某一份记忆里写过东西, 才在这个任务**这一轮成功结束时**
 * 让 MakerMemoryManager 看一眼那一份到没到整理线 (索引接近上限, 或上次整理后改动
 * 攒够了)。没写过记忆的任务结束时什么都不做; 到线才调用一次辅助模型。
 *
 *  - 写入时只记下「哪个任务写了哪一份」, 不在工具调用途中整理 —— 模型可能还在连着写。
 *  - 伙伴的记忆不走这里: 伙伴项目有自己的记忆整理自动化, manager 对独立作用域直接返回不整理。
 *  - 记录带账号作用域: 换账号后旧任务的待检查项作废, 不拿新账号的同名路径去整理。
 *  - 整理在宿主后台进行, 不进任务对话, 失败只记日志 —— 记忆未改动, 下次再试。
 */
import type { MakerMemoryManager } from '@cindy/maker-core';

import { createLogger } from '../logger.js';

const log = createLogger('memory-tidy');

interface Pending {
  owner: string | null;
  getManager: () => MakerMemoryManager | undefined;
  storeKeys: Set<string>;
}

export function createMemoryTidyTrigger() {
  const pending = new Map<string, Pending>();
  return {
    /** 记忆工具写入成功后调用。没有任务 id (宿主内部调用) 时不记。 */
    noteWrite(
      sessionId: string | undefined,
      storeKey: string,
      getManager: () => MakerMemoryManager | undefined,
    ): void {
      if (!sessionId) return;
      const owner = getManager()?.currentOwnerScopeKey() ?? null;
      const entry = pending.get(sessionId);
      if (entry && entry.owner === owner) {
        entry.storeKeys.add(storeKey);
        return;
      }
      pending.set(sessionId, { owner, getManager, storeKeys: new Set([storeKey]) });
    },

    /** 任务一轮成功结束后调用。返回值只给测试等待用。 */
    async onTurnDone(sessionId: string): Promise<void> {
      const entry = pending.get(sessionId);
      if (!entry) return;
      pending.delete(sessionId);
      const manager = entry.getManager();
      if (!manager || manager.currentOwnerScopeKey() !== entry.owner) return;
      for (const storeKey of entry.storeKeys) {
        // 每次整理前都重新核对账号: 第一次等模型的时候切了账号, 后面的不能再按旧任务去整理新账号的记忆
        // (共享的管理器此时已经指向新账号, 同名的键会打开新账号的那一份)。
        if (manager.currentOwnerScopeKey() !== entry.owner) return;
        try {
          const outcome = await manager.tidy(storeKey, 'auto');
          if (outcome.status === 'failed') log.warn('memory tidy produced no usable plan');
        } catch {
          // 不带 error 文本: 里面可能有工作目录路径。
          log.warn('memory tidy did not complete');
        }
      }
    },
  };
}

export const memoryTidyTrigger = createMemoryTidyTrigger();
