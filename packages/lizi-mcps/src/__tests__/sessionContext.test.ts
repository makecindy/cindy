import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { createOrcaMcpServer } from '../orca/server.js';
import { createLiziMcpProviders } from '../providers.js';
import { createXdtHelperMcpServer } from '../lizi_xdtHelperMcpServer.js';
import { runWithLiziMcpSessionContext } from '../session-context.js';
import type { OrcaMcpDeps } from '../orca/server.js';
import type { RenameSessionsDeps } from '../xdt-helper/rename_sessions.js';
import type { SetCurrentSessionTitleDeps } from '../xdt-helper/set_current_session_title.js';

function parse(result: { content: Array<{ type: string; text?: string }> }) {
  const block = result.content[0];
  if (block?.type !== 'text' || typeof block.text !== 'string') {
    throw new Error('Expected first MCP content block to be text');
  }
  return JSON.parse(block.text);
}

function tools(server: unknown) {
  return (
    server as {
      _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
    }
  )._registeredTools;
}

function createOrcaDeps(overrides: Partial<OrcaMcpDeps> = {}): OrcaMcpDeps {
  return {
    startTeam: vi.fn(async () => ({ ok: true as const, teamId: 'team-1' })),
    createWorker: vi.fn(async () => ({
      ok: true as const,
      workerId: 'worker-1',
      workerSessionId: 'worker-session-1',
    })),
    listWorkers: vi.fn(async () => ({ ok: true as const, workers: [] })),
    switchFocus: vi.fn(async () => ({
      ok: true as const,
      workerId: 'worker-1',
    })),
    sendToWorker: vi.fn(async () => ({
      ok: true as const,
      agentKind: 'codex' as const,
      wakeKind: 'already-active' as const,
      targetTitle: null,
      targetLastUserSendAt: null,
    })),
    listWorkerQueuedMessages: vi.fn(async () => ({
      ok: true as const,
      workerId: 'worker-1',
      workerSessionId: 'worker-session-1',
      messages: [],
    })),
    updateWorkerQueuedMessage: vi.fn(async () => ({
      ok: true as const,
      workerId: 'worker-1',
      queuedMessageId: 'queued-1',
    })),
    cancelWorkerQueuedMessage: vi.fn(async () => ({
      ok: true as const,
      workerId: 'worker-1',
      queuedMessageId: 'queued-1',
    })),
    idleWorker: vi.fn(async () => ({ ok: true as const, workerId: 'worker-1' })),
    endTeam: vi.fn(async () => ({ ok: true as const })),
    archiveWorker: vi.fn(async () => ({ ok: true as const, workerId: 'worker-1' })),
    listAvailableModels: vi.fn(async () => ({ ok: true as const })),
    getWorkspaceInfo: vi.fn(async () => ({
      ok: true as const,
      workflow: {
        workflow_id: 'team-1',
        lead_session_id: 'lead-1',
        status: 'active',
      },
      ui_capacity: 1,
      worker_count: 0,
      workers: [],
    })),
    getWorkerStatus: vi.fn(async () => ({
      ok: true as const,
      worker_id: 'worker-1',
      session_id: 'worker-session-1',
      status: 'done',
      session_status: 'not_running',
      idle_ms: 123,
      restored_from_storage: true,
    })),
    readWorker: vi.fn(async () => ({
      ok: true as const,
      worker_id: 'worker-1',
      session_id: 'worker-session-1',
      status: 'done',
      session_status: 'not_running',
      idle_ms: 0,
      restored_from_storage: true,
      result: 'worker output',
    })),
    ...overrides,
  };
}

describe('dynamic lizi MCP session context', () => {
  it('keeps the 16-tool Orca manifest order stable across server construction', () => {
    const context = {
      agentKind: 'codex' as const,
      workingDir: 'C:\\repo',
      sessionId: 'lead-1',
      vendorOptions: { orcaRole: 'lead' },
    };
    const first = Object.keys(tools(createOrcaMcpServer(createOrcaDeps(), context)));
    const second = Object.keys(tools(createOrcaMcpServer(createOrcaDeps(), context)));

    expect(first).toHaveLength(16);
    expect(first).toEqual(second);
    expect(first).toContain('create_worker');
    expect(first).toContain('create_workers');
  });

  // github_lizi / gitlab_lizi 的同款用例已分别随 lizi_github / lizi_gitlab 退役
  // 删除(2026-07-14,能力迁入内置意识 cindy-github / cindy-gitlab)。原覆盖的
  // 两条路径由 cindy_memory 版承接:Claude 绑定语境路径见下面第一个用例,Codex
  // call-time 动态语境路径见既有的 dynamic 用例。

  it('lets cindy_memory resolve the workingDir from the bound Claude session', async () => {
    // Claude 绑定语境:toClaudeSdkConfig 传入的 workingDir 即会话绑定值,tool
    // 调用时应原样传给 deps 回调(getStore),不经 AsyncLocalStorage。
    const getStore = vi.fn(async (_workdir: string) => ({
      list: vi.fn(async () => []),
    }));
    const getManager = () => ({
      isEnabled: () => true,
      getStore,
    }) as never;
    const provider = createLiziMcpProviders({ memory: { getManager } })
      .find((p) => p.name === 'cindy_memory');
    if (!provider) throw new Error('cindy_memory provider missing');

    const cfg = provider.toClaudeSdkConfig({
      agentKind: 'claude-code',
      workingDir: '/claude-repo',
      vendorOptions: {},
    }) as { type: 'sdk'; instance: unknown };

    const result = await tools(cfg.instance).call_tool.handler({
      name: 'memory_list',
      args: {},
    });

    expect(parse(result as never)).toMatchObject({ ok: true, data: [] });
    expect(getStore).toHaveBeenLastCalledWith('/claude-repo');
  });

  it('lets cindy_memory resolve the current Codex workingDir dynamically', async () => {
    const getStore = vi.fn(async (workdir: string) => {
      if (!workdir) throw new Error('MakerMemoryManager.getStore: absWorkdir required');
      return {
        list: vi.fn(async () => [
          {
            filename: 'project_codex-memory.md',
            frontmatter: {
              type: 'project',
              title: 'Codex memory',
              description: 'resolved from dynamic context',
              updatedAt: '2026-06-24T00:00:00.000Z',
            },
            sizeBytes: 123,
          },
        ]),
      };
    });
    const getManager = () => ({
      isEnabled: () => true,
      getStore,
    }) as never;
    const provider = createLiziMcpProviders({ memory: { getManager } })
      .find((p) => p.name === 'cindy_memory');
    if (!provider) throw new Error('cindy_memory provider missing');

    const cfg = provider.toClaudeSdkConfig({
      agentKind: 'codex',
      workingDir: '',
      vendorOptions: {},
    }) as { type: 'sdk'; instance: unknown };
    const server = cfg.instance;

    const withoutCtx = await tools(server).call_tool.handler({
      name: 'memory_list',
      args: {},
    });
    expect(parse(withoutCtx as never)).toMatchObject({
      ok: false,
      code: 'INTERNAL',
    });
    expect(getStore).toHaveBeenLastCalledWith('');

    const withCtx = await runWithLiziMcpSessionContext(
      {
        agentKind: 'codex',
        workingDir: '/repo',
        sessionId: 'codex-current-session',
        vendorOptions: {},
      },
      () =>
        tools(server).call_tool.handler({
          name: 'memory_list',
          args: {},
        }),
    );

    expect(parse(withCtx as never)).toMatchObject({
      ok: true,
      data: [
        {
          filename: 'project_codex-memory.md',
          type: 'project',
          title: 'Codex memory',
          description: 'resolved from dynamic context',
          updatedAt: '2026-06-24T00:00:00.000Z',
          sizeBytes: 123,
        },
      ],
    });
    expect(getStore).toHaveBeenLastCalledWith('/repo');
  });

  it('scopes cindy_memory stores by remoteHostId for SSH remote session contexts', async () => {
    // SSH remote ctx 带 remoteHostId:workingDir 是远端机器上的路径, 直接当
    // store key 会与本地同名路径互串 — withStore 必须经 buildMemoryScopeKey
    // 定位到 ssh:<hostId>:<path> 的独立 store。
    const getStore = vi.fn(async (_workdir: string) => ({
      list: vi.fn(async () => []),
    }));
    const getManager = () => ({
      isEnabled: () => true,
      getStore,
    }) as never;
    const provider = createLiziMcpProviders({ memory: { getManager } })
      .find((p) => p.name === 'cindy_memory');
    if (!provider) throw new Error('cindy_memory provider missing');

    const cfg = provider.toClaudeSdkConfig({
      agentKind: 'codex',
      workingDir: '',
      vendorOptions: {},
    }) as { type: 'sdk'; instance: unknown };
    const server = cfg.instance;

    const remote = await runWithLiziMcpSessionContext(
      {
        agentKind: 'claude-code',
        workingDir: '/home/me/proj',
        remoteHostId: 'my-ssh-host',
        sessionId: 'remote-session',
        vendorOptions: {},
      },
      () => tools(server).call_tool.handler({ name: 'memory_list', args: {} }),
    );
    expect(parse(remote as never)).toMatchObject({ ok: true, data: [] });
    expect(getStore).toHaveBeenLastCalledWith('ssh:my-ssh-host:/home/me/proj');

    // 本地 ctx (无 remoteHostId) 保持原样键 — 既有存储目录不迁移。
    const local = await runWithLiziMcpSessionContext(
      {
        agentKind: 'claude-code',
        workingDir: '/home/me/proj',
        sessionId: 'local-session',
        vendorOptions: {},
      },
      () => tools(server).call_tool.handler({ name: 'memory_list', args: {} }),
    );
    expect(parse(local as never)).toMatchObject({ ok: true, data: [] });
    expect(getStore).toHaveBeenLastCalledWith('/home/me/proj');
  });

  it('advertises Cindy as the helper self-inspection category', async () => {
    const server = createXdtHelperMcpServer(
      {},
      { agentKind: 'codex', workingDir: '', vendorOptions: {} },
    );

    const listed = await tools(server).list_tools.handler({});
    expect(parse(listed as never).categories).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'cindy' })]),
    );
  });

  it('lets cindy_helper resolve the current Codex session id dynamically', async () => {
    const server = createXdtHelperMcpServer(
      {},
      {
        agentKind: 'codex',
        workingDir: '',
        vendorOptions: {},
      },
    );

    const withoutCtx = await tools(server).call_tool.handler({
      name: 'get_current_session_id',
      args: {},
    });
    expect(parse(withoutCtx as never)).toMatchObject({
      ok: false,
      errorCode: 'NO_SESSION_CONTEXT',
    });

    const withCtx = await runWithLiziMcpSessionContext(
      {
        agentKind: 'codex',
        workingDir: '/repo',
        sessionId: 'codex-current-session',
        vendorOptions: {},
      },
      () =>
        tools(server).call_tool.handler({
          name: 'get_current_session_id',
          args: {},
        }),
    );

    expect(parse(withCtx as never)).toMatchObject({
      ok: true,
      session_id: 'codex-current-session',
      agent_kind: 'codex',
      working_dir: '/repo',
    });
  });

  it('lets cindy_helper update the current session title dynamically', async () => {
    const setCurrentSessionTitle: SetCurrentSessionTitleDeps['setCurrentSessionTitle'] = vi.fn(
      async ({ sessionId, title }) => ({
        ok: true as const,
        sessionId,
        title,
      }),
    );
    const server = createXdtHelperMcpServer(
      {
        setCurrentSessionTitle,
      },
      {
        agentKind: 'codex',
        workingDir: '',
        vendorOptions: {},
      },
    );

    const listed = await tools(server).list_tools.handler({
      category: 'control',
    });
    const listedPayload = parse(listed as never);
    expect(listedPayload).toMatchObject({ ok: true, category: 'control' });
    expect(listedPayload.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'set_current_session_title' })]),
    );

    const withoutCtx = await tools(server).call_tool.handler({
      name: 'set_current_session_title',
      args: { title: 'New title' },
    });
    expect(parse(withoutCtx as never)).toMatchObject({
      ok: false,
      errorCode: 'NO_SESSION_CONTEXT',
    });
    expect(setCurrentSessionTitle).not.toHaveBeenCalled();

    const withCtx = await runWithLiziMcpSessionContext(
      {
        agentKind: 'codex',
        workingDir: '/repo',
        sessionId: 'codex-current-session',
        vendorOptions: {},
      },
      () =>
        tools(server).call_tool.handler({
          name: 'set_current_session_title',
          args: { title: '  PR   #263   首页用量面板缓存与展示  ' },
        }),
    );

    expect(parse(withCtx as never)).toMatchObject({
      ok: true,
      session_id: 'codex-current-session',
      title: 'PR #263 首页用量面板缓存与展示',
    });
    expect(setCurrentSessionTitle).toHaveBeenCalledWith({
      sessionId: 'codex-current-session',
      title: 'PR #263 首页用量面板缓存与展示',
    });
  });

  it('requires a dry-run token before batch-renaming sessions', async () => {
    const renameSessions: RenameSessionsDeps['renameSessions'] = vi.fn(
      async ({ changes }: Parameters<RenameSessionsDeps['renameSessions']>[0]) => ({
        ok: true as const,
        changes: changes.map((change) => ({
          sessionId: change.sessionId,
          currentTitle: 'Old title',
          newTitle: change.title,
          workingDir: '/repo',
          updatedAt: '2026-06-23T00:00:00.000Z',
        })),
      }),
    );
    const server = createXdtHelperMcpServer(
      {
        renameSessions,
      },
      {
        agentKind: 'codex',
        workingDir: '',
        vendorOptions: {},
      },
    );

    const listed = await tools(server).list_tools.handler({
      category: 'control',
    });
    expect(parse(listed as never).tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'rename_sessions' })]),
    );

    const args = {
      changes: [
        {
          session_id: 'session-1',
          title: '  New   title  ',
          expected_current_title: 'Old title',
        },
      ],
    };
    const preview = await tools(server).call_tool.handler({
      name: 'rename_sessions',
      args,
    });
    const previewPayload = parse(preview as never);
    expect(previewPayload).toMatchObject({
      ok: true,
      dry_run: true,
      changes: [
        {
          session_id: 'session-1',
          current_title: 'Old title',
          new_title: 'New title',
          working_dir: '/repo',
          updated_at: '2026-06-23T00:00:00.000Z',
        },
      ],
    });
    expect(previewPayload.confirmation_token).toEqual(expect.any(String));
    expect(renameSessions).toHaveBeenCalledWith({
      changes: [
        {
          sessionId: 'session-1',
          title: 'New title',
          expectedCurrentTitle: 'Old title',
          expectedUpdatedAt: undefined,
        },
      ],
      dryRun: true,
    });

    const blocked = await tools(server).call_tool.handler({
      name: 'rename_sessions',
      args: { ...args, dry_run: false },
    });
    expect(parse(blocked as never)).toMatchObject({
      ok: false,
      errorCode: 'CONFIRMATION_REQUIRED',
    });
    expect(renameSessions).toHaveBeenCalledTimes(1);

    const unboundWrite = await tools(server).call_tool.handler({
      name: 'rename_sessions',
      args: {
        ...args,
        dry_run: false,
        confirmation_token: previewPayload.confirmation_token,
      },
    });
    expect(parse(unboundWrite as never)).toMatchObject({
      ok: false,
      errorCode: 'NO_SESSION_CONTEXT',
    });
    expect(renameSessions).toHaveBeenCalledTimes(1);

    const applied = await runWithLiziMcpSessionContext(
      {
        agentKind: 'codex',
        workingDir: '/repo',
        sessionId: 'codex-current-session',
        vendorOptions: {},
      },
      () =>
        tools(server).call_tool.handler({
          name: 'rename_sessions',
          args: {
            ...args,
            dry_run: false,
            confirmation_token: previewPayload.confirmation_token,
          },
        }),
    );
    expect(parse(applied as never)).toMatchObject({
      ok: true,
      dry_run: false,
      changes: [{ session_id: 'session-1', new_title: 'New title' }],
    });
    expect(renameSessions).toHaveBeenLastCalledWith({
      changes: [
        {
          sessionId: 'session-1',
          title: 'New title',
          expectedCurrentTitle: 'Old title',
          expectedUpdatedAt: undefined,
        },
      ],
      dryRun: false,
    });
    expect(renameSessions).toHaveBeenCalledTimes(2);

    const explicitUpdatedAtArgs = {
      changes: [
        {
          session_id: 'session-2',
          title: 'Second title',
          expected_updated_at: '2026-06-23T01:00:00.000Z',
        },
      ],
    };
    const explicitUpdatedAtPreview = await tools(server).call_tool.handler({
      name: 'rename_sessions',
      args: explicitUpdatedAtArgs,
    });
    const explicitUpdatedAtPayload = parse(explicitUpdatedAtPreview as never);

    await runWithLiziMcpSessionContext(
      {
        agentKind: 'codex',
        workingDir: '/repo',
        sessionId: 'codex-current-session',
        vendorOptions: {},
      },
      () => tools(server).call_tool.handler({
        name: 'rename_sessions',
        args: {
          ...explicitUpdatedAtArgs,
          dry_run: false,
          confirmation_token: explicitUpdatedAtPayload.confirmation_token,
        },
      }),
    );

    expect(renameSessions).toHaveBeenLastCalledWith({
      changes: [
        {
          sessionId: 'session-2',
          title: 'Second title',
          expectedCurrentTitle: 'Old title',
          expectedUpdatedAt: '2026-06-23T01:00:00.000Z',
        },
      ],
      dryRun: false,
    });
  });

  it('binds rename_sessions writes to the title returned by the dry run', async () => {
    const renameSessions: RenameSessionsDeps['renameSessions'] = vi.fn(
      async ({ changes, dryRun }: Parameters<RenameSessionsDeps['renameSessions']>[0]) => ({
        ok: true as const,
        changes: changes.map((change) => ({
          sessionId: change.sessionId,
          currentTitle: dryRun ? 'Preview title' : 'Renamed elsewhere',
          newTitle: change.title,
          workingDir: '/repo',
          updatedAt: '2026-06-23T00:00:00.000Z',
        })),
      }),
    );
    const server = createXdtHelperMcpServer(
      { renameSessions },
      {
        agentKind: 'codex',
        workingDir: '',
        vendorOptions: {},
      },
    );

    const args = {
      changes: [
        {
          session_id: 'session-1',
          title: 'New title',
        },
      ],
    };
    const preview = await tools(server).call_tool.handler({
      name: 'rename_sessions',
      args,
    });
    const previewPayload = parse(preview as never);

    await runWithLiziMcpSessionContext(
      {
        agentKind: 'codex',
        workingDir: '/repo',
        sessionId: 'codex-current-session',
        vendorOptions: {},
      },
      () =>
        tools(server).call_tool.handler({
          name: 'rename_sessions',
          args: {
            ...args,
            dry_run: false,
            confirmation_token: previewPayload.confirmation_token,
          },
        }),
    );

    expect(renameSessions).toHaveBeenCalledTimes(2);
    expect(renameSessions).toHaveBeenLastCalledWith({
      changes: [
        {
          sessionId: 'session-1',
          title: 'New title',
          expectedCurrentTitle: 'Preview title',
          expectedUpdatedAt: undefined,
        },
      ],
      dryRun: false,
    });
  });

  it('rejects caller-forged rename_sessions confirmation tokens', async () => {
    const renameSessions: RenameSessionsDeps['renameSessions'] = vi.fn(
      async ({ changes }: Parameters<RenameSessionsDeps['renameSessions']>[0]) => ({
        ok: true as const,
        changes: changes.map((change) => ({
          sessionId: change.sessionId,
          currentTitle: 'Forged title',
          newTitle: change.title,
          workingDir: '/repo',
          updatedAt: '2026-06-23T00:00:00.000Z',
        })),
      }),
    );
    const server = createXdtHelperMcpServer(
      { renameSessions },
      {
        agentKind: 'codex',
        workingDir: '',
        vendorOptions: {},
      },
    );
    const args = {
      changes: [
        {
          session_id: 'session-1',
          title: 'New title',
        },
      ],
    };
    const payload = {
      v: 1,
      changes: [
        {
          sessionId: 'session-1',
          title: 'New title',
          expectedCurrentTitle: null,
          expectedUpdatedAt: null,
          approvedCurrentTitle: 'Forged title',
        },
      ],
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const forgedToken = `v1.${encoded}.${createHash('sha256').update(encoded).digest('hex').slice(0, 24)}`;

    const result = await runWithLiziMcpSessionContext(
      {
        agentKind: 'codex',
        workingDir: '/repo',
        sessionId: 'codex-current-session',
        vendorOptions: {},
      },
      () =>
        tools(server).call_tool.handler({
          name: 'rename_sessions',
          args: {
            ...args,
            dry_run: false,
            confirmation_token: forgedToken,
          },
        }),
    );

    expect(parse(result as never)).toMatchObject({
      ok: false,
      errorCode: 'CONFIRMATION_REQUIRED',
    });
    expect(renameSessions).not.toHaveBeenCalled();
  });

  it('does not turn a null preview title into an empty-string precondition', async () => {
    const renameSessions: RenameSessionsDeps['renameSessions'] = vi.fn(
      async ({ changes, dryRun }: Parameters<RenameSessionsDeps['renameSessions']>[0]) => ({
        ok: true as const,
        changes: changes.map((change) => ({
          sessionId: change.sessionId,
          currentTitle: dryRun ? null : 'Renamed elsewhere',
          newTitle: change.title,
          workingDir: '/repo',
          updatedAt: '2026-06-23T00:00:00.000Z',
        })),
      }),
    );
    const server = createXdtHelperMcpServer(
      { renameSessions },
      {
        agentKind: 'codex',
        workingDir: '',
        vendorOptions: {},
      },
    );
    const args = {
      changes: [
        {
          session_id: 'session-1',
          title: 'New title',
        },
      ],
    };
    const preview = await tools(server).call_tool.handler({
      name: 'rename_sessions',
      args,
    });
    const previewPayload = parse(preview as never);

    await runWithLiziMcpSessionContext(
      {
        agentKind: 'codex',
        workingDir: '/repo',
        sessionId: 'codex-current-session',
        vendorOptions: {},
      },
      () =>
        tools(server).call_tool.handler({
          name: 'rename_sessions',
          args: {
            ...args,
            dry_run: false,
            confirmation_token: previewPayload.confirmation_token,
          },
        }),
    );

    expect(renameSessions).toHaveBeenCalledTimes(2);
    expect(renameSessions).toHaveBeenLastCalledWith({
      changes: [
        {
          sessionId: 'session-1',
          title: 'New title',
          expectedCurrentTitle: undefined,
          expectedUpdatedAt: undefined,
        },
      ],
      dryRun: false,
    });
  });

  it('lets cindy_orca resolve a Codex session id from AsyncLocalStorage', async () => {
    const startTeam = vi.fn(async () => ({
      ok: true as const,
      teamId: 'team-1',
    }));
    const deps: OrcaMcpDeps = createOrcaDeps({
      startTeam,
    });
    const server = createOrcaMcpServer(deps, {
      agentKind: 'codex',
      workingDir: '',
      vendorOptions: {},
    });

    const withoutCtx = await tools(server).start_team.handler({});
    expect(parse(withoutCtx as never)).toMatchObject({
      ok: false,
      errorCode: 'LEAD_NOT_SUPPORTED',
    });

    const withCtx = await runWithLiziMcpSessionContext(
      {
        agentKind: 'codex',
        workingDir: '/repo',
        sessionId: 'codex-lead-session',
        vendorOptions: {},
      },
      () => tools(server).start_team.handler({}),
    );

    expect(parse(withCtx as never)).toMatchObject({
      ok: true,
      team_id: 'team-1',
    });
    expect(startTeam).toHaveBeenCalledWith({
      leadSessionId: 'codex-lead-session',
    });
  });

  it('requires cindy_orca external worker controls to resolve caller session context', async () => {
    const deps: OrcaMcpDeps = createOrcaDeps();
    const server = createOrcaMcpServer(deps, {
      agentKind: 'codex',
      workingDir: '',
      vendorOptions: {},
    });

    const withoutSendCtx = await tools(server).send_to_worker.handler({
      target_session_id: 'worker-session-1',
      message: 'hello',
    });
    const withoutIdleCtx = await tools(server).idle_worker.handler({
      worker_id: 'worker-1',
    });
    const withoutArchiveCtx = await tools(server).archive_worker.handler({
      worker_id: 'worker-1',
    });

    expect(parse(withoutSendCtx as never)).toMatchObject({
      ok: false,
      errorCode: 'LEAD_NOT_SUPPORTED',
    });
    expect(parse(withoutIdleCtx as never)).toMatchObject({
      ok: false,
      errorCode: 'LEAD_NOT_SUPPORTED',
    });
    expect(parse(withoutArchiveCtx as never)).toMatchObject({
      ok: false,
      errorCode: 'LEAD_NOT_SUPPORTED',
    });
    expect(deps.sendToWorker).not.toHaveBeenCalled();
    expect(deps.idleWorker).not.toHaveBeenCalled();
    expect(deps.archiveWorker).not.toHaveBeenCalled();

    await runWithLiziMcpSessionContext(
      {
        agentKind: 'codex',
        workingDir: '/repo',
        sessionId: 'codex-lead-session',
        vendorOptions: {},
      },
      async () => {
        await tools(server).send_to_worker.handler({
          target_session_id: 'worker-session-1',
          message: 'hello',
        });
        await tools(server).idle_worker.handler({
          worker_id: 'worker-1',
        });
        await tools(server).archive_worker.handler({
          worker_id: 'worker-1',
        });
      },
    );

    expect(deps.sendToWorker).toHaveBeenCalledWith({
      callerLeadSessionId: 'codex-lead-session',
      targetSessionId: 'worker-session-1',
      message: 'hello',
    });
    expect(deps.idleWorker).toHaveBeenCalledWith({
      callerLeadSessionId: 'codex-lead-session',
      workerId: 'worker-1',
    });
    expect(deps.archiveWorker).toHaveBeenCalledWith({
      callerLeadSessionId: 'codex-lead-session',
      workerId: 'worker-1',
    });
  });

  it('routes cindy_orca diagnostic tools through the current lead session context', async () => {
    const deps = createOrcaDeps({
      getWorkspaceInfo: vi.fn(async () => ({
        ok: true as const,
        workflow: {
          workflow_id: 'team-1',
          lead_session_id: 'codex-lead-session',
          status: 'active',
        },
        ui_capacity: 1,
        worker_count: 1,
        workers: [{
          worker_id: 'worker-1',
          session_id: 'worker-session-1',
          status: 'done',
          session_status: 'not_running',
          idle_ms: 123,
          restored_from_storage: true,
          label: 'dev',
          role: 'developer',
          agent_kind: 'codex' as const,
          model: 'gpt-5.5',
          effort: 'high',
          focused: true,
          working_dir: '/repo',
        }],
      })),
      getWorkerStatus: vi.fn(async () => ({
        ok: true as const,
        worker_id: 'worker-1',
        session_id: 'worker-session-1',
        status: 'done',
        session_status: 'not_running',
        idle_ms: 123,
        restored_from_storage: true,
      })),
      readWorker: vi.fn(async () => ({
        ok: true as const,
        worker_id: 'worker-1',
        session_id: 'worker-session-1',
        status: 'done',
        session_status: 'not_running',
        idle_ms: 0,
        restored_from_storage: true,
        result: 'done output',
      })),
    });
    const server = createOrcaMcpServer(deps, {
      agentKind: 'codex',
      workingDir: '',
      vendorOptions: {},
    });

    const withoutCtx = await tools(server).get_workspace_info.handler({});
    expect(parse(withoutCtx as never)).toMatchObject({
      ok: false,
      errorCode: 'LEAD_NOT_SUPPORTED',
    });

    await runWithLiziMcpSessionContext(
      {
        agentKind: 'codex',
        workingDir: '/repo',
        sessionId: 'codex-lead-session',
        vendorOptions: {},
      },
      async () => {
        const workspace = parse(await tools(server).get_workspace_info.handler({}) as never);
        expect(workspace).toMatchObject({
          ok: true,
          workflow: {
            workflow_id: 'team-1',
            lead_session_id: 'codex-lead-session',
            status: 'active',
          },
          ui_capacity: 1,
          worker_count: 1,
          workers: [{
            worker_id: 'worker-1',
            session_id: 'worker-session-1',
            session_status: 'not_running',
            restored_from_storage: true,
            working_dir: '/repo',
          }],
        });

        const status = parse(await tools(server).worker_status.handler({ worker_id: 'worker-1' }) as never);
        expect(status).toMatchObject({
          ok: true,
          worker_id: 'worker-1',
          session_id: 'worker-session-1',
          status: 'done',
          session_status: 'not_running',
          idle_ms: 123,
          restored_from_storage: true,
        });

        const output = parse(await tools(server).read_worker.handler({ worker_id: 'worker-1' }) as never);
        expect(output).toMatchObject({
          ok: true,
          worker_id: 'worker-1',
          session_id: 'worker-session-1',
          status: 'done',
          session_status: 'not_running',
          result: 'done output',
        });
      },
    );

    expect(deps.getWorkspaceInfo).toHaveBeenCalledWith({ leadSessionId: 'codex-lead-session' });
    expect(deps.getWorkerStatus).toHaveBeenCalledWith({
      leadSessionId: 'codex-lead-session',
      workerId: 'worker-1',
    });
    expect(deps.readWorker).toHaveBeenCalledWith({
      leadSessionId: 'codex-lead-session',
      workerId: 'worker-1',
    });
  });
});
