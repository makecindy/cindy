/**
 * deviceLinkCreateArgs.test.ts —— device-link 远程建会话参数组装(「归属一致」行为断言)。
 *
 * 锁住历史上真实出过的 bug:控制端在远程项目下建会话,被控端却把它建成项目外的独立会话。
 * 根因是 create 参数 workspaceKind 没传 'project'。这里直接对组装函数做行为断言(而非 grep
 * 源码接线),确保带项目目录时 workspaceKind 必为 'project' → 两端归属一致。
 *
 * 2026-07(#807)起 workingDir 可缺省:「在对端设备上开不绑项目的对话」是合法意图。
 * 归属一致的断言因此变成**双向**的 —— 有目录必 'project',无目录必 'dialogue',
 * 且无目录时不能把 workingDir 塞进 payload(否则被控端会拿空串去校验路径)。
 */
import { describe, it, expect } from 'vitest';

import type { CatalogModel, ProviderView } from '@cindy/model-providers';

import {
  buildDeviceLinkCreateArgs,
  buildProvisionalRemoteSession,
  resolveDeviceLinkSubmission,
} from '@/features/cc-agent/deviceLinkCreateArgs';

function catalogModel(id: string): CatalogModel {
  return {
    id,
    name: id,
    group: 'test',
    sortOrder: 0,
    contextWindow: 200_000,
    efforts: [],
    defaultEffort: null,
    supportsFastMode: false,
    status: 'active',
  } as CatalogModel;
}

/** 被控端供应商目录的最小形态(与 draftModelCalibration.test.ts 同款构造)。 */
function deviceProvider(id: string, connected: boolean, modelIds: string[]): ProviderView {
  return {
    id,
    name: id,
    source: 'builtin',
    agents: ['claude-code'],
    models: { 'claude-code': modelIds.map(catalogModel) },
    routing: {
      'claude-code': { upstream: 'https://provider.test', authStrategy: 'none' },
    },
    auth: { method: 'oauth' },
    connected,
  } as unknown as ProviderView;
}

describe('buildDeviceLinkCreateArgs', () => {
  it('归属一致核心:workspaceKind 恒为 project(被控端据此挂到项目下,不独立)', () => {
    const args = buildDeviceLinkCreateArgs({
      agentKind: 'cc',
      workingDir: '/host/proj',
      model: 'claude-sonnet-4-6',
      effort: 'medium',
      permissionMode: 'acceptEdits',
      fastMode: false,
    });
    expect(args.workspaceKind).toBe('project');
    expect(args.workingDir).toBe('/host/proj');
  });

  it('agentKind 归一到 maker-core 形态:cc → claude-code,codex → codex', () => {
    expect(buildDeviceLinkCreateArgs({ agentKind: 'cc', workingDir: '/p', model: 'm', effort: 'medium', permissionMode: 'acceptEdits', fastMode: false }).agentKind).toBe('claude-code');
    expect(buildDeviceLinkCreateArgs({ agentKind: 'codex', workingDir: '/p', model: 'm', effort: 'high', permissionMode: 'auto', fastMode: false }).agentKind).toBe('codex');
  });

  it('其余字段原样透传(model/effort/permissionMode/fastMode)', () => {
    const args = buildDeviceLinkCreateArgs({
      agentKind: 'codex',
      workingDir: '/host/repo',
      model: 'gpt-5.5',
      effort: 'high',
      permissionMode: 'auto',
      fastMode: true,
    });
    expect(args).toEqual({
      agentKind: 'codex',
      workingDir: '/host/repo',
      workspaceKind: 'project',
      model: 'gpt-5.5',
      effort: 'high',
      permissionMode: 'auto',
      fastMode: true,
    });
  });

  // [12] 远程 create 透传 extraDirs:被控端 bootstrapSession 再按 set-extra-dirs 同款校验,
  // 这里只锁「控制端是否把草稿 extraDirs 带进 create args」这一接线。
  it('非空 extraDirs 透传进 args', () => {
    const args = buildDeviceLinkCreateArgs({
      agentKind: 'cc',
      workingDir: '/host/proj',
      model: 'claude-sonnet-4-6',
      effort: 'medium',
      permissionMode: 'acceptEdits',
      fastMode: false,
      extraDirs: ['/host/refs', '/host/docs'],
    });
    expect(args.extraDirs).toEqual(['/host/refs', '/host/docs']);
  });

  it('空数组 / 缺省 extraDirs 不出现在 args(payload 干净,被控端只在非空时才校验)', () => {
    const base = {
      agentKind: 'cc' as const,
      workingDir: '/host/proj',
      model: 'm',
      effort: 'medium' as const,
      permissionMode: 'acceptEdits' as const,
      fastMode: false,
    };
    expect('extraDirs' in buildDeviceLinkCreateArgs({ ...base, extraDirs: [] })).toBe(false);
    expect('extraDirs' in buildDeviceLinkCreateArgs({ ...base, extraDirs: undefined })).toBe(false);
    expect('extraDirs' in buildDeviceLinkCreateArgs(base)).toBe(false);
  });

  // P2:草稿选定的来源(被控端供应商)透传进 create args,被控端 bootstrapSession 落 provider_id。
  const base = {
    agentKind: 'codex' as const,
    workingDir: '/host/repo',
    model: 'gpt-5.5',
    effort: 'high' as const,
    permissionMode: 'auto' as const,
    fastMode: false,
  };

  it('非空 providerId 透传进 args(被控端 create 时落 provider_id → 首个请求即按所选来源路由)', () => {
    expect(buildDeviceLinkCreateArgs({ ...base, providerId: 'openai' }).providerId).toBe('openai');
  });

  it('null / 空 / 缺省 providerId 不出现在 args(跟随默认路由 → provider_id 留 NULL,no-break)', () => {
    expect('providerId' in buildDeviceLinkCreateArgs({ ...base, providerId: null })).toBe(false);
    expect('providerId' in buildDeviceLinkCreateArgs({ ...base, providerId: '' })).toBe(false);
    expect('providerId' in buildDeviceLinkCreateArgs(base)).toBe(false);
  });

  // 远程 worktree:控制端先经隧道调被控端 worktree:create(以预生成 id 登记绑定),
  // 再以同一 id + worktree 路径建会话 —— id 两步同值,被控端 close-session 才能按绑定回收。
  it('预生成 id 透传进 args(远程 worktree 流程:与 worktree:create 登记的绑定同 id)', () => {
    const args = buildDeviceLinkCreateArgs({
      ...base,
      id: 'session-preset-1',
      workingDir: '/host/repo/.xdt-worktrees/auto-x1',
    });
    expect(args.id).toBe('session-preset-1');
    expect(args.workingDir).toBe('/host/repo/.xdt-worktrees/auto-x1');
    expect(args.workspaceKind).toBe('project');
  });

  it('缺省 id 不出现在 args(非 worktree 流程由被控端自行生成)', () => {
    expect('id' in buildDeviceLinkCreateArgs(base)).toBe(false);
  });

  // #807:跨设备纯对话。每台设备都有自己的一批对话,「在对端开个不绑项目的对话」必须走通。
  describe('无项目目录 = 在该设备上建 standalone dialogue', () => {
    const noDir = {
      agentKind: 'cc' as const,
      model: 'claude-sonnet-4-6',
      effort: 'medium' as const,
      permissionMode: 'acceptEdits' as const,
      fastMode: false,
    };

    it('缺省 workingDir → workspaceKind 为 dialogue,且不带 workingDir 字段', () => {
      const args = buildDeviceLinkCreateArgs(noDir);
      expect(args.workspaceKind).toBe('dialogue');
      expect('workingDir' in args).toBe(false);
    });

    it('空串 / 纯空白 workingDir 同样落到 dialogue(不把脏值当真实路径送去被控端校验)', () => {
      for (const dir of ['', '   ', '\t']) {
        const args = buildDeviceLinkCreateArgs({ ...noDir, workingDir: dir });
        expect(args.workspaceKind).toBe('dialogue');
        expect('workingDir' in args).toBe(false);
      }
    });

    it('归属一致是双向的:两个字段同源派生,不可能出现「带目录却标 dialogue」', () => {
      expect(buildDeviceLinkCreateArgs({ ...noDir, workingDir: '/host/proj' }).workspaceKind).toBe('project');
      expect(buildDeviceLinkCreateArgs(noDir).workspaceKind).toBe('dialogue');
    });

    it('workingDir 两端去空白后透传(避免被控端 guard 因首尾空格判成不同目录)', () => {
      expect(buildDeviceLinkCreateArgs({ ...noDir, workingDir: '  /host/proj  ' }).workingDir).toBe('/host/proj');
    });

    it('dialogue 也照样透传 extraDirs / providerId(对话同样可带引用目录与指定来源)', () => {
      const args = buildDeviceLinkCreateArgs({
        ...noDir,
        extraDirs: ['/host/refs'],
        providerId: 'anthropic',
      });
      expect(args.workspaceKind).toBe('dialogue');
      expect(args.extraDirs).toEqual(['/host/refs']);
      expect(args.providerId).toBe('anthropic');
    });
  });
});

describe('buildProvisionalRemoteSession', () => {
  const NOW = '2026-07-30T03:00:00.000Z';
  const project = buildDeviceLinkCreateArgs({
    agentKind: 'codex',
    workingDir: '/peer/proj',
    model: 'gpt-5.4',
    effort: 'high',
    permissionMode: 'plan',
    fastMode: true,
    extraDirs: ['/peer/refs'],
    providerId: 'openai',
  });
  const dialogue = buildDeviceLinkCreateArgs({
    agentKind: 'cc',
    model: 'sonnet',
    effort: 'medium',
    permissionMode: 'default',
    fastMode: false,
  });

  it('workingDir 取被控端 create 响应的 workDir —— 纯对话的运行目录控制端根本猜不到', () => {
    // 这条是整个临时行存在的理由:SessionView 的 delayed-create 交接要求 workingDir 非空,
    // 而 dialogue 的运行目录由被控端分配,只能从响应里拿。
    const row = buildProvisionalRemoteSession({
      sessionId: 's-1',
      workDir: '/peer/.cindy/dialogues/s-1',
      args: dialogue,
      nowIso: NOW,
    });
    expect(row.workingDir).toBe('/peer/.cindy/dialogues/s-1');
    expect(row.workspaceKind).toBe('dialogue');
  });

  it('运行配置照抄刚提交的 args,不另推一遍(否则临时行会和对端实际建的不一致)', () => {
    const row = buildProvisionalRemoteSession({
      sessionId: 's-2',
      workDir: '/peer/proj',
      args: project,
      nowIso: NOW,
    });
    expect(row.model).toBe('gpt-5.4');
    expect(row.effort).toBe('high');
    expect(row.permissionMode).toBe('plan');
    expect(row.fastMode).toBe(true);
    expect(row.providerId).toBe('openai');
    expect(row.extraDirs).toEqual(['/peer/refs']);
    expect(row.workspaceKind).toBe('project');
  });

  it('agentKind 转回本机形态(args 里是 maker-core 形态)', () => {
    expect(
      buildProvisionalRemoteSession({ sessionId: 's', workDir: '/w', args: project, nowIso: NOW })
        .agentKind,
    ).toBe('codex');
    expect(
      buildProvisionalRemoteSession({ sessionId: 's', workDir: '/w', args: dialogue, nowIso: NOW })
        .agentKind,
    ).toBe('cc');
  });

  it('新会话的确定初值:active / 未置顶 / 计数为 0 / 标题与被控端 create 的默认值一致', () => {
    const row = buildProvisionalRemoteSession({
      sessionId: 's-3',
      workDir: '/w',
      args: dialogue,
      nowIso: NOW,
    });
    expect(row.status).toBe('active');
    expect(row.pinnedAt).toBeNull();
    expect(row.clearedAt).toBeNull();
    expect(row.sdkSessionId).toBeNull();
    expect(row.totalTokenUsage).toBe(0);
    // 被控端 create 出来的标题正是 'New Maker'(auto-title 的覆写判据也认这个值)。
    expect(row.title).toBe('New Maker');
  });

  it('userSendAt 置为当下:用户此刻正在发第一条,侧边栏该立刻浮到顶部(与本机路径同口径)', () => {
    const row = buildProvisionalRemoteSession({
      sessionId: 's-4',
      workDir: '/w',
      args: dialogue,
      nowIso: NOW,
    });
    expect(row.userSendAt).toBe(NOW);
    expect(row.createdAt).toBe(NOW);
    expect(row.updatedAt).toBe(NOW);
  });

  it('providerId 缺省(跟随默认路由)时落 null,不留 undefined', () => {
    const row = buildProvisionalRemoteSession({
      sessionId: 's-5',
      workDir: '/w',
      args: dialogue,
      nowIso: NOW,
    });
    expect(row.providerId).toBeNull();
    expect(row.extraDirs).toEqual([]);
  });
});

/**
 * resolveDeviceLinkSubmission —— 远程建会话参数的**唯一入口**。
 *
 * 这组断言存在的理由是结构性的:在它之前,「普通发送」与「新建目标」各自推导这组值,于是任何
 * 一条校准规则漏加在一边就长出一个只在其中一条路径上复现的缺陷 —— 第 25 轮的 providerId
 * 正是如此(发送有 ChatInput 兜底、建目标直接把未认证来源写进被控端 sessions.provider_id)。
 * 最后一条断言把「两条路径必须等价」本身变成可执行的检查。
 */
describe('resolveDeviceLinkSubmission', () => {
  const AGENT = 'claude-code' as const;
  const candidate = {
    model: 'claude-sonnet-4-6',
    effort: 'medium' as const,
    permissionMode: 'default' as const,
    fastMode: false,
  };

  it('仍然有效的显式来源原样保留', () => {
    const args = resolveDeviceLinkSubmission({
      agentKind: 'cc',
      workingDir: '/peer/proj',
      candidate: { ...candidate, providerId: 'anthropic' },
      deviceProviders: [deviceProvider('anthropic', true, ['claude-sonnet-4-6'])],
      capabilityAgentKind: AGENT,
    });
    expect(args.providerId).toBe('anthropic');
    // 转调底层组装:归属一致的派生不受影响。
    expect(args.workspaceKind).toBe('project');
    expect(args.workingDir).toBe('/peer/proj');
  });

  it('被控端已断开该来源时不得原样透传 —— 回落到该模型的原生默认来源', () => {
    const args = resolveDeviceLinkSubmission({
      agentKind: 'cc',
      candidate: { ...candidate, providerId: 'stale-source' },
      deviceProviders: [deviceProvider('anthropic', true, ['claude-sonnet-4-6'])],
      capabilityAgentKind: AGENT,
    });
    // 关键反向断言:绝不能等于那个已失效的显式选择。
    expect(args.providerId).not.toBe('stale-source');
    expect(args.providerId).toBe('anthropic');
  });

  it('来源仍在但已不提供当前模型时同样回落', () => {
    const args = resolveDeviceLinkSubmission({
      agentKind: 'cc',
      candidate: { ...candidate, providerId: 'other' },
      deviceProviders: [
        deviceProvider('other', true, ['some-other-model']),
        deviceProvider('anthropic', true, ['claude-sonnet-4-6']),
      ],
      capabilityAgentKind: AGENT,
    });
    expect(args.providerId).toBe('anthropic');
  });

  it('没有任何来源提供该模型 → 不带 providerId(交回被控端默认路由,provider_id 留 NULL)', () => {
    const args = resolveDeviceLinkSubmission({
      agentKind: 'cc',
      candidate: { ...candidate, providerId: 'stale-source' },
      deviceProviders: [deviceProvider('other', true, ['some-other-model'])],
      capabilityAgentKind: AGENT,
    });
    expect(args.providerId).toBeUndefined();
  });

  it('目录尚未加载完(空数组)时不带 providerId,而不是把失效值送出去', () => {
    const args = resolveDeviceLinkSubmission({
      agentKind: 'cc',
      candidate: { ...candidate, providerId: 'anything' },
      deviceProviders: [],
      capabilityAgentKind: AGENT,
    });
    expect(args.providerId).toBeUndefined();
  });

  it('无项目目录 → dialogue,且不把 workingDir 塞进 payload(转调派生未被绕过)', () => {
    const args = resolveDeviceLinkSubmission({
      agentKind: 'codex',
      candidate: { ...candidate, providerId: null },
      deviceProviders: [deviceProvider('anthropic', true, ['claude-sonnet-4-6'])],
      capabilityAgentKind: AGENT,
      extraDirs: ['/peer/ref'],
      id: 'preset-id',
    });
    expect(args.workspaceKind).toBe('dialogue');
    expect('workingDir' in args).toBe(false);
    expect(args.agentKind).toBe('codex');
    expect(args.extraDirs).toEqual(['/peer/ref']);
    expect(args.id).toBe('preset-id');
  });

  it('同一组候选值:发送路径与建目标路径的输出必须完全一致', () => {
    // 两条路径的差别只在候选值**从哪来**(ChatInput 回传 / 组件派生),不在如何校准与组装。
    // 喂同一组值就必须得到同一份 args —— 这正是第 25 轮那类「只在一条路径上复现」的缺陷
    // 在结构上不可能再出现的原因。
    const shared = {
      agentKind: 'cc' as const,
      workingDir: '/peer/proj',
      extraDirs: ['/peer/ref'],
      deviceProviders: [deviceProvider('anthropic', true, ['claude-sonnet-4-6'])],
      capabilityAgentKind: AGENT,
    };
    const fromSend = resolveDeviceLinkSubmission({
      ...shared,
      candidate: { ...candidate, providerId: 'stale-source' },
    });
    const fromGoal = resolveDeviceLinkSubmission({
      ...shared,
      candidate: { ...candidate, providerId: 'stale-source' },
    });
    expect(fromGoal).toEqual(fromSend);
    // 且两者都已被校准(不是「一致地都错」)。
    expect(fromSend.providerId).toBe('anthropic');
  });
});
