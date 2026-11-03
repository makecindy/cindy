/**
 * 目录模型来源偏好(纯本地)的行为锁:键语义(channel + teamId + workspace)、
 * teamId 的 null 兜底(与 prefsFor 的 multi-team 宽松语义一致)、null 写清除、
 * 损坏文件宽容为空表。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => ({ dir: '' }));

// owner-scoped 路径打桩到临时目录(真实实现依赖 electron app 与登录态)。
vi.mock('../../im/ownerScopedStorage.js', () => ({
  ownerScopedImUserDataPath: (...parts: string[]) => path.join(tmp.dir, ...parts),
}));

import {
  clearWorkspaceProviderSourcesForRemoteModelChanges,
  getWorkspaceProviderSource,
  getWorkspaceProviderRoute,
  listWorkspaceProviderSources,
  setWorkspaceProviderSource,
} from '../workspaceProviderSourceStore';

describe('workspaceProviderSourceStore', () => {
  it('keeps location and provider together across team fallback and local reselection', () => {
    setWorkspaceProviderSource('slack', null, 'chat', 'openai', 'share:owner');
    expect(getWorkspaceProviderRoute('slack', 'T2', 'chat')).toMatchObject({ providerId: 'openai', agentDeviceId: 'share:owner' });
    setWorkspaceProviderSource('slack', 'T2', 'chat', 'openai');
    expect(getWorkspaceProviderRoute('slack', 'T2', 'chat')?.agentDeviceId).toBeUndefined();
    expect(getWorkspaceProviderRoute('slack', 'T1', 'chat')?.agentDeviceId).toBe('share:owner');
  });
  beforeEach(() => {
    tmp.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wps-'));
  });
  afterEach(() => {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('写读一条来源偏好;不同渠道/目录互不串', () => {
    setWorkspaceProviderSource('telegram', null, 'chat', 'anthropic');
    setWorkspaceProviderSource('slack', null, 'chat', 'openai');
    setWorkspaceProviderSource('x', null, 'chat', 'google');
    expect(getWorkspaceProviderSource('telegram', null, 'chat')).toBe('anthropic');
    expect(getWorkspaceProviderSource('slack', null, 'chat')).toBe('openai');
    expect(getWorkspaceProviderSource('x', null, 'chat')).toBe('google');
    expect(getWorkspaceProviderSource('telegram', null, 'repo')).toBeNull();
    expect(getWorkspaceProviderSource('x', null, 'repo')).toBeNull();
  });

  it('teamId 精确匹配优先, null 行兜底(multi-team 宽松语义)', () => {
    setWorkspaceProviderSource('slack', null, 'repo', 'anthropic');
    setWorkspaceProviderSource('slack', 'T1', 'repo', 'openai');
    expect(getWorkspaceProviderSource('slack', 'T1', 'repo')).toBe('openai');
    expect(getWorkspaceProviderSource('slack', 'T2', 'repo')).toBe('anthropic');
  });

  it('providerId=null 清除条目', () => {
    setWorkspaceProviderSource('telegram', null, 'chat', 'anthropic');
    setWorkspaceProviderSource('telegram', null, 'chat', null);
    expect(getWorkspaceProviderSource('telegram', null, 'chat')).toBeNull();
    expect(listWorkspaceProviderSources()).toEqual([]);
  });

  it('损坏文件宽容为空表, 下次写入覆盖', () => {
    fs.writeFileSync(path.join(tmp.dir, 'hook-workspace-provider-source.json'), '{broken');
    expect(listWorkspaceProviderSources()).toEqual([]);
    setWorkspaceProviderSource('telegram', null, 'chat', 'anthropic');
    expect(getWorkspaceProviderSource('telegram', null, 'chat')).toBe('anthropic');
  });

  it('读侧与 IPC 同规过滤不合规条目(外部写入异常值不透传)', () => {
    fs.writeFileSync(
      path.join(tmp.dir, 'hook-workspace-provider-source.json'),
      JSON.stringify({
        entries: [
          { channel: 'telegram', teamId: null, workspace: 'chat', providerId: 'anthropic' },
          { channel: 'telegram', teamId: null, workspace: 'bad alias!', providerId: 'x' },
          { channel: 'telegram', teamId: null, workspace: 'ok', providerId: 'p'.repeat(200) },
        ],
      }),
    );
    expect(listWorkspaceProviderSources()).toEqual([
      { channel: 'telegram', teamId: null, workspace: 'chat', providerId: 'anthropic' },
    ]);
  });

  describe('远端快照改模型时清理同键来源(issue #5912)', () => {
    const row = (
      workspace: string,
      model: string | null,
      teamId: string | null = null,
      agentKind: string | null = model === null ? null : 'codex',
    ) => ({ workspace, model, teamId, agentKind });

    it('模型被清空 / 整行消失 / 改成别的: 同键来源清除, 其它键与其它渠道不动', () => {
      setWorkspaceProviderSource('x', null, 'chat', 'openai');
      setWorkspaceProviderSource('x', null, 'gone', 'openai');
      setWorkspaceProviderSource('x', null, 'swapped', 'openai');
      setWorkspaceProviderSource('x', null, 'same', 'openai');
      setWorkspaceProviderSource('slack', null, 'chat', 'openai');

      const next = clearWorkspaceProviderSourcesForRemoteModelChanges(
        'x',
        [row('chat', 'gpt-test'), row('gone', 'gpt-test'), row('swapped', 'gpt-test'), row('same', 'gpt-test')],
        [row('chat', null), row('swapped', 'claude-test'), row('same', 'gpt-test')],
      );

      expect(next).toEqual([
        { channel: 'x', teamId: null, workspace: 'same', providerId: 'openai' },
        { channel: 'slack', teamId: null, workspace: 'chat', providerId: 'openai' },
      ]);
      expect(listWorkspaceProviderSources()).toEqual(next);
    });

    it('模型未变(含一直继承默认、只钉来源)时不写文件, 返回 null', () => {
      setWorkspaceProviderSource('x', null, 'chat', 'sub');
      setWorkspaceProviderSource('slack', 'T1', 'repo', 'openai');
      expect(
        clearWorkspaceProviderSourcesForRemoteModelChanges('x', [], [row('chat', null)]),
      ).toBeNull();
      expect(
        clearWorkspaceProviderSourcesForRemoteModelChanges(
          'slack',
          [row('repo', 'gpt-test', 'T1')],
          [row('repo', 'gpt-test', 'T1')],
        ),
      ).toBeNull();
      expect(listWorkspaceProviderSources()).toHaveLength(2);
    });

    it('只换 Agent、模型 id 不变也算路由变化, 来源清除', () => {
      setWorkspaceProviderSource('x', null, 'chat', 'openai');
      const next = clearWorkspaceProviderSourcesForRemoteModelChanges(
        'x',
        [row('chat', 'shared-model', null, 'codex')],
        [row('chat', 'shared-model', null, 'claude-code')],
      );
      expect(next).toEqual([]);
    });

    it('某 team 改路由不清共用的 null-team 兜底来源(避免其它 team 静默换账号)', () => {
      setWorkspaceProviderSource('slack', null, 'repo', 'openai');
      const next = clearWorkspaceProviderSourcesForRemoteModelChanges(
        'slack',
        [row('repo', 'gpt-test', 'T1'), row('repo', 'gpt-test', 'T2')],
        [row('repo', 'claude-test', 'T1'), row('repo', 'gpt-test', 'T2')],
      );
      expect(next).toBeNull();
      expect(getWorkspaceProviderSource('slack', 'T2', 'repo')).toBe('openai');
    });

    it('按 teamId 精确键判定, 不误清其它 team 的来源', () => {
      setWorkspaceProviderSource('slack', 'T1', 'repo', 'openai');
      setWorkspaceProviderSource('slack', 'T2', 'repo', 'openai');
      const next = clearWorkspaceProviderSourcesForRemoteModelChanges(
        'slack',
        [row('repo', 'gpt-test', 'T1'), row('repo', 'gpt-test', 'T2')],
        [row('repo', 'gpt-test', 'T2')],
      );
      expect(next).toEqual([{ channel: 'slack', teamId: 'T2', workspace: 'repo', providerId: 'openai' }]);
    });
  });
});
