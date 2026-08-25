import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createComputerMcpServer } from './server.js';
import type { ComputerMcpDeps } from '../types.js';

/** Temp session workingDir for path-boundary-constrained tools (recording/replay). */
async function makeWorkingDir(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'computer-wd-')));
}

async function writeTrajectory(
  root: string,
  actions: Array<{ tool: string; arguments?: Record<string, unknown> }>,
  directoryName = 'rec',
): Promise<string> {
  const directory = path.join(root, directoryName);
  await Promise.all(
    actions.map(async (action, index) => {
      const turn = path.join(directory, `turn-${String(index + 1).padStart(5, '0')}`);
      await fs.mkdir(turn, { recursive: true });
      await fs.writeFile(path.join(turn, 'action.json'), JSON.stringify(action), 'utf8');
    }),
  );
  return directory;
}

function textPayload(result: unknown): unknown {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  const first = content[0];
  if (!first?.text) throw new Error('missing text payload');
  return JSON.parse(first.text);
}

async function makeHarness(
  deps: ComputerMcpDeps,
  options?: Parameters<typeof createComputerMcpServer>[1],
) {
  const server = createComputerMcpServer(deps, options);
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'computer-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('createComputerMcpServer', () => {
  it('lists desktop computer-use tools', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(),
    };
    const h = await makeHarness(deps);

    const payload = textPayload(await h.client.callTool({ name: 'list_tools', arguments: {} })) as {
      ok: boolean;
      tools: Array<{
        name: string;
        description: string;
        inputSchema?: { properties?: Record<string, unknown> };
      }>;
      workflow: string;
    };

    expect(payload.ok).toBe(true);
    expect(payload.tools.map((tool) => tool.name)).toContain('get_window_state');
    expect(payload.tools.map((tool) => tool.name)).toContain('get_accessibility_tree');
    expect(payload.tools.map((tool) => tool.name)).toContain('move_cursor');
    expect(payload.tools.map((tool) => tool.name)).toContain('start_recording');
    expect(payload.tools.map((tool) => tool.name)).toContain('replay_trajectory');
    expect(payload.tools.map((tool) => tool.name)).toContain('type_text');
    const listWindows = payload.tools.find((tool) => tool.name === 'list_windows');
    const typeText = payload.tools.find((tool) => tool.name === 'type_text');
    expect(listWindows?.inputSchema?.properties).toHaveProperty('query');
    expect(listWindows?.inputSchema?.properties).toHaveProperty('workspace_root');
    expect(listWindows?.inputSchema?.properties).toHaveProperty('process_name');
    expect(payload.workflow).toContain('query/workspace_root/process_name');
    expect(listWindows?.description).toContain('{"process_name":"Simulator"}');
    expect(payload.workflow).toContain('{"process_name":"Simulator"}');
    expect(payload.tools.find((tool) => tool.name === 'get_window_state')?.description)
      .toContain('{"capture_mode":"vision"}');
    expect(payload.tools.find((tool) => tool.name === 'click')?.description)
      .toContain('Always include pid');
    expect(payload.tools.find((tool) => tool.name === 'launch_app')?.description)
      .toContain('{"process_name":"Simulator"}');
    expect(payload.tools.find((tool) => tool.name === 'launch_app')?.inputSchema?.properties)
      .not.toHaveProperty('use_external_simulator');
    expect(payload.tools.find((tool) => tool.name === 'hotkey')?.inputSchema?.properties)
      .not.toHaveProperty('use_external_ios_workflow');
    expect(typeText?.inputSchema?.properties).toHaveProperty('delivery_mode');
    expect(payload.workflow).toContain('always for coordinates');
    expect(payload.workflow).toContain('{"capture_mode":"vision"}');
    await h.cleanup();
  });

  it('routes status without calling the external driver call path', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(async () => ({
        installed: true,
        executablePath: 'cua-driver',
        version: 'cua-driver 1.2.3',
        daemonRunning: true,
        installCommand: 'install cua-driver',
        docsUrl: 'https://cua.ai/docs/cua-driver',
      })),
      callTool: vi.fn(),
    };
    const h = await makeHarness(deps);

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'status', args: {} },
    })) as {
      ok: boolean;
      data: { installed: boolean; version: string };
    };

    expect(payload.ok).toBe(true);
    expect(payload.data.installed).toBe(true);
    expect(payload.data.version).toBe('cua-driver 1.2.3');
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
  });

  it('checks permissions in read-only mode', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(async () => ({
        installed: true,
        executablePath: 'cua-driver',
        version: 'cua-driver 1.2.3',
        daemonRunning: false,
        permissionState: {
          platform: 'macos' as const,
          required: true,
          status: 'missing' as const,
          accessibility: 'missing' as const,
          screenRecording: 'missing' as const,
          canGrant: true,
        },
        installCommand: 'install cua-driver',
        docsUrl: 'https://cua.ai/docs/cua-driver',
      })),
      callTool: vi.fn(),
    };
    const h = await makeHarness(deps);

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'check_permissions', args: {} },
    })) as { ok: boolean; data: { daemonRunning: boolean; permissionState: { status: string } } };

    expect(payload.ok).toBe(true);
    expect(payload.data.daemonRunning).toBe(false);
    expect(payload.data.permissionState.status).toBe('missing');
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
  });

  it('dispatches lightweight accessibility tree discovery', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ windows: [] })),
    };
    const h = await makeHarness(deps);

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'get_accessibility_tree', args: {} },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('get_accessibility_tree', {});
    await h.cleanup();
  });

  it('dispatches list_windows with filters and current session context', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ windows: [] })),
    };
    const h = await makeHarness(deps, { sessionId: 'agent-session-1' });

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'list_windows',
        args: {
          query: 'settings',
          workspace_root: '/repo',
          process_name: 'Electron',
        },
      },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('list_windows', {
      query: 'settings',
      workspace_root: '/repo',
      process_name: 'Electron',
      session: 'agent-session-1',
    }, { sessionId: 'agent-session-1' });
    await h.cleanup();
  });

  it('normalizes the list_windows app compatibility alias without forwarding it', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ windows: [] })),
    };
    const h = await makeHarness(deps, { sessionId: 'agent-session-1' });

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'list_windows',
        args: { app: 'Simulator' },
      },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('list_windows', {
      process_name: 'Simulator',
      session: 'agent-session-1',
    }, { sessionId: 'agent-session-1' });
    await h.cleanup();
  });

  it('accepts a list_windows alias that matches the canonical process_name', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ windows: [] })),
    };
    const h = await makeHarness(deps);

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'list_windows',
        args: { app: 'Simulator', process_name: 'Simulator' },
      },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('list_windows', {
      process_name: 'Simulator',
    });
    await h.cleanup();
  });

  it('rejects conflicting list_windows alias and canonical values', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(),
    };
    const h = await makeHarness(deps);

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'list_windows',
        args: { app: 'Simulator', process_name: 'Xcode' },
      },
    });
    const payload = textPayload(result) as {
      ok: boolean;
      errorCode: string;
      data: { validation_errors: Array<{ message: string }> };
    };

    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('INVALID_ARGS');
    expect(payload.data.validation_errors[0]?.message).toContain('use only process_name');
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
  });

  it('normalizes screenshot true to capture_mode vision without forwarding the alias', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ elements: [] })),
    };
    const h = await makeHarness(deps, { sessionId: 'agent-session-1' });

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'get_window_state',
        args: { pid: 123, window_id: 7, screenshot: true },
      },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('get_window_state', {
      pid: 123,
      window_id: 7,
      capture_mode: 'vision',
      session: 'agent-session-1',
    }, { sessionId: 'agent-session-1' });
    await h.cleanup();
  });

  it('accepts screenshot true when capture_mode is already vision', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ elements: [] })),
    };
    const h = await makeHarness(deps);

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'get_window_state',
        args: { pid: 123, window_id: 7, screenshot: true, capture_mode: 'vision' },
      },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('get_window_state', {
      pid: 123,
      window_id: 7,
      capture_mode: 'vision',
    });
    await h.cleanup();
  });

  it('rejects screenshot true when capture_mode conflicts', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(),
    };
    const h = await makeHarness(deps);

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'get_window_state',
        args: { pid: 123, window_id: 7, screenshot: true, capture_mode: 'som' },
      },
    });
    const payload = textPayload(result) as {
      ok: boolean;
      errorCode: string;
      data: { validation_errors: Array<{ message: string }> };
    };

    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('INVALID_ARGS');
    expect(payload.data.validation_errors[0]?.message).toContain('use only capture_mode');
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
  });

  it.each([
    ['non-string app', 'list_windows', { app: 42 }],
    ['non-string canonical with app alias', 'list_windows', { app: 'Simulator', process_name: 42 }],
    ['false screenshot', 'get_window_state', { pid: 123, window_id: 7, screenshot: false }],
    ['non-boolean screenshot', 'get_window_state', { pid: 123, window_id: 7, screenshot: 'true' }],
    ['invalid canonical with screenshot alias', 'get_window_state', {
      pid: 123,
      window_id: 7,
      screenshot: true,
      capture_mode: 'bogus',
    }],
    ['app on another tool', 'launch_app', { app: 'Simulator' }],
  ])('keeps strict validation for %s', async (_caseName, name, args) => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(),
    };
    const h = await makeHarness(deps);

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: { name, args },
    });
    const payload = textPayload(result) as { ok: boolean; errorCode: string };

    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('INVALID_ARGS');
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
  });

  it('validates tool args before dispatch', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(),
    };
    const h = await makeHarness(deps);

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'type_text', args: { pid: 123 } },
    });
    const payload = textPayload(result) as { ok: boolean; errorCode: string };

    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('INVALID_ARGS');
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
  });

  it('forwards an explicit type_text delivery mode to cua-driver', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: true })),
    };
    const h = await makeHarness(deps);

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'type_text',
        args: { pid: 123, text: 'hello', delivery_mode: 'foreground' },
      },
    });

    expect(textPayload(result)).toMatchObject({ ok: true });
    expect(deps.callTool).toHaveBeenCalledWith('type_text', {
      pid: 123,
      text: 'hello',
      delivery_mode: 'foreground',
    });
    await h.cleanup();
  });

  it('dispatches zoom with cua-driver 0.5 region bounds', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: true })),
    };
    const h = await makeHarness(deps);

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'zoom',
        args: { window_id: 7, x1: 10, y1: 20, x2: 110, y2: 120 },
      },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('zoom', {
      window_id: 7,
      x1: 10,
      y1: 20,
      x2: 110,
      y2: 120,
    });
    await h.cleanup();
  });

  it('dispatches launch_app with current cua-driver args', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: true })),
    };
    const h = await makeHarness(deps);

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'launch_app',
        args: {
          bundle_id: 'com.example.app',
          creates_new_application_instance: true,
          electron_debugging_port: 9222,
          additional_arguments: ['--flag'],
        },
      },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('launch_app', {
      bundle_id: 'com.example.app',
      creates_new_application_instance: true,
      electron_debugging_port: 9222,
      additional_arguments: ['--flag'],
    });
    await h.cleanup();
  });

  it('dispatches standalone Simulator.app launches through the normal desktop driver', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: true })),
    };
    const h = await makeHarness(deps);

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'launch_app',
        args: { name: 'Simulator' },
      },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('launch_app', {
      name: 'Simulator',
    });
    await h.cleanup();
  });

  it('dispatches Xcode launches through the normal desktop driver', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: true })),
    };
    const h = await makeHarness(deps);

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'launch_app',
        args: {
          name: 'Xcode',
          bundle_id: 'com.apple.dt.Xcode',
          urls: ['file:///repo/App.xcworkspace'],
        },
      },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('launch_app', {
      name: 'Xcode',
      bundle_id: 'com.apple.dt.Xcode',
      urls: ['file:///repo/App.xcworkspace'],
    });
    await h.cleanup();
  });

  it.each([
    ['Xcode hotkey', 'hotkey', { pid: 686, window_id: 282, keys: ['cmd', 'r'] }],
    ['Simulator click', 'click', { pid: 44412, window_id: 29131, x: 20, y: 20 }],
  ])(
    'dispatches %s without requiring process provenance',
    async (_label, name, args) => {
      const deps: ComputerMcpDeps = {
        getStatus: vi.fn(),
        callTool: vi.fn(async () => ({ ok: true })),
      };
      const h = await makeHarness(deps, { sessionId: 'agent-session-1' });

      const payload = textPayload(await h.client.callTool({
        name: 'call_tool',
        arguments: {
          name,
          args,
        },
      })) as { ok: boolean };

      expect(payload.ok).toBe(true);
      expect(deps.callTool).toHaveBeenCalledWith(
        name,
        { ...args, session: 'agent-session-1' },
        { sessionId: 'agent-session-1' },
      );
      await h.cleanup();
    },
  );

  it('rejects model-supplied external iOS override fields before dispatch', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(),
    };
    const h = await makeHarness(deps);

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'launch_app',
        args: {
          bundle_id: 'com.apple.iphonesimulator',
          use_external_simulator: true,
        },
      },
    });
    const payload = textPayload(result) as { ok: boolean; errorCode: string };

    expect(payload).toMatchObject({
      ok: false,
      errorCode: 'INVALID_ARGS',
    });
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
  });

  it('rejects legacy launch_app args before dispatch', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(),
    };
    const h = await makeHarness(deps);

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'launch_app',
        args: { path: '/Applications/Test.app', wait_ms: 500 },
      },
    });
    const payload = textPayload(result) as { ok: boolean; errorCode: string };

    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('INVALID_ARGS');
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
  });

  it('dispatches set_value with value and required window_id', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: true })),
    };
    const h = await makeHarness(deps);

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'set_value',
        args: { pid: 123, window_id: 7, element_index: 2, value: 'Option' },
      },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('set_value', {
      pid: 123,
      window_id: 7,
      element_index: 2,
      value: 'Option',
    });
    await h.cleanup();
  });

  it('rejects legacy set_value text args before dispatch', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(),
    };
    const h = await makeHarness(deps);

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'set_value',
        args: { pid: 123, element_index: 2, text: 'Option' },
      },
    });
    const payload = textPayload(result) as { ok: boolean; errorCode: string };

    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('INVALID_ARGS');
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
  });

  it('dispatches scroll with current direction-based args', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: true })),
    };
    const h = await makeHarness(deps);

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'scroll',
        args: { pid: 123, direction: 'down', amount: 3, by: 'page' },
      },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('scroll', {
      pid: 123,
      direction: 'down',
      amount: 3,
      by: 'page',
    });
    await h.cleanup();
  });

  it('injects the current session id into session-aware action tools', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: true })),
    };
    const h = await makeHarness(deps, { sessionId: 'agent-session-1' });

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'click',
        args: { pid: 123, window_id: 7, x: 10, y: 20 },
      },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('click', {
      pid: 123,
      window_id: 7,
      x: 10,
      y: 20,
      session: 'agent-session-1',
    }, { sessionId: 'agent-session-1' });
    await h.cleanup();
  });

  it('resolves dynamic session context at tool-call time', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: true })),
    };
    let sessionId = 'dynamic-session-1';
    const h = await makeHarness(deps, {
      getSessionContext: () => ({
        agentKind: 'codex',
        workingDir: '/repo',
        sessionId,
      }),
    });

    await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'click',
        args: { pid: 123, window_id: 7, x: 10, y: 20 },
      },
    });
    sessionId = 'dynamic-session-2';
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'click',
        args: { pid: 123, window_id: 7, x: 11, y: 21 },
      },
    });
    const payload = textPayload(result) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenNthCalledWith(1, 'click', {
      pid: 123,
      window_id: 7,
      x: 10,
      y: 20,
      session: 'dynamic-session-1',
    }, { sessionId: 'dynamic-session-1', agentKind: 'codex' });
    expect(deps.callTool).toHaveBeenNthCalledWith(2, 'click', {
      pid: 123,
      window_id: 7,
      x: 11,
      y: 21,
      session: 'dynamic-session-2',
    }, { sessionId: 'dynamic-session-2', agentKind: 'codex' });
    await h.cleanup();
  });

  it('overrides caller-supplied session ids with the host session id', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: true })),
    };
    const h = await makeHarness(deps, { sessionId: 'agent-session-1' });

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'move_cursor',
        args: { x: 10, y: 20, cursor_id: 'stale-manual-cursor', session: 'manual-session' },
      },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('move_cursor', {
      x: 10,
      y: 20,
      cursor_id: 'agent-session-1',
      session: 'agent-session-1',
    }, { sessionId: 'agent-session-1' });
    await h.cleanup();
  });

  it('maps cursor-state reads to the host session cursor id', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: true })),
    };
    const h = await makeHarness(deps, { sessionId: 'agent-session-1' });

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'get_agent_cursor_state',
        args: { cursor_id: 'stale-manual-cursor' },
      },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('get_agent_cursor_state', {
      cursor_id: 'agent-session-1',
    }, { sessionId: 'agent-session-1' });
    await h.cleanup();
  });

  it('dispatches trajectory recording tools with the current session id (output_dir constrained to workingDir)', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: true })),
    };
    // output_dir is a local write path → constrained to the session workingDir;
    // a relative arg resolves to an absolute path inside it before dispatch.
    const root = await makeWorkingDir();
    const h = await makeHarness(deps, {
      getSessionContext: () => ({
        agentKind: 'claude-code',
        workingDir: root,
        sessionId: 'recording-session',
      }),
    });

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'start_recording',
        args: { output_dir: 'rec', record_video: true },
      },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('start_recording', {
      output_dir: path.join(root, 'rec'),
      record_video: true,
      session: 'recording-session',
    }, { sessionId: 'recording-session', agentKind: 'claude-code' });
    await h.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects a recording output_dir outside the session workingDir', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: true })),
    };
    const root = await makeWorkingDir();
    const h = await makeHarness(deps, {
      getSessionContext: () => ({
        agentKind: 'claude-code',
        workingDir: root,
        sessionId: 'recording-session',
      }),
    });

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'start_recording',
        args: { output_dir: '/tmp/cua-recording', record_video: true },
      },
    })) as { ok: boolean; errorCode?: string };

    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('PATH_NOT_ALLOWED');
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('suggests the driver default or workingDir for rejected screenshot paths', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(),
    };
    const root = await makeWorkingDir();
    const h = await makeHarness(deps, {
      getSessionContext: () => ({
        agentKind: 'claude-code',
        workingDir: root,
        sessionId: 'screenshot-session',
      }),
    });

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'get_window_state',
        args: {
          pid: 123,
          window_id: 7,
          capture_mode: 'vision',
          screenshot_out_file: path.resolve(root, '..', 'outside.png'),
        },
      },
    })) as { ok: boolean; errorCode: string; data: { message: string } };

    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('PATH_NOT_ALLOWED');
    expect(payload.data.message).toContain('省略 screenshot_out_file');
    expect(payload.data.message).toContain('workingDir 内');
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('suggests omitting screenshot_out_file when the session has no workingDir', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(),
    };
    const h = await makeHarness(deps);

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'get_window_state',
        args: {
          pid: 123,
          window_id: 7,
          capture_mode: 'vision',
          screenshot_out_file: 'state.png',
        },
      },
    })) as { ok: boolean; errorCode: string; data: { message: string } };

    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('PATH_NOT_ALLOWED');
    expect(payload.data.message).toContain('省略 screenshot_out_file');
    expect(payload.data.message).toContain('driver 使用默认路径');
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
  });

  it('replays a validated trajectory through Cindy action dispatch', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: true })),
    };
    const root = await makeWorkingDir();
    await writeTrajectory(root, [
      {
        tool: 'click',
        arguments: { pid: 123, window_id: 7, x: 10, y: 20 },
      },
    ]);
    const h = await makeHarness(deps, {
      getSessionContext: () => ({ agentKind: 'claude-code', workingDir: root }),
    });

    const payload = textPayload(
      await h.client.callTool({
        name: 'call_tool',
        arguments: {
          name: 'replay_trajectory',
          args: { dir: 'rec', delay_ms: 0, stop_on_error: false },
        },
      }),
    ) as {
      ok: boolean;
      data: { attempted: number; succeeded: number; failed: number };
    };

    expect(payload).toMatchObject({
      ok: true,
      data: { attempted: 1, succeeded: 1, failed: 0 },
    });
    expect(deps.callTool).toHaveBeenCalledWith(
      'click',
      { pid: 123, window_id: 7, x: 10, y: 20 },
      { agentKind: 'claude-code' },
    );
    expect(deps.callTool).not.toHaveBeenCalledWith(
      'replay_trajectory',
      expect.anything(),
      expect.anything(),
    );
    await h.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')(
    'replays inside a workingDir reached through a symbolic link',
    async () => {
      const deps: ComputerMcpDeps = {
        getStatus: vi.fn(),
        callTool: vi.fn(async () => ({ ok: true })),
      };
      const container = await makeWorkingDir();
      const realWorkingDir = path.join(container, 'real-workspace');
      const linkedWorkingDir = path.join(container, 'linked-workspace');
      await fs.mkdir(realWorkingDir);
      await fs.symlink(realWorkingDir, linkedWorkingDir, 'dir');
      await writeTrajectory(realWorkingDir, [
        {
          tool: 'get_window_state',
          arguments: {
            pid: 121,
            window_id: 1,
            screenshot_out_file: 'screens/state.png',
          },
        },
      ]);
      const h = await makeHarness(deps, {
        getSessionContext: () => ({
          agentKind: 'claude-code',
          workingDir: linkedWorkingDir,
        }),
      });

      const payload = textPayload(await h.client.callTool({
        name: 'call_tool',
        arguments: {
          name: 'replay_trajectory',
          args: { dir: 'rec', delay_ms: 0 },
        },
      })) as { ok: boolean; data: { succeeded: number } };

      expect(payload).toMatchObject({ ok: true, data: { succeeded: 1 } });
      expect(deps.callTool).toHaveBeenCalledWith(
        'get_window_state',
        {
          pid: 121,
          window_id: 1,
          screenshot_out_file: path.join(realWorkingDir, 'screens', 'state.png'),
        },
        { agentKind: 'claude-code' },
      );
      await h.cleanup();
      await fs.rm(container, { recursive: true, force: true });
    },
  );

  it('replays external iOS desktop actions through the normal driver path', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: true })),
    };
    const root = await makeWorkingDir();
    await writeTrajectory(root, [
      { tool: 'launch_app', arguments: { name: 'Simulator' } },
      { tool: 'click', arguments: { pid: 202, window_id: 2, x: 30, y: 40 } },
    ]);
    const h = await makeHarness(deps, {
      getSessionContext: () => ({ agentKind: 'claude-code', workingDir: root }),
    });

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'replay_trajectory',
        args: { dir: 'rec', delay_ms: 0, stop_on_error: false },
      },
    })) as { ok: boolean; data: { attempted: number; succeeded: number } };

    expect(payload).toMatchObject({
      ok: true,
      data: { attempted: 2, succeeded: 2 },
    });
    expect(deps.callTool).toHaveBeenNthCalledWith(
      1,
      'launch_app',
      { name: 'Simulator' },
      { agentKind: 'claude-code' },
    );
    expect(deps.callTool).toHaveBeenNthCalledWith(
      2,
      'click',
      { pid: 202, window_id: 2, x: 30, y: 40 },
      { agentKind: 'claude-code' },
    );
    await h.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('executes the immutable preflight snapshot when the action file changes later', async () => {
    const root = await makeWorkingDir();
    const trajectory = await writeTrajectory(root, [
      { tool: 'type_text', arguments: { pid: 616, text: 'original text' } },
    ]);
    const actionPath = path.join(trajectory, 'turn-00001', 'action.json');
    const callTool = vi.fn(async () => {
      await fs.writeFile(
        actionPath,
        JSON.stringify({ tool: 'launch_app', arguments: { name: 'Simulator' } }),
        'utf8',
      );
      return { ok: true };
    });
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool,
    };
    const h = await makeHarness(deps, {
      getSessionContext: () => ({ agentKind: 'claude-code', workingDir: root }),
    });

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'replay_trajectory',
        args: { dir: 'rec', delay_ms: 0 },
      },
    })) as { ok: boolean; data: { succeeded: number } };

    expect(payload).toMatchObject({ ok: true, data: { succeeded: 1 } });
    expect(callTool).toHaveBeenCalledWith(
      'type_text',
      { pid: 616, text: 'original text' },
      { agentKind: 'claude-code' },
    );
    expect(callTool).not.toHaveBeenCalledWith('launch_app', expect.anything());
    await h.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a recorded turn that escapes through a symlink',
    async () => {
      const deps: ComputerMcpDeps = {
        getStatus: vi.fn(),
        callTool: vi.fn(async () => ({ ok: true })),
      };
      const root = await makeWorkingDir();
      const outside = await makeWorkingDir();
      await fs.mkdir(path.join(root, 'rec'), { recursive: true });
      await fs.writeFile(
        path.join(outside, 'action.json'),
        JSON.stringify({ tool: 'get_screen_size', arguments: {} }),
        'utf8',
      );
      await fs.symlink(outside, path.join(root, 'rec', 'turn-00001'), 'dir');
      const h = await makeHarness(deps, {
        getSessionContext: () => ({
          agentKind: 'claude-code',
          workingDir: root,
        }),
      });

      const result = await h.client.callTool({
        name: 'call_tool',
        arguments: {
          name: 'replay_trajectory',
          args: { dir: 'rec', delay_ms: 0 },
        },
      });

      expect(textPayload(result)).toMatchObject({
        ok: false,
        errorCode: 'TRAJECTORY_VALIDATION_FAILED',
        data: { turn: 'turn-00001' },
      });
      expect(deps.callTool).not.toHaveBeenCalled();
      await h.cleanup();
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a symbolic-link action file even when its target stays in the task',
    async () => {
      const deps: ComputerMcpDeps = {
        getStatus: vi.fn(),
        callTool: vi.fn(async () => ({ ok: true })),
      };
      const root = await makeWorkingDir();
      const turn = path.join(root, 'rec', 'turn-00001');
      await fs.mkdir(turn, { recursive: true });
      await fs.writeFile(
        path.join(root, 'safe-action.json'),
        JSON.stringify({ tool: 'get_screen_size', arguments: {} }),
        'utf8',
      );
      await fs.symlink(path.join(root, 'safe-action.json'), path.join(turn, 'action.json'));
      const h = await makeHarness(deps, {
        getSessionContext: () => ({ agentKind: 'claude-code', workingDir: root }),
      });

      const result = await h.client.callTool({
        name: 'call_tool',
        arguments: {
          name: 'replay_trajectory',
          args: { dir: 'rec', delay_ms: 0 },
        },
      });

      expect(textPayload(result)).toMatchObject({
        ok: false,
        errorCode: 'TRAJECTORY_VALIDATION_FAILED',
        data: { turn: 'turn-00001' },
      });
      expect(deps.callTool).not.toHaveBeenCalled();
      await h.cleanup();
      await fs.rm(root, { recursive: true, force: true });
    },
  );

  it('rejects trajectories whose aggregate action files exceed the memory budget', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: true })),
    };
    const root = await makeWorkingDir();
    await writeTrajectory(
      root,
      Array.from({ length: 9 }, (_, index) => ({
        tool: 'type_text',
        arguments: { pid: 800 + index, text: 'x'.repeat(240_000) },
      })),
    );
    const h = await makeHarness(deps, {
      getSessionContext: () => ({ agentKind: 'claude-code', workingDir: root }),
    });

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'replay_trajectory',
        args: { dir: 'rec', delay_ms: 0, stop_on_error: false },
      },
    });

    expect(textPayload(result)).toMatchObject({
      ok: false,
      errorCode: 'TRAJECTORY_VALIDATION_FAILED',
      data: { turn: 'turn-00009' },
    });
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('bounds accumulated replay result summaries', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => 'x'.repeat(10_000)),
    };
    const root = await makeWorkingDir();
    await writeTrajectory(
      root,
      Array.from({ length: 40 }, () => ({ tool: 'get_screen_size', arguments: {} })),
    );
    const h = await makeHarness(deps, {
      getSessionContext: () => ({ agentKind: 'claude-code', workingDir: root }),
    });

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'replay_trajectory',
        args: { dir: 'rec', delay_ms: 0 },
      },
    })) as { data: { turns: Array<{ result_summary: string }> } };

    expect(payload.data.turns).toHaveLength(40);
    expect(payload.data.turns.every((turn) => turn.result_summary.length <= 2_048)).toBe(true);
    expect(
      payload.data.turns.reduce((total, turn) => total + turn.result_summary.length, 0),
    ).toBeLessThanOrEqual(64 * 1024);
    await h.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('preserves recorded tool summaries instead of exposing Cindy envelopes', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi
        .fn()
        .mockResolvedValueOnce('screen is 1440x900')
        .mockRejectedValueOnce(new Error('driver capture failed')),
    };
    const root = await makeWorkingDir();
    await writeTrajectory(root, [
      { tool: 'get_screen_size', arguments: {} },
      { tool: 'get_screen_size', arguments: {} },
    ]);
    const h = await makeHarness(deps, {
      getSessionContext: () => ({ agentKind: 'claude-code', workingDir: root }),
    });

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'replay_trajectory',
        args: { dir: 'rec', delay_ms: 0, stop_on_error: false },
      },
    })) as {
      data: {
        turns: Array<{ result_summary: string }>;
        first_failure: { error: string };
      };
    };

    expect(payload.data.turns.map((turn) => turn.result_summary)).toEqual([
      'screen is 1440x900',
      'driver capture failed',
    ]);
    expect(payload.data.first_failure.error).toBe('driver capture failed');
    await h.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('stops dispatching recorded actions after the MCP request is cancelled', async () => {
    const controller = new AbortController();
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => {
        controller.abort();
        return { ok: true };
      }),
    };
    const root = await makeWorkingDir();
    await writeTrajectory(root, [
      { tool: 'get_screen_size', arguments: {} },
      { tool: 'get_screen_size', arguments: {} },
    ]);
    const h = await makeHarness(deps, {
      getSessionContext: () => ({ agentKind: 'claude-code', workingDir: root }),
    });

    await expect(
      h.client.callTool(
        {
          name: 'call_tool',
          arguments: {
            name: 'replay_trajectory',
            args: { dir: 'rec', delay_ms: 100, stop_on_error: false },
          },
        },
        undefined,
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(deps.callTool).toHaveBeenCalledTimes(1);
    await h.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects nested trajectory replay before any action is dispatched', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: true })),
    };
    const root = await makeWorkingDir();
    await writeTrajectory(root, [
      { tool: 'replay_trajectory', arguments: { dir: 'another-recording' } },
    ]);
    const h = await makeHarness(deps, {
      getSessionContext: () => ({ agentKind: 'claude-code', workingDir: root }),
    });

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'replay_trajectory',
        args: { dir: 'rec', delay_ms: 0 },
      },
    });

    expect(textPayload(result)).toMatchObject({
      ok: false,
      errorCode: 'TRAJECTORY_VALIDATION_FAILED',
      data: { turn: 'turn-00001' },
    });
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('fails closed before replay when a recorded action is malformed', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(),
    };
    const root = await makeWorkingDir();
    const turn = path.join(root, 'rec', 'turn-00001');
    await fs.mkdir(turn, { recursive: true });
    await fs.writeFile(path.join(turn, 'action.json'), '{not-json', 'utf8');
    const h = await makeHarness(deps, {
      getSessionContext: () => ({ agentKind: 'claude-code', workingDir: root }),
    });

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'replay_trajectory',
        args: { dir: 'rec', delay_ms: 0 },
      },
    });

    expect(textPayload(result)).toMatchObject({
      ok: false,
      errorCode: 'TRAJECTORY_VALIDATION_FAILED',
      data: { turn: 'turn-00001' },
    });
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects legacy scroll delta args before dispatch', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(),
    };
    const h = await makeHarness(deps);

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'scroll',
        args: { pid: 123, delta_y: 300 },
      },
    });
    const payload = textPayload(result) as { ok: boolean; errorCode: string };

    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('INVALID_ARGS');
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
  });

  it('rejects legacy zoom x/y/width/height args before dispatch', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(),
    };
    const h = await makeHarness(deps);

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'zoom',
        args: { window_id: 7, x: 10, y: 20, width: 100, height: 100 },
      },
    });
    const payload = textPayload(result) as { ok: boolean; errorCode: string };

    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('INVALID_ARGS');
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
  });
});
