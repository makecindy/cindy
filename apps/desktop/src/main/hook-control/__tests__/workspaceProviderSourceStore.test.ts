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
  getWorkspaceProviderSource,
  listWorkspaceProviderSources,
  setWorkspaceProviderSource,
} from '../workspaceProviderSourceStore';

describe('workspaceProviderSourceStore', () => {
  beforeEach(() => {
    tmp.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wps-'));
  });
  afterEach(() => {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('写读一条来源偏好;不同渠道/目录互不串', () => {
    setWorkspaceProviderSource('telegram', null, 'chat', 'anthropic');
    setWorkspaceProviderSource('slack', null, 'chat', 'openai');
    expect(getWorkspaceProviderSource('telegram', null, 'chat')).toBe('anthropic');
    expect(getWorkspaceProviderSource('slack', null, 'chat')).toBe('openai');
    expect(getWorkspaceProviderSource('telegram', null, 'repo')).toBeNull();
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
});
