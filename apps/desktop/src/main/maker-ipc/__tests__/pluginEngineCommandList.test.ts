/**
 * 插件引擎的 `/` 面板命令清单（issue #11963）。
 *
 * 内置引擎的命令是 agent 级别的静态白名单；插件引擎（ACP）的命令是**会话级别**的
 * 广播（`available_commands_update`），所以入口要放行 'acp'，清单也只能按会话读。
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentBuiltinCommand } from '@cindy/maker-core';

import { parseCommandListAgentKind, pluginEngineCommandList } from '../pluginEngineCommandList.js';

function builtin(name: string, description = ''): AgentBuiltinCommand {
  return { kind: 'agent-builtin', name, description };
}

describe('plugin engine command list', () => {
  it('放行插件引擎的命令清单入口，内置引擎的口径不变', () => {
    expect(parseCommandListAgentKind('claude-code')).toBe('claude-code');
    expect(parseCommandListAgentKind('codex')).toBe('codex');
    expect(parseCommandListAgentKind('pi')).toBe('pi');
    expect(parseCommandListAgentKind('acp')).toBe('acp');
    expect(parseCommandListAgentKind('nonsense')).toBeNull();
    expect(parseCommandListAgentKind(undefined)).toBeNull();
  });

  it('读的是那个会话里引擎广播的命令（含描述）', () => {
    const listSessionCommands = vi.fn(() => [builtin('agy-skill', 'Run the deploy pipeline')]);
    const commands = pluginEngineCommandList('task-1', {
      sessionMeta: { agentKind: 'acp' },
      listSessionCommands,
    });
    expect(listSessionCommands).toHaveBeenCalledWith('task-1');
    expect(commands).toEqual([{ kind: 'agent-builtin', name: 'agy-skill', description: 'Run the deploy pipeline' }]);
  });

  it('任务还不存在或不是插件引擎时没有命令可列', () => {
    const listSessionCommands = vi.fn(() => [builtin('agy-skill')]);
    expect(pluginEngineCommandList('task-1', { sessionMeta: null, listSessionCommands })).toEqual([]);
    expect(pluginEngineCommandList('task-1', {
      sessionMeta: { agentKind: 'claude-code' },
      listSessionCommands,
    })).toEqual([]);
    expect(listSessionCommands).not.toHaveBeenCalled();
  });
});
