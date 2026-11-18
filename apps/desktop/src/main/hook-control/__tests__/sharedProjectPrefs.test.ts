/**
 * 所有官方 IM 机器人共用一套项目配置(sharedProjectPrefs.ts)的行为锁。
 *
 * 规则依据: 飞书 / Telegram / Slack / X 不再各配一遍项目的模型与权限 —— 一个项目只有一份,
 * 在哪个机器人里用到都按它跑。各渠道原有的配置一次性并入: 模型按 飞书 -> Telegram -> Slack -> X
 * 取第一个配置过该项目的; 权限档取最严的, 合并不得放宽任何项目。
 * 全部用例走真实的本机偏好文件(临时目录), 不 mock 存储。tier: unit。
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
  absorbChannelChange,
  adoptChannelPrefs,
  adoptReadyChannels,
  clearLegacyGlobalDefaultsOnce,
  getSharedProjectPref,
  listSharedProjectPrefs,
  projectSharedOntoChannel,
  rowsAfterServerSnapshot,
  setSharedProjectPref,
  stricterPermission,
} from '../sharedProjectPrefs';
import {
  applyIncomingServerWorkspacePrefs,
  clearWorkspacePrefsFor,
  getWorkspacePref,
  isSharedPrefsAdopted,
  listWorkspacePrefs,
  markWorkspacePrefsMigrated,
  moveWorkspacePrefsToRenamed,
  reconcileWorkspacePrefsForMirror,
  setWorkspacePref,
} from '../workspacePrefsStore';
import {
  clearWorkspaceProviderSourcesFor,
  getWorkspaceProviderSource,
  setWorkspaceProviderSource,
} from '../workspaceProviderSourceStore';

describe('sharedProjectPrefs', () => {
  beforeEach(() => {
    tmp.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-prefs-'));
  });
  afterEach(() => {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  });

  // 最小失败输入: 同一个项目在飞书与 Telegram 各配了不同模型, 另一个项目只有 Slack 配过。
  it('并入时同一项目按 飞书 -> Telegram -> Slack -> X 取第一个配置过它的, 连同它的模型来源', () => {
    setWorkspacePref('telegram', null, 'repo', { agentKind: 'codex', model: 'tg-model' });
    setWorkspaceProviderSource('telegram', null, 'repo', 'tg-provider');
    setWorkspacePref('feishu', null, 'repo', { agentKind: 'claude-code', model: 'feishu-model' });
    setWorkspaceProviderSource('feishu', null, 'repo', 'feishu-provider');
    setWorkspacePref('slack', null, 'docs', { model: 'slack-model' });
    for (const channel of ['telegram', 'feishu', 'slack'] as const) markWorkspacePrefsMigrated(channel);

    expect(adoptReadyChannels()).toEqual(['feishu', 'telegram', 'slack']);

    expect(getSharedProjectPref('repo')).toMatchObject({ agentKind: 'claude-code', model: 'feishu-model' });
    expect(getWorkspaceProviderSource('shared', null, 'repo')).toBe('feishu-provider');
    expect(getSharedProjectPref('docs').model).toBe('slack-model');
    // X 的偏好还在服务端(从没连上过), 等它导入本机后再并入。
    expect(isSharedPrefsAdopted('x')).toBe(false);
    // 每个渠道只并入一次: 之后它自己的行只是镜像, 不得再次覆盖共用的那一份。
    setSharedProjectPref('repo', { model: 'edited-here' });
    expect(adoptReadyChannels()).toEqual([]);
    expect(getSharedProjectPref('repo').model).toBe('edited-here');
  });

  // 权限边界: 合并不得把任何项目放宽。最小失败输入: 排在前面的渠道没填权限(= 完全访问),
  // 排在后面的渠道显式填了更严的一档。
  it('并入时权限档取各渠道显式填过的里面最严的, 没填的不算', () => {
    setWorkspacePref('feishu', null, 'repo', { model: 'm' });
    setWorkspacePref('telegram', null, 'repo', { permissionMode: 'bypassPermissions' });
    setWorkspacePref('slack', null, 'repo', { permissionMode: 'ask' });
    setWorkspacePref('x', null, 'repo', { permissionMode: 'auto' });
    for (const channel of ['feishu', 'telegram', 'slack', 'x'] as const) markWorkspacePrefsMigrated(channel);

    adoptReadyChannels();

    expect(getSharedProjectPref('repo')).toMatchObject({ model: 'm', permissionMode: 'ask' });
    expect(stricterPermission(null, 'auto')).toBe('auto');
    expect(stricterPermission('acceptEdits', 'bypassPermissions')).toBe('acceptEdits');
    // 不认识的档按最严算: 不能因为一个没见过的名字而放宽。
    expect(stricterPermission('bypassPermissions', 'some-future-mode')).toBe('some-future-mode');
  });

  // 协议 / 持久化: 共用的那一份要原样出现在每个渠道给服务端看的行里(镜像流程据此推送),
  // 在设置页清空的项目也要让渠道行清空。最小失败输入: 渠道行与共用那份不一致。
  it('投影让渠道行与共用那份一致并待镜像; 一致时不再产生写入', () => {
    setWorkspacePref('telegram', null, 'repo', { model: 'old-tg' });
    setWorkspacePref('telegram', null, 'gone', { model: 'cleared-later' });
    markWorkspacePrefsMigrated('telegram');
    adoptChannelPrefs('telegram');
    setSharedProjectPref('repo', { agentKind: 'codex', model: 'shared-model', permissionMode: 'ask' });
    setSharedProjectPref('gone', { model: null });

    expect(projectSharedOntoChannel('telegram', [null])).toBe(true);
    expect(getWorkspacePref('telegram', null, 'repo')).toMatchObject({
      agentKind: 'codex', model: 'shared-model', permissionMode: 'ask',
    });
    expect(getWorkspacePref('telegram', null, 'gone').model).toBeNull();
    // 共用那份里清空的项目不留空行(它不镜像, 留着只会一直占条数上限)。
    const stored = JSON.parse(
      fs.readFileSync(path.join(tmp.dir, 'hook-workspace-prefs.json'), 'utf-8'),
    ) as { entries: Array<{ channel: string; workspace: string }> };
    expect(stored.entries.filter((row) => row.channel === 'shared').map((row) => row.workspace)).toEqual(['repo']);
    // 改过的行等着推给服务端(服务端这时还是旧值)。
    const pending = reconcileWorkspacePrefsForMirror('telegram', [
      { workspace: 'repo', model: 'old-tg', effort: null, agentKind: null, permissionMode: null },
    ]).map((candidate) => candidate.prefs.workspace);
    expect(pending).toContain('repo');
    expect(getWorkspacePref('telegram', null, 'repo').model).toBe('shared-model');

    expect(projectSharedOntoChannel('telegram', [null])).toBe(false);
    // Slack 多 workspace: 每个在用的 team 各一行。
    expect(projectSharedOntoChannel('slack', ['T1', 'T2'])).toBe(true);
    expect(getWorkspacePref('slack', 'T2', 'repo').model).toBe('shared-model');
  });

  // 时序: 在 IM 里用 /model 卡改某个渠道的行, 要并回共用那份(在哪个机器人里改都一样);
  // 但服务端快照里整行消失(换绑到新机器人 / 服务端没有数据)不得把共用那份清空。
  it('渠道行被服务端改动时并回共用那份并作废旧来源; 整行消失不清空', () => {
    setSharedProjectPref('repo', { agentKind: 'claude-code', model: 'm1', permissionMode: 'ask' });
    setSharedProjectPref('docs', { model: 'docs-model' });
    setWorkspaceProviderSource('shared', null, 'repo', 'provider-for-m1');
    markWorkspacePrefsMigrated('feishu');
    adoptChannelPrefs('feishu');
    projectSharedOntoChannel('feishu', [null]);
    // 行已镜像到服务端(变为 clean), 之后服务端推来 /model 卡的改动, 且不再带 docs 这一行。
    const before = reconcileWorkspacePrefsForMirror('feishu', listWorkspacePrefs('feishu'));
    expect(before.length).toBeGreaterThan(0);
    applyIncomingServerWorkspacePrefs('feishu', listWorkspacePrefs('feishu'));
    const rowsBefore = listWorkspacePrefs('feishu');
    const rowsAfter = [
      { workspace: 'repo', agentKind: 'claude-code', model: 'm2', effort: null, permissionMode: 'ask' },
    ];

    expect(absorbChannelChange(rowsBefore, rowsAfter)).toEqual(['repo']);

    expect(getSharedProjectPref('repo')).toMatchObject({ model: 'm2', permissionMode: 'ask' });
    expect(getWorkspaceProviderSource('shared', null, 'repo')).toBeNull();
    expect(getSharedProjectPref('docs').model).toBe('docs-model');
    // 本机刚写下去、已与共用那份一致的值不算远端改动(不会顺手清掉刚选的来源)。
    setWorkspaceProviderSource('shared', null, 'repo', 'provider-for-m2');
    expect(absorbChannelChange(rowsBefore, rowsAfter)).toEqual([]);
    expect(getWorkspaceProviderSource('shared', null, 'repo')).toBe('provider-for-m2');
  });

  // 时序(评审指出): 合并结果不得取决于哪个机器人先连上。最小失败输入: Telegram 先并入,
  // 飞书稍后才第一次连上; 另一个项目在两者之间被用户改过。
  it('排在前面的渠道晚并入时顶替原样并入的行, 但不动用户改过的行', () => {
    setWorkspacePref('telegram', null, 'repo', { agentKind: 'codex', model: 'tg-model', permissionMode: 'ask' });
    setWorkspaceProviderSource('telegram', null, 'repo', 'tg-provider');
    setWorkspacePref('telegram', null, 'edited', { model: 'tg-edited' });
    markWorkspacePrefsMigrated('telegram');
    expect(adoptReadyChannels()).toEqual(['telegram']);
    setSharedProjectPref('edited', { model: 'picked-by-user' });

    setWorkspacePref('feishu', null, 'repo', { agentKind: 'claude-code', model: 'feishu-model' });
    setWorkspacePref('feishu', null, 'edited', { model: 'feishu-edited' });
    markWorkspacePrefsMigrated('feishu');
    expect(adoptReadyChannels()).toEqual(['feishu']);

    // 飞书排在 Telegram 前面: 整组换成飞书的(它没配来源, Telegram 的来源随之作废), 权限仍取更严的。
    expect(getSharedProjectPref('repo')).toMatchObject({
      agentKind: 'claude-code', model: 'feishu-model', permissionMode: 'ask',
    });
    expect(getWorkspaceProviderSource('shared', null, 'repo')).toBeNull();
    expect(getSharedProjectPref('edited').model).toBe('picked-by-user');
  });

  // 时序(评审指出): 用户把一个项目的配置清回默认之后, 晚到的渠道不得把它升级前的旧值带回来。
  // 最小失败输入: Telegram 并入 -> 用户清空 -> 飞书才第一次并入, 且飞书对这个项目有旧配置。
  it('用户清空过的项目, 晚并入的渠道不会把旧值带回来', () => {
    setWorkspacePref('telegram', null, 'repo', { model: 'tg-model' });
    markWorkspacePrefsMigrated('telegram');
    adoptReadyChannels();
    setSharedProjectPref('repo', { model: null });
    expect(listSharedProjectPrefs()).toEqual([]);

    setWorkspacePref('feishu', null, 'repo', { model: 'feishu-model', permissionMode: 'ask' });
    markWorkspacePrefsMigrated('feishu');
    adoptReadyChannels();

    // 模型保持「跟随默认」; 权限档仍按「只严不宽」收紧。
    expect(getSharedProjectPref('repo')).toMatchObject({ model: null, permissionMode: 'ask' });
  });

  // 持久化(评审指出): 设置页可以只换来源不填别的, 这样的项目没有偏好行, 并入时不得丢。
  it('只选过来源、没有偏好行的项目, 来源也并入共用那份', () => {
    setWorkspaceProviderSource('telegram', null, 'source-only', 'tg-provider', 'device-1');
    markWorkspacePrefsMigrated('telegram');
    adoptReadyChannels();
    expect(getWorkspaceProviderSource('shared', null, 'source-only')).toBe('tg-provider');
  });

  // 时序(评审指出): 只选过来源也算「配置过这个项目」, 同样按固定顺序、与连接先后无关。
  // 最小失败输入: 两种先后 —— 后面的渠道先并入来源、前面的渠道后到; 前面的渠道只有来源、
  // 后面的渠道后到且带着模型。
  it('只有来源的项目也按固定顺序归属: 前面的渠道后到会顶替, 后面的渠道后到顶替不了', () => {
    setWorkspaceProviderSource('telegram', null, 'late-feishu', 'tg-provider');
    setWorkspaceProviderSource('feishu', null, 'early-feishu', 'feishu-provider');
    markWorkspacePrefsMigrated('telegram');
    setWorkspacePref('telegram', null, 'early-feishu', { model: 'tg-model', permissionMode: 'ask' });
    // Telegram 先连上; 飞书的 early-feishu 来源此时已在本机, 但飞书还没并入。
    expect(adoptReadyChannels()).toEqual(['telegram']);
    expect(getWorkspaceProviderSource('shared', null, 'late-feishu')).toBe('tg-provider');
    expect(getSharedProjectPref('early-feishu').model).toBe('tg-model');

    setWorkspaceProviderSource('feishu', null, 'late-feishu', 'feishu-late-provider');
    markWorkspacePrefsMigrated('feishu');
    expect(adoptReadyChannels()).toEqual(['feishu']);

    expect(getWorkspaceProviderSource('shared', null, 'late-feishu')).toBe('feishu-late-provider');
    // 飞书对 early-feishu 只选过来源(模型跟随默认): 整组归飞书, Telegram 的模型让位, 权限仍取更严的。
    expect(getSharedProjectPref('early-feishu')).toMatchObject({ model: null, permissionMode: 'ask' });
    expect(getWorkspaceProviderSource('shared', null, 'early-feishu')).toBe('feishu-provider');
  });

  // 持久化上限(评审指出): 渠道已经写满时, 清掉一个项目再配另一个不得因为旧行还没推完而
  // 写不下去(那样新配置永远同步不出去)。对齐完成后再对齐一次不得再报告有改动。
  it('渠道写满后清一个再配一个仍能对齐, 对齐后不再产生写入', () => {
    for (let index = 0; index < 256; index += 1) setSharedProjectPref(`p${index}`, { model: 'm' });
    expect(projectSharedOntoChannel('telegram', [null])).toBe(true);
    setSharedProjectPref('p0', { model: null });
    setSharedProjectPref('replacement', { model: 'm' });

    expect(projectSharedOntoChannel('telegram', [null])).toBe(true);
    expect(getWorkspacePref('telegram', null, 'replacement').model).toBe('m');
    expect(getWorkspacePref('telegram', null, 'p0').model).toBeNull();
    expect(projectSharedOntoChannel('telegram', [null])).toBe(false);

  });

  // 时序(评审指出): 在 IM 里把一个项目的设置全部清回默认时, 快照里这一行是全空的, 本机不存
  // 全空行 —— 不能因此当成「快照里没有这一行」而把旧值又写回去。
  it('服务端快照里明确清空的行并回共用那份; 快照里没有的行不算', () => {
    setSharedProjectPref('cleared', { model: 'm1', permissionMode: 'ask' });
    setSharedProjectPref('absent', { model: 'm2' });
    const before = listSharedProjectPrefs();
    const server = [
      { workspace: 'cleared', model: null, effort: null, agentKind: null, permissionMode: null },
    ];
    // 落快照后本机这个渠道一行都没剩。
    expect(absorbChannelChange(before, rowsAfterServerSnapshot([], server))).toEqual(['cleared']);
    expect(listSharedProjectPrefs().map((row) => row.workspace)).toEqual(['absent']);
  });

  // 持久化上限(评审指出): Slack 多 workspace 每个 workspace 各有一整份, 条数上限按 workspace 各算。
  it('Slack 两个 workspace 各写满一百多个项目不会撞上限', () => {
    for (let index = 0; index < 130; index += 1) setSharedProjectPref(`p${index}`, { model: 'm' });
    expect(projectSharedOntoChannel('slack', ['T1', 'T2'])).toBe(true);
    expect(listWorkspacePrefs('slack').filter((row) => row.model === 'm')).toHaveLength(260);
  });

  // 时序(评审指出): 「从哪个渠道并入」的标记要跟着项目改名走, 旧名称下不得留。
  // 最小失败输入: (a) Telegram 并入后项目改名, 飞书才到 —— 飞书仍应按顺序顶替;
  // (b) 改名后用户改了模型, 又改回原名, 飞书才到 —— 用户改的不得被当成原样并入而顶替。
  it('项目改名后合并顺序照旧; 改名期间用户改过的配置改回原名后不会被顶替', () => {
    setWorkspacePref('telegram', null, 'app', { model: 'tg-app' });
    setWorkspacePref('telegram', null, 'tool', { model: 'tg-tool' });
    markWorkspacePrefsMigrated('telegram');
    adoptReadyChannels();

    moveWorkspacePrefsToRenamed([{ from: 'app', to: 'main' }, { from: 'tool', to: 'kit' }]);
    setSharedProjectPref('kit', { model: 'picked-by-user' });
    moveWorkspacePrefsToRenamed([{ from: 'kit', to: 'tool' }]);

    setWorkspacePref('feishu', null, 'main', { model: 'feishu-main' });
    setWorkspacePref('feishu', null, 'tool', { model: 'feishu-tool' });
    markWorkspacePrefsMigrated('feishu');
    adoptReadyChannels();

    expect(getSharedProjectPref('main').model).toBe('feishu-main');
    expect(getSharedProjectPref('tool').model).toBe('picked-by-user');
  });

  // 规则(2026-11-13 用户裁决): 旧版「新对话配置」留下的全局默认在升级时直接清掉, 不等用户手动点。
  // 只清一次: 之后这份设置再有值(别的入口写的)不得在每次启动时被抹掉。
  // 最小失败输入: 第一次启动时改过 -> 清; 第二次启动时又是改过的 -> 不动。tier: unit。
  it('旧版全局默认只在升级后第一次启动时清一次', () => {
    const reset = vi.fn();
    expect(clearLegacyGlobalDefaultsOnce({ isCustomized: () => true, reset })).toBe(true);
    expect(reset).toHaveBeenCalledTimes(1);

    expect(clearLegacyGlobalDefaultsOnce({ isCustomized: () => true, reset })).toBe(false);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  // 没改过的电脑: 不调用重置, 但同样记为已处理 —— 以后再写进去的值不属于「旧版遗留」。
  it('从没改过全局默认的电脑不重置, 之后写入的值也不会被清', () => {
    const reset = vi.fn();
    expect(clearLegacyGlobalDefaultsOnce({ isCustomized: () => false, reset })).toBe(false);
    expect(clearLegacyGlobalDefaultsOnce({ isCustomized: () => true, reset })).toBe(false);
    expect(reset).not.toHaveBeenCalled();
  });

  // 规则(2026-11-13 用户裁决): 项目移除后清掉按它的名称存的全部配置 —— 共用那份、各渠道给
  // 服务端看的行(收成待清空, 推上去后服务端也清)、以及模型来源; 别的项目不受影响。
  // 最小失败输入: 两个项目都有配置, 移除其中一个。tier: unit。
  it('移除的项目: 共用配置、各渠道行与模型来源一并清掉, 其它项目不动', () => {
    setSharedProjectPref('gone', { model: 'm1', permissionMode: 'bypassPermissions' });
    setSharedProjectPref('kept', { model: 'm2' });
    setWorkspaceProviderSource('shared', null, 'gone', 'p1');
    setWorkspaceProviderSource('telegram', null, 'gone', 'p-old');
    setWorkspaceProviderSource('shared', null, 'kept', 'p2');
    markWorkspacePrefsMigrated('telegram');
    adoptChannelPrefs('telegram');
    projectSharedOntoChannel('telegram', [null]);

    expect(clearWorkspaceProviderSourcesFor(['gone'])?.map((entry) => entry.workspace)).toEqual(['kept']);
    expect(clearWorkspacePrefsFor(['gone'])).toEqual(['telegram']);

    expect(listSharedProjectPrefs().map((row) => row.workspace)).toEqual(['kept']);
    expect(getSharedProjectPref('gone')).toMatchObject({ model: null, permissionMode: null });
    expect(getWorkspacePref('telegram', null, 'gone')).toMatchObject({ model: null, permissionMode: null });
    expect(getWorkspacePref('telegram', null, 'kept').model).toBe('m2');
    // 渠道那一行等着把「清空」推给服务端。
    const pending = reconcileWorkspacePrefsForMirror('telegram', [
      { workspace: 'gone', model: 'm1', effort: null, agentKind: null, permissionMode: 'bypassPermissions' },
      { workspace: 'kept', model: 'm2', effort: null, agentKind: null, permissionMode: null },
    ]).map((candidate) => candidate.prefs.workspace);
    expect(pending).toContain('gone');
    // 没有可清的时候不产生写入。
    expect(clearWorkspacePrefsFor(['gone'])).toEqual([]);
    expect(clearWorkspaceProviderSourcesFor(['gone'])).toBeNull();
  });

  // 时序(评审指出): 项目移除时, 还没连上过的渠道的旧偏好还在服务端, 本机清不到。之后同名的
  // 新项目出现, 那个渠道才第一次连上并入 —— 上一个项目的模型和权限不得并进新项目。
  // 最小失败输入: Telegram 已并入 -> 移除 app -> 飞书带着 app 的旧行第一次并入。tier: unit。
  it('移除项目之后才并入的渠道, 不会把上一个项目的配置带进同名的新项目', () => {
    setWorkspacePref('telegram', null, 'app', { model: 'tg-app' });
    markWorkspacePrefsMigrated('telegram');
    adoptReadyChannels();
    clearWorkspacePrefsFor(['app']);

    setWorkspacePref('feishu', null, 'app', { model: 'old-feishu-app', permissionMode: 'ask' });
    setWorkspacePref('feishu', null, 'other', { model: 'feishu-other' });
    markWorkspacePrefsMigrated('feishu');
    expect(adoptReadyChannels()).toEqual(['feishu']);

    expect(getSharedProjectPref('app')).toMatchObject({ model: null, permissionMode: null });
    expect(getSharedProjectPref('other').model).toBe('feishu-other');
    // 渠道那行随后被对齐清掉, 等着推给服务端。
    expect(projectSharedOntoChannel('feishu', [null])).toBe(true);
    expect(getWorkspacePref('feishu', null, 'app').model).toBeNull();
  });

  // 持久化: 侧栏给项目改名时, 共用那份跟着挪到新名称下, 旧名称下不留行。
  it('项目改名时共用那份跟到新名称', () => {
    setSharedProjectPref('old-name', { model: 'm1' });
    moveWorkspacePrefsToRenamed([{ from: 'old-name', to: 'new-name' }]);
    expect(listSharedProjectPrefs().map((row) => [row.workspace, row.model])).toEqual([['new-name', 'm1']]);
  });
});
