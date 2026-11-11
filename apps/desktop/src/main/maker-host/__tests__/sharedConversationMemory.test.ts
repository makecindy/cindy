/**
 * 对话里别人也能说话的任务, 启动时不带主人账号级记忆的索引
 * (docs/product-rules/cindy-memory.md §7)。
 *
 * 入口: 任务启动钩子里的这一步, 对着真的 MakerMemoryManager (真文件、真 sqlite)。
 * 保护的规则: 登记过的任务拿到的索引快照里没有账号级记忆的标题和摘要; 没登记的任务、
 * 伙伴任务不受影响; 取不到索引时给空快照, 不回落到完整索引。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import DatabaseCtor from 'better-sqlite3';
import { MakerMemoryManager, USER_MEMORY_SCOPE_KEY, type Logger } from '@cindy/maker-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  withholdAccountMemoryIndexInSharedConversation,
  type SharedConversationMemoryOpts,
} from '../shared-conversation-memory.js';

vi.setConfig({ testTimeout: process.platform === 'win32' ? 30_000 : 5_000 });

const noopLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

describe('withholdAccountMemoryIndexInSharedConversation', () => {
  let root: string;
  let manager: MakerMemoryManager;
  const workingDir = path.join(path.sep, 'memory-shared', 'project');
  const entry = (type: 'user' | 'project', name: string) => ({
    type, name, title: `title ${name}`, description: `about ${name}`, body: `body of ${name}`,
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'shared-conversation-memory-'));
    manager = new MakerMemoryManager({
      basePath: root,
      sqliteFactory: (file) => new DatabaseCtor(file),
      agents: {},
      logger: noopLogger,
      initialEnabled: true,
    });
    await manager.write(USER_MEMORY_SCOPE_KEY, entry('user', 'home-address'));
    await manager.write(workingDir, entry('project', 'arch'));
  });
  afterEach(async () => {
    manager.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  });

  const run = async (opts: SharedConversationMemoryOpts, shared: boolean, source = manager) => {
    const warn = vi.fn();
    await withholdAccountMemoryIndexInSharedConversation('task-1', opts, {
      isSharedSession: () => shared,
      manager: source,
      warn,
    });
    return warn;
  };

  it('gives a shared conversation the project index and no account memory titles', async () => {
    const opts: SharedConversationMemoryOpts = { workingDir };
    await run(opts, true);

    expect(opts.makerMemoryIndexSnapshot).toContain('[project_arch.md]');
    expect(opts.makerMemoryIndexSnapshot).not.toContain('home-address');
    expect(opts.makerMemoryIndexSnapshot).toContain('memory_list');
  });

  it('leaves the owner\'s own tasks to load the full index as before', async () => {
    const opts: SharedConversationMemoryOpts = { workingDir };
    await run(opts, false);
    expect(opts.makerMemoryIndexSnapshot).toBeUndefined();
  });

  it('does not touch a teammate task, which carries its own memory', async () => {
    const withSnapshot: SharedConversationMemoryOpts = { workingDir, makerMemoryIndexSnapshot: 'teammate memory' };
    await run(withSnapshot, true);
    expect(withSnapshot.makerMemoryIndexSnapshot).toBe('teammate memory');

    const botScope: SharedConversationMemoryOpts = { workingDir, makerMemoryScopeKey: 'bot:helper' };
    await run(botScope, true);
    expect(botScope.makerMemoryIndexSnapshot).toBeUndefined();
  });

  it('starts with an empty index, not the full one, when the index cannot be read', async () => {
    const opts: SharedConversationMemoryOpts = { workingDir };
    const warn = await run(opts, true, {
      getPromptIndex: async () => { throw new Error('memory:not-ready'); },
    } as unknown as MakerMemoryManager);

    expect(opts.makerMemoryIndexSnapshot).toBe('');
    expect(warn).toHaveBeenCalledOnce();
  });
});
