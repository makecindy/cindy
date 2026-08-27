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
  applyIncomingServerWorkspacePrefs,
  getWorkspacePref,
  importWorkspacePrefsIfNeeded,
  isWorkspacePrefsMigrated,
  listWorkspacePrefs,
  markWorkspacePrefMirrored,
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

  it('新建 team 专属行时从 null 兜底继承未改字段', () => {
    setWorkspacePref('slack', null, 'repo', { model: 'sonnet', agentKind: 'claude-code' });
    setWorkspacePref('slack', 'T1', 'repo', { model: 'opus' });
    expect(getWorkspacePref('slack', 'T1', 'repo')).toMatchObject({
      model: 'opus',
      agentKind: 'claude-code',
    });
    expect(getWorkspacePref('slack', null, 'repo')).toMatchObject({
      model: 'sonnet',
      agentKind: 'claude-code',
    });
  });

  it('四个字段都清空则保留墓碑，不丢键', () => {
    setWorkspacePref('x', null, 'chat', { model: 'grok-4', agentKind: 'pi' });
    setWorkspacePref('x', null, 'chat', {
      model: null,
      agentKind: null,
      effort: null,
      permissionMode: null,
    });
    expect(listWorkspacePrefs('x')).toEqual([
      {
        workspace: 'chat',
        model: null,
        effort: null,
        agentKind: null,
        permissionMode: null,
        teamId: null,
      },
    ]);
  });

  it('未迁移时按目录合并：本地已写的键保留，其它目录仍从 server 补进', () => {
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
      {
        workspace: 'repo',
        model: 'server-repo',
        effort: null,
        agentKind: 'codex',
        permissionMode: null,
      },
    ]);
    expect(getWorkspacePref('telegram', null, 'chat').model).toBe('local-first');
    expect(getWorkspacePref('telegram', null, 'repo').model).toBe('server-repo');
    expect(isWorkspacePrefsMigrated('telegram')).toBe(true);
  });

  it('server 全量快照不复活本机墓碑，也不丢掉未镜像的本机实值', () => {
    setWorkspacePref('slack', null, 'chat', { model: 'local-chat' });
    setWorkspacePref('slack', null, 'repo', {
      model: null,
      effort: null,
      agentKind: null,
      permissionMode: null,
    });
    applyIncomingServerWorkspacePrefs('slack', [
      {
        workspace: 'repo',
        model: 'resurrect-me',
        effort: null,
        agentKind: 'claude-code',
        permissionMode: null,
      },
      {
        workspace: 'other',
        model: 'from-card',
        effort: null,
        agentKind: 'codex',
        permissionMode: null,
      },
    ]);
    expect(getWorkspacePref('slack', null, 'repo').model).toBeNull();
    expect(getWorkspacePref('slack', null, 'chat').model).toBe('local-chat');
    expect(getWorkspacePref('slack', null, 'other').model).toBe('from-card');
  });

  it('过期镜像回执不能清掉更新的墓碑', () => {
    const live = setWorkspacePref('slack', null, 'chat', { model: 'opus' });
    const cleared = setWorkspacePref('slack', null, 'chat', {
      model: null,
      effort: null,
      agentKind: null,
      permissionMode: null,
    });
    markWorkspacePrefMirrored('slack', null, 'chat', live.rev);
    expect(listWorkspacePrefs('slack')).toEqual([
      {
        workspace: 'chat',
        model: null,
        effort: null,
        agentKind: null,
        permissionMode: null,
        teamId: null,
      },
    ]);
    markWorkspacePrefMirrored('slack', null, 'chat', cleared.rev);
    expect(listWorkspacePrefs('slack')).toEqual([]);
  });

  it('镜像确认后丢掉墓碑，后续卡片写入可以进本机', () => {
    const written = setWorkspacePref('slack', null, 'repo', {
      model: null,
      effort: null,
      agentKind: null,
      permissionMode: null,
    });
    expect(listWorkspacePrefs('slack').map((e) => e.workspace)).toEqual(['repo']);
    markWorkspacePrefMirrored('slack', null, 'repo', written.rev);
    expect(listWorkspacePrefs('slack')).toEqual([]);

    applyIncomingServerWorkspacePrefs('slack', [
      {
        workspace: 'repo',
        model: 'from-card',
        effort: null,
        agentKind: 'claude-code',
        permissionMode: null,
      },
    ]);
    expect(getWorkspacePref('slack', null, 'repo').model).toBe('from-card');
  });

  it('快照已无该键时也丢掉墓碑（删除已在 server 落地）', () => {
    setWorkspacePref('slack', null, 'repo', {
      model: null,
      effort: null,
      agentKind: null,
      permissionMode: null,
    });
    setWorkspacePref('slack', null, 'chat', { model: 'keep-me' });
    applyIncomingServerWorkspacePrefs('slack', [
      {
        workspace: 'chat',
        model: 'keep-me',
        effort: null,
        agentKind: null,
        permissionMode: null,
      },
    ]);
    expect(listWorkspacePrefs('slack').map((e) => e.workspace)).toEqual(['chat']);
    applyIncomingServerWorkspacePrefs('slack', [
      {
        workspace: 'repo',
        model: 'from-card',
        effort: null,
        agentKind: null,
        permissionMode: null,
      },
      {
        workspace: 'chat',
        model: 'keep-me',
        effort: null,
        agentKind: null,
        permissionMode: null,
      },
    ]);
    expect(getWorkspacePref('slack', null, 'repo').model).toBe('from-card');
  });

  it('全量快照含同一键时，未镜像实值仍保留，不被 server 旧值盖掉', () => {
    setWorkspacePref('slack', null, 'chat', { model: 'offline-edit' });
    applyIncomingServerWorkspacePrefs('slack', [
      {
        workspace: 'chat',
        model: 'stale-server',
        effort: null,
        agentKind: null,
        permissionMode: null,
      },
      {
        workspace: 'other',
        model: 'from-card',
        effort: null,
        agentKind: null,
        permissionMode: null,
      },
    ]);
    expect(getWorkspacePref('slack', null, 'chat').model).toBe('offline-edit');
    expect(getWorkspacePref('slack', null, 'other').model).toBe('from-card');
  });

  it('已同步实值在卡片快照省略该键时删除；未镜像实值保留', () => {
    const synced = setWorkspacePref('slack', null, 'repo', { model: 'old-local' });
    markWorkspacePrefMirrored('slack', null, 'repo', synced.rev);
    setWorkspacePref('slack', null, 'chat', { model: 'dirty-local' });
    applyIncomingServerWorkspacePrefs('slack', [
      {
        workspace: 'other',
        model: 'from-card',
        effort: null,
        agentKind: null,
        permissionMode: null,
      },
    ]);
    expect(getWorkspacePref('slack', null, 'repo').model).toBeNull();
    expect(listWorkspacePrefs('slack').map((e) => e.workspace).sort()).toEqual(['chat', 'other']);
    expect(getWorkspacePref('slack', null, 'chat').model).toBe('dirty-local');
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
