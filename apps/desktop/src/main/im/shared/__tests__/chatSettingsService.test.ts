/**
 * 设置页「群聊」总表的读写(2026-11-23 用户需求: 内置飞书按群设置项目、模型、权限; 2026-11-24 主人裁决:
 * 推广到各平台, 加「群成员也能提问」, Telegram / 钉钉升级前用过的群保持回答群成员)。
 *
 * 生产入口: listImChatSettingsForUi / saveImChatSettings / resumeImChatMembers, 存储是真实文件(临时目录),
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
vi.mock('../controlProjects', () => ({
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

const { encodeFeishuLaneUserId } = await import('@cindy/im');
const { sessions } = await import('../../../localDb/schema');
const { parseImChatSettingsPatch } = await import('../../../../shared/imChatSettings');
const { imChatRouteOverride } = await import('../chatOverrides');
const { listImChatSettingsForUi, saveImChatSettings, resumeImChatMembers, ImChatSettingsError } =
  await import('../chatSettingsService');
const { projectToken } = await import('../projectToken');
const { writeImChatSettings, __testing: storeTesting } = await import('../chatSettingsStore');
const { setImProjectPorts } = await import('../imProjectPorts');
const { registerImChatSource } = await import('../chatSources');
const { feishuBotGroups, cachedFeishuGroupAvatar, __testing } = await import('../../feishu/groupList');
const { __testing: gateTesting } = await import('../guestGate');

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

/** 飞书个人机器人的名单来源(同 im/chatSourcesWiring.ts), 接口由替身给出。 */
function fakeIm(callApi: (args: unknown) => Promise<Record<string, unknown>>) {
  const im = { callApi: vi.fn(callApi) };
  registerImChatSource('feishu', {
    botId: () => 'cli_bot',
    connected: () => true,
    remote: (refresh) => feishuBotGroups(im as never, 'cli_bot', refresh),
    cachedAvatar: cachedFeishuGroupAvatar,
  });
  return im;
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
  storeTesting.resetCache();
  gateTesting.reset();
});

afterEach(async () => {
  setImProjectPorts(null);
  await fs.rm(h.root, { recursive: true, force: true });
});

describe('im chat settings service', () => {
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
    writeImChatSettings('feishu', 'cli_bot', 'oc_saved', { projectDir: path.join(h.root, 'gone') }, '旧群');
    const im = fakeIm(async () => {
      throw Object.assign(new Error('no scope'), { code: 99991672 });
    });

    const list = await listImChatSettingsForUi('feishu');

    expect(list.source).toBe('local');
    expect(list.listError).toBe('permission');
    expect(list.chats.map((g) => [g.chatId, g.name])).toEqual([
      ['oc_used', '飞书 · 用过的群'],
      ['oc_saved', '旧群'],
    ]);
    expect(list.chats[1]!.project).toMatchObject({ available: false, name: 'gone' });
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

    const list = await listImChatSettingsForUi('feishu');
    expect(list.chats.map((g) => [g.chatId, g.avatarUrl])).toEqual([
      ['oc_a', 'https://s1-imfile.feishucdn.com/static-resource/a'],
      ['oc_b', null],
      ['oc_c', null],
    ]);
    const callApi = im.callApi;
    await listImChatSettingsForUi('feishu');
    expect(callApi).toHaveBeenCalledTimes(1);
    await listImChatSettingsForUi('feishu', { refresh: true });
    expect(callApi).toHaveBeenCalledTimes(2);
    // 保存不重新拉名单, 返回的群仍带着上次读到的头像。
    const saved = await saveImChatSettings('feishu', 'oc_a', { permissionMode: 'plan' }, '有头像');
    expect(saved.avatarUrl).toBe('https://s1-imfile.feishucdn.com/static-resource/a');
  });

  it('项目只能按侧栏清单选; 清单外的标记不写入, 全部改回跟随后删除该群记录', async () => {
    const im = fakeIm(async () => ({ data: { items: [{ chat_id: 'oc_g1', name: '项目群' }], has_more: false } }));

    await expect(
      saveImChatSettings('feishu', 'oc_g1', { projectToken: 'a'.repeat(24) }, '项目群'),
    ).rejects.toBeInstanceOf(ImChatSettingsError);

    const saved = await saveImChatSettings('feishu', 'oc_g1',
      { projectToken: projectToken(projectDir), permissionMode: 'plan' },
      '项目群',
    );
    expect(saved.project).toMatchObject({ name: 'project-a', available: true });
    expect(saved.permissionMode).toBe('plan');
    expect((await listImChatSettingsForUi('feishu')).chats[0]!.permissionMode).toBe('plan');

    const cleared = await saveImChatSettings('feishu', 'oc_g1', { projectToken: null, permissionMode: null }, null);
    expect(cleared).toMatchObject({ project: null, route: null, permissionMode: null, members: false });
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

    await expect(saveImChatSettings('feishu', 'oc_g1', { permissionMode: 'bypassPermissions' }, null)).rejects.toThrow();
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
    setImProjectPorts({
      projectWorkspaces: () => ({ chat: '', 'project-a': projectDir, 'project-b': otherDir }),
      syncProjectWorkspaces,
      projectPermissionMode: (alias) => (alias === 'project-a' ? null : 'auto'),
      projectFingerprint: (alias) => `fp:${alias}`,
      resolveProject,
      listProviders: async () => [],
    });
    const im = fakeIm(async () => ({ data: { items: [{ chat_id: 'oc_g1', name: '项目群' }], has_more: false } }));

    const saved = await saveImChatSettings('feishu', 'oc_g1', { projectToken: projectToken(projectDir) }, '项目群');
    // 没填权限的那一行按完全访问(同插件与官方机器人)。
    expect(saved.project?.config).toEqual({
      route: { agentKind: 'claude-code', model: 'claude-opus-5-5', providerId: 'anthropic', agentDeviceId: null, effort: 'xhigh' },
      permissionMode: 'bypassPermissions',
    });
    resolveProject.mockClear();
    const list = await listImChatSettingsForUi('feishu');
    expect(list.projects.map((p) => [p.name, p.permissionMode])).toEqual([
      ['project-a', 'bypassPermissions'],
      ['project-b', 'auto'],
    ]);
    expect(list.chats[0]!.project?.config?.route?.model).toBe('claude-opus-5-5');
    expect(resolveProject).toHaveBeenCalledTimes(1);
    expect(resolveProject).toHaveBeenCalledWith('project-a', [], { dryRun: true });
    expect(syncProjectWorkspaces).toHaveBeenCalled();

    // 打开飞书卡片时的概要(2026-11-23 用户反馈收起时的群数与头像要展开一次才出现): 仍认得这个群
    // 单独绑了项目, 但不为显示群数去解析项目模型(要列供应商、可能问另一台电脑), 也不重复读群名单。
    resolveProject.mockClear();
    const summary = await listImChatSettingsForUi('feishu', { summary: true });
    expect(summary.chats[0]!.project).toMatchObject({ name: 'project-a', available: true, config: null });
    expect(resolveProject).not.toHaveBeenCalled();
    expect(im.callApi).toHaveBeenCalledTimes(1);
  });

  // 2026-11-24 主人裁决: 钉钉升级前就回答群成员, 保持现状——第一次整理时把机器人用过的群记为
  // 「群成员也能提问」, 之后新加进的群默认不勾; 飞书等原本只认主人的平台默认不勾。
  // 最小失败输入: 一个有任务记录的钉钉群, 整理后再出现一个新群。
  it('钉钉: 升级前用过的群保持群成员可提问, 整理后新群默认不勾; 飞书默认不勾', async () => {
    await db.insert(sessions).values({
      id: 'dingtalk_old',
      title: '钉钉群聊 · 老群',
      source: 'dingtalk',
      imBotContextId: 'ding1',
      imUserId: `g/${encodeURIComponent('cid-old')}`,
      createdAt: 1,
      updatedAt: 1,
    } as typeof sessions.$inferInsert);
    let known = [{ chatId: 'cid-old', name: '老群', avatarUrl: null, kind: 'group' as const }];
    registerImChatSource('dingtalk', { botId: () => 'ding1', connected: () => true, known: async () => known });

    const first = await listImChatSettingsForUi('dingtalk');
    expect(first.chats.map((c) => [c.chatId, c.name, c.members])).toEqual([['cid-old', '老群', true]]);

    known = [...known, { chatId: 'cid-new', name: '新群', avatarUrl: null, kind: 'group' as const }];
    const second = await listImChatSettingsForUi('dingtalk');
    expect(second.chats.map((c) => [c.chatId, c.members])).toEqual([['cid-old', true], ['cid-new', false]]);

    fakeIm(async () => ({ data: { items: [{ chat_id: 'oc_g1', name: '项目群' }], has_more: false } }));
    expect((await listImChatSettingsForUi('feishu')).chats[0]).toMatchObject({ chatId: 'oc_g1', members: false });
  });

  // 2026-11-24 用户实测: Telegram 私聊批准卡写着「批准后群成员可以召唤」, 若勾选框另存一份, 批准后成员
  // 仍被挡住。Telegram 的「群成员也能提问」读写的就是群准入, 不写设置文件。
  // 最小失败输入: 一个已批准、一个待批准的 Telegram 群, 在设置里勾上待批准的那个。
  it('Telegram: 群成员也能提问就是群准入, 勾选即批准, 不另存', async () => {
    const approval = new Map<string, boolean>([['-100111', true], ['-100222', false]]);
    const set = vi.fn((chatId: string, on: boolean) => { approval.set(chatId, on); return true; });
    registerImChatSource('telegram', {
      botId: () => 'bot1',
      connected: () => true,
      known: async () => [
        { chatId: '-100111', name: '已批准', avatarUrl: null, kind: 'group' as const },
        { chatId: '-100222', name: '待批准', avatarUrl: null, kind: 'group' as const },
      ],
      members: { get: (chatId) => approval.get(chatId) === true, set },
    });

    const list = await listImChatSettingsForUi('telegram');
    expect(list.chats.map((c) => [c.chatId, c.members])).toEqual([['-100111', true], ['-100222', false]]);

    expect(await saveImChatSettings('telegram', '-100222', { members: true }, '待批准')).toMatchObject({ members: true });
    expect(set).toHaveBeenCalledExactlyOnceWith('-100222', true, '待批准');
    // 设置文件里没有另存一份群成员开关。
    const file = path.join(h.root, 'owners', 'owner-1', 'telegram-chat-settings.json');
    expect(JSON.parse(await fs.readFile(file, 'utf8')).bots).toEqual({});
  });

  it('勾选群成员也能提问即保存; 暂停后「恢复」解除, 取消勾选清掉暂停', async () => {
    fakeIm(async () => ({ data: { items: [{ chat_id: 'oc_g1', name: '项目群' }], has_more: false } }));
    expect(await saveImChatSettings('feishu', 'oc_g1', { members: true }, '项目群')).toMatchObject({ members: true, membersPaused: false });
    writeImChatSettings('feishu', 'cli_bot', 'oc_g1', { membersPaused: true }, null);
    expect((await listImChatSettingsForUi('feishu')).chats[0]).toMatchObject({ members: true, membersPaused: true });
    expect(await resumeImChatMembers('feishu', 'oc_g1', '项目群')).toMatchObject({ members: true, membersPaused: false });

    writeImChatSettings('feishu', 'cli_bot', 'oc_g1', { membersPaused: true }, null);
    expect(await saveImChatSettings('feishu', 'oc_g1', { members: false }, '项目群')).toMatchObject({ members: false, membersPaused: false });
  });

  // 依据: 群聊覆盖路由支持插件引擎(acp, 允许 effort='' 且强校验 providerId 必须为 acp-plugin:*)。
  // 缺口: 上述用例只覆盖内置模型覆盖，未验证 acp 路由持久化与非法 providerId fail-closed。
  // 最小失败输入: 保存合法 Antigravity acp 路由后回读，以及传入无 acp-plugin 前缀的 acp 路由被拒。
  // tier: unit
  it('按群模型支持保存和回读插件引擎(acp)路由并拒绝非法 providerId', async () => {
    fakeIm(async () => ({ data: { items: [{ chat_id: 'oc_g1', name: '项目群' }], has_more: false } }));
    const acpRoute = {
      agentKind: 'acp' as const,
      model: 'gemini-3-pro',
      providerId: 'acp-plugin:cindy-antigravity:antigravity',
      agentDeviceId: null,
      effort: '' as const,
    };
    const saved = await saveImChatSettings('feishu', 'oc_g1', { route: acpRoute }, '项目群');
    expect(saved.route).toEqual(acpRoute);
    expect(imChatRouteOverride('feishu', 'cli_bot', encodeFeishuLaneUserId('oc_g1'))).toEqual(acpRoute);

    expect(() =>
      parseImChatSettingsPatch({
        route: { ...acpRoute, providerId: 'not-a-plugin-provider' },
      }),
    ).toThrow('IM_CHAT_SETTINGS_INVALID');
  });
});
