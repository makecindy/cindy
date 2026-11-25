import { readFileSync } from 'node:fs';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import { MAKER_INVOKE } from '../channels.js';
import { AGENT_COMMAND_LIST_FAILURE_MESSAGE, toAgentCommandListFailure } from '../agentCommandListIpcBoundary.js';
import { parseCommandListAgentKind, pluginEngineCommandList } from '../pluginEngineCommandList.js';
import { PLUGIN_ENGINE_AGENT_KIND } from '../../../shared/pluginEngines.js';

/**
 * `maker:list-agent-commands` 里插件引擎（'acp'）分支的注册行为（不是源码文本断言）。
 *
 * 插件引擎的 `/…` 是引擎给**这个会话**广播的（ACP `available_commands_update`），不是
 * agent 级别的静态清单：入口放行 'acp'、由 Main 按 sessionId 解析会话后读会话清单；
 * 缺 sessionId 按既有口径折叠成稳定失败契约。registerMakerIpc 无法整体导入，沿用仓库
 * 既有的「切源码 + 编译 + new Function 注入依赖」手法真实执行这个 handler。
 */
const registerSource = readFileSync(new URL('../register.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** 截取 [from, to) 之间的源码（to 是下一个注册语句的起点，不包含）。 */
function sliceBetween(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`slice anchor missing: ${start < 0 ? from : to}`);
  return source.slice(start, end);
}

const handlerSource = sliceBetween(
  registerSource,
  'ipcMain.handle(\n    MAKER_INVOKE.LIST_AGENT_COMMANDS,',
  '\n  ipcMain.handle(\n    MAKER_INVOKE.LIST_AGENT_SKILLS,',
);

type ListAgentCommandsHandler = (
  event: unknown,
  agentKind: unknown,
  rawParams?: unknown,
) => Promise<unknown>;

interface HarnessDeps {
  /** maker.getSessionMeta 的返回值；缺省 null（任务行还不存在）。 */
  sessionMeta?: { agentKind: string } | null;
  /** maker.getSessionCommands 的返回值（会话里引擎广播的清单）。 */
  sessionCommands?: unknown;
}

function compileHandler(deps: HarnessDeps) {
  const listSessionCommands = vi.fn(() => deps.sessionCommands ?? []);
  const listAgentCommands = vi.fn(() => [{ name: 'help', description: '' }]);
  const logWarn = vi.fn();
  const maker = {
    getSessionMeta: vi.fn(async () => deps.sessionMeta ?? null),
    getSessionCommands: listSessionCommands,
    listAgentCommands,
    getSessionRuntimeCapabilities: vi.fn(() => undefined),
  };
  const bindings = {
    MAKER_INVOKE,
    assertAgentCommandListIpcCaller: () => undefined,
    isDeviceLinkInvoke: () => false,
    assertTrustedAppRendererEvent: () => undefined,
    parseCommandListAgentKind,
    pluginEngineCommandList,
    PLUGIN_ENGINE_AGENT_KIND,
    throwIpcError: (code: string, message: string) => {
      throw new Error(`[${code}] ${message}`);
    },
    requireObject: (value: unknown) => value,
    maker,
    hasBuiltinAgentKind: (meta: { agentKind: string } | null) =>
      !!meta && meta.agentKind !== PLUGIN_ENGINE_AGENT_KIND,
    shouldListPiPackageCommands: () => false,
    listPiRuntimePaletteCommands: () => [],
    listManagedPiPromptCommands: async () => [],
    mergePiPackageCommands: (_kind: unknown, builtins: unknown[], packageCommands: unknown[]) => [
      ...builtins,
      ...packageCommands,
    ],
    toAgentCommandListFailure,
    log: { warn: logWarn },
  };
  const handlers = new Map<string, ListAgentCommandsHandler>();
  const js = ts.transpileModule(
    `${handlerSource}\nreturn handlers.get(MAKER_INVOKE.LIST_AGENT_COMMANDS);`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const handler = new Function('ipcMain', 'handlers', ...Object.keys(bindings), js)(
    {
      handle: (channel: string, fn: ListAgentCommandsHandler) => {
        handlers.set(channel, fn);
      },
    },
    handlers,
    ...Object.values(bindings),
  ) as ListAgentCommandsHandler | undefined;
  if (!handler) throw new Error('LIST_AGENT_COMMANDS handler was not registered');
  return { handler, maker, listSessionCommands, listAgentCommands, logWarn };
}

describe('maker:list-agent-commands acp branch (#11963)', () => {
  it("returns the session's engine-broadcast list with descriptions", async () => {
    const { handler, maker, listSessionCommands, listAgentCommands } = compileHandler({
      sessionMeta: { agentKind: PLUGIN_ENGINE_AGENT_KIND },
      sessionCommands: [
        { kind: 'agent-builtin', name: 'deploy', description: 'Ship the current branch' },
      ],
    });
    await expect(handler({}, PLUGIN_ENGINE_AGENT_KIND, { sessionId: 'task-1' })).resolves.toEqual({
      success: true,
      commands: [{ kind: 'agent-builtin', name: 'deploy', description: 'Ship the current branch' }],
    });
    expect(maker.getSessionMeta).toHaveBeenCalledWith('task-1');
    expect(listSessionCommands).toHaveBeenCalledWith('task-1');
    // 会话清单走的是广播，不是 agent 级别的静态白名单。
    expect(listAgentCommands).not.toHaveBeenCalled();
  });

  it('lists nothing when the task row is missing or not a plugin-engine task', async () => {
    for (const sessionMeta of [null, { agentKind: 'claude-code' }]) {
      const { handler, listSessionCommands } = compileHandler({ sessionMeta });
      await expect(handler({}, PLUGIN_ENGINE_AGENT_KIND, { sessionId: 'task-1' })).resolves.toEqual({
        success: true,
        commands: [],
      });
      expect(listSessionCommands).not.toHaveBeenCalled();
    }
  });

  it('folds a missing sessionId into the stable failure contract and logs locally', async () => {
    const { handler, maker, logWarn } = compileHandler({});
    await expect(handler({}, PLUGIN_ENGINE_AGENT_KIND, {})).resolves.toEqual({
      success: false,
      error: AGENT_COMMAND_LIST_FAILURE_MESSAGE,
      commands: [],
    });
    expect(maker.getSessionMeta).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it('still serves builtin engines through the static path', async () => {
    const { handler, listSessionCommands, listAgentCommands } = compileHandler({
      sessionMeta: { agentKind: 'claude-code' },
    });
    await expect(handler({}, 'claude-code', { sessionId: 'task-1' })).resolves.toEqual({
      success: true,
      commands: [{ name: 'help', description: '' }],
    });
    expect(listAgentCommands).toHaveBeenCalledWith('claude-code');
    expect(listSessionCommands).not.toHaveBeenCalled();
  });
});
