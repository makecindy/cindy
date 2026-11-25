/**
 * 设置页「群聊」的读写(2026-11-23 用户需求: 内置飞书按群设置项目、模型、权限)。
 *
 * 生产入口: listFeishuGroupSettingsForUi / saveFeishuGroupSettings, 存储是真实文件(临时目录),
 * 本机任务记录是真 SQLite。覆盖缺口: 群名单读不到时的退回、项目只能按侧栏清单选、损坏文件
 * 不被覆盖、绑定项目在「项目与模型」里的设置带给界面 —— adapter 用例只验证已保存的设置如何被
 * 建任务读到。tier: unit。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  root: '',
  projects: [] as Array<{ workingDir: string; displayName: string; latestActivityMs: number }>,
}));

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/never-used-here' } }));
vi.mock('../../ownerScopedStorage', () => ({
  ownerScopedImUserDataPath: (...parts: string[]) => path.join(h.root, 'owners', 'owner-1', ...parts),
}));
vi.mock('../../shared/controlProjects', () => ({
  listProjectsForControl: vi.fn(async () => h.projects),
}));
// 项目路由解析只在拿不到推理强度时问模型目录; 渠道设置只取群聊权限档。
vi.mock('../../defaultSessionSettings', () => ({ getImDefaultEffortFor: vi.fn(() => 'high') }));
vi.mock('../../defaultSettingsStore', () => ({ readImDefaultSettings: () => ({ groupPermissionMode: 'auto' }) }));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  maskPath: (p: string) => p,
}));

let db: ReturnType<typeof drizzle>;
vi.mock('../../../localDb/client/current', () => ({ getDbClient: () => ({ drizzle: db }) }));

const { sessions } = await import('../../../localDb/schema');
const { listFeishuGroupSettingsForUi, saveFeishuGroupSettings, FeishuGroupSettingsError, __testing } =
  await import('../groupSettingsService');
const { projectToken } = await import('../../shared/projectToken');
const { writeFeishuGroupSettings } = await import('../groupSettingsStore');
const { setFeishuGroupProjectPorts } = await import('../groupOverrides');

function createTableSql(): string {
  const config = getTableConfig(sessions);
  const cols = config.columns.map((col) => {
    const parts = [`"${col.name}"`, col.getSQLType()];
    if (col.primary) parts.push('PRIMARY KEY');
    if (col.notNull) parts.push('NOT NULL');
    const dflt = col.default;
    if (dflt !== undefined && typeof dflt !== 'object') {
      parts.push(`DEFAULT ${typeof dflt === 'string' ? `'${dflt}'` : Number(dflt)}`);
    }
    return parts.join(' ');
  });
  return `CREATE TABLE "${config.name}" (${cols.join(', ')})`;
}

function fakeIm(callApi: (args: unknown) => Promise<Record<string, unknown>>) {
  return {
    getBotAppId: () => 'cli_bot',
    getStatus: () => ({ kind: 'connected' as const, appId: 'cli_bot' }),
    callApi: vi.fn(callApi),
  } as never;
}

let projectDir = '';
beforeEach(async () => {
  h.root = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-group-service-'));
  projectDir = path.join(h.root, 'project-a');
  h.projects = [{ workingDir: projectDir, displayName: 'project-a', latestActivityMs: 1 }];
  const raw = new Database(':memory:');
  raw.exec(createTableSql());
  db = drizzle(raw);
  __testing.resetCache();
});

afterEach(async () => {
  setFeishuGroupProjectPorts(null);
  await fs.rm(h.root, { recursive: true, force: true });
});

describe('feishu group settings service', () => {
  it('群名单读不到时退回机器人用过的群, 已保存设置的群也列出, 移出侧栏的项目标为不可用', async () => {
    await db.insert(sessions).values({
      id: 'feishu_cli_bot_g-oc_used',
      title: '飞书 · 用过的群',
      source: 'feishu',
      feishuBotAppId: 'cli_bot',
      feishuOpenId: 'g/oc_used',
      createdAt: 1,
      updatedAt: 1,
    } as typeof sessions.$inferInsert);
    writeFeishuGroupSettings('cli_bot', 'oc_saved', { projectDir: path.join(h.root, 'gone') }, '旧群');
    const im = fakeIm(async () => {
      throw Object.assign(new Error('no scope'), { code: 99991672 });
    });

    const list = await listFeishuGroupSettingsForUi(im);

    expect(list.source).toBe('local');
    expect(list.listError).toBe('permission');
    expect(list.groups.map((g) => [g.chatId, g.name])).toEqual([
      ['oc_used', '飞书 · 用过的群'],
      ['oc_saved', '旧群'],
    ]);
    expect(list.groups[1]!.project).toMatchObject({ available: false, name: 'gone' });
    // 界面拿到的是项目标记与名字, 不是本机路径。
    expect(JSON.stringify(list)).not.toContain(h.root);
  });

  it('飞书名单带回群头像(只收 https); 30 秒内复用名单, 点刷新才重新读', async () => {
    const im = fakeIm(async () => ({
      data: {
        items: [
          { chat_id: 'oc_a', name: '有头像', avatar: 'https://s1-imfile.feishucdn.com/static-resource/a' },
          { chat_id: 'oc_b', name: '坏地址', avatar: 'javascript:alert(1)' },
          { chat_id: 'oc_c', name: '明文', avatar: 'http://example.com/c.png' },
        ],
        has_more: false,
      },
    }));

    const list = await listFeishuGroupSettingsForUi(im);
    expect(list.groups.map((g) => [g.chatId, g.avatarUrl])).toEqual([
      ['oc_a', 'https://s1-imfile.feishucdn.com/static-resource/a'],
      ['oc_b', null],
      ['oc_c', null],
    ]);
    const callApi = (im as unknown as { callApi: ReturnType<typeof vi.fn> }).callApi;
    await listFeishuGroupSettingsForUi(im);
    expect(callApi).toHaveBeenCalledTimes(1);
    await listFeishuGroupSettingsForUi(im, { refresh: true });
    expect(callApi).toHaveBeenCalledTimes(2);
    // 保存不重新拉名单, 返回的群仍带着上次读到的头像。
    const saved = await saveFeishuGroupSettings(im, 'oc_a', { permissionMode: 'plan' }, '有头像');
    expect(saved.avatarUrl).toBe('https://s1-imfile.feishucdn.com/static-resource/a');
  });

  it('项目只能按侧栏清单选; 清单外的标记不写入, 全部改回跟随后删除该群记录', async () => {
    const im = fakeIm(async () => ({ data: { items: [{ chat_id: 'oc_g1', name: '项目群' }], has_more: false } }));

    await expect(
      saveFeishuGroupSettings(im, 'oc_g1', { projectToken: 'a'.repeat(24) }, '项目群'),
    ).rejects.toBeInstanceOf(FeishuGroupSettingsError);

    const saved = await saveFeishuGroupSettings(
      im,
      'oc_g1',
      { projectToken: projectToken(projectDir), permissionMode: 'plan' },
      '项目群',
    );
    expect(saved.project).toMatchObject({ name: 'project-a', available: true });
    expect(saved.permissionMode).toBe('plan');
    expect((await listFeishuGroupSettingsForUi(im)).groups[0]!.permissionMode).toBe('plan');

    const cleared = await saveFeishuGroupSettings(im, 'oc_g1', { projectToken: null, permissionMode: null }, null);
    expect(cleared).toMatchObject({ project: null, route: null, permissionMode: null });
    const file = JSON.parse(
      await fs.readFile(path.join(h.root, 'owners', 'owner-1', 'feishu-group-settings.json'), 'utf8'),
    );
    expect(file.bots).toEqual({});
  });

  it('存储文件损坏时拒绝保存且不覆盖原文件', async () => {
    const file = path.join(h.root, 'owners', 'owner-1', 'feishu-group-settings.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{not json');
    const im = fakeIm(async () => ({ data: { items: [] } }));

    await expect(saveFeishuGroupSettings(im, 'oc_g1', { permissionMode: 'bypassPermissions' }, null)).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe('{not json');
  });

  it('绑定的项目带上它在「项目与模型」里的模型与权限; 只解析被绑定的项目', async () => {
    const otherDir = path.join(h.root, 'project-b');
    h.projects = [
      { workingDir: projectDir, displayName: 'project-a', latestActivityMs: 2 },
      { workingDir: otherDir, displayName: 'project-b', latestActivityMs: 1 },
    ];
    const resolveProject = vi.fn(async () => ({
      agentKind: 'claude-code',
      model: 'claude-opus-5-5',
      effort: 'xhigh',
      providerId: 'anthropic',
      agentDeviceId: null,
      fingerprint: 'fp',
    }));
    const syncProjectWorkspaces = vi.fn(async () => {});
    setFeishuGroupProjectPorts({
      projectWorkspaces: () => ({ chat: '', 'project-a': projectDir, 'project-b': otherDir }),
      syncProjectWorkspaces,
      projectPermissionMode: (alias) => (alias === 'project-a' ? null : 'auto'),
      projectFingerprint: (alias) => `fp:${alias}`,
      resolveProject,
      listProviders: async () => [],
    });
    const im = fakeIm(async () => ({ data: { items: [{ chat_id: 'oc_g1', name: '项目群' }], has_more: false } }));

    const saved = await saveFeishuGroupSettings(im, 'oc_g1', { projectToken: projectToken(projectDir) }, '项目群');
    // 没填权限的那一行按完全访问(同插件与官方机器人)。
    expect(saved.project?.config).toEqual({
      route: { agentKind: 'claude-code', model: 'claude-opus-5-5', providerId: 'anthropic', agentDeviceId: null, effort: 'xhigh' },
      permissionMode: 'bypassPermissions',
    });
    resolveProject.mockClear();
    const list = await listFeishuGroupSettingsForUi(im);
    expect(list.projects.map((p) => [p.name, p.permissionMode])).toEqual([
      ['project-a', 'bypassPermissions'],
      ['project-b', 'auto'],
    ]);
    expect(list.groups[0]!.project?.config?.route?.model).toBe('claude-opus-5-5');
    expect(resolveProject).toHaveBeenCalledTimes(1);
    expect(resolveProject).toHaveBeenCalledWith('project-a', []);
    expect(syncProjectWorkspaces).toHaveBeenCalled();

    // 打开飞书卡片时的概要(2026-11-23 用户反馈收起时的群数与头像要展开一次才出现): 仍认得这个群
    // 单独绑了项目, 但不为显示群数去解析项目模型(要列供应商、可能问另一台电脑), 也不重复读群名单。
    resolveProject.mockClear();
    const summary = await listFeishuGroupSettingsForUi(im, { summary: true });
    expect(summary.groups[0]!.project).toMatchObject({ name: 'project-a', available: true, config: null });
    expect(resolveProject).not.toHaveBeenCalled();
    expect((im as unknown as { callApi: ReturnType<typeof vi.fn> }).callApi).toHaveBeenCalledTimes(1);
  });
});
