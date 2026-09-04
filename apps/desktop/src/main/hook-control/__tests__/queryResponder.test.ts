/**
 * hook-control/queryResponder 单测: query.request -> query.response 的应答
 * 构造(workspaces / models 两种 kind), 重点是 models 应答携带每 agent 的
 * permissionModes(label = displayName 原样透传)与数据源抛错时的 ok:false。
 * 纯函数注入(规则 14), 无 Electron / maker。
 */

import { describe, expect, it, vi } from 'vitest';

import { buildQueryResponse, type QueryResponderDeps } from '../queryResponder';

const DEPS: QueryResponderDeps = {
  listWorkspaces: () => ['xdmaker', 'blog'],
  listSessions: () => [{ id: 's1', title: 'Fix login', workspace: 'xdmaker', lastActiveAt: 10 }],
  listAgentModels: () => [
    {
      agentKind: 'claude-code',
      models: [
        {
          id: 'claude-opus-4-8',
          displayName: 'Opus 4.8',
          efforts: ['low', 'high'],
          defaultEffort: 'high',
          group: 'anthropic',
        },
      ],
      permissionModes: [
        { id: 'ask', displayName: 'Ask permissions' },
        { id: 'acceptEdits', displayName: 'Auto accept edits' },
        { id: 'bypassPermissions', displayName: 'Bypass permissions' },
      ],
    },
    {
      agentKind: 'codex',
      models: [{ id: 'gpt-5.5', displayName: 'GPT-5.5', efforts: ['low'], defaultEffort: 'low' }], // 无 group -> 线上 null
      permissionModes: [
        { id: 'ask', displayName: 'Default permissions' },
        { id: 'bypassPermissions', displayName: 'Full access' },
      ],
    },
  ],
};

describe('buildQueryResponse', () => {
  it('workspaces: 透传别名清单', async () => {
    const res = await buildQueryResponse(DEPS, { queryId: 'q1', kind: 'workspaces' });
    expect(res).toEqual({
      queryId: 'q1',
      kind: 'workspaces',
      ok: true,
      error: null,
      workspaces: ['xdmaker', 'blog'],
    });
  });

  it('models: 每 agent 携带模型清单与 permissionModes(label=displayName)', async () => {
    const res = await buildQueryResponse(DEPS, { queryId: 'q2', kind: 'models' });
    expect(res.ok).toBe(true);
    expect(res.agents).toHaveLength(2);
    expect(res.agents?.[0]).toEqual({
      agentKind: 'claude-code',
      models: [
        {
          id: 'claude-opus-4-8',
          label: 'Opus 4.8',
          efforts: ['low', 'high'],
          defaultEffort: 'high',
          group: 'anthropic',
        },
      ],
      permissionModes: [
        { id: 'ask', label: 'Ask permissions' },
        { id: 'acceptEdits', label: 'Auto accept edits' },
        { id: 'bypassPermissions', label: 'Bypass permissions' },
      ],
    });
    expect(res.agents?.[1].models[0].group).toBeNull();
    expect(res.agents?.[1].permissionModes).toEqual([
      { id: 'ask', label: 'Default permissions' },
      { id: 'bypassPermissions', label: 'Full access' },
    ]);
  });

  it('sessions: 只透传隐私最小化字段并在 responder 再次限制为 20 条', async () => {
    const sessions = Array.from({ length: 25 }, (_, index) => ({
      id: `s-${index}`,
      title: `Session ${index}`,
      workspace: 'xdmaker',
      lastActiveAt: index + 1,
    }));
    const res = await buildQueryResponse(
      { ...DEPS, listSessions: () => sessions },
      { queryId: 'q-sessions', kind: 'sessions' },
    );
    expect(res).toEqual({
      queryId: 'q-sessions',
      kind: 'sessions',
      ok: true,
      error: null,
      sessions: sessions.slice(0, 20),
    });
    expect(JSON.stringify(res)).not.toContain('workingDir');
  });

  it('session-new: waits for the task to exist and returns its id', async () => {
    const createSession = vi.fn(async () => ({ sessionId: 'new-task-id' }));
    const sessionNew = {
      previousExternalKey: 'telegram:dm:1:g1',
      externalKey: 'telegram:dm:1:g2',
      workspace: 'xdmaker',
      options: { agentKind: 'pi', model: 'grok-4.6', permissionMode: 'bypassPermissions' },
      source: { im: 'telegram', userText: '' },
    };
    const res = await buildQueryResponse(
      { ...DEPS, createSession },
      { queryId: 'q-new', kind: 'session-new', sessionNew },
    );
    expect(createSession).toHaveBeenCalledWith(sessionNew);
    expect(res).toEqual({
      queryId: 'q-new',
      kind: 'session-new',
      ok: true,
      error: null,
      sessionId: 'new-task-id',
    });
  });

  it('数据源抛错: ok=false + 原因, 不炸调用方', async () => {
    const res = await buildQueryResponse(
      {
        ...DEPS,
        listAgentModels: () => {
          throw new Error('capabilities not ready');
        },
      },
      { queryId: 'q3', kind: 'models' },
    );
    expect(res).toMatchObject({ queryId: 'q3', ok: false, error: 'capabilities not ready' });
  });

  it('异步数据源: Promise 解析后照常构造, reject 时 ok=false', async () => {
    const ok = await buildQueryResponse(
      { ...DEPS, listAgentModels: async () => await Promise.resolve(DEPS.listAgentModels()) },
      { queryId: 'q4', kind: 'models' },
    );
    expect(ok.ok).toBe(true);
    expect(ok.agents).toHaveLength(2);
    const bad = await buildQueryResponse(
      { ...DEPS, listAgentModels: () => Promise.reject(new Error('providers unavailable')) },
      { queryId: 'q5', kind: 'models' },
    );
    expect(bad).toMatchObject({ queryId: 'q5', ok: false, error: 'providers unavailable' });
  });
});
