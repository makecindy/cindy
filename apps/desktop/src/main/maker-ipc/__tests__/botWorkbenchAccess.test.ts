import { describe, expect, it, vi } from 'vitest';

import {
  authorizeWorkbenchTarget,
  createBotWorkbenchAccess,
  type BotWorkbenchAccessDeps,
  type WorkbenchTargetFacts,
} from '../botWorkbenchAccess.js';

const PROJECT = '/Users/me/Code/tapmon-art';

function target(patch: Partial<WorkbenchTargetFacts> = {}): WorkbenchTargetFacts {
  return {
    id: 'task-1',
    status: 'active',
    source: 'desktop',
    remoteHostId: null,
    workingDir: PROJECT,
    orcaRole: null,
    botLinked: false,
    delegationChild: false,
    ...patch,
  };
}

function setup(overrides: Partial<BotWorkbenchAccessDeps> = {}) {
  const deps: BotWorkbenchAccessDeps = {
    resolveCaller: vi.fn(async () => ({ ok: true as const, botId: 'bot-1' })),
    readProjectDirs: vi.fn(async () => [PROJECT]),
    readTarget: vi.fn(async () => target()),
    listProjectTasks: vi.fn(async () => []),
    listDelegations: vi.fn(async () => new Map()),
    readActivityPhase: vi.fn(async () => null),
    listSchedules: vi.fn(async () => []),
    sendToSession: vi.fn(async () => ({ ok: true as const, wakeKind: 'queued', queuedMessageId: 'q-1' })),
    stopSessionTurn: vi.fn(async () => ({ ok: true as const, status: 'requested' as const })),
    caseInsensitive: false,
    ...overrides,
  };
  return { deps, access: createBotWorkbenchAccess(deps) };
}

describe('authorizeWorkbenchTarget', () => {
  it('allows an ordinary local task inside a handed-over project, including its worktrees', () => {
    expect(authorizeWorkbenchTarget(target(), [PROJECT], false)).toEqual({ ok: true, projectDir: PROJECT });
    expect(
      authorizeWorkbenchTarget(target({ workingDir: `${PROJECT}/.cindy-worktrees/fix-icons` }), [PROJECT], false),
    ).toEqual({ ok: true, projectDir: PROJECT });
  });

  it.each([
    ['missing', null, 'TASK_NOT_FOUND'],
    ['deleted', target({ status: 'deleted' }), 'TASK_NOT_FOUND'],
    ['a Bot hidden session (link row)', target({ botLinked: true }), 'TASK_NOT_ACCESSIBLE'],
    ['a Bot hidden session (source)', target({ source: 'bot' }), 'TASK_NOT_ACCESSIBLE'],
    ['remote', target({ remoteHostId: 'ssh-1' }), 'TASK_REMOTE'],
    ['archived', target({ status: 'archived' }), 'TASK_ARCHIVED'],
    ['a background task', target({ delegationChild: true }), 'TASK_IS_BACKGROUND_TASK'],
    ['an automation run', target({ source: 'scheduler' }), 'TASK_NOT_SUPPORTED'],
    ['an IM channel task', target({ source: 'telegram' }), 'TASK_NOT_SUPPORTED'],
    ['an Orca worker', target({ orcaRole: 'worker' }), 'TASK_NOT_SUPPORTED'],
    ['outside the project', target({ workingDir: '/Users/me/Code/other' }), 'TASK_OUTSIDE_WORKBENCH'],
    ['a sibling folder sharing the prefix', target({ workingDir: `${PROJECT}-old` }), 'TASK_OUTSIDE_WORKBENCH'],
    ['a dialogue task without a directory', target({ workingDir: null }), 'TASK_OUTSIDE_WORKBENCH'],
  ])('rejects %s', (_label, facts, errorCode) => {
    expect(authorizeWorkbenchTarget(facts, [PROJECT], false)).toMatchObject({ ok: false, errorCode });
  });

  it('rejects every target when no project was handed over', () => {
    expect(authorizeWorkbenchTarget(target(), [], false)).toMatchObject({
      ok: false,
      errorCode: 'TASK_OUTSIDE_WORKBENCH',
    });
  });

  it('folds case only on case-insensitive platforms', () => {
    const upper = target({ workingDir: 'C:/Code/Tapmon' });
    expect(authorizeWorkbenchTarget(upper, ['C:/code/tapmon'], true)).toMatchObject({ ok: true });
    expect(authorizeWorkbenchTarget(upper, ['C:/code/tapmon'], false)).toMatchObject({ ok: false });
  });
});

describe('workbench continue / stop', () => {
  it('continues a task through the existing send path, as the calling Bot', async () => {
    const { deps, access } = setup();
    await expect(access.continueTask({ callerSessionId: 'bot-main', taskId: 'task-1', message: ' 把导出做完 ' }))
      .resolves.toEqual({ ok: true, taskId: 'task-1', delivery: 'queued', queuedMessageId: 'q-1' });
    expect(deps.sendToSession).toHaveBeenCalledWith({
      targetSessionId: 'task-1',
      message: '把导出做完',
      dispatcherSessionId: 'bot-main',
    });
  });

  it('stops the current turn through the existing graceful stop path', async () => {
    const { deps, access } = setup();
    await expect(access.stopTask({ callerSessionId: 'bot-main', taskId: 'task-1' }))
      .resolves.toEqual({ ok: true, taskId: 'task-1', status: 'requested' });
    expect(deps.stopSessionTurn).toHaveBeenCalledWith({ targetSessionId: 'task-1' });
  });

  it('refuses a caller that is not a Bot main task and never touches the target', async () => {
    const { deps, access } = setup({
      resolveCaller: vi.fn(async () => ({
        ok: false as const,
        errorCode: 'BOT_MAIN_TASK_REQUIRED',
        message: 'only the main task',
      })),
    });
    await expect(access.continueTask({ callerSessionId: 'group-lane', taskId: 'task-1', message: 'hi' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'BOT_MAIN_TASK_REQUIRED' });
    await expect(access.stopTask({ callerSessionId: 'group-lane', taskId: 'task-1' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'BOT_MAIN_TASK_REQUIRED' });
    expect(deps.readTarget).not.toHaveBeenCalled();
    expect(deps.sendToSession).not.toHaveBeenCalled();
    expect(deps.stopSessionTurn).not.toHaveBeenCalled();
  });

  it.each([
    ['outside the handed-over project', target({ workingDir: '/elsewhere' }), 'TASK_OUTSIDE_WORKBENCH'],
    ['a Bot hidden session', target({ botLinked: true }), 'TASK_NOT_ACCESSIBLE'],
    ['a remote task', target({ remoteHostId: 'ssh-1' }), 'TASK_REMOTE'],
    ['an archived task', target({ status: 'archived' }), 'TASK_ARCHIVED'],
  ])('denies %s without sending or stopping', async (_label, facts, errorCode) => {
    const { deps, access } = setup({ readTarget: vi.fn(async () => facts) });
    await expect(access.continueTask({ callerSessionId: 'bot-main', taskId: 'task-1', message: 'hi' }))
      .resolves.toMatchObject({ ok: false, errorCode });
    await expect(access.stopTask({ callerSessionId: 'bot-main', taskId: 'task-1' }))
      .resolves.toMatchObject({ ok: false, errorCode });
    expect(deps.sendToSession).not.toHaveBeenCalled();
    expect(deps.stopSessionTurn).not.toHaveBeenCalled();
  });

  it('stops before delivery when the account changes mid-call', async () => {
    const { deps, access } = setup({ isOwnerScopeCurrent: () => false });
    await expect(access.continueTask({ callerSessionId: 'bot-main', taskId: 'task-1', message: 'hi' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'OWNER_SCOPE_CHANGED' });
    expect(deps.sendToSession).not.toHaveBeenCalled();
  });

  it('rejects empty or oversized messages', async () => {
    const { deps, access } = setup();
    await expect(access.continueTask({ callerSessionId: 'bot-main', taskId: 'task-1', message: '  ' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    await expect(access.continueTask({ callerSessionId: 'bot-main', taskId: 'task-1', message: 'x'.repeat(4_001) }))
      .resolves.toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(deps.resolveCaller).not.toHaveBeenCalled();
  });
});

describe('workbench snapshot', () => {
  it('projects tasks, background tasks and project automations from host signals', async () => {
    const phases: Record<string, string | null> = {
      running: 'running',
      asking: 'needs-interaction',
      broken: 'error',
      idle: null,
      'delegated-1': null,
    };
    const { access } = setup({
      listDelegations: vi.fn(async () => new Map([['delegated-1', 'queued' as const]])),
      listProjectTasks: vi.fn(async () => [
        { id: 'idle', title: '整理评审意见', workingDir: PROJECT, agentKind: 'cc', summary: '12 条意见', lastActiveAt: 5 },
        { id: 'running', title: '导出图标', workingDir: PROJECT, agentKind: 'cc', summary: null, lastActiveAt: 4 },
        { id: 'asking', title: '合并命名修正', workingDir: PROJECT, agentKind: 'codex', summary: null, lastActiveAt: 3 },
        { id: 'broken', title: '压缩原画', workingDir: PROJECT, agentKind: 'cc', summary: null, lastActiveAt: 2 },
        { id: 'delegated-1', title: '过一遍导出目录', workingDir: PROJECT, agentKind: 'pi', summary: null, lastActiveAt: 1 },
        { id: 'elsewhere', title: '别的项目', workingDir: '/other', agentKind: 'cc', summary: null, lastActiveAt: 9 },
      ]),
      readActivityPhase: vi.fn(async (id: string) => phases[id] ?? null),
      listSchedules: vi.fn(async () => [
        { id: 's-1', name: '检查 PR', status: 'active', workspaceKind: 'project', workingDir: PROJECT, nextFireAt: 0 },
        { id: 's-2', name: '别处的自动化', status: 'active', workspaceKind: 'project', workingDir: '/other' },
        { id: 's-3', name: '伙伴内部', status: 'active', source: 'bot', workspaceKind: 'project', workingDir: PROJECT },
      ]),
    });
    const result = await access.get({ callerSessionId: 'bot-main' });
    if (!result.ok) throw new Error('expected ok');
    const byId = new Map(result.workbench.tasks.map((task) => [task.id, task]));
    expect(byId.get('running')).toMatchObject({ state: 'running', kind: 'existing', project: 'tapmon-art' });
    expect(byId.get('asking')).toMatchObject({ state: 'waiting' });
    expect(byId.get('broken')).toMatchObject({ state: 'stopped' });
    expect(byId.get('idle')).toMatchObject({ state: 'done', summary: '12 条意见' });
    expect(byId.get('delegated-1')).toMatchObject({ state: 'queued', kind: 'delegated' });
    expect(byId.has('elsewhere')).toBe(false);
    expect(result.workbench.tasks.at(-1)?.state).toBe('done');
    expect(result.workbench.automations.map((item) => [item.id, item.state])).toEqual([['s-1', 'automation']]);
    expect(result.workbench.counts).toMatchObject({ running: 1, waiting: 1, queued: 1, stopped: 1, automation: 1, done: 1 });
    expect(result.workbench.totalTasks).toBe(5);
  });

  it('reads nothing from projects before any project is handed over', async () => {
    const { deps, access } = setup({ readProjectDirs: vi.fn(async () => []) });
    const result = await access.get({ callerSessionId: 'bot-main' });
    expect(result).toMatchObject({ ok: true, workbench: { projects: [], tasks: [], automations: [] } });
    expect(deps.listProjectTasks).not.toHaveBeenCalled();
    expect(deps.listSchedules).not.toHaveBeenCalled();
  });
});
