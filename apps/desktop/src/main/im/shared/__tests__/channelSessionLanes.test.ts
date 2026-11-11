/**
 * 「这段对话里别人也能说话」的登记 (docs/product-rules/cindy-memory.md §7)。
 *
 * 保护的规则: 登记过的任务启动时不带主人账号级记忆的索引。判定必须跨应用重启成立 ——
 * 重启后主人从桌面端接着聊会重新启动任务, 那时渠道还没有新消息可供判断。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../../ownerContext.js', async () => {
  const nodePath = await import('node:path');
  return {
    ownerScopedPath: (...parts: string[]): string => {
      if (!state.dir) throw new Error('owner context not configured');
      return nodePath.join(state.dir, ...parts);
    },
  };
});

const {
  forgetNotedChannelSessionsForTest,
  isSharedChannelSession,
  isSharedChannelTurn,
  noteSharedChannelSession,
} = await import('../channelSessionLanes');

describe('channel shared sessions', () => {
  beforeEach(() => {
    state.dir = mkdtempSync(path.join(os.tmpdir(), 'cindy-shared-sessions-'));
    forgetNotedChannelSessionsForTest();
  });
  afterEach(() => {
    rmSync(state.dir, { recursive: true, force: true });
    state.dir = '';
  });

  it('counts a group chat, and a turn started by someone other than the owner, as shared', () => {
    expect(isSharedChannelTurn({ channelNoteSource: { chatKind: 'group' } })).toBe(true);
    expect(isSharedChannelTurn({ messageOrigin: { chat: { kind: 'group' } } })).toBe(true);
    // 主人在群里发的一轮: 对话仍然是别人也能说话的。
    expect(isSharedChannelTurn({
      turnPermissionPolicy: { autoReviewContext: { requesterAuthority: 'owner', source: 'group' } },
    })).toBe(true);
    expect(isSharedChannelTurn({
      turnPermissionPolicy: { autoReviewContext: { requesterAuthority: 'guest', source: 'direct' } },
    })).toBe(true);
  });

  it('leaves the owner\'s private chat, and a private chat with an unverified sender, unshared', () => {
    expect(isSharedChannelTurn({})).toBe(false);
    expect(isSharedChannelTurn({ channelNoteSource: { chatKind: 'direct' } })).toBe(false);
    expect(isSharedChannelTurn({
      turnPermissionPolicy: { autoReviewContext: { requesterAuthority: 'unknown', source: 'direct' } },
    })).toBe(false);
  });

  it('keeps the mark across an app restart', () => {
    expect(isSharedChannelSession('group-task')).toBe(false);
    noteSharedChannelSession('group-task');
    expect(isSharedChannelSession('group-task')).toBe(true);

    forgetNotedChannelSessionsForTest();

    expect(isSharedChannelSession('group-task')).toBe(true);
    expect(isSharedChannelSession('owner-dm-task')).toBe(false);
  });

  it('holds within the running app when the mark cannot be saved', () => {
    state.dir = '';
    noteSharedChannelSession('group-task');
    expect(isSharedChannelSession('group-task')).toBe(true);
  });

  it('still marks a task in the running app when the saved file is damaged, and leaves that file alone', () => {
    const file = path.join(state.dir, 'channel-shared-sessions.json');
    writeFileSync(file, '{ not json', 'utf8');

    noteSharedChannelSession('group-task');

    expect(isSharedChannelSession('group-task')).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('{ not json');
  });

  it('withholds while the account folder is not available yet', () => {
    state.dir = '';
    expect(isSharedChannelSession('any-task')).toBe(true);
  });
});
