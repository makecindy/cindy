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
  it('registers an eager gateway only when the project capability is enabled', () => {
    const enabled = createIOSSimulatorCodexDynamicToolProvider({
      deps: { callTool: vi.fn() },
      isEnabled: () => true,
    });
    const disabled = createIOSSimulatorCodexDynamicToolProvider({
      deps: { callTool: vi.fn() },
      isEnabled: () => false,
    });

    if (process.platform === 'darwin') {
      expect(enabled.listTools(CONTEXT)).toEqual([
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
      expect(enabled.listTools(CONTEXT)).toEqual([]);
    }
    expect(disabled.listTools(CONTEXT)).toEqual([]);
  });

  it('lists tools without invoking the simulator host', async () => {
    const callTool = vi.fn();
    const provider = createIOSSimulatorCodexDynamicToolProvider({
      deps: { callTool },
      isEnabled: () => true,
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
      expect(callTool).not.toHaveBeenCalled();
    }
  });

  it('validates and forwards inner calls with authoritative session context', async () => {
    const callTool = vi.fn(async () => ({ ok: true, data: { available: true } }));
    const provider = createIOSSimulatorCodexDynamicToolProvider({
      deps: { callTool },
      isEnabled: () => true,
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
        { sessionId: 'session-a', origin: 'agent' },
      );
    } else {
      expect(result?.success).toBe(false);
      expect(callTool).not.toHaveBeenCalled();
    }
  });
});
