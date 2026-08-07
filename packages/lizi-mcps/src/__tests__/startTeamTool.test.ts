import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { XdtHelperToolResult } from '../lizi_xdtHelperToolRegistry.js';
import { registerStartTeamTool } from '../xdt-helper/start_team.js';

function parse(result: XdtHelperToolResult) {
  const [block] = result.content;
  if (block?.type !== 'text') {
    throw new Error('Expected first MCP content block to be text');
  }
  return JSON.parse(block.text);
}

describe('start_team tool', () => {
  it('describes the subagent distinction before a team is started', () => {
    const registry = new XdtHelperToolRegistry();
    registerStartTeamTool(registry, {
      sessionId: 'session-1',
      vendorOptions: undefined,
      startTeam: vi.fn(),
    });

    expect(registry.get('start_team')?.description).toContain(
      '注:start_team 开启的是 session 级、持久、UI 可见的多 worker 协同。若用户要的是一个 subagent(一次性、用完即弃的子任务执行体),请用你自己的原生 subagent 机制(如 Codex 的 spawn_agent、Claude Code 的 Task 工具),不要为此 start_team 开协同。'
        + 'Orca 协同永远不是 subagent 的替代品;你没有原生 subagent 机制时,如实告知用户并请他决定,不要拿 Orca 顶替,也不要自己起进程冒充。',
    );
  });

  it('rejects worker sessions with subagent routing hint before calling host', async () => {
    const startTeam = vi.fn(async () => ({
      ok: true as const,
      teamId: 'team-1',
      workerPermissionMode: 'auto' as const,
    }));
    const registry = new XdtHelperToolRegistry();
    registerStartTeamTool(registry, {
      sessionId: 'worker-session-1',
      vendorOptions: { orcaRole: 'worker' },
      startTeam,
    });

    const res = await registry.call('start_team', {});

    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({
      ok: false,
      errorCode: 'WORKER_CANNOT_NEST',
      data: {
        hint: 'start_team 是 Orca worker 协同入口,不是 subagent 入口。若用户明确要求 subagent / 子代理,请使用你自己的原生 subagent 机制(如 Codex 的 spawn_agent、Claude Code 的 Task/Agent 工具),不要使用 Orca start_team / create_worker。没有原生 subagent 机制时如实告知用户,Orca 协同不是它的替代品。',
      },
    });
    expect(startTeam).not.toHaveBeenCalled();
  });

  it('passes an explicit Full access default to the host and reports the effective mode', async () => {
    const startTeam = vi.fn(async () => ({
      ok: true as const,
      teamId: 'team-1',
      workerPermissionMode: 'bypassPermissions' as const,
    }));
    const registry = new XdtHelperToolRegistry();
    registerStartTeamTool(registry, {
      sessionId: 'lead-session-1',
      vendorOptions: undefined,
      startTeam,
    });

    const res = await registry.call('start_team', {
      worker_permission_mode: 'bypassPermissions',
    });

    expect(res.isError).not.toBe(true);
    expect(startTeam).toHaveBeenCalledWith({
      leadSessionId: 'lead-session-1',
      workerPermissionMode: 'bypassPermissions',
    });
    expect(parse(res)).toMatchObject({
      ok: true,
      team_id: 'team-1',
      worker_permission_mode: 'bypassPermissions',
    });
  });

  it.each(['USER_CANCELLED', 'CONFIRM_TIMEOUT'] as const)(
    'preserves the host confirmation error %s without claiming the team started',
    async (errorCode) => {
      const startTeam = vi.fn().mockResolvedValue({
        ok: false,
        errorCode,
        message:
          errorCode === 'USER_CANCELLED'
            ? '用户未确认 Worker Full access。'
            : 'Worker Full access 确认超时。',
      });
      const registry = new XdtHelperToolRegistry();
      registerStartTeamTool(registry, {
        sessionId: 'lead-1',
        vendorOptions: {},
        startTeam,
      });

      const result = await registry.call('start_team', {
        worker_permission_mode: 'bypassPermissions',
      });

      expect(parse(result)).toMatchObject({
        ok: false,
        errorCode,
      });
      expect(result.isError).toBe(true);
    },
  );

  it('omits the host override and reports Auto-review when no mode is specified', async () => {
    const startTeam = vi.fn(async () => ({
      ok: true as const,
      teamId: 'team-1',
      workerPermissionMode: 'auto' as const,
    }));
    const registry = new XdtHelperToolRegistry();
    registerStartTeamTool(registry, {
      sessionId: 'lead-session-1',
      vendorOptions: undefined,
      startTeam,
    });

    const res = await registry.call('start_team', {});

    expect(startTeam).toHaveBeenCalledWith({
      leadSessionId: 'lead-session-1',
      workerPermissionMode: undefined,
    });
    expect(parse(res)).toMatchObject({
      ok: true,
      team_id: 'team-1',
      worker_permission_mode: 'auto',
    });
  });

  it('allows an existing Lead to switch the current Team default explicitly', async () => {
    const startTeam = vi.fn(async () => ({
      ok: true as const,
      teamId: 'team-1',
      workerPermissionMode: 'bypassPermissions' as const,
      reused: true,
    }));
    const registry = new XdtHelperToolRegistry();
    registerStartTeamTool(registry, {
      sessionId: 'lead-session-1',
      vendorOptions: { orcaRole: 'lead' },
      startTeam,
    });

    const res = await registry.call('start_team', {
      worker_permission_mode: 'bypassPermissions',
    });

    expect(res.isError).not.toBe(true);
    expect(startTeam).toHaveBeenCalledWith({
      leadSessionId: 'lead-session-1',
      workerPermissionMode: 'bypassPermissions',
    });
    expect(parse(res)).toMatchObject({
      ok: true,
      worker_permission_mode: 'bypassPermissions',
      reused: true,
    });
  });
});
