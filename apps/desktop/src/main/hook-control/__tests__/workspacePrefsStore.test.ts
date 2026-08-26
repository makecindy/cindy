/**
 * 目录会话偏好(本机正本)的行为锁：键语义、迁移一次性导入、派发取值合并。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../im/ownerScopedStorage.js', () => ({
  ownerScopedImUserDataPath: (...parts: string[]) => path.join(tmp.dir, ...parts),
}));

import {
  getWorkspacePref,
  importWorkspacePrefsIfNeeded,
  isWorkspacePrefsMigrated,
  listWorkspacePrefs,
  replaceChannelWorkspacePrefs,
  resolveWorkspacePrefOverrides,
  setWorkspacePref,
} from '../workspacePrefsStore';

describe('workspacePrefsStore', () => {
  beforeEach(() => {
    tmp.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wprefs-'));
  });
  afterEach(() => {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('写读一条偏好；不同渠道/目录互不串', () => {
    setWorkspacePref('slack', null, 'chat', { model: 'claude-opus-4-8', agentKind: 'claude-code' });
    setWorkspacePref('telegram', null, 'chat', { model: 'gpt-5.5', agentKind: 'codex' });
    expect(getWorkspacePref('slack', null, 'chat').model).toBe('claude-opus-4-8');
    expect(getWorkspacePref('telegram', null, 'chat').model).toBe('gpt-5.5');
    expect(getWorkspacePref('slack', null, 'repo').model).toBeNull();
  });

  it('teamId 精确匹配优先，null 行兜底', () => {
    setWorkspacePref('slack', null, 'repo', { model: 'sonnet' });
    setWorkspacePref('slack', 'T1', 'repo', { model: 'opus' });
    expect(getWorkspacePref('slack', 'T1', 'repo').model).toBe('opus');
    expect(getWorkspacePref('slack', 'T2', 'repo').model).toBe('sonnet');
  });

  it('四个字段都清空则删除条目', () => {
    setWorkspacePref('x', null, 'chat', { model: 'grok-4', agentKind: 'pi' });
    setWorkspacePref('x', null, 'chat', {
      model: null,
      agentKind: null,
      effort: null,
      permissionMode: null,
    });
    expect(listWorkspacePrefs('x')).toEqual([]);
  });

  it('未迁移且本地为空时导入 server 快照；已有本地写入不覆盖', () => {
    importWorkspacePrefsIfNeeded('slack', [
      {
        workspace: 'chat',
        model: 'from-server',
        effort: null,
        agentKind: 'claude-code',
        permissionMode: null,
      },
    ]);
    expect(isWorkspacePrefsMigrated('slack')).toBe(true);
    expect(getWorkspacePref('slack', null, 'chat').model).toBe('from-server');

    setWorkspacePref('telegram', null, 'chat', { model: 'local-first' });
    importWorkspacePrefsIfNeeded('telegram', [
      {
        workspace: 'chat',
        model: 'from-server',
        effort: null,
        agentKind: null,
        permissionMode: null,
      },
    ]);
    expect(getWorkspacePref('telegram', null, 'chat').model).toBe('local-first');
    expect(isWorkspacePrefsMigrated('telegram')).toBe(true);
  });

  it('replaceChannel 只替换该渠道，并丢掉空白/非法别名', () => {
    setWorkspacePref('slack', null, 'keep-me', { model: 'slack-old' });
    setWorkspacePref('x', null, 'chat', { model: 'x-keep' });
    replaceChannelWorkspacePrefs('slack', [
      {
        workspace: 'chat',
        model: 'slack-new',
        effort: null,
        agentKind: null,
        permissionMode: null,
      },
      {
        workspace: 'bad alias!',
        model: 'nope',
        effort: null,
        agentKind: null,
        permissionMode: null,
      },
      { workspace: 'empty', model: null, effort: null, agentKind: null, permissionMode: null },
    ]);
    expect(listWorkspacePrefs('slack').map((e) => e.workspace)).toEqual(['chat']);
    expect(getWorkspacePref('x', null, 'chat').model).toBe('x-keep');
  });

  it('损坏文件宽容为空表', () => {
    fs.writeFileSync(path.join(tmp.dir, 'hook-workspace-prefs.json'), '{broken');
    expect(listWorkspacePrefs('slack')).toEqual([]);
    setWorkspacePref('slack', null, 'chat', { model: 'ok' });
    expect(getWorkspacePref('slack', null, 'chat').model).toBe('ok');
  });
});

describe('resolveWorkspacePrefOverrides', () => {
  const dispatched = {
    agentKind: 'codex',
    model: 'gpt-5.5',
    effort: 'low',
    permissionMode: 'ask',
  };

  it('本机显式字段压过 dispatch', () => {
    expect(
      resolveWorkspacePrefOverrides(
        {
          workspace: 'chat',
          model: 'opus',
          effort: null,
          agentKind: 'claude-code',
          permissionMode: null,
        },
        dispatched,
        true,
      ),
    ).toEqual({
      agentKind: 'claude-code',
      model: 'opus',
      effort: null,
      permissionMode: null,
    });
  });

  it('迁完之后 null 不再回落 dispatch', () => {
    expect(
      resolveWorkspacePrefOverrides(
        {
          workspace: 'chat',
          model: null,
          effort: null,
          agentKind: null,
          permissionMode: null,
        },
        dispatched,
        true,
      ),
    ).toEqual({
      agentKind: null,
      model: null,
      effort: null,
      permissionMode: null,
    });
  });

  it('尚未迁移时允许沿用 dispatch（升级窗口）', () => {
    expect(resolveWorkspacePrefOverrides(null, dispatched, false)).toEqual(dispatched);
  });
});
