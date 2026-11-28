/**
 * 测试价值
 * - 生产入口与可观察结果: 设置 → IM 机器人 → 某平台的「项目」(personalChannelStore + imProjectPorts)决定新任务
 *   放进哪个侧栏项目, 落在该项目里的任务模型与权限跟随「项目与模型」那一行; 「谁来回复」的伙伴归属按
 *   每条消息现读, 个人 Telegram adapter 的主人轮次随之不挂逐轮策略。
 * - 规则依据: 2026-11-24 用户裁决「选了项目就跟项目走, 直接对话才用平台自己的模型」; 伙伴自有 bot 的
 *   权限口径(cindy-bots-runtime 2026-10-16)。
 * - 现有覆盖为何不够: 飞书按群项目只覆盖群 lane; 平台级默认项目与可切换的伙伴归属是新路径。
 * - 最小失败输入 / tier: unit。真实存储文件写在临时目录, 项目表与解析经端口给出。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  root: '',
  projects: [] as Array<{ workingDir: string; displayName: string; latestActivityMs: number }>,
}));

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));
vi.mock('../../ownerScopedStorage', () => ({
  ownerScopedImUserDataPath: (...parts: string[]) => path.join(mocks.root, 'owners', 'acct', ...parts),
}));
vi.mock('../../defaultSettingsStore', () => ({
  readImDefaultSettings: () => ({ permissionMode: 'auto', groupPermissionMode: 'auto' }),
}));
vi.mock('../controlProjects', () => ({
  listProjectsForControl: vi.fn(async () => mocks.projects),
}));
vi.mock('../../defaultSessionSettings', () => ({ getImDefaultEffortFor: () => 'high' }));

import { personalChannelProjectDefaults, personalChannelProjectDir, setImProjectPorts } from '../imProjectPorts';
import {
  clearPersonalChannelChoice,
  listPersonalChannelsForCompanion,
  readPersonalChannelChoice,
  writePersonalChannelChoice,
} from '../personalChannelStore';

describe('personal channel project and reply target', () => {
  let projectDir = '';
  const resolveProject = vi.fn(async () => ({
    agentKind: 'codex', model: 'gpt-6.2-sol', effort: 'high', providerId: 'openai', agentDeviceId: null, fingerprint: 'fp-resolved',
  }));

  beforeEach(async () => {
    mocks.root = await fs.mkdtemp(path.join(os.tmpdir(), 'im-personal-channel-'));
    projectDir = path.join(mocks.root, 'cindy');
    await fs.mkdir(projectDir);
    mocks.projects = [{ workingDir: projectDir, displayName: 'cindy', latestActivityMs: 0 }];
    setImProjectPorts({
      projectWorkspaces: () => ({ cindy: projectDir }),
      syncProjectWorkspaces: async () => {},
      projectPermissionMode: () => 'ask',
      projectFingerprint: () => 'fp-raw',
      resolveProject,
      listProviders: async () => [],
    });
  });

  afterEach(async () => {
    setImProjectPorts(null);
    await fs.rm(mocks.root, { recursive: true, force: true });
  });

  it('puts new tasks into the chosen project and follows that project only for tasks inside it', async () => {
    expect(await personalChannelProjectDir('telegram')).toBeUndefined();

    writePersonalChannelChoice('telegram', { projectDir });
    expect(await personalChannelProjectDir('telegram')).toBe(projectDir);
    // 只改了 Telegram: 别的平台仍在对话目录。
    expect(await personalChannelProjectDir('discord')).toBeUndefined();

    const project = personalChannelProjectDefaults('telegram', projectDir);
    expect(project?.permissionMode).toBe('ask');
    expect(await project!.resolve([])).toMatchObject({
      agentKind: 'codex', model: 'gpt-6.2-sol', providerId: 'openai', permissionMode: 'ask',
      fingerprint: 'telegram-channel-project:fp-resolved',
    });
    // 对话目录(或用 /project 切进的别的目录)里的任务仍按平台自己的设置。
    expect(personalChannelProjectDefaults('telegram', path.join(mocks.root, 'dialogue'))).toBeNull();
  });

  it('falls back to the chat folder when the project left the sidebar', async () => {
    writePersonalChannelChoice('wecom', { projectDir });
    mocks.projects = [];
    expect(await personalChannelProjectDir('wecom')).toBeNull();
  });

  it('lists companion-assigned personal channels (excluding wechat) and cleans stale channel state on unbind/adopt', () => {
    writePersonalChannelChoice('feishu', { projectDir, companionBotId: 'bot-a' });
    writePersonalChannelChoice('telegram', { companionBotId: 'bot-a' });
    writePersonalChannelChoice('wechat', { projectDir, companionBotId: 'bot-a' });
    writePersonalChannelChoice('discord', { companionBotId: 'bot-b' });

    expect(listPersonalChannelsForCompanion('bot-a')).toEqual(['telegram', 'feishu']);
    expect(listPersonalChannelsForCompanion('bot-b')).toEqual(['discord']);

    expect(clearPersonalChannelChoice('feishu')).toBe(true);
    expect(clearPersonalChannelChoice('feishu')).toBe(false);
    expect(readPersonalChannelChoice('feishu')).toEqual({ projectDir: null, companionBotId: null });
    expect(listPersonalChannelsForCompanion('bot-a')).toEqual(['telegram']);
  });
});
