import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createXdtHelperMcpServer } from '../lizi_xdtHelperMcpServer.js';
import type { LiziMcpSessionContext } from '../types.js';

const parse = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0].text);

// Production entry: the cindy_helper `create_task_worktree` tool. It binds the worktree to the
// calling task only, so the task identity it forwards and the callers it refuses are the contract.
describe('create_task_worktree MCP', () => {
  it('creates the worktree for the calling task and refuses callers that cannot own one', async () => {
    let context: Partial<LiziMcpSessionContext> = { sessionId: 'caller' };
    const createTaskWorktree = vi.fn(async () => ({
      ok: true as const,
      worktreePath: '/repo/.cindy-worktrees/brave-ada',
      branch: 'cindy/brave-ada',
      baseRepo: '/repo',
      sourceBranch: 'refs/remotes/origin/main',
      created: true,
    }));
    const server = createXdtHelperMcpServer(
      { createTaskWorktree, resolveSurface: async () => 'default' },
      {
        agentKind: 'claude-code',
        workingDir: '/repo',
        getSessionContext: () => ({ agentKind: 'claude-code', workingDir: '/repo', ...context }),
      },
    );
    const client = new Client({ name: 'task-worktree-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    const call = async (args: object) =>
      parse(await client.callTool({ name: 'call_tool', arguments: { name: 'create_task_worktree', args } }));
    try {
      const discovery = parse(await client.callTool({ name: 'list_tools', arguments: { category: 'control' } }));
      expect(discovery.tools.map((tool: { name: string }) => tool.name)).toContain('create_task_worktree');

      expect(await call({ repo_dir: '/repo' })).toMatchObject({
        ok: true,
        worktree_path: '/repo/.cindy-worktrees/brave-ada',
        branch: 'cindy/brave-ada',
        source_branch: 'refs/remotes/origin/main',
        created: true,
      });
      expect(createTaskWorktree).toHaveBeenLastCalledWith({ callerSessionId: 'caller', repoDir: '/repo' });

      createTaskWorktree.mockResolvedValueOnce({ ok: false, errorCode: 'WORKTREE_UNAVAILABLE', message: 'not a git repository' } as never);
      expect(await call({})).toMatchObject({ ok: false, errorCode: 'WORKTREE_UNAVAILABLE' });
      expect(createTaskWorktree).toHaveBeenLastCalledWith({ callerSessionId: 'caller' });

      createTaskWorktree.mockClear();
      for (const [next, errorCode] of [
        [{ sessionId: undefined }, 'NO_SESSION_CONTEXT'],
        // Remote Claude/Codex tasks never see control tools; remote Pi keeps them, so the tool refuses.
        [{ sessionId: 'caller', remoteHostId: 'ssh-host', agentKind: 'pi' }, 'UNSUPPORTED_CAPABILITY'],
        [{ sessionId: 'caller', mcpCallerKind: 'descendant' }, 'ROOT_REQUIRED'],
      ] as const) {
        context = next;
        expect(await call({})).toMatchObject({ ok: false, errorCode });
      }
      expect(createTaskWorktree).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
});
