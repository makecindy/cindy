/**
 * ghostErrandRunner.test.ts — 派活执行器单测(纯 DI,无 Electron)。
 * 覆盖:配置解析与权限档钳制、专属会话建/复用/关键配置变更重建、忙检、
 * 投递失败映射、queued 竞态如实报 BUSY、turn 收口取文、DB 兜底取文、超时。
 */

import { describe, it, expect, vi } from 'vitest';

import {
  clampErrandPermissionMode,
  createGhostErrandRunner,
  type GhostErrandRunnerDeps,
  type GhostErrandSessionRow,
} from '../ghostErrandRunner';
import type { AgentEvent } from '@cindy/maker-core';

/** 最小可观察会话替身:测试手动放事件。 */
function fakeSession(id: string): {
  session: { id: string; onEvent(listener: (ev: AgentEvent) => void): () => void };
  emit: (ev: AgentEvent) => void;
} {
  const listeners = new Set<(ev: AgentEvent) => void>();
  return {
    session: {
      id,
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit: (ev) => listeners.forEach((l) => l(ev)),
  };
}

const textEvent = (text: string): AgentEvent =>
  ({ type: 'text', source: 'codex', data: { text, isFinal: true } }) as unknown as AgentEvent;
const doneEvent = (): AgentEvent => ({ type: 'done', data: {} }) as unknown as AgentEvent;

const ACTIVE_ROW: GhostErrandSessionRow = {
  status: 'active',
  agentKind: 'cc',
  model: 'claude-x',
  permissionMode: 'plan',
  workingDir: '/dialogues/x',
  workspaceKind: 'dialogue',
};

function makeDeps(overrides: Partial<GhostErrandRunnerDeps> = {}): {
  deps: GhostErrandRunnerDeps;
  emitters: Map<string, ReturnType<typeof fakeSession>>;
  writes: Array<[string, string | null]>;
} {
  const emitters = new Map<string, ReturnType<typeof fakeSession>>();
  const writes: Array<[string, string | null]> = [];
  const ensureEmitter = (id: string) => {
    let e = emitters.get(id);
    if (!e) {
      e = fakeSession(id);
      emitters.set(id, e);
    }
    return e;
  };
  const deps: GhostErrandRunnerDeps = {
    readConfig: () => ({}),
    readSessionId: () => null,
    writeSessionId: (ghostId, sessionId) => {
      writes.push([ghostId, sessionId]);
    },
    getSessionRow: async () => ACTIVE_ROW,
    createSession: vi.fn(async () => 'sess-new'),
    getGhostName: () => '帮手',
    getDraftDefaults: () => ({}),
    normalizeWorkingDir: (dir) => dir.replace(/\/+$/, ''),
    isUserPickedDir: () => false,
    isSessionBusy: () => false,
    dispatch: vi.fn(async () => ({ ok: true as const, wakeKind: 'resumed' as const })),
    getObservableSession: (id) => ensureEmitter(id).session,
    onSilentStopSettled: () => () => undefined,
    readLatestAssistantText: async () => null,
    log: { info: () => undefined, warn: () => undefined },
    sleep: async () => undefined,
    ...overrides,
  };
  return { deps, emitters, writes };
}

const REQUEST = { ghostId: 'helper', ghostVersion: '1.0.0', message: '干活' };

describe('权限档钳制', () => {
  it('白名单外/缺省一律收敛到 plan;bypassPermissions 不存在', () => {
    expect(clampErrandPermissionMode(undefined)).toBe('plan');
    expect(clampErrandPermissionMode('bypassPermissions')).toBe('plan');
    expect(clampErrandPermissionMode('ask')).toBe('plan');
    expect(clampErrandPermissionMode('acceptEdits')).toBe('acceptEdits');
    expect(clampErrandPermissionMode('auto')).toBe('auto');
  });
});

describe('专属会话建/复用', () => {
  it('无映射时创建会话并写映射,onSession 尽早回报', async () => {
    const { deps, emitters, writes } = makeDeps();
    const runner = createGhostErrandRunner(deps);
    const seen: string[] = [];
    const p = runner(REQUEST, { onSession: (sid) => seen.push(sid) });
    await vi.waitFor(() => {
      expect(emitters.has('sess-new')).toBe(true);
    });
    const e = emitters.get('sess-new')!;
    e.emit(textEvent('答案'));
    e.emit(doneEvent());
    const r = await p;
    expect(r).toMatchObject({ ok: true, sessionId: 'sess-new', text: '答案', agentKind: 'cc' });
    expect(seen).toEqual(['sess-new']);
    expect(writes).toContainEqual(['helper', 'sess-new']);
  });

  it('映射有效且配置匹配时复用,不再创建', async () => {
    const createSession = vi.fn(async () => 'should-not-happen');
    const { deps, emitters } = makeDeps({
      readSessionId: () => 'sess-old',
      createSession,
    });
    const runner = createGhostErrandRunner(deps);
    const p = runner(REQUEST);
    await vi.waitFor(() => expect(emitters.has('sess-old')).toBe(true));
    const e = emitters.get('sess-old')!;
    e.emit(textEvent('ok'));
    e.emit(doneEvent());
    expect(await p).toMatchObject({ ok: true, sessionId: 'sess-old' });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('关键配置变了(权限档不匹配)→ 解除映射并重建', async () => {
    const { deps, emitters, writes } = makeDeps({
      readConfig: () => ({ permissionMode: 'auto' }),
      readSessionId: () => 'sess-old',
      getSessionRow: async (id) => (id === 'sess-old' ? ACTIVE_ROW : ACTIVE_ROW),
    });
    const runner = createGhostErrandRunner(deps);
    const p = runner(REQUEST);
    await vi.waitFor(() => expect(emitters.has('sess-new')).toBe(true));
    const e = emitters.get('sess-new')!;
    e.emit(doneEvent());
    await p;
    expect(writes[0]).toEqual(['helper', null]);
    expect(writes).toContainEqual(['helper', 'sess-new']);
  });

  it('配置目录经规范化再比对(尾斜杠不导致重建)', async () => {
    const createSession = vi.fn(async () => 'should-not-happen');
    const { deps, emitters } = makeDeps({
      readConfig: () => ({ workingDir: '/proj/demo/' }),
      readSessionId: () => 'sess-proj',
      getSessionRow: async () => ({
        ...ACTIVE_ROW,
        workspaceKind: 'project',
        workingDir: '/proj/demo',
      }),
      createSession,
    });
    const runner = createGhostErrandRunner(deps);
    const p = runner(REQUEST);
    await vi.waitFor(() => expect(emitters.has('sess-proj')).toBe(true));
    emitters.get('sess-proj')!.emit(doneEvent());
    await p;
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe('插件转述目录(request.workingDir)', () => {
  it('台账里的目录:建会话带上该目录;归一化后的同目录会话可复用', async () => {
    const createSession = vi.fn(async () => 'sess-repo');
    const { deps, emitters } = makeDeps({
      createSession,
      isUserPickedDir: (ghostId, dir) => ghostId === 'helper' && dir === '/proj/repo',
    });
    const runner = createGhostErrandRunner(deps);
    const p = runner({ ...REQUEST, workingDir: '/proj/repo/' });
    await vi.waitFor(() => expect(emitters.has('sess-repo')).toBe(true));
    emitters.get('sess-repo')!.emit(doneEvent());
    await p;
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workingDir: '/proj/repo' }),
    );

    // 第二单同目录:命中已有 project 间,不再新建。
    const createAgain = vi.fn(async () => 'should-not-happen');
    const second = makeDeps({
      createSession: createAgain,
      isUserPickedDir: () => true,
      readSessionId: () => 'sess-repo',
      getSessionRow: async () => ({
        ...ACTIVE_ROW,
        workspaceKind: 'project',
        workingDir: '/proj/repo',
      }),
    });
    const runner2 = createGhostErrandRunner(second.deps);
    const p2 = runner2({ ...REQUEST, workingDir: '/proj/repo' });
    await vi.waitFor(() => expect(second.emitters.has('sess-repo')).toBe(true));
    second.emitters.get('sess-repo')!.emit(doneEvent());
    await p2;
    expect(createAgain).not.toHaveBeenCalled();
  });

  it('台账里没有的目录 → INVALID_REQUEST,不建会话不投递', async () => {
    const createSession = vi.fn(async () => 'should-not-happen');
    const dispatch = vi.fn(async () => ({ ok: true as const, wakeKind: 'resumed' as const }));
    const { deps } = makeDeps({ createSession, dispatch, isUserPickedDir: () => false });
    const runner = createGhostErrandRunner(deps);
    const r = await runner({ ...REQUEST, workingDir: '/anywhere/else' });
    expect(r).toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });
    expect(createSession).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('用户在「AI 代办」卡配置了目录 → 用户配置优先,转述字段忽略(不查台账)', async () => {
    const createSession = vi.fn(async () => 'sess-cfg');
    const isUserPickedDir = vi.fn(() => false);
    const { deps, emitters } = makeDeps({
      readConfig: () => ({ workingDir: '/user/configured' }),
      createSession,
      isUserPickedDir,
    });
    const runner = createGhostErrandRunner(deps);
    const p = runner({ ...REQUEST, workingDir: '/ghost/says' });
    await vi.waitFor(() => expect(emitters.has('sess-cfg')).toBe(true));
    emitters.get('sess-cfg')!.emit(doneEvent());
    await p;
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workingDir: '/user/configured' }),
    );
    expect(isUserPickedDir).not.toHaveBeenCalled();
  });
});

describe('忙检与投递', () => {
  it('会话正忙 → BUSY,不投递', async () => {
    const dispatch = vi.fn();
    const { deps } = makeDeps({
      readSessionId: () => 'sess-1',
      isSessionBusy: () => true,
      dispatch: dispatch as unknown as GhostErrandRunnerDeps['dispatch'],
    });
    expect(await createGhostErrandRunner(deps)(REQUEST)).toMatchObject({
      ok: false,
      errorCode: 'BUSY',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('投递返回 queued(竞态窗口)→ 如实报 BUSY', async () => {
    const { deps } = makeDeps({
      readSessionId: () => 'sess-1',
      dispatch: async () => ({ ok: true as const, wakeKind: 'queued' as const }),
    });
    expect(await createGhostErrandRunner(deps)(REQUEST)).toMatchObject({
      ok: false,
      errorCode: 'BUSY',
    });
  });

  it('投递失败映射:NOT_FOUND/ARCHIVED → SESSION_UNAVAILABLE 并解除映射', async () => {
    const { deps, writes } = makeDeps({
      readSessionId: () => 'sess-1',
      dispatch: async () => ({ ok: false as const, errorCode: 'ARCHIVED', message: '归档了' }),
    });
    expect(await createGhostErrandRunner(deps)(REQUEST)).toMatchObject({
      ok: false,
      errorCode: 'SESSION_UNAVAILABLE',
    });
    expect(writes).toContainEqual(['helper', null]);
  });
});

describe('收口与取文', () => {
  it('观察器无文本时回落 DB 最新 assistant 消息', async () => {
    const { deps, emitters } = makeDeps({
      readSessionId: () => 'sess-1',
      readLatestAssistantText: async () => 'DB 里的答案',
    });
    const runner = createGhostErrandRunner(deps);
    const p = runner(REQUEST);
    await vi.waitFor(() => expect(emitters.has('sess-1')).toBe(true));
    emitters.get('sess-1')!.emit(doneEvent());
    expect(await p).toMatchObject({ ok: true, text: 'DB 里的答案' });
  });

  it('终态错误 → TURN_FAILED', async () => {
    const { deps, emitters } = makeDeps({ readSessionId: () => 'sess-1' });
    const runner = createGhostErrandRunner(deps);
    const p = runner(REQUEST);
    await vi.waitFor(() => expect(emitters.has('sess-1')).toBe(true));
    // isTerminal: true 是 maker-core isTerminalAgentErrorEvent 的显式终态判据。
    emitters.get('sess-1')!.emit(
      { type: 'error', data: { message: '模型炸了', isTerminal: true } } as unknown as AgentEvent,
    );
    expect(await p).toMatchObject({ ok: false, errorCode: 'TURN_FAILED' });
  });

  it('超时 → TIMEOUT', async () => {
    const { deps, emitters } = makeDeps({ readSessionId: () => 'sess-1' });
    const runner = createGhostErrandRunner({ ...deps, turnTimeoutMs: 20 });
    const p = runner(REQUEST);
    await vi.waitFor(() => expect(emitters.has('sess-1')).toBe(true));
    expect(await p).toMatchObject({ ok: false, errorCode: 'TIMEOUT' });
  });
});
