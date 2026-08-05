import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => {
  const ipcMainHandlers = new Map<string, (e: unknown, payload: unknown) => unknown>();
  return {
    ipcMain: {
      handle: vi.fn((channel: string, fn: (e: unknown, payload: unknown) => unknown) => {
        ipcMainHandlers.set(channel, fn);
      }),
      on: vi.fn(),
      __handlers: ipcMainHandlers,
    },
  };
});

import { ipcMain, type BrowserWindow } from 'electron';

import { MAKER_INVOKE } from '../../maker-ipc/channels.js';
import { registerRsbWindowIpc } from '../ipc.js';
import type { RsbWindowController } from '../controller.js';

function makeController() {
  return {
    getState: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
    setDetached: vi.fn(),
    getContext: vi.fn(),
    getSidebarWebContents: vi.fn(),
    markReady: vi.fn(),
    setContext: vi.fn(),
    routeCommand: vi.fn(async () => 'routed'),
  } as unknown as RsbWindowController & { routeCommand: ReturnType<typeof vi.fn> };
}

function getSendCommandHandler() {
  const handlers = (
    ipcMain as unknown as {
      __handlers: Map<string, (e: unknown, payload: unknown) => unknown>;
    }
  ).__handlers;
  const handler = handlers.get(MAKER_INVOKE.RSB_WINDOW_SEND_COMMAND);
  if (!handler) throw new Error('RSB_WINDOW_SEND_COMMAND handler not registered');
  return handler;
}

function registerController(controller: RsbWindowController) {
  const mainWebContents = { id: 1 };
  const mainWindow = {
    isDestroyed: () => false,
    webContents: mainWebContents,
  } as unknown as BrowserWindow;
  registerRsbWindowIpc({ controller, getMainWindow: () => mainWindow });
  return { handler: getSendCommandHandler(), mainWebContents };
}

beforeEach(() => {
  (ipcMain as unknown as { __handlers: Map<string, unknown> }).__handlers.clear();
  (ipcMain.handle as ReturnType<typeof vi.fn>).mockClear();
  (ipcMain.on as ReturnType<typeof vi.fn>).mockClear();
});

describe('right-sidebar-window IPC', () => {
  it('preserves missing vs explicit null worker focus hints in ensure commands', async () => {
    const controller = makeController();
    const { handler, mainWebContents } = registerController(controller);
    await handler(
      { sender: mainWebContents },
      {
        command: { type: 'ensure-orca-workers-tab', sessionId: 's1', focusTab: true },
        allowOpen: true,
      },
    );
    await handler(
      { sender: mainWebContents },
      {
        command: {
          type: 'ensure-orca-workers-tab',
          sessionId: 's1',
          focusWorkerSessionId: null,
          focusTab: true,
        },
        allowOpen: false,
      },
    );
    await handler(
      { sender: mainWebContents },
      {
        command: {
          type: 'ensure-orca-workers-tab',
          sessionId: 's1',
          focusWorkerSessionId: undefined,
          focusTab: true,
        },
        allowOpen: true,
      },
    );

    expect(controller.routeCommand).toHaveBeenNthCalledWith(1, {
      command: { type: 'ensure-orca-workers-tab', sessionId: 's1', focusTab: true },
      allowOpen: true,
    });
    expect(controller.routeCommand).toHaveBeenNthCalledWith(2, {
      command: {
        type: 'ensure-orca-workers-tab',
        sessionId: 's1',
        focusWorkerSessionId: null,
        focusTab: true,
      },
      allowOpen: false,
    });
    expect(controller.routeCommand).toHaveBeenNthCalledWith(3, {
      command: { type: 'ensure-orca-workers-tab', sessionId: 's1', focusTab: true },
      allowOpen: true,
    });
  });

  it('validates and forwards worker search jumps and web-browser open commands', async () => {
    const controller = makeController();
    const { handler, mainWebContents } = registerController(controller);
    const searchJump = {
      kind: 'conversation-search',
      sessionId: 'worker-1',
      messageId: 'message-1',
      messageIdKind: 'clientId',
      messageClientId: 'message-1',
    };

    await handler(
      { sender: mainWebContents },
      {
        command: {
          type: 'ensure-orca-workers-tab',
          sessionId: 'lead-1',
          focusWorkerSessionId: 'worker-1',
          searchJump,
          focusTab: true,
        },
        allowOpen: true,
      },
    );
    await handler(
      { sender: mainWebContents },
      {
        command: {
          type: 'open-web-browser',
          sessionId: 'lead-1',
          url: 'https://example.com/',
        },
        allowOpen: true,
      },
    );

    expect(controller.routeCommand).toHaveBeenNthCalledWith(1, {
      command: {
        type: 'ensure-orca-workers-tab',
        sessionId: 'lead-1',
        focusWorkerSessionId: 'worker-1',
        searchJump,
        focusTab: true,
      },
      allowOpen: true,
    });
    expect(controller.routeCommand).toHaveBeenNthCalledWith(2, {
      command: {
        type: 'open-web-browser',
        sessionId: 'lead-1',
        url: 'https://example.com/',
      },
      allowOpen: true,
    });

    await expect(
      handler(
        { sender: mainWebContents },
        {
          command: {
            type: 'ensure-orca-workers-tab',
            sessionId: 'lead-1',
            searchJump: { kind: 'conversation-search' },
          },
          allowOpen: true,
        },
      ),
    ).rejects.toThrow(/searchJump/);
  });

  it('validates and forwards external-file browser commands', async () => {
    const controller = makeController();
    const { handler, mainWebContents } = registerController(controller);

    await handler(
      { sender: mainWebContents },
      {
        command: {
          type: 'open-file-browser',
          sessionId: 's1',
          absPath: 'C:\\tmp\\note.md',
          targetKind: 'external-file',
        },
        allowOpen: true,
      },
    );

    expect(controller.routeCommand).toHaveBeenCalledWith({
      command: {
        type: 'open-file-browser',
        sessionId: 's1',
        absPath: 'C:\\tmp\\note.md',
        targetKind: 'external-file',
      },
      allowOpen: true,
    });

    await expect(
      handler(
        { sender: mainWebContents },
        {
          command: {
            type: 'open-file-browser',
            sessionId: 's1',
            targetKind: 'external-file',
          },
          allowOpen: true,
        },
      ),
    ).rejects.toThrow(/command.absPath required/);
  });

  it('validates and forwards open-ghost-tab commands (ghostId 走身份卡同一校验)', async () => {
    const controller = makeController();
    const { handler, mainWebContents } = registerController(controller);

    await handler(
      { sender: mainWebContents },
      {
        command: { type: 'open-ghost-tab', sessionId: 's1', ghostId: 'tab-demo-a' },
        allowOpen: true,
      },
    );
    expect(controller.routeCommand).toHaveBeenCalledWith({
      command: { type: 'open-ghost-tab', sessionId: 's1', ghostId: 'tab-demo-a' },
      allowOpen: true,
    });

    // 野值(路径穿越形状 / 缺失)进不了命令通道。
    for (const ghostId of ['../escape', 'UPPER', '', undefined]) {
      await expect(
        handler(
          { sender: mainWebContents },
          {
            command: { type: 'open-ghost-tab', sessionId: 's1', ghostId },
            allowOpen: true,
          },
        ),
      ).rejects.toThrow(/ghostId/);
    }
  });

  it('drops commands from secondary renderers but still validates their payloads', async () => {
    const controller = makeController();
    const { handler } = registerController(controller);

    await expect(
      handler(
        { sender: { id: 2 } },
        {
          command: { type: 'open-terminal', sessionId: 'secondary-session' },
          allowOpen: true,
        },
      ),
    ).resolves.toBe('stale-context');
    expect(controller.routeCommand).not.toHaveBeenCalled();

    await expect(
      handler(
        { sender: { id: 2 } },
        { command: { type: 'open-terminal', sessionId: '' }, allowOpen: true },
      ),
    ).rejects.toThrow(/command.sessionId required/);
  });

  it('forwards userInitiated when present and omits it when absent', async () => {
    const controller = makeController();
    const { handler, mainWebContents } = registerController(controller);
    const command = { type: 'open-web-browser', sessionId: 's1', url: 'https://x.test/' };

    await handler({ sender: mainWebContents }, { command, allowOpen: true, userInitiated: false });
    await handler({ sender: mainWebContents }, { command, allowOpen: true });

    expect(controller.routeCommand).toHaveBeenNthCalledWith(1, {
      command,
      allowOpen: true,
      userInitiated: false,
    });
    // 缺省不注入字段 —— controller 侧自己按 "!== false" 兜到用户手势语义。
    expect(controller.routeCommand).toHaveBeenNthCalledWith(2, { command, allowOpen: true });

    await expect(
      handler({ sender: mainWebContents }, { command, allowOpen: true, userInitiated: 'yes' }),
    ).rejects.toThrow(/request.userInitiated/);
  });

  it('open payload:缺省/空 = 用户手势;显式 false 透传;野值拒绝', async () => {
    const controller = makeController();
    registerController(controller);
    const handlers = (
      ipcMain as unknown as { __handlers: Map<string, (e: unknown, p: unknown) => unknown> }
    ).__handlers;
    const open = handlers.get(MAKER_INVOKE.RSB_WINDOW_OPEN);
    if (!open) throw new Error('RSB_WINDOW_OPEN handler not registered');

    open({}, undefined);
    open({}, {});
    open({}, { userInitiated: false });

    expect(controller.open).toHaveBeenNthCalledWith(1, { userInitiated: true });
    expect(controller.open).toHaveBeenNthCalledWith(2, { userInitiated: true });
    expect(controller.open).toHaveBeenNthCalledWith(3, { userInitiated: false });

    expect(() => open({}, { userInitiated: 1 })).toThrow(/options.userInitiated/);
  });

  it('requires an explicit allowOpen boolean in the IPC envelope', async () => {
    const controller = makeController();
    const { handler, mainWebContents } = registerController(controller);

    await expect(
      handler(
        { sender: mainWebContents },
        { command: { type: 'open-terminal', sessionId: 's1' } },
      ),
    ).rejects.toThrow(/request.allowOpen/);
  });
});
