import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  callToolMock,
  clientCloseMock,
  clientConnectMock,
  clientCtorMock,
  existsSyncMock,
  transportCtorMock,
} = vi.hoisted(() => ({
  callToolMock: vi.fn(),
  clientCloseMock: vi.fn(),
  clientConnectMock: vi.fn(),
  clientCtorMock: vi.fn(),
  existsSyncMock: vi.fn(),
  transportCtorMock: vi.fn(),
}));

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: existsSyncMock,
    },
    existsSync: existsSyncMock,
  };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation((...args: unknown[]) => {
    clientCtorMock(...args);
    return {
      callTool: callToolMock,
      close: clientCloseMock,
      connect: clientConnectMock,
    };
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation((...args: unknown[]) => {
    transportCtorMock(...args);
    return {};
  }),
}));

import {
  closeComputerUseSwitchLocator,
  findComputerUseSwitchTarget,
  locateComputerUseSwitchTarget,
} from '../switch-target.js';

const windowsResult = {
  structuredContent: {
    windows: [{
      app_name: 'System Settings',
      bounds: { x: 466, y: 210, width: 723, height: 527 },
      pid: 100,
      window_id: 200,
    }],
  },
};

const stateResult = {
  structuredContent: {
    element_count: 2,
    elements: [{
      role: 'AXCheckBox',
      label: 'CuaDriver_Toggle',
      value: false,
      frame: { x: 1_123, y: 474, w: 36, h: 16 },
    }],
  },
};

const toolErrorResult = {
  isError: true,
  content: [{ type: 'text', text: 'session failed' }],
};

function mockSuccessfulLocate(): void {
  callToolMock.mockImplementation(async ({ name }: { name: string }) => (
    name === 'list_windows' ? windowsResult : stateResult
  ));
}

beforeEach(async () => {
  await closeComputerUseSwitchLocator();
  vi.clearAllMocks();
  setPlatform('darwin');
  existsSyncMock.mockReturnValue(true);
  clientConnectMock.mockResolvedValue(undefined);
  clientCloseMock.mockResolvedValue(undefined);
  mockSuccessfulLocate();
});

afterAll(() => {
  setPlatform(originalPlatform);
});

describe('persistent switch locator connection', () => {
  it('does not connect during isolated module import and connects on first locate', async () => {
    vi.resetModules();

    const switchTarget = await import('../switch-target.js');

    try {
      expect(clientCtorMock).not.toHaveBeenCalled();
      expect(transportCtorMock).not.toHaveBeenCalled();
      expect(clientConnectMock).not.toHaveBeenCalled();

      await expect(switchTarget.locateComputerUseSwitchTarget()).resolves.toMatchObject({
        status: 'found',
      });

      expect(clientCtorMock).toHaveBeenCalledTimes(1);
      expect(transportCtorMock).toHaveBeenCalledTimes(1);
      expect(clientConnectMock).toHaveBeenCalledTimes(1);
    } finally {
      await switchTarget.closeComputerUseSwitchLocator();
    }
  });

  it('reuses one client, transport, and session', async () => {
    await expect(locateComputerUseSwitchTarget()).resolves.toMatchObject({ status: 'found' });
    await expect(locateComputerUseSwitchTarget()).resolves.toMatchObject({ status: 'found' });

    expect(clientCtorMock).toHaveBeenCalledTimes(1);
    expect(transportCtorMock).toHaveBeenCalledTimes(1);
    expect(clientConnectMock).toHaveBeenCalledTimes(1);
    expect(clientCloseMock).not.toHaveBeenCalled();

    const sessions = callToolMock.mock.calls.map(
      ([request]) => request.arguments.session as string,
    );
    expect(sessions).toHaveLength(4);
    expect(new Set(sessions)).toEqual(new Set([sessions[0]]));
  });

  it('filters the AX snapshot by the stable CuaDriver row label', async () => {
    await expect(locateComputerUseSwitchTarget()).resolves.toMatchObject({ status: 'found' });

    const stateRequest = callToolMock.mock.calls
      .map(([request]) => request)
      .find((request) => request.name === 'get_window_state');
    expect(stateRequest?.arguments).toMatchObject({
      query: 'CuaDriver',
    });
  });

  it('serializes overlapping locate operations', async () => {
    const {
      promise: firstState,
      resolve: resolveFirstState,
    } = Promise.withResolvers<typeof stateResult>();
    callToolMock
      .mockResolvedValueOnce(windowsResult)
      .mockReturnValueOnce(firstState)
      .mockResolvedValueOnce(windowsResult)
      .mockResolvedValueOnce(stateResult);

    const firstLocate = locateComputerUseSwitchTarget();
    const secondLocate = locateComputerUseSwitchTarget();

    await vi.waitFor(() => expect(callToolMock).toHaveBeenCalledTimes(2));
    expect(callToolMock).toHaveBeenCalledTimes(2);
    expect(clientCtorMock).toHaveBeenCalledTimes(1);

    resolveFirstState(stateResult);
    await expect(Promise.all([firstLocate, secondLocate])).resolves.toEqual([
      expect.objectContaining({ status: 'found' }),
      expect.objectContaining({ status: 'found' }),
    ]);
    expect(callToolMock.mock.calls.map(([request]) => request.name)).toEqual([
      'list_windows',
      'get_window_state',
      'list_windows',
      'get_window_state',
    ]);
  });

  it('discards a failed connection and reconnects on the next locate', async () => {
    clientConnectMock
      .mockRejectedValueOnce(new Error('connect failed'))
      .mockResolvedValueOnce(undefined);

    await expect(locateComputerUseSwitchTarget()).rejects.toThrow('connect failed');
    await expect(locateComputerUseSwitchTarget()).resolves.toMatchObject({ status: 'found' });

    expect(clientCtorMock).toHaveBeenCalledTimes(2);
    expect(transportCtorMock).toHaveBeenCalledTimes(2);
    expect(clientConnectMock).toHaveBeenCalledTimes(2);
    expect(clientCloseMock).toHaveBeenCalledTimes(1);
  });

  it('discards a connection after a tool failure and reconnects', async () => {
    callToolMock
      .mockRejectedValueOnce(new Error('tool failed'))
      .mockResolvedValueOnce(windowsResult)
      .mockResolvedValueOnce(stateResult);

    await expect(locateComputerUseSwitchTarget()).rejects.toThrow('tool failed');
    await expect(locateComputerUseSwitchTarget()).resolves.toMatchObject({ status: 'found' });

    expect(clientCtorMock).toHaveBeenCalledTimes(2);
    expect(transportCtorMock).toHaveBeenCalledTimes(2);
    expect(clientConnectMock).toHaveBeenCalledTimes(2);
    expect(clientCloseMock).toHaveBeenCalledTimes(1);
  });

  it('discards and reconnects when list_windows resolves with an MCP error', async () => {
    callToolMock
      .mockResolvedValueOnce(toolErrorResult)
      .mockResolvedValueOnce(windowsResult)
      .mockResolvedValueOnce(stateResult);

    await expect(locateComputerUseSwitchTarget()).rejects.toThrow('list_windows');
    await expect(locateComputerUseSwitchTarget()).resolves.toMatchObject({ status: 'found' });

    expect(clientCtorMock).toHaveBeenCalledTimes(2);
    expect(transportCtorMock).toHaveBeenCalledTimes(2);
    expect(clientConnectMock).toHaveBeenCalledTimes(2);
    expect(clientCloseMock).toHaveBeenCalledTimes(1);
  });

  it('discards and reconnects when get_window_state resolves with an MCP error', async () => {
    callToolMock
      .mockResolvedValueOnce(windowsResult)
      .mockResolvedValueOnce(toolErrorResult)
      .mockResolvedValueOnce(windowsResult)
      .mockResolvedValueOnce(stateResult);

    await expect(locateComputerUseSwitchTarget()).rejects.toThrow('get_window_state');
    await expect(locateComputerUseSwitchTarget()).resolves.toMatchObject({ status: 'found' });

    expect(clientCtorMock).toHaveBeenCalledTimes(2);
    expect(transportCtorMock).toHaveBeenCalledTimes(2);
    expect(clientConnectMock).toHaveBeenCalledTimes(2);
    expect(clientCloseMock).toHaveBeenCalledTimes(1);
  });

  it('serializes close with locate work and closes idempotently', async () => {
    const {
      promise: pendingState,
      resolve: resolveState,
    } = Promise.withResolvers<typeof stateResult>();
    callToolMock
      .mockResolvedValueOnce(windowsResult)
      .mockReturnValueOnce(pendingState);

    const locate = locateComputerUseSwitchTarget();
    await vi.waitFor(() => expect(callToolMock).toHaveBeenCalledTimes(2));
    const firstClose = closeComputerUseSwitchLocator();
    const secondClose = closeComputerUseSwitchLocator();

    expect(clientCloseMock).not.toHaveBeenCalled();

    resolveState(stateResult);
    await locate;
    await expect(Promise.all([firstClose, secondClose])).resolves.toEqual([undefined, undefined]);
    expect(clientCloseMock).toHaveBeenCalledTimes(1);
  });

  it('swallows close errors and reconnects on the next locate', async () => {
    await locateComputerUseSwitchTarget();
    clientCloseMock.mockRejectedValueOnce(new Error('close failed'));

    await expect(closeComputerUseSwitchLocator()).resolves.toBeUndefined();
    await expect(locateComputerUseSwitchTarget()).resolves.toMatchObject({ status: 'found' });

    expect(clientCloseMock).toHaveBeenCalledTimes(1);
    expect(clientCtorMock).toHaveBeenCalledTimes(2);
  });
});

describe('findComputerUseSwitchTarget', () => {
  it('targets the exact CuaDriver checkbox instead of other computer-use rows', () => {
    const result = findComputerUseSwitchTarget(
      [{
        app_name: 'System Settings',
        bounds: { x: 466, y: 210, width: 723, height: 527 },
        pid: 100,
        window_id: 200,
      }],
      {
        elements: [
          {
            role: 'AXCheckBox',
            label: 'Codex Computer Use_Toggle',
            frame: { x: 1_123, y: 433, w: 36, h: 16 },
          },
          {
            role: 'AXCheckBox',
            label: 'CuaDriver_Toggle',
            value: false,
            frame: { x: 1_123, y: 474, w: 36, h: 16 },
          },
        ],
      },
    );

    expect(result).toEqual({ x: 675, y: 272, enabled: false });
  });

  it('returns null when the branded row is absent or virtualized', () => {
    const windows = [{
      app_name: 'System Settings',
      bounds: { x: 100, y: 100, width: 800, height: 600 },
    }];

    expect(findComputerUseSwitchTarget(windows, {
      elements: [{
        role: 'AXCheckBox',
        label: 'Codex Computer Use_Toggle',
        frame: { x: 700, y: 300, w: 36, h: 16 },
      }],
    })).toBeNull();
    expect(findComputerUseSwitchTarget(windows, {
      elements: [{
        role: 'AXCheckBox',
        label: 'CuaDriver_Toggle',
        frame: { x: 700, y: 300, w: 36, h: 1 },
      }],
    })).toBeNull();
  });

  it('identifies the permission pane when the AX snapshot includes its heading', () => {
    const result = findComputerUseSwitchTarget(
      [{
        app_name: 'System Settings',
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      }],
      {
        elements: [
          { role: 'AXStaticText', label: 'Screen Recording' },
          {
            role: 'AXCheckBox',
            label: 'CuaDriver_Toggle',
            value: true,
            frame: { x: 700, y: 300, w: 36, h: 16 },
          },
        ],
      },
    );

    expect(result).toEqual({
      x: 718,
      y: 308,
      enabled: true,
      permission: 'screenRecording',
    });
  });
});
