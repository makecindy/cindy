import { describe, expect, it, vi } from 'vitest';

import { createIOSSimulatorCodexDynamicToolProvider } from '../ios-simulator-codex-dynamic-tools.js';

const CONTEXT = {
  sessionId: 'session-a',
  workingDir: '/repo',
  model: 'qwen/qwen3.8-max-preview',
  providerId: 'xd',
  vendorOptions: {},
};

describe('iOS Simulator Codex dynamic tools', () => {
  it('keeps the lightweight gateway discoverable so it can explain installation', () => {
    const provider = createIOSSimulatorCodexDynamicToolProvider({
      deps: { callTool: vi.fn() },
    });

    if (process.platform === 'darwin') {
      expect(provider.listTools(CONTEXT)).toEqual([
        expect.objectContaining({
          type: 'function',
          name: 'cindy_ios_simulator__list_tools',
          deferLoading: false,
        }),
        expect.objectContaining({
          type: 'function',
          name: 'cindy_ios_simulator__call_tool',
          deferLoading: false,
        }),
      ]);
    } else {
      expect(provider.listTools(CONTEXT)).toEqual([]);
    }
  });

  it('lists tools without invoking the simulator host', async () => {
    const callTool = vi.fn();
    const provider = createIOSSimulatorCodexDynamicToolProvider({
      deps: { callTool },
    });

    const result = await provider.callTool(
      {
        threadId: 'thread-a',
        turnId: 'turn-a',
        callId: 'call-a',
        namespace: null,
        tool: 'cindy_ios_simulator__list_tools',
        arguments: {},
      },
      CONTEXT,
    );

    expect(result?.success).toBe(process.platform === 'darwin');
    if (process.platform === 'darwin') {
      expect(result?.contentItems[0]).toMatchObject({
        type: 'inputText',
        text: expect.stringContaining('"check_environment"'),
      });
      // The workflow hint is model guidance: naming a superseded tool would send
      // the model straight back to the ambiguous name this rename hides.
      const listed = JSON.stringify(result?.contentItems ?? []);
      expect(listed).toContain('list_simulator_devices');
      expect(listed).not.toContain('list_devices');
      expect(callTool).not.toHaveBeenCalled();
    }
  });

  it('validates and forwards inner calls with authoritative session context', async () => {
    const callTool = vi.fn(async () => ({ ok: true, data: { available: true } }));
    const provider = createIOSSimulatorCodexDynamicToolProvider({
      deps: { callTool },
    });

    const result = await provider.callTool(
      {
        threadId: 'thread-a',
        turnId: 'turn-a',
        callId: 'call-a',
        namespace: null,
        tool: 'cindy_ios_simulator__call_tool',
        arguments: { name: 'check_environment', args: {} },
      },
      CONTEXT,
    );

    if (process.platform === 'darwin') {
      expect(result?.success).toBe(true);
      expect(callTool).toHaveBeenCalledWith(
        'check_environment',
        {},
        { sessionId: 'session-a', workingDir: '/repo', origin: 'agent' },
      );
    } else {
      expect(result?.success).toBe(false);
      expect(callTool).not.toHaveBeenCalled();
    }
  });

  it('surfaces an actionable plugin-required notice without touching the Host', async () => {
    const callTool = vi.fn(async () => ({
      ok: false,
      errorCode: 'IOS_SIMULATOR_PLUGIN_REQUIRED',
      message: 'Install the iOS Simulator plugin.',
    }));
    const describeTools = vi.fn(async () => ({
      ready: false,
      instanceCount: 0,
      runningInstanceCount: 0,
      tools: {
        check_environment: {
          state: 'unavailable' as const,
          reasonCode: 'IOS_SIMULATOR_PLUGIN_REQUIRED',
        },
      },
      notice: {
        errorCode: 'IOS_SIMULATOR_PLUGIN_REQUIRED' as const,
        message: 'Open Plugins → Marketplace and install iOS Simulator.',
        data: { action: 'install-plugin', pluginId: 'ios-simulator' },
      },
    }));
    const provider = createIOSSimulatorCodexDynamicToolProvider({
      deps: { callTool, describeTools },
    });

    const result = await provider.callTool(
      {
        threadId: 'thread-a',
        turnId: 'turn-a',
        callId: 'call-a',
        namespace: null,
        tool: 'cindy_ios_simulator__list_tools',
        arguments: {},
      },
      CONTEXT,
    );

    if (process.platform === 'darwin') {
      expect(result?.success).toBe(true);
      expect(result?.contentItems[0]).toMatchObject({
        text: expect.stringContaining('IOS_SIMULATOR_PLUGIN_REQUIRED'),
      });
      expect(result?.contentItems[0]).toMatchObject({
        text: expect.stringContaining('install-plugin'),
      });
      expect(describeTools).toHaveBeenCalledWith({
        sessionId: 'session-a',
        workingDir: '/repo',
        origin: 'agent',
      });
      expect(callTool).not.toHaveBeenCalled();
    }
  });
});
