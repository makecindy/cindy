import { homedir } from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { SESSION_ACTIVITY_CHANNEL } from '@cindy/device-link';
import type { AgentEvent, InteractionRequest } from '@cindy/maker-core';
import { BRAND_NAME } from '@cindy/maker-shared/branding';

import { computeAgentIslandWindowBounds, type AgentIslandLayoutPreference } from '../geometry.js';
import {
  AGENT_ISLAND_GET_DISPLAY_OPTIONS_CHANNEL,
  AGENT_ISLAND_PREVIEW_SOUND_CHANNEL,
  AGENT_ISLAND_SET_DISPLAY_TARGET_CHANNEL,
  AGENT_ISLAND_SET_MASCOT_SKIN_CHANNEL,
  AGENT_ISLAND_SET_SOUND_SETTINGS_CHANNEL,
  AGENT_ISLAND_SET_VISIBLE_SESSION_CHANNEL,
  DEFAULT_AGENT_ISLAND_SOUND_SETTINGS,
  computeAgentIslandContentHeight,
  type AgentIslandDisplayState,
  type AgentIslandSoundChoice,
  type AgentIslandSoundSettings,
} from '../../../shared/agentIsland.js';
import { AGENT_ISLAND_DISPLAY_CONFIG } from '../displayConfig.js';
import type { AgentIslandNativeFrame } from '../MacAgentIslandNativeHost.js';
import { markAppContentWindow } from '../../windowFocusClassifier.js';
import type { AgentIslandService } from '../service.js';

const REMOTE_DAEMON_CLOSED_REASON = 'remote_daemon_closed';

// 受保护目录检测按 path.join(homedir(), ...) 的字面量匹配;测试消息必须用同一
// 拼法,否则在 Windows 开发机上分隔符对不上,darwin mock 下的用例会失真。
const protectedFolderFile = (kind: 'Desktop' | 'Documents', file: string): string =>
  path.join(homedir(), kind, file);

function handleInteractionRequestForTest(
  service: AgentIslandService,
  meta: Parameters<AgentIslandService['handleInteractionRequest']>[0],
  request: InteractionRequest,
): void {
  service.handleInteractionRequest(
    meta,
    request,
    service.captureInteractionEpoch(meta.sessionId),
  );
}

const mocks = vi.hoisted(() => ({
  getSessionRowSnapshot: vi.fn<() => Promise<{
    status: string;
    title: string | null;
    userSendAt: number | null;
    workingDir: string | null;
    workspaceKind: string | null;
  } | null>>(() => Promise.resolve(null)),
  primaryDisplay: {
    id: 1,
    label: 'Built-in Retina Display',
    bounds: { x: 0, y: 0, width: 1728, height: 1117 },
    internal: false,
  },
  displays: [] as Array<{
    id: number;
    label?: string;
    bounds: { x: number; y: number; width: number; height: number };
    internal: boolean;
  }>,
  getPrimaryDisplay: vi.fn(),
  getDisplayMatching: vi.fn(),
  getAllDisplays: vi.fn(),
  getPreferredSystemLanguages: vi.fn(),
  getLocale: vi.fn(),
  ipcHandle: vi.fn(),
  browserWindowFromWebContents: vi.fn(),
  browserWindowGetAllWindows: vi.fn<() => BrowserWindow[]>(() => []),
  readLayoutPreferences: vi.fn<() => Map<number, AgentIslandLayoutPreference>>(() => new Map()),
  writeLayoutPreference: vi.fn(),
  tapWindowBroadcast: vi.fn(),
  showMessageBox: vi.fn(),
  openExternal: vi.fn(),
  readdir: vi.fn<(...args: unknown[]) => Promise<string[]>>(() => Promise.resolve([])),
}));

// 受保护目录引导会由 Main 亲自 readdir 核实一次;只替换这一个 API,其余 fs/promises
// 保持真实。默认让读取失败(EPERM),模拟 macOS 真的拒绝了访问。
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readdir: mocks.readdir,
}));

function tccDeniedError(): NodeJS.ErrnoException {
  const error = new Error('EPERM: operation not permitted, scandir') as NodeJS.ErrnoException;
  error.code = 'EPERM';
  return error;
}

vi.mock('electron', () => {
  return {
    app: {
      getPreferredSystemLanguages: mocks.getPreferredSystemLanguages,
      getLocale: mocks.getLocale,
    },
    BrowserWindow: {
      fromWebContents: mocks.browserWindowFromWebContents,
      getAllWindows: mocks.browserWindowGetAllWindows,
    },
    dialog: { showMessageBox: mocks.showMessageBox },
    ipcMain: { handle: mocks.ipcHandle },
    shell: { openExternal: mocks.openExternal },
    screen: {
      getPrimaryDisplay: mocks.getPrimaryDisplay,
      getDisplayMatching: mocks.getDisplayMatching,
      getAllDisplays: mocks.getAllDisplays,
    },
  };
});

vi.mock('../../localDb/ipc/sessions.js', () => ({
  getSessionRowSnapshot: mocks.getSessionRowSnapshot,
}));

vi.mock('../layoutPreferenceStore.js', () => ({
  readAgentIslandLayoutPreferences: mocks.readLayoutPreferences,
  writeAgentIslandLayoutPreference: mocks.writeLayoutPreference,
}));

vi.mock('../../device-link/broadcast-tap.js', () => ({
  tapWindowBroadcast: mocks.tapWindowBroadcast,
}));

import { resetEpermGuidanceForTest } from '../../file-access/permissions.js';

beforeEach(() => {
  mocks.getSessionRowSnapshot.mockReset();
  mocks.getSessionRowSnapshot.mockResolvedValue(null);
  mocks.displays.splice(0, mocks.displays.length, mocks.primaryDisplay);
  mocks.getPrimaryDisplay.mockReset();
  mocks.getDisplayMatching.mockReset();
  mocks.getAllDisplays.mockReset();
  mocks.getPreferredSystemLanguages.mockReset();
  mocks.getLocale.mockReset();
  mocks.ipcHandle.mockReset();
  mocks.browserWindowFromWebContents.mockReset();
  mocks.browserWindowFromWebContents.mockReturnValue(null);
  mocks.browserWindowGetAllWindows.mockReset();
  mocks.browserWindowGetAllWindows.mockReturnValue([]);
  mocks.getPrimaryDisplay.mockImplementation(() => mocks.primaryDisplay);
  mocks.getDisplayMatching.mockImplementation(() => mocks.primaryDisplay);
  mocks.getAllDisplays.mockImplementation(() => mocks.displays);
  mocks.getPreferredSystemLanguages.mockReturnValue(['en']);
  mocks.getLocale.mockReturnValue('en');
  AGENT_ISLAND_DISPLAY_CONFIG.renderMode = 'all-displays';
  AGENT_ISLAND_DISPLAY_CONFIG.selectionMode = 'native-preferred-then-xdmaker-window';
  AGENT_ISLAND_DISPLAY_CONFIG.preferHardwareNotchFallback = true;
  AGENT_ISLAND_DISPLAY_CONFIG.preferInternalDisplayFallback = true;
  AGENT_ISLAND_DISPLAY_CONFIG.notifyOrcaWorkerSessions = false;
  mocks.readLayoutPreferences.mockReset();
  mocks.readLayoutPreferences.mockReturnValue(new Map());
  mocks.writeLayoutPreference.mockReset();
  mocks.tapWindowBroadcast.mockReset();
  mocks.showMessageBox.mockReset();
  mocks.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false });
  mocks.openExternal.mockReset();
  mocks.openExternal.mockResolvedValue(undefined);
  mocks.readdir.mockReset();
  mocks.readdir.mockRejectedValue(tccDeniedError());
  resetEpermGuidanceForTest();
});

type NativePublishCall = [
  AgentIslandDisplayState,
  AgentIslandNativeFrame | AgentIslandNativeFrame[],
  ...unknown[],
];

function latestNativeFrames(publish: {
  mock: { calls: NativePublishCall[] };
}): AgentIslandNativeFrame[] {
  const frameOrFrames = publish.mock.calls.at(-1)?.[1];
  if (!frameOrFrames) return [];
  return Array.isArray(frameOrFrames) ? frameOrFrames : [frameOrFrames];
}

function latestNativeFrame(publish: {
  mock: { calls: NativePublishCall[] };
}): AgentIslandNativeFrame | undefined {
  return latestNativeFrames(publish)[0];
}

function latestNativeStatesByDisplayId(publish: {
  mock: { calls: NativePublishCall[] };
}): Record<string, AgentIslandDisplayState> | undefined {
  const raw = publish.mock.calls.at(-1)?.[2];
  return raw && typeof raw === 'object'
    ? raw as Record<string, AgentIslandDisplayState>
    : undefined;
}

function terminalErrorEvent(message: string, reason?: string): AgentEvent {
  return {
    type: 'error',
    source: 'claude-code',
    data: { message, isTerminal: true, ...(reason ? { reason } : {}) },
  };
}

function recoverableErrorEvent(message: string): AgentEvent {
  return {
    type: 'error',
    source: 'codex',
    data: { message, isTerminal: false, willRetry: true },
  };
}

function authenticationErrorEvent(message = 'authentication failed'): AgentEvent {
  return {
    type: 'error',
    source: 'claude-code',
    data: { message, sdkError: 'authentication_failed', isTerminal: true },
  };
}

function doneEvent(): AgentEvent {
  return {
    type: 'done',
    source: 'codex',
    data: { result: 'done' },
  };
}

function cancelledDoneEvent(turnId?: string): AgentEvent {
  return {
    type: 'done',
    source: 'codex',
    data: {
      type: 'codex/event/task_complete',
      cancelled: true,
      ...(turnId ? { raw: { id: turnId } } : {}),
    },
  };
}

function textEvent(text: string, isFinal = false): AgentEvent {
  return {
    type: 'text',
    source: 'codex',
    data: { text, isFinal },
  };
}

function customSound(name: string): AgentIslandSoundChoice {
  return { type: 'custom', path: `/tmp/${name}`, name };
}

function registeredIpcHandler(channel: string): (...args: unknown[]) => unknown {
  const call = mocks.ipcHandle.mock.calls.find(([registeredChannel]) => registeredChannel === channel);
  expect(call).toBeDefined();
  return call?.[1] as (...args: unknown[]) => unknown;
}

function syncEnabledForTest(service: { setEnabled(enabled: boolean): void }, publish: { mockClear(): void }): void {
  service.setEnabled(true);
  publish.mockClear();
}

describe('Agent Island window geometry', () => {
  it('simulates a notch at the display top center', () => {
    const display = {
      bounds: { x: 100, y: -900, width: 1728, height: 1117 },
    };

    expect(computeAgentIslandWindowBounds(display)).toEqual({
      x: 624,
      y: -900,
      width: 680,
      height: 580,
    });
  });

  it('keeps the Vibe Island horizontal inset rule on narrow displays', () => {
    const display = {
      bounds: { x: 0, y: 0, width: 500, height: 900 },
    };

    expect(computeAgentIslandWindowBounds(display)).toEqual({
      x: 36,
      y: 0,
      width: 428,
      height: 580,
    });
  });

  it('uses Vibe Island expanded carrier insets for the open panel', () => {
    const display = {
      bounds: { x: 100, y: -900, width: 1728, height: 1117 },
    };

    expect(computeAgentIslandWindowBounds(display, true)).toEqual({
      x: 564,
      y: -900,
      width: 800,
      height: 640,
    });
  });

  it('uses measured content height for the carrier frame when available', () => {
    const display = {
      bounds: { x: 100, y: -900, width: 1728, height: 1117 },
    };

    expect(computeAgentIslandWindowBounds(display, { expanded: true, contentHeight: 240 })).toEqual({
      x: 564,
      y: -900,
      width: 800,
      height: 320,
    });
  });

  it('clamps dragged horizontal position so the expanded island still fits', () => {
    const display = {
      bounds: { x: 100, y: -900, width: 1728, height: 1117 },
    };

    expect(computeAgentIslandWindowBounds(display, { expanded: false, centerXRatio: 1 })).toEqual({
      x: 1088,
      y: -900,
      width: 680,
      height: 580,
    });

    expect(computeAgentIslandWindowBounds(display, { expanded: true, centerXRatio: 1 })).toEqual({
      x: 1028,
      y: -900,
      width: 800,
      height: 640,
    });
  });

  it('uses the resized content width for compact and expanded carrier frames', () => {
    const display = {
      bounds: { x: 0, y: 0, width: 1200, height: 900 },
    };

    expect(computeAgentIslandWindowBounds(display, {
      expanded: false,
      centerXRatio: 0.25,
      contentWidth: 420,
    })).toEqual({
      x: 70,
      y: 0,
      width: 460,
      height: 580,
    });

    expect(computeAgentIslandWindowBounds(display, {
      expanded: true,
      centerXRatio: 0.25,
      contentWidth: 420,
      contentHeight: 240,
    })).toEqual({
      x: 10,
      y: 0,
      width: 580,
      height: 320,
    });
  });

  it('allows dragged content wider than the default expanded width', () => {
    const display = {
      bounds: { x: 0, y: 0, width: 1200, height: 900 },
    };

    expect(computeAgentIslandWindowBounds(display, {
      expanded: false,
      centerXRatio: 0.5,
      contentWidth: 900,
    })).toEqual({
      x: 130,
      y: 0,
      width: 940,
      height: 580,
    });

    expect(computeAgentIslandWindowBounds(display, {
      expanded: true,
      centerXRatio: 0.5,
      contentWidth: 1200,
      contentHeight: 240,
    })).toEqual({
      x: 60,
      y: 0,
      width: 1080,
      height: 320,
    });
  });

  it('allows compact resize narrower than the expanded panel minimum', () => {
    const display = {
      bounds: { x: 0, y: 0, width: 1200, height: 900 },
    };

    expect(computeAgentIslandWindowBounds(display, {
      expanded: false,
      centerXRatio: 0.5,
      contentWidth: 250,
    })).toEqual({
      x: 455,
      y: 0,
      width: 290,
      height: 580,
    });

    expect(computeAgentIslandWindowBounds(display, {
      expanded: true,
      centerXRatio: 0.5,
      contentWidth: 250,
      contentHeight: 240,
    })).toEqual({
      x: 340,
      y: 0,
      width: 520,
      height: 320,
    });
  });
});

describe('Agent Island expanded content height', () => {
  it('reserves a row slot for the idle expanded new conversation action', () => {
    expect(computeAgentIslandContentHeight({
      mode: 'expanded',
      displaySurface: 'collapsed',
      hasSession: false,
      totalCount: 0,
      measuredContentHeight: 0,
    })).toBe(154);
  });

  it('keeps the single-session expanded height but grows for independent task rows', () => {
    expect(computeAgentIslandContentHeight({
      mode: 'expanded',
      displaySurface: 'completionCard',
      hasSession: true,
      totalCount: 1,
      measuredContentHeight: 0,
    })).toBe(190);

    expect(computeAgentIslandContentHeight({
      mode: 'expanded',
      displaySurface: 'sessionList',
      hasSession: true,
      totalCount: 3,
      measuredContentHeight: 0,
    })).toBe(330);

    expect(computeAgentIslandContentHeight({
      mode: 'expanded',
      displaySurface: 'sessionList',
      hasSession: true,
      totalCount: 6,
      measuredContentHeight: 0,
    })).toBe(510);
  });

  it('keeps automatic cards single-height even when multiple sessions exist', () => {
    expect(computeAgentIslandContentHeight({
      mode: 'expanded',
      displaySurface: 'completionCard',
      hasSession: true,
      totalCount: 3,
      measuredContentHeight: 0,
    })).toBe(190);

    expect(computeAgentIslandContentHeight({
      mode: 'expanded',
      displaySurface: 'interactionCard',
      hasSession: true,
      totalCount: 3,
      measuredContentHeight: 0,
    })).toBe(190);
  });

  it('uses measured expanded content height for all expanded surfaces', () => {
    expect(computeAgentIslandContentHeight({
      mode: 'expanded',
      displaySurface: 'completionCard',
      hasSession: true,
      totalCount: 1,
      measuredContentHeight: 126,
    })).toBe(134);

    expect(computeAgentIslandContentHeight({
      mode: 'expanded',
      displaySurface: 'sessionList',
      hasSession: true,
      totalCount: 3,
      measuredContentHeight: 198,
    })).toBe(206);

    expect(computeAgentIslandContentHeight({
      mode: 'expanded',
      displaySurface: 'interactionCard',
      hasSession: true,
      totalCount: 1,
      measuredContentHeight: 80,
    })).toBe(118);
  });
});

describe('AgentIslandService native publishing', () => {
  it('keeps compact activity broadcasting alive in headless mode', async () => {
    const { AgentIslandService } = await import('../service.js');
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: {
        failed: false,
        headless: true,
        publish: () => true,
        suspend: () => undefined,
      },
    });

    service.setEnabled(false);
    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');

    expect(mocks.tapWindowBroadcast).toHaveBeenCalledWith(
      SESSION_ACTIVITY_CHANNEL,
      expect.objectContaining({
        sessionId: 's1',
        phase: 'running',
        compactDetail: 'run tests',
      }),
    );

    mocks.tapWindowBroadcast.mockClear();
    service.resetRuntimeState();
    service.handleUserPrompt({ sessionId: 's2', agentKind: 'codex' }, 'check logs');

    expect(mocks.tapWindowBroadcast).toHaveBeenCalledWith(
      SESSION_ACTIVITY_CHANNEL,
      expect.objectContaining({
        sessionId: 's2',
        phase: 'running',
        compactDetail: 'check logs',
      }),
    );
  });

  it('replays current compact activity for late sessions subscribers', async () => {
    const { AgentIslandService } = await import('../service.js');
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: {
        failed: false,
        headless: true,
        publish: () => true,
        suspend: () => undefined,
      },
    });

    service.setEnabled(false);
    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');
    mocks.tapWindowBroadcast.mockClear();

    service.replaySessionActivity();

    expect(mocks.tapWindowBroadcast).toHaveBeenCalledWith(
      SESSION_ACTIVITY_CHANNEL,
      expect.objectContaining({
        sessionId: 's1',
        phase: 'running',
        compactDetail: 'run tests',
      }),
    );
  });

  it('replays unread terminal activity for late sessions subscribers', async () => {
    const { AgentIslandService } = await import('../service.js');
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: {
        failed: false,
        headless: true,
        publish: () => true,
        suspend: () => undefined,
      },
    });

    service.setEnabled(false);
    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');
    service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, doneEvent());
    mocks.tapWindowBroadcast.mockClear();

    service.replaySessionActivity();

    // 完成但未读(attention=true)对迟到订阅者重放完整快照,而不是收尾清除包 ——
    // 手机端会话行右侧的完成绿点靠 phase+attention 点亮;已读后 attention 翻 false
    // 才降级为 terminal clear(由 relay isPublishableActivity 判定)。
    expect(mocks.tapWindowBroadcast).toHaveBeenCalledWith(
      SESSION_ACTIVITY_CHANNEL,
      expect.objectContaining({
        sessionId: 's1',
        phase: 'completed',
        attention: true,
      }),
    );
  });

  it('broadcasts a terminal clear for read receipts even when the session is unknown to state', async () => {
    const { AgentIslandService } = await import('../service.js');
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: {
        failed: false,
        headless: true,
        publish: () => true,
        suspend: () => undefined,
      },
    });

    service.setEnabled(false);
    // 桌面重启后 state / relay 条目全部丢失,但远端(手机)列表行可能仍挂着重启前
    // 的 attention=true 条目。explicit 已读回执对**本机拥有**的会话(localDb 有行)
    // 必须产生一帧收尾包,否则远端绿点永久挂死。
    mocks.getSessionRowSnapshot.mockResolvedValueOnce({
      status: 'active',
      title: 'stale',
      userSendAt: null,
      workingDir: '/tmp/x',
      workspaceKind: null,
    });
    service.handleSessionAttentionCleared('stale-session', 'explicit');

    await vi.waitFor(() => {
      expect(mocks.tapWindowBroadcast).toHaveBeenCalledWith(
        SESSION_ACTIVITY_CHANNEL,
        {
          sessionId: 'stale-session',
          phase: 'completed',
          compactDetail: '',
          attention: false,
        },
      );
    });

    // 本机只是控制端(会话不在本机 localDb,snapshot 默认 mock 返回 null):
    // 不得替 owner 设备广播否定帧,第三方控制端会误删 owner 的 live 条目。
    mocks.tapWindowBroadcast.mockClear();
    service.handleSessionAttentionCleared('remote-owned-session', 'explicit');
    await vi.waitFor(() => {
      expect(mocks.getSessionRowSnapshot).toHaveBeenCalledWith('remote-owned-session');
    });
    expect(mocks.tapWindowBroadcast).not.toHaveBeenCalled();

    // passive 与 explicit 同权:桌面控制端的正常阅读路径是 passive 回执,发起侧
    // 已做过 error 免疫;owner 重启后本机有行的会话必须照发收尾包,否则完成绿点
    // 在 passive 阅读路径下永远清不掉。
    mocks.tapWindowBroadcast.mockClear();
    mocks.getSessionRowSnapshot.mockResolvedValueOnce({
      status: 'active',
      title: 'stale-2',
      userSendAt: null,
      workingDir: '/tmp/x',
      workspaceKind: null,
    });
    service.handleSessionAttentionCleared('stale-session-2', 'passive');
    await vi.waitFor(() => {
      expect(mocks.tapWindowBroadcast).toHaveBeenCalledWith(
        SESSION_ACTIVITY_CHANNEL,
        expect.objectContaining({ sessionId: 'stale-session-2', attention: false }),
      );
    });
  });

  it('keeps live activity intact when a read receipt arrives for a running or awaiting session', async () => {
    const { AgentIslandService } = await import('../service.js');
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: {
        failed: false,
        headless: true,
        publish: () => true,
        suspend: () => undefined,
      },
    });

    service.setEnabled(false);
    // needs-interaction 是稳定态:等待授权期间收到已读回执(如桌面切到该会话的
    // passive 清点),不得向远端发 completed 收尾包 —— 会把手机列表行的等待授权
    // 指示误清成"已完成",且没有后续事件能补回。
    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');
    handleInteractionRequestForTest(service,
      { sessionId: 's1' },
      {
        kind: 'permission',
        requestId: 'req-live',
        toolName: 'Bash',
        input: { command: 'pnpm test' },
      },
    );
    mocks.tapWindowBroadcast.mockClear();

    service.handleSessionAttentionCleared('s1', 'passive');

    expect(mocks.tapWindowBroadcast).not.toHaveBeenCalledWith(
      SESSION_ACTIVITY_CHANNEL,
      expect.objectContaining({ sessionId: 's1', phase: 'completed' }),
    );
  });

  it('broadcasts a terminal clear when a read receipt clears unread completion attention', async () => {
    const { AgentIslandService } = await import('../service.js');
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: {
        failed: false,
        headless: true,
        publish: () => true,
        suspend: () => undefined,
      },
    });

    service.setEnabled(false);
    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');
    service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, doneEvent());
    mocks.tapWindowBroadcast.mockClear();

    service.handleSessionAttentionCleared('s1', 'passive');

    expect(mocks.tapWindowBroadcast).toHaveBeenCalledWith(
      SESSION_ACTIVITY_CHANNEL,
      expect.objectContaining({
        sessionId: 's1',
        phase: 'completed',
        attention: false,
      }),
    );
  });

  it('does not broadcast a terminal clear when a passive receipt hits an unread error', async () => {
    const { AgentIslandService } = await import('../service.js');
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: {
        failed: false,
        headless: true,
        publish: () => true,
        suspend: () => undefined,
      },
    });

    service.setEnabled(false);
    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');
    service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, terminalErrorEvent('boom'));
    mocks.tapWindowBroadcast.mockClear();

    // 未读 error 对 passive 免疫:不能发收尾包,否则手机列表行的 error 红点会被
    // 导航级被动信号清掉(「已读以真实展示为准」)。
    service.handleSessionAttentionCleared('s1', 'passive');

    expect(mocks.tapWindowBroadcast).not.toHaveBeenCalledWith(
      SESSION_ACTIVITY_CHANNEL,
      expect.objectContaining({ sessionId: 's1', attention: false }),
    );

    // explicit(报错 UI 真实展示)仍可清:此时必须发收尾包。
    service.handleSessionAttentionCleared('s1', 'explicit');
    expect(mocks.tapWindowBroadcast).toHaveBeenCalledWith(
      SESSION_ACTIVITY_CHANNEL,
      expect.objectContaining({
        sessionId: 's1',
        attention: false,
      }),
    );
  });

  it('clears pending compact activity relay state during runtime reset', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      mocks.getSessionRowSnapshot.mockImplementation(() => new Promise<null>(() => undefined));
      const { AgentIslandService } = await import('../service.js');
      const service = new AgentIslandService({
        getMainWindow: () => null,
        nativeHost: {
          failed: false,
          headless: true,
          publish: () => true,
          suspend: () => undefined,
        },
      });

      service.setEnabled(false);
      service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'first step');
      expect(mocks.tapWindowBroadcast).toHaveBeenCalledWith(
        SESSION_ACTIVITY_CHANNEL,
        expect.objectContaining({
          sessionId: 's1',
          phase: 'running',
          compactDetail: 'first step',
        }),
      );

      mocks.tapWindowBroadcast.mockClear();
      vi.advanceTimersByTime(100);
      service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'second step');
      expect(mocks.tapWindowBroadcast).not.toHaveBeenCalled();

      service.resetRuntimeState();
      expect(mocks.tapWindowBroadcast).toHaveBeenCalledWith(
        SESSION_ACTIVITY_CHANNEL,
        {
          sessionId: 's1',
          phase: 'completed',
          compactDetail: '',
          attention: false,
        },
      );

      mocks.tapWindowBroadcast.mockClear();
      vi.advanceTimersByTime(1_500);
      expect(mocks.tapWindowBroadcast).not.toHaveBeenCalled();

      service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'second step');
      expect(mocks.tapWindowBroadcast).toHaveBeenCalledWith(
        SESSION_ACTIVITY_CHANNEL,
        expect.objectContaining({
          sessionId: 's1',
          phase: 'running',
          compactDetail: 'second step',
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces streaming text preview publishes on a short timer', async () => {
    vi.useFakeTimers();
    try {
      const { AgentIslandService } = await import('../service.js');
      const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
        void state;
        void frameOrFrames;
        return true;
      });
      const service = new AgentIslandService({
        getMainWindow: () => null,
        nativeHost: { failed: false, publish },
      });

      syncEnabledForTest(service, publish);
      service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');
      publish.mockClear();

      service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, textEvent('Hello'));
      service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, textEvent(' world'));

      expect(publish).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(49);
      expect(publish).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish.mock.calls.at(-1)?.[0].sessions[0]?.activityLines.map((line) => `${line.kind}:${line.text}`))
        .toContain('assistant:Hello world');

      service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, textEvent('Hello world.', true));

      expect(publish).toHaveBeenCalledTimes(2);
      expect(publish.mock.calls.at(-1)?.[0].sessions[0]?.activityLines.map((line) => `${line.kind}:${line.text}`))
        .toContain('assistant:Hello world.');
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('resolves permission actions from the island with session-scoped updates', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn(() => true);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });
    const resolver = vi.fn(() => true);
    const sessionUpdate = { destination: 'session', type: 'addRules' };

    service.setPermissionResolver(resolver);
    handleInteractionRequestForTest(service,
      { sessionId: 's1' },
      {
        kind: 'permission',
        requestId: 'req-1',
        toolName: 'Bash',
        input: { command: 'pnpm test' },
        suggestions: [sessionUpdate, { destination: 'project' }],
      },
    );

    service.handlePermissionAction({ requestId: 'req-1', action: 'allowForSession' });

    expect(resolver).toHaveBeenCalledWith('req-1', {
      kind: 'permission',
      behavior: 'allow',
      permissionUpdates: [sessionUpdate],
    });
  });

  it('clears the island permission prompt immediately after native approval succeeds', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });
    const resolver = vi.fn(() => true);

    syncEnabledForTest(service, publish);
    service.setPermissionResolver(resolver);
    handleInteractionRequestForTest(service,
      { sessionId: 's1', agentKind: 'codex' },
      {
        kind: 'permission',
        requestId: 'req-1',
        toolName: 'Bash',
        input: { command: 'pnpm test' },
      },
    );

    expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      phase: 'needs-interaction',
      permissionAction: { requestId: 'req-1' },
    });

    service.handlePermissionAction({ requestId: 'req-1', action: 'allow' });

    expect(resolver).toHaveBeenCalledWith('req-1', {
      kind: 'permission',
      behavior: 'allow',
      permissionUpdates: undefined,
    });
    expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      phase: 'running',
      permissionAction: null,
    });
    expect(publish.mock.calls.at(-1)?.[0].pillSnapshot.pendingInteractionCount).toBe(0);
  });

  it('keeps permission routing through recoverable errors and clears it on terminal errors', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn(() => true);
    const resolver = vi.fn(() => true);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });

    syncEnabledForTest(service, publish);
    service.setPermissionResolver(resolver);
    handleInteractionRequestForTest(service,
      { sessionId: 's1', agentKind: 'codex' },
      {
        kind: 'permission',
        requestId: 'req-reconnecting',
        toolName: 'Bash',
        input: { command: 'pnpm test' },
      },
    );

    service.handleAgentEvent(
      { sessionId: 's1', agentKind: 'codex' },
      recoverableErrorEvent('Reconnecting... 1/5'),
    );
    service.handlePermissionAction({ requestId: 'req-reconnecting', action: 'allow' });

    expect(resolver).toHaveBeenCalledWith('req-reconnecting', {
      kind: 'permission',
      behavior: 'allow',
      permissionUpdates: undefined,
    });

    handleInteractionRequestForTest(service,
      { sessionId: 's1', agentKind: 'codex' },
      {
        kind: 'permission',
        requestId: 'req-terminal',
        toolName: 'Bash',
        input: { command: 'pnpm test' },
      },
    );
    service.handleAgentEvent(
      { sessionId: 's1', agentKind: 'codex' },
      terminalErrorEvent('retry exhausted'),
    );
    service.handlePermissionAction({ requestId: 'req-terminal', action: 'allow' });

    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('clears an island permission prompt by request id after app-side approval', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });

    syncEnabledForTest(service, publish);
    handleInteractionRequestForTest(service,
      { sessionId: 's1', agentKind: 'codex' },
      {
        kind: 'permission',
        requestId: 'req-1',
        toolName: 'Bash',
        input: { command: 'pnpm test' },
      },
    );

    expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      phase: 'needs-interaction',
      permissionAction: { requestId: 'req-1' },
    });

    expect(service.handleInteractionDismissedByRequestId('req-1')).toBe(true);

    expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      phase: 'running',
      permissionAction: null,
    });
    expect(publish.mock.calls.at(-1)?.[0].pillSnapshot.pendingInteractionCount).toBe(0);
    expect(service.handleInteractionDismissedByRequestId('req-1')).toBe(false);
  });

  it('tracks plugin setup as a session interaction and returns to running when dismissed', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn(
      (
        state: AgentIslandDisplayState,
        frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[],
      ) => {
        void state;
        void frameOrFrames;
        return true;
      },
    );
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });

    syncEnabledForTest(service, publish);
    service.handlePluginSetupInteraction('s1', 'setup-1', '连接 Google 账号');
    expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      phase: 'needs-interaction',
      interactionKind: 'plugin_setup',
      detail: '连接 Google 账号',
    });
    expect(publish.mock.calls.at(-1)?.[0].pillSnapshot.pendingInteractionCount).toBe(1);

    service.handleInteractionDismissed('s1', 'setup-1');
    expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      phase: 'running',
    });
    expect(publish.mock.calls.at(-1)?.[0].sessions[0].interactionKind).toBeUndefined();
    expect(publish.mock.calls.at(-1)?.[0].pillSnapshot.pendingInteractionCount).toBe(0);
  });

  it('reveals the next pending permission prompt after approving the current one', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });
    const resolver = vi.fn(() => true);

    syncEnabledForTest(service, publish);
    service.setPermissionResolver(resolver);
    handleInteractionRequestForTest(service,
      { sessionId: 's1', agentKind: 'claude-code' },
      {
        kind: 'permission',
        requestId: 'req-1',
        toolName: 'WebSearch',
        input: { query: 'first' },
      },
    );
    handleInteractionRequestForTest(service,
      { sessionId: 's1', agentKind: 'claude-code' },
      {
        kind: 'permission',
        requestId: 'req-2',
        toolName: 'WebSearch',
        input: { query: 'second' },
      },
    );

    expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      phase: 'needs-interaction',
      permissionAction: { requestId: 'req-1' },
    });

    service.handlePermissionAction({ requestId: 'req-1', action: 'allow' });

    expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      phase: 'needs-interaction',
      permissionAction: { requestId: 'req-2' },
    });

    service.handlePermissionAction({ requestId: 'req-2', action: 'allow' });

    expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      phase: 'running',
      permissionAction: null,
    });
  });

  it('does not restore a permission prompt already cleared by tool start', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });

    syncEnabledForTest(service, publish);
    handleInteractionRequestForTest(service,
      { sessionId: 's1', agentKind: 'claude-code' },
      {
        kind: 'permission',
        requestId: 'req-1',
        toolName: 'WebSearch',
        input: { query: 'first' },
      },
    );
    handleInteractionRequestForTest(service,
      { sessionId: 's1', agentKind: 'claude-code' },
      {
        kind: 'permission',
        requestId: 'req-2',
        toolName: 'WebSearch',
        input: { query: 'second' },
      },
    );

    service.handleAgentEvent(
      { sessionId: 's1', agentKind: 'claude-code' },
      {
        type: 'tool_use',
        source: 'claude-code',
        data: { toolUseId: 'req-1', toolName: 'WebSearch', input: { query: 'first' } },
      },
    );

    expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      phase: 'needs-interaction',
      permissionAction: { requestId: 'req-2' },
    });

    service.handleInteractionDismissed('s1', 'req-2');

    expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      phase: 'running',
      permissionAction: null,
    });
  });

  it('does not restore a permission prompt cleared by Claude Code id/name tool start', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });

    syncEnabledForTest(service, publish);
    handleInteractionRequestForTest(service,
      { sessionId: 's1', agentKind: 'claude-code' },
      {
        kind: 'permission',
        requestId: 'toolu_claude_123',
        toolName: 'Bash',
        input: { command: 'pnpm test' },
      },
    );

    service.handleAgentEvent(
      { sessionId: 's1', agentKind: 'claude-code' },
      {
        type: 'tool_use',
        source: 'claude-code',
        data: { id: 'toolu_claude_123', name: 'Bash', input: { command: 'pnpm test' } },
      },
    );

    expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      phase: 'running',
      permissionAction: null,
    });

    service.handleInteractionDismissed('s1', 'toolu_claude_123');

    expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      phase: 'running',
      permissionAction: null,
    });
  });

  it('refreshes placeholder titles and hides dialogue workspace folders', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    mocks.getSessionRowSnapshot.mockResolvedValueOnce({
      status: 'active',
      title: 'New Maker',
      userSendAt: null,
      workingDir: '/Users/alice/Library/Application Support/xdt-maker/dialogues/2026-06-16/14ad7035-b7aa-4f5d-bc9f-6e39cffdd9ea',
      workspaceKind: 'dialogue',
    });
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });
    syncEnabledForTest(service, publish);

    service.handleUserPrompt(
      {
        sessionId: 's1',
        agentKind: 'codex',
        workingDir: '/Users/alice/Library/Application Support/xdt-maker/dialogues/2026-06-16/14ad7035-b7aa-4f5d-bc9f-6e39cffdd9ea',
        workspaceKind: 'dialogue',
      },
      '/goal 测试一下是不是支持目标模式',
    );
    await vi.waitFor(() => expect(mocks.getSessionRowSnapshot).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      title: 'New Maker',
      projectName: null,
    }));
    expect(publish.mock.calls.at(-1)?.[0].strings).toMatchObject({
      appName: BRAND_NAME,
      newMessage: 'New message',
      needsInput: 'Needs input',
      running: 'Running',
    });

    service.handleSessionMetadataPatch('s1', {
      title: '目标模式测试',
      workingDir: '/Users/alice/Library/Application Support/xdt-maker/dialogues/2026-06-16/14ad7035-b7aa-4f5d-bc9f-6e39cffdd9ea',
      workspaceKind: 'dialogue',
    });

    await vi.waitFor(() => expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      title: '目标模式测试',
      projectName: null,
    }));
  });

  it('does not recreate a closed session when async metadata finishes later', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    let resolveSnapshot!: (row: Awaited<ReturnType<typeof mocks.getSessionRowSnapshot>>) => void;
    let snapshotResolved = false;
    const snapshotPromise = new Promise<Awaited<ReturnType<typeof mocks.getSessionRowSnapshot>>>((resolve) => {
      resolveSnapshot = resolve;
    }).then((row) => {
      snapshotResolved = true;
      return row;
    });
    mocks.getSessionRowSnapshot.mockReturnValueOnce(snapshotPromise);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });
    syncEnabledForTest(service, publish);

    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');
    await vi.waitFor(() => expect(mocks.getSessionRowSnapshot).toHaveBeenCalledTimes(1));
    expect((
      service as unknown as { state: { sessions: Map<string, unknown> } }
    ).state.sessions.has('s1')).toBe(true);

    service.handleSessionClosed('s1');
    const publishCountAfterClose = publish.mock.calls.length;
    expect((
      service as unknown as { state: { sessions: Map<string, unknown> } }
    ).state.sessions.has('s1')).toBe(false);

    resolveSnapshot({
      status: 'active',
      title: 'Late metadata',
      userSendAt: null,
      workingDir: '/repo',
      workspaceKind: 'project',
    });
    await vi.waitFor(() => expect(snapshotResolved).toBe(true));
    await Promise.resolve();

    expect((
      service as unknown as { state: { sessions: Map<string, unknown> } }
    ).state.sessions.has('s1')).toBe(false);
    expect(publish).toHaveBeenCalledTimes(publishCountAfterClose);
  });

  it('waits for the renderer enabled preference before publishing native state', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const suspend = vi.fn();
    const focusedWindow = {
      isDestroyed: () => false,
      isFocused: () => true,
      isMinimizable: () => true,
    } as unknown as BrowserWindow;
    markAppContentWindow(focusedWindow);
    mocks.browserWindowGetAllWindows.mockReturnValue([focusedWindow]);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish, suspend },
    });

    service.setAppFocused(true);
    expect(publish).not.toHaveBeenCalled();
    expect(suspend).not.toHaveBeenCalled();

    service.setEnabled(false);
    expect(publish).not.toHaveBeenCalled();
    expect(suspend).not.toHaveBeenCalled();

    service.setEnabled(true);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      visible: true,
      appFocused: true,
      notchStatus: 'closed',
    });

    service.setEnabled(false);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(suspend).toHaveBeenCalledTimes(1);

    service.setAppFocused(false);
    mocks.browserWindowGetAllWindows.mockReturnValue([]);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(suspend).toHaveBeenCalledTimes(1);

    service.setEnabled(true);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]?.[0]).toMatchObject({
      visible: true,
      appFocused: false,
      notchStatus: 'closed',
    });
  });

  it('preserves focused secondary content windows when enabling', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const mainWindow = {
      isDestroyed: () => false,
      isFocused: () => false,
      isMinimizable: () => true,
    } as unknown as BrowserWindow;
    const secondaryWindow = {
      isDestroyed: () => false,
      isFocused: () => true,
      isMinimizable: () => true,
    } as unknown as BrowserWindow;
    markAppContentWindow(mainWindow);
    markAppContentWindow(secondaryWindow);
    mocks.browserWindowGetAllWindows.mockReturnValue([mainWindow, secondaryWindow]);
    const service = new AgentIslandService({
      getMainWindow: () => mainWindow,
      nativeHost: { failed: false, publish },
    });

    service.setEnabled(true);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      visible: true,
      appFocused: true,
      notchStatus: 'closed',
    });
  });

  it('accepts visible session updates only from the focused window', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });
    service.registerIpc();
    const getVisibleSessionId = () => (
      service as unknown as { state: { visibleSessionId: string | null } }
    ).state.visibleSessionId;
    const getVisibleSessionIds = () => Array.from((
      service as unknown as { state: { visibleSessionIds: Set<string> } }
    ).state.visibleSessionIds);
    const event = { sender: {} };
    const backgroundWindow = {
      isDestroyed: () => false,
      isFocused: () => false,
    } as unknown as BrowserWindow;
    const focusedWindow = {
      isDestroyed: () => false,
      isFocused: () => true,
    } as unknown as BrowserWindow;
    const destroyedWindow = {
      isDestroyed: () => true,
      isFocused: () => true,
    } as unknown as BrowserWindow;
    const handler = registeredIpcHandler(AGENT_ISLAND_SET_VISIBLE_SESSION_CHANNEL);

    mocks.browserWindowFromWebContents.mockReturnValue(backgroundWindow);
    await handler(event, 'background-session');
    expect(getVisibleSessionId()).toBeNull();

    mocks.browserWindowFromWebContents.mockReturnValue(focusedWindow);
    await handler(event, 'focused-session');
    expect(getVisibleSessionId()).toBe('focused-session');
    expect(getVisibleSessionIds()).toEqual(['focused-session']);

    await handler(event, ['lead-session', 'worker-session']);
    expect(getVisibleSessionId()).toBe('lead-session');
    expect(getVisibleSessionIds()).toEqual(['lead-session', 'worker-session']);

    await handler(event, null);
    expect(getVisibleSessionId()).toBeNull();
    expect(getVisibleSessionIds()).toEqual([]);

    await handler(event, 'focused-session');
    expect(getVisibleSessionId()).toBe('focused-session');

    mocks.browserWindowFromWebContents.mockReturnValue(destroyedWindow);
    await handler(event, 'destroyed-session');
    expect(getVisibleSessionId()).toBe('focused-session');
  });

  it('accepts pending focus visible-session acks before the window focus flag settles', async () => {
    const { AgentIslandService } = await import('../service.js');
    const send = vi.fn();
    const mainWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: { send },
    } as unknown as BrowserWindow;
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const service = new AgentIslandService({
      getMainWindow: () => mainWindow,
      nativeHost: { failed: false, publish },
    });
    syncEnabledForTest(service, publish);
    service.registerIpc();
    service.handleUserPrompt({ sessionId: 'target-session', agentKind: 'codex' }, 'run tests');
    const expand = (
      service as unknown as {
        handleNativeExpand(): void;
      }
    ).handleNativeExpand.bind(service);
    const focusSession = (
      service as unknown as {
        focusSession(sessionId: string): void;
      }
    ).focusSession.bind(service);
    const notYetFocusedWindow = {
      isDestroyed: () => false,
      isFocused: () => false,
    } as unknown as BrowserWindow;

    expand();
    publish.mockClear();
    focusSession('target-session');
    mocks.browserWindowFromWebContents.mockReturnValue(notYetFocusedWindow);
    await registeredIpcHandler(AGENT_ISLAND_SET_VISIBLE_SESSION_CHANNEL)(
      { sender: {} },
      'target-session',
    );

    expect(send).toHaveBeenCalledWith('notification:focus-session', 'target-session');
    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({
      mode: 'compact',
      currentSessionId: 'target-session',
    });
  });

  it('smart-suppresses all visible split sessions', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });
    syncEnabledForTest(service, publish);
    service.setAppFocused(true);
    service.registerIpc();
    const focusedWindow = {
      isDestroyed: () => false,
      isFocused: () => true,
    } as unknown as BrowserWindow;
    mocks.browserWindowFromWebContents.mockReturnValue(focusedWindow);
    await registeredIpcHandler(AGENT_ISLAND_SET_VISIBLE_SESSION_CHANNEL)(
      { sender: {} },
      ['lead-session', 'worker-session'],
    );

    service.handleUserPrompt({ sessionId: 'lead-session', agentKind: 'codex' }, 'lead prompt');
    service.handleUserPrompt({ sessionId: 'worker-session', agentKind: 'codex' }, 'worker prompt');
    service.handleAgentEvent({ sessionId: 'lead-session', agentKind: 'codex' }, doneEvent());
    service.handleAgentEvent({ sessionId: 'worker-session', agentKind: 'codex' }, doneEvent());

    const sessions = (
      service as unknown as {
        state: {
          sessions: Map<string, {
            unread: boolean;
            revealUntil: number | null;
            deferredReveal: boolean;
            deferredRevealReason: string | null;
          }>;
        };
      }
    ).state.sessions;
    expect(sessions.get('lead-session')).toMatchObject({
      unread: false,
      revealUntil: null,
      deferredReveal: false,
      deferredRevealReason: null,
    });
    expect(sessions.get('worker-session')).toMatchObject({
      unread: false,
      revealUntil: null,
      deferredReveal: false,
      deferredRevealReason: null,
    });
  });

  it('shows localized macOS protected-folder guidance once per folder kind', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    try {
      const { AgentIslandService } = await import('../service.js');
      const publish = vi.fn(() => true);
      const service = new AgentIslandService({
        getMainWindow: () => null,
        nativeHost: { failed: false, publish },
      });
      const event: AgentEvent = {
        type: 'tool_result_full',
        source: 'claude-code',
        data: {
          toolUseId: 'tool-1',
          fullText: `EPERM: operation not permitted, open '${protectedFolderFile('Desktop', 'blocked.txt')}'`,
        },
      };

      service.handleAgentEvent({ sessionId: 's1', agentKind: 'claude-code' }, event);
      await vi.waitFor(() => expect(mocks.showMessageBox).toHaveBeenCalledTimes(1));
      service.handleAgentEvent({ sessionId: 's2', agentKind: 'claude-code' }, event);
      await Promise.resolve();

      expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
      expect(mocks.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
        type: 'warning',
        title: 'macOS folder access denied',
        message: 'Cindy cannot access your Desktop folder',
        buttons: ['Open System Settings', 'Cancel'],
      }));
      expect(mocks.openExternal).not.toHaveBeenCalled();
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('opens macOS folder settings from a guidance dialog attached to the main window', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    try {
      const { AgentIslandService } = await import('../service.js');
      const mainWindow = { isDestroyed: () => false } as unknown as BrowserWindow;
      mocks.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false });
      const service = new AgentIslandService({
        getMainWindow: () => mainWindow,
        nativeHost: { failed: false, publish: vi.fn(() => true) },
      });

      service.handleAgentEvent(
        { sessionId: 's1', agentKind: 'claude-code' },
        {
          type: 'tool_result_full',
          source: 'claude-code',
          data: {
            toolUseId: 'tool-1',
            fullText: `EPERM: operation not permitted, open '${protectedFolderFile('Documents', 'blocked.txt')}'`,
            isError: true,
          },
        },
      );

      await vi.waitFor(() => expect(mocks.openExternal).toHaveBeenCalledWith(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_DocumentsFolder',
      ));
      expect(mocks.showMessageBox).toHaveBeenCalledWith(
        mainWindow,
        expect.objectContaining({ message: 'Cindy cannot access your Documents folder' }),
      );
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('does not show protected-folder guidance for an explicitly successful tool result', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    try {
      const { AgentIslandService } = await import('../service.js');
      const service = new AgentIslandService({
        getMainWindow: () => null,
        nativeHost: { failed: false, publish: vi.fn(() => true) },
      });

      service.handleAgentEvent(
        { sessionId: 's1', agentKind: 'codex' },
        {
          type: 'tool_result_full',
          source: 'codex',
          data: {
            toolUseId: 'tool-1',
            fullText: `Log excerpt: EPERM under '${protectedFolderFile('Desktop', 'blocked.txt')}'`,
            isError: false,
          },
        },
      );
      await Promise.resolve();

      expect(mocks.showMessageBox).not.toHaveBeenCalled();
      expect(mocks.openExternal).not.toHaveBeenCalled();
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('stays silent when the folder is readable, and still guides on a later real denial', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    try {
      const { AgentIslandService } = await import('../service.js');
      const service = new AgentIslandService({
        getMainWindow: () => null,
        nativeHost: { failed: false, publish: vi.fn(() => true) },
      });
      const event: AgentEvent = {
        type: 'tool_result_full',
        source: 'claude-code',
        data: {
          toolUseId: 'tool-1',
          fullText: `EPERM: operation not permitted, open '${protectedFolderFile('Documents', 'blocked.txt')}'`,
        },
      };

      // 粗筛命中,但 Main 亲自读得动 → 那条 EPERM 与 TCC 无关,不得打扰用户。
      mocks.readdir.mockResolvedValue([]);
      service.handleAgentEvent({ sessionId: 's1', agentKind: 'claude-code' }, event);
      await vi.waitFor(() => expect(mocks.readdir).toHaveBeenCalledTimes(1));
      expect(mocks.showMessageBox).not.toHaveBeenCalled();

      // 等首轮探测完整收尾并释放同目录的探测占位,否则第二条事件会被串行化挡掉。
      await new Promise((resolve) => setImmediate(resolve));

      // 且没有吃掉该目录的提醒名额:之后真被系统拒绝时仍然提示。
      mocks.readdir.mockRejectedValue(tccDeniedError());
      service.handleAgentEvent({ sessionId: 's2', agentKind: 'claude-code' }, event);
      await vi.waitFor(() => expect(mocks.showMessageBox).toHaveBeenCalledTimes(1));
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('does not show macOS protected-folder guidance on other platforms', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    try {
      const { AgentIslandService } = await import('../service.js');
      const service = new AgentIslandService({
        getMainWindow: () => null,
        nativeHost: { failed: false, publish: vi.fn(() => true) },
      });

      service.handleAgentEvent(
        { sessionId: 's1', agentKind: 'claude-code' },
        {
          type: 'tool_result_full',
          source: 'claude-code',
          data: {
            toolUseId: 'tool-1',
            fullText: `EPERM: operation not permitted, open '${protectedFolderFile('Desktop', 'blocked.txt')}'`,
            isError: true,
          },
        },
      );
      await Promise.resolve();

      expect(mocks.showMessageBox).not.toHaveBeenCalled();
      expect(mocks.openExternal).not.toHaveBeenCalled();
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('clears unread completion attention when focused windows report visible sessions', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });
    syncEnabledForTest(service, publish);
    service.registerIpc();

    service.handleUserPrompt({ sessionId: 'lead-session', agentKind: 'codex' }, 'lead prompt');
    service.handleUserPrompt({ sessionId: 'worker-session', agentKind: 'codex' }, 'worker prompt');
    service.handleAgentEvent({ sessionId: 'lead-session', agentKind: 'codex' }, doneEvent());
    service.handleAgentEvent({ sessionId: 'worker-session', agentKind: 'codex' }, doneEvent());

    expect(publish.mock.calls.at(-1)?.[0].pillSnapshot).toMatchObject({
      unreadCompletedCount: 2,
    });

    const focusedWindow = {
      isDestroyed: () => false,
      isFocused: () => true,
    } as unknown as BrowserWindow;
    mocks.browserWindowFromWebContents.mockReturnValue(focusedWindow);
    await registeredIpcHandler(AGENT_ISLAND_SET_VISIBLE_SESSION_CHANNEL)(
      { sender: {} },
      ['lead-session', 'worker-session'],
    );

    const lastState = publish.mock.calls.at(-1)?.[0];
    expect(lastState?.pillSnapshot).toMatchObject({
      unreadCompletedCount: 0,
      deferredRevealCount: 0,
    });
    expect(lastState?.sessions.some((session) => (
      session.sessionId === 'lead-session' || session.sessionId === 'worker-session'
    ))).toBe(false);
  });

  it('clears stale visible sessions before applying app focus', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });
    syncEnabledForTest(service, publish);
    service.registerIpc();
    const focusedWindow = {
      isDestroyed: () => false,
      isFocused: () => true,
    } as unknown as BrowserWindow;
    mocks.browserWindowFromWebContents.mockReturnValue(focusedWindow);

    service.setAppFocused(true);
    await registeredIpcHandler(AGENT_ISLAND_SET_VISIBLE_SESSION_CHANNEL)(
      { sender: {} },
      'previous-session',
    );
    service.setAppFocused(false);
    service.handleAgentEvent({ sessionId: 'previous-session', agentKind: 'codex' }, doneEvent());

    service.setAppFocused(true);

    const lastState = publish.mock.calls.at(-1)?.[0];
    expect(lastState).toMatchObject({
      mode: 'expanded',
      displayPolicy: 'transient',
      displaySurface: 'completionCard',
      currentSessionId: 'previous-session',
      smartSuppressed: false,
    });
    expect(lastState?.pillSnapshot).toMatchObject({
      unreadCompletedCount: 1,
      deferredRevealCount: 0,
    });
    const state = (
      service as unknown as {
        state: {
          visibleSessionId: string | null;
          visibleSessionIds: Set<string>;
        };
      }
    ).state;
    expect(state.visibleSessionId).toBeNull();
    expect(Array.from(state.visibleSessionIds)).toEqual([]);
  });

  it('restores main window focus after runtime reset before visible-session suppression', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const suspend = vi.fn();
    const focusedWindow = {
      isDestroyed: () => false,
      isFocused: () => true,
      isMinimizable: () => true,
    } as unknown as BrowserWindow;
    markAppContentWindow(focusedWindow);
    mocks.browserWindowGetAllWindows.mockReturnValue([focusedWindow]);
    const service = new AgentIslandService({
      getMainWindow: () => focusedWindow,
      nativeHost: { failed: false, publish, suspend },
    });
    service.registerIpc();
    syncEnabledForTest(service, publish);
    service.setAppFocused(true);

    service.resetRuntimeState();
    publish.mockClear();
    service.setEnabled(true);

    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({
      appFocused: true,
      displayPolicy: 'closed',
    });

    mocks.browserWindowFromWebContents.mockReturnValue(focusedWindow);
    await registeredIpcHandler(AGENT_ISLAND_SET_VISIBLE_SESSION_CHANNEL)(
      { sender: {} },
      'visible-session',
    );
    service.handleAgentEvent({ sessionId: 'visible-session', agentKind: 'codex' }, doneEvent());

    const lastState = publish.mock.calls.at(-1)?.[0];
    expect(lastState).toMatchObject({
      mode: 'compact',
      currentSessionId: 'visible-session',
      smartSuppressed: false,
    });
    expect(lastState?.pillSnapshot).toMatchObject({
      unreadCompletedCount: 0,
      deferredRevealCount: 0,
    });
  });

  it('clears runtime sessions and suspends the native helper on reset', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const suspend = vi.fn();
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish, suspend },
    });
    syncEnabledForTest(service, publish);
    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');
    expect((
      service as unknown as { state: { sessions: Map<string, unknown> } }
    ).state.sessions.size).toBe(1);

    service.resetRuntimeState();

    const state = (
      service as unknown as {
        state: {
          sessions: Map<string, unknown>;
          visibleSessionId: string | null;
          visibleSessionIds: Set<string>;
        };
      }
    ).state;
    expect(state.sessions.size).toBe(0);
    expect(state.visibleSessionId).toBeNull();
    expect(Array.from(state.visibleSessionIds)).toEqual([]);
    expect(suspend).toHaveBeenCalledTimes(1);

    publish.mockClear();
    service.setEnabled(true);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0].sessions).toEqual([]);
  });

  it('publishes sound settings and previews selected sounds through native helper', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const playSound = vi.fn<(sound: AgentIslandSoundChoice) => boolean>(() => true);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish, playSound },
    });
    syncEnabledForTest(service, publish);
    service.registerIpc();
    const settings: AgentIslandSoundSettings = {
      enabled: true,
      sounds: {
        ...DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds,
        start: { type: 'builtin', id: 'none' },
        complete: customSound('complete.wav'),
      },
    };

    await registeredIpcHandler(AGENT_ISLAND_SET_SOUND_SETTINGS_CHANNEL)(null, settings);

    expect(publish.mock.calls.at(-1)?.[0].soundSettings).toEqual(settings);

    await registeredIpcHandler(AGENT_ISLAND_PREVIEW_SOUND_CHANNEL)(null, 'none');
    await registeredIpcHandler(AGENT_ISLAND_PREVIEW_SOUND_CHANNEL)(null, 'not-a-sound');
    await registeredIpcHandler(AGENT_ISLAND_PREVIEW_SOUND_CHANNEL)(null, 'startup-chime');
    await registeredIpcHandler(AGENT_ISLAND_PREVIEW_SOUND_CHANNEL)(null, {
      type: 'custom',
      path: '/tmp/agent-island.wav',
      name: 'agent-island.wav',
    });

    expect(playSound).toHaveBeenCalledTimes(2);
    expect(playSound).toHaveBeenNthCalledWith(1, { type: 'builtin', id: 'startup-chime' });
    expect(playSound).toHaveBeenNthCalledWith(2, {
      type: 'custom',
      path: '/tmp/agent-island.wav',
      name: 'agent-island.wav',
    });
  });

  it('publishes the selected mascot skin through native state', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });
    syncEnabledForTest(service, publish);
    service.registerIpc();

    await registeredIpcHandler(AGENT_ISLAND_SET_MASCOT_SKIN_CHANNEL)(null, 'tarara');

    expect(publish.mock.calls.at(-1)?.[0].mascotSkin).toBe('tarara');
  });

  it('plays configured sounds for task start and completion transitions', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const playSound = vi.fn<(sound: AgentIslandSoundChoice) => boolean>(() => true);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish, playSound },
    });
    syncEnabledForTest(service, publish);
    service.setSoundSettings({
      enabled: true,
      sounds: {
        ...DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds,
        start: customSound('start.wav'),
        complete: customSound('complete.wav'),
      },
    });
    playSound.mockClear();

    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');
    service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, doneEvent());

    expect(playSound).toHaveBeenNthCalledWith(1, customSound('start.wav'));
    expect(playSound).toHaveBeenNthCalledWith(2, customSound('complete.wav'));
  });

  it('removes user-stopped sessions and ignores provider completion tails without playing completion sound', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const playSound = vi.fn<(sound: AgentIslandSoundChoice) => boolean>(() => true);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish, playSound },
    });
    syncEnabledForTest(service, publish);
    service.setSoundSettings({
      enabled: true,
      sounds: {
        ...DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds,
        start: customSound('start.wav'),
        complete: customSound('complete.wav'),
      },
    });

    service.handleUserPrompt({ sessionId: 'codex-stop', agentKind: 'codex' }, 'run tests');
    service.handleUserPrompt({ sessionId: 'claude-stop', agentKind: 'claude-code' }, 'run tests');
    playSound.mockClear();

    service.handleSessionStopped('codex-stop');
    service.handleAgentEvent(
      { sessionId: 'codex-stop', agentKind: 'codex' },
      cancelledDoneEvent(),
    );
    service.handleSessionStopped('claude-stop');
    service.handleAgentEvent(
      { sessionId: 'claude-stop', agentKind: 'claude-code' },
      { type: 'status', source: 'claude-code', data: { isRunning: false, status: 'Done' } },
    );
    service.handleAgentEvent(
      { sessionId: 'claude-stop', agentKind: 'claude-code' },
      { type: 'done', source: 'claude-code', data: { reason: 'turn_interrupted' } },
    );

    expect(playSound).not.toHaveBeenCalled();
    expect(publish.mock.calls.at(-1)?.[0].sessions).toEqual([]);

    service.handleUserPrompt({ sessionId: 'claude-stop', agentKind: 'claude-code' }, 'run again');
    service.handleAgentEvent(
      { sessionId: 'claude-stop', agentKind: 'claude-code' },
      { type: 'status', source: 'claude-code', data: { isRunning: true, status: 'Thinking...' } },
    );
    service.handleAgentEvent(
      { sessionId: 'claude-stop', agentKind: 'claude-code' },
      { type: 'status', source: 'claude-code', data: { isRunning: false, status: 'Done' } },
    );

    expect(playSound).toHaveBeenCalledWith(customSound('complete.wav'));
    expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      sessionId: 'claude-stop',
      phase: 'completed',
    });
  });

  it('removes a cancelled run that has no explicit Stop boundary', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const playSound = vi.fn<(sound: AgentIslandSoundChoice) => boolean>(() => true);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish, playSound },
    });
    syncEnabledForTest(service, publish);
    service.setSoundSettings({
      enabled: true,
      sounds: {
        ...DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds,
        start: customSound('start.wav'),
        complete: customSound('complete.wav'),
      },
    });
    const meta = { sessionId: 'codex-permission-tighten', agentKind: 'codex' as const };
    service.handleUserPrompt(meta, 'run tests');
    playSound.mockClear();

    service.handleAgentEvent(meta, cancelledDoneEvent());

    expect(playSound).not.toHaveBeenCalled();
    expect(publish.mock.calls.at(-1)?.[0].sessions).toEqual([]);
  });

  it('keeps a replacement turn running while ordinary completion tails from the stopped turn drain', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const playSound = vi.fn<(sound: AgentIslandSoundChoice) => boolean>(() => true);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish, playSound },
    });
    syncEnabledForTest(service, publish);
    service.setSoundSettings({
      enabled: true,
      sounds: {
        ...DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds,
        start: customSound('start.wav'),
        complete: customSound('complete.wav'),
      },
    });
    const meta = { sessionId: 'claude-replacement', agentKind: 'claude-code' as const };
    service.handleUserPrompt(meta, 'first turn');
    service.handleSessionStopped(meta.sessionId);
    service.handleUserPrompt(meta, 'replacement turn');
    playSound.mockClear();

    service.handleAgentEvent(
      meta,
      { type: 'status', source: 'claude-code', data: { isRunning: false, status: 'Done' } },
    );
    service.handleAgentEvent(
      meta,
      { type: 'done', source: 'claude-code', data: { reason: 'turn_interrupted' } },
    );

    expect(playSound).not.toHaveBeenCalled();
    expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      sessionId: meta.sessionId,
      phase: 'running',
    });

    service.handleAgentEvent(
      meta,
      { type: 'status', source: 'claude-code', data: { isRunning: true, status: 'Thinking...' } },
    );
    service.handleAgentEvent(
      meta,
      { type: 'status', source: 'claude-code', data: { isRunning: false, status: 'Done' } },
    );

    expect(playSound).toHaveBeenCalledTimes(1);
    expect(playSound).toHaveBeenCalledWith(customSound('complete.wav'));
    expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      sessionId: meta.sessionId,
      phase: 'completed',
    });
  });

  it('accepts replacement-turn interaction requests before its running status arrives', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });
    const resolver = vi.fn(() => true);
    const meta = { sessionId: 'replacement-interaction', agentKind: 'claude-code' as const };
    syncEnabledForTest(service, publish);
    service.setPermissionResolver(resolver);
    service.handleUserPrompt(meta, 'first turn');
    service.handleSessionStopped(meta.sessionId);
    service.handleUserPrompt(meta, 'replacement turn');
    service.handleUserPromptDispatching(meta.sessionId);

    handleInteractionRequestForTest(service,
      meta,
      {
        kind: 'permission',
        requestId: 'replacement-request',
        toolName: 'Bash',
        input: { command: 'pnpm test' },
      },
    );

    expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      sessionId: meta.sessionId,
      phase: 'needs-interaction',
      permissionAction: { requestId: 'replacement-request' },
    });

    service.handlePermissionAction({ requestId: 'replacement-request', action: 'allow' });

    expect(resolver).toHaveBeenCalledWith('replacement-request', {
      kind: 'permission',
      behavior: 'allow',
      permissionUpdates: undefined,
    });
  });

  it('rejects an interaction captured before the Stop and replacement prompt boundary', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });
    const resolver = vi.fn(() => true);
    const meta = { sessionId: 'stale-interaction', agentKind: 'claude-code' as const };
    syncEnabledForTest(service, publish);
    service.setPermissionResolver(resolver);
    service.handleUserPrompt(meta, 'first turn');
    const staleInteractionEpoch = service.captureInteractionEpoch(meta.sessionId);
    service.handleSessionStopped(meta.sessionId);
    service.handleUserPrompt(meta, 'replacement turn');

    service.handleInteractionRequest(
      meta,
      {
        kind: 'permission',
        requestId: 'stale-request',
        toolName: 'Bash',
        input: { command: 'rm -rf build' },
      },
      staleInteractionEpoch,
    );

    expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      sessionId: meta.sessionId,
      phase: 'running',
      permissionAction: null,
    });

    service.handlePermissionAction({ requestId: 'stale-request', action: 'allow' });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('rejects an old interaction that enters after replacement preview but before dispatch', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });
    const meta = { sessionId: 'preview-race-interaction', agentKind: 'claude-code' as const };
    syncEnabledForTest(service, publish);
    service.handleUserPrompt(meta, 'first turn');
    service.handleSessionStopped(meta.sessionId);
    service.handleUserPrompt(meta, 'replacement turn');

    const staleEpoch = service.captureInteractionEpoch(meta.sessionId);
    expect(service.isInteractionCurrent(meta.sessionId, staleEpoch)).toBe(false);

    service.handleUserPromptDispatching(meta.sessionId);
    expect(service.isInteractionCurrent(meta.sessionId, staleEpoch)).toBe(false);
    expect(service.isInteractionCurrent(
      meta.sessionId,
      service.captureInteractionEpoch(meta.sessionId),
    )).toBe(true);
  });

  it('restores stop-tail suppression when a replacement prompt preview rolls back', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const playSound = vi.fn<(sound: AgentIslandSoundChoice) => boolean>(() => true);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish, playSound },
    });
    syncEnabledForTest(service, publish);
    service.setSoundSettings({
      enabled: true,
      sounds: {
        ...DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds,
        start: customSound('start.wav'),
        complete: customSound('complete.wav'),
      },
    });
    const meta = { sessionId: 'rollback-stop', agentKind: 'claude-code' as const };
    service.handleUserPrompt(meta, 'run tests');
    service.handleSessionStopped(meta.sessionId);
    const stoppedInteractionEpoch = service.captureInteractionEpoch(meta.sessionId);
    playSound.mockClear();

    service.handleUserPrompt(meta, 'retry', { clientId: 'retry-client' });
    service.rollbackUserPrompt(meta.sessionId, 'retry-client');
    expect(service.captureInteractionEpoch(meta.sessionId)).toBe(stoppedInteractionEpoch);
    service.handleAgentEvent(
      meta,
      { type: 'status', source: 'claude-code', data: { isRunning: false, status: 'Done' } },
    );

    expect(playSound).not.toHaveBeenCalled();
    expect(publish.mock.calls.at(-1)?.[0].sessions).toEqual([]);
  });

  it('ignores a stale cancelled terminal event before a replacement turn dispatches', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const playSound = vi.fn<(sound: AgentIslandSoundChoice) => boolean>(() => true);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish, playSound },
    });
    syncEnabledForTest(service, publish);
    service.setSoundSettings({
      enabled: true,
      sounds: {
        ...DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds,
        start: customSound('start.wav'),
        complete: customSound('complete.wav'),
      },
    });
    const meta = { sessionId: 'codex-stop', agentKind: 'codex' as const };
    service.handleUserPrompt(meta, 'run tests');
    service.handleAgentEvent(meta, {
      type: 'status',
      source: 'codex',
      data: { isRunning: true, status: 'Generating...', turnId: 'turn-stopped' },
    });
    service.handleSessionStopped(meta.sessionId, 'turn-stopped');
    service.handleUserPrompt(meta, 'replacement turn');
    playSound.mockClear();

    service.handleAgentEvent(meta, cancelledDoneEvent('turn-stopped'));

    expect(playSound).not.toHaveBeenCalled();
    expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      sessionId: meta.sessionId,
      phase: 'running',
    });
  });

  it('ignores an identified stopped-turn cancellation after the replacement is running', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const playSound = vi.fn<(sound: AgentIslandSoundChoice) => boolean>(() => true);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish, playSound },
    });
    syncEnabledForTest(service, publish);
    const meta = { sessionId: 'codex-running-replacement', agentKind: 'codex' as const };
    service.handleUserPrompt(meta, 'first turn');
    service.handleAgentEvent(meta, {
      type: 'status',
      source: 'codex',
      data: { isRunning: true, status: 'Generating...', turnId: 'turn-stopped' },
    });
    service.handleSessionStopped(meta.sessionId, 'turn-stopped');
    service.handleUserPrompt(meta, 'replacement turn');
    service.handleUserPromptDispatching(meta.sessionId);
    service.handleAgentEvent(meta, {
      type: 'status',
      source: 'codex',
      data: { isRunning: true, status: 'Generating...', turnId: 'turn-replacement' },
    });
    playSound.mockClear();

    service.handleAgentEvent(meta, cancelledDoneEvent('turn-stopped'));

    expect(playSound).not.toHaveBeenCalled();
    expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      sessionId: meta.sessionId,
      phase: 'running',
    });
  });

  it('removes a replacement turn cancelled after its vendor dispatch boundary', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const playSound = vi.fn<(sound: AgentIslandSoundChoice) => boolean>(() => true);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish, playSound },
    });
    syncEnabledForTest(service, publish);
    const meta = { sessionId: 'codex-replacement-cancelled', agentKind: 'codex' as const };
    service.handleUserPrompt(meta, 'first turn');
    service.handleAgentEvent(meta, {
      type: 'status',
      source: 'codex',
      data: { isRunning: true, status: 'Generating...', turnId: 'turn-stopped' },
    });
    service.handleSessionStopped(meta.sessionId, 'turn-stopped');
    service.handleUserPrompt(meta, 'replacement turn');
    service.handleUserPromptDispatching(meta.sessionId);
    playSound.mockClear();

    service.handleAgentEvent(meta, cancelledDoneEvent('turn-replacement'));

    expect(playSound).not.toHaveBeenCalled();
    expect(publish.mock.calls.at(-1)?.[0].sessions).toEqual([]);
  });

  it('clears an older provider turn id when a later stop cannot identify its turn', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const playSound = vi.fn<(sound: AgentIslandSoundChoice) => boolean>(() => true);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish, playSound },
    });
    syncEnabledForTest(service, publish);
    const meta = { sessionId: 'codex-stop-without-turn-id', agentKind: 'codex' as const };
    service.handleUserPrompt(meta, 'first turn');
    service.handleSessionStopped(meta.sessionId, 'turn-from-earlier-stop');
    service.handleSessionStopped(meta.sessionId);
    service.handleUserPrompt(meta, 'replacement turn');
    service.handleUserPromptDispatching(meta.sessionId);
    playSound.mockClear();

    service.handleAgentEvent(meta, cancelledDoneEvent('turn-from-earlier-stop'));

    expect(playSound).not.toHaveBeenCalled();
    expect(publish.mock.calls.at(-1)?.[0].sessions).toEqual([]);
  });

  it('clears silenced-run bookkeeping when a session is stopped', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const playSound = vi.fn<(sound: AgentIslandSoundChoice) => boolean>(() => true);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish, playSound },
    });
    syncEnabledForTest(service, publish);
    service.setSoundSettings({
      enabled: true,
      sounds: {
        ...DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds,
        start: customSound('start.wav'),
      },
    });
    const meta = { sessionId: 'silenced-stop', agentKind: 'claude-code' as const };
    service.handleScheduleEvent({
      type: 'silenced',
      scheduleId: 'schedule-1',
      runId: 'run-1',
      sessionId: meta.sessionId,
    });
    service.handleUserPrompt(meta, 'scheduled run');
    service.handleSessionStopped(meta.sessionId);
    playSound.mockClear();

    service.handleUserPrompt(meta, 'manual replacement');

    expect(playSound).toHaveBeenCalledWith(customSound('start.wav'));
  });

  it('plays the completion sound when the completed visible session is smart-suppressed', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const playSound = vi.fn<(sound: AgentIslandSoundChoice) => boolean>(() => true);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish, playSound },
    });
    syncEnabledForTest(service, publish);
    service.setSoundSettings({
      enabled: true,
      sounds: {
        ...DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds,
        start: customSound('start.wav'),
        complete: customSound('complete.wav'),
      },
    });
    service.setAppFocused(true);
    service.registerIpc();
    const focusedWindow = {
      isDestroyed: () => false,
      isFocused: () => true,
    } as unknown as BrowserWindow;
    mocks.browserWindowFromWebContents.mockReturnValue(focusedWindow);
    await registeredIpcHandler(AGENT_ISLAND_SET_VISIBLE_SESSION_CHANNEL)(
      { sender: {} },
      's1',
    );
    playSound.mockClear();

    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');
    service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, doneEvent());

    expect(playSound).toHaveBeenNthCalledWith(1, customSound('start.wav'));
    expect(playSound).toHaveBeenNthCalledWith(2, customSound('complete.wav'));
    expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      sessionId: 's1',
      phase: 'completed',
      attention: false,
    });
  });

  it('keeps an unplanned remote daemon close in error and does not play completion sound', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const playSound = vi.fn<(sound: AgentIslandSoundChoice) => boolean>(() => true);
    const isPlannedRemoteDaemonClose = vi.fn(() => false);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish, playSound },
      isPlannedRemoteDaemonClose,
    });
    syncEnabledForTest(service, publish);
    service.setSoundSettings({
      enabled: true,
      sounds: {
        ...DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds,
        error: customSound('error.wav'),
        complete: customSound('complete.wav'),
      },
    });
    service.handleUserPrompt({ sessionId: 's1', agentKind: 'claude-code' }, 'run tests');
    playSound.mockClear();

    service.handleAgentEvent(
      { sessionId: 's1', agentKind: 'claude-code' },
      terminalErrorEvent('remote daemon closed', REMOTE_DAEMON_CLOSED_REASON),
    );
    service.handleAgentEvent(
      { sessionId: 's1', agentKind: 'claude-code' },
      { type: 'status', source: 'claude-code', data: { isRunning: false, status: 'Done' } },
    );
    service.handleAgentEvent(
      { sessionId: 's1', agentKind: 'claude-code' },
      doneEvent(),
    );

    expect(playSound).toHaveBeenCalledTimes(1);
    expect(playSound).toHaveBeenCalledWith(customSound('error.wav'));
    expect(isPlannedRemoteDaemonClose).toHaveBeenCalledWith('s1');
    expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      sessionId: 's1',
      phase: 'error',
      detail: 'remote daemon closed',
    });
  });

  it('allows a remote daemon close inside the upgrade window to converge to completed', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const isPlannedRemoteDaemonClose = vi.fn(() => true);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
      isPlannedRemoteDaemonClose,
    });
    syncEnabledForTest(service, publish);

    service.handleAgentEvent(
      { sessionId: 'upgrade', agentKind: 'claude-code' },
      terminalErrorEvent('remote daemon closed', REMOTE_DAEMON_CLOSED_REASON),
    );
    service.handleAgentEvent(
      { sessionId: 'upgrade', agentKind: 'claude-code' },
      { type: 'done', source: 'claude-code', data: { reason: REMOTE_DAEMON_CLOSED_REASON } },
    );

    expect(isPlannedRemoteDaemonClose).toHaveBeenCalledWith('upgrade');
    expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      sessionId: 'upgrade',
      phase: 'completed',
    });
  });

  it('keeps a successful remote auth retry transient until its replacement turn starts', async () => {
    vi.useFakeTimers();
    try {
      const { AgentIslandService } = await import('../service.js');
      const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
        void state;
        void frameOrFrames;
        return true;
      });
      const playSound = vi.fn<(sound: AgentIslandSoundChoice) => boolean>(() => true);
      const service = new AgentIslandService({
        getMainWindow: () => null,
        nativeHost: { failed: false, publish, playSound },
      });
      syncEnabledForTest(service, publish);
      service.setSoundSettings({
        enabled: true,
        sounds: {
          ...DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds,
          error: customSound('error.wav'),
          complete: customSound('complete.wav'),
        },
      });
      const meta = { sessionId: 'remote-auth', agentKind: 'claude-code' };
      service.handleUserPrompt(meta, 'retry me');
      playSound.mockClear();
      publish.mockClear();

      service.deferRemoteAuthRetryError(meta, authenticationErrorEvent());
      service.handleAgentEvent(meta, {
        type: 'status',
        source: 'claude-code',
        data: { isRunning: false, status: 'Done' },
      });
      service.handleAgentEvent(meta, doneEvent());

      expect(playSound).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();

      service.handleAgentEvent(meta, {
        type: 'status',
        source: 'claude-code',
        data: { isRunning: true, status: 'Working' },
      });
      await vi.advanceTimersByTimeAsync(30_000);

      expect(playSound).not.toHaveBeenCalled();
      expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
        sessionId: 'remote-auth',
        phase: 'running',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a deferred remote auth error when the retry fails', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const playSound = vi.fn<(sound: AgentIslandSoundChoice) => boolean>(() => true);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish, playSound },
    });
    syncEnabledForTest(service, publish);
    service.setSoundSettings({
      enabled: true,
      sounds: {
        ...DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds,
        error: customSound('error.wav'),
      },
    });
    const meta = { sessionId: 'remote-auth-failed', agentKind: 'claude-code' };
    service.handleUserPrompt(meta, 'retry me');
    playSound.mockClear();

    service.deferRemoteAuthRetryError(meta, authenticationErrorEvent('invalid api key'));
    service.handleAgentEvent(meta, doneEvent());

    expect(service.resolveDeferredRemoteAuthRetryError(meta.sessionId)).toBe(true);
    expect(service.resolveDeferredRemoteAuthRetryError(meta.sessionId)).toBe(false);
    expect(playSound).toHaveBeenCalledTimes(1);
    expect(playSound).toHaveBeenCalledWith(customSound('error.wav'));
    expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      sessionId: 'remote-auth-failed',
      phase: 'error',
      detail: 'invalid api key',
    });
  });

  it('falls back to the deferred remote auth error when no renderer reports an outcome', async () => {
    vi.useFakeTimers();
    try {
      const { AgentIslandService } = await import('../service.js');
      const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
        void state;
        void frameOrFrames;
        return true;
      });
      const service = new AgentIslandService({
        getMainWindow: () => null,
        nativeHost: { failed: false, publish },
      });
      syncEnabledForTest(service, publish);
      const meta = { sessionId: 'background-auth', agentKind: 'claude-code' };
      service.handleUserPrompt(meta, 'retry me');
      publish.mockClear();

      service.deferRemoteAuthRetryError(meta, authenticationErrorEvent('background 401'));
      service.handleAgentEvent(meta, doneEvent());
      await vi.advanceTimersByTimeAsync(29_999);
      expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
        sessionId: 'background-auth',
        phase: 'running',
      });

      await vi.advanceTimersByTimeAsync(1);
      expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
        sessionId: 'background-auth',
        phase: 'error',
        detail: 'background 401',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not play task start sound for a silent scheduler run', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const playSound = vi.fn<(sound: AgentIslandSoundChoice) => boolean>(() => true);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish, playSound },
    });
    syncEnabledForTest(service, publish);
    service.setSoundSettings({
      enabled: true,
      sounds: {
        ...DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds,
        start: customSound('start.wav'),
      },
    });
    playSound.mockClear();

    service.handleScheduleEvent({
      type: 'silenced',
      scheduleId: 'schedule-1',
      runId: 'run-1',
      sessionId: 's1',
    });
    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'silent run');

    expect(playSound).not.toHaveBeenCalled();
  });

  it('does not play deferred transition sounds for events that completed while disabled', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const playSound = vi.fn<(sound: AgentIslandSoundChoice) => boolean>(() => true);
    const suspend = vi.fn();
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish, playSound, suspend },
    });
    syncEnabledForTest(service, publish);
    service.setSoundSettings({
      enabled: true,
      sounds: {
        ...DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds,
        start: customSound('start.wav'),
        complete: customSound('complete.wav'),
      },
    });

    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');
    expect(playSound).toHaveBeenCalledWith(customSound('start.wav'));
    playSound.mockClear();

    service.setEnabled(false);
    service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, doneEvent());
    service.setEnabled(true);

    expect(playSound).not.toHaveBeenCalled();
  });

  it('defers completion reveal and sound until the session input queue drains', async () => {
    const { AgentIslandService } = await import('../service.js');
    let deferCompletion = true;
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void frameOrFrames;
      return state.visible;
    });
    const playSound = vi.fn<(sound: AgentIslandSoundChoice) => boolean>(() => true);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish, playSound },
    });
    service.setCompletionDeferResolver(() => deferCompletion);
    syncEnabledForTest(service, publish);
    service.setSoundSettings({
      enabled: true,
      sounds: {
        ...DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds,
        start: customSound('start.wav'),
        complete: customSound('complete.wav'),
      },
    });

    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'first queued task');
    playSound.mockClear();
    publish.mockClear();

    service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, doneEvent());

    expect(playSound).not.toHaveBeenCalled();
    expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      sessionId: 's1',
      phase: 'running',
      attention: false,
    });

    deferCompletion = false;
    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'final queued task');
    playSound.mockClear();

    service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, doneEvent());

    expect(playSound).toHaveBeenCalledWith(customSound('complete.wav'));
    expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      sessionId: 's1',
      phase: 'completed',
      attention: true,
    });
  });

  it('does not play a completion sound or reveal card for a silenced scheduler completion', async () => {
    vi.useFakeTimers();
    try {
      const { AgentIslandService } = await import('../service.js');
      const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
        void frameOrFrames;
        return state.visible;
      });
      const playSound = vi.fn<(sound: AgentIslandSoundChoice) => boolean>(() => true);
      const service = new AgentIslandService({
        getMainWindow: () => null,
        nativeHost: { failed: false, publish, playSound },
      });
      syncEnabledForTest(service, publish);
      service.setSoundSettings({
        enabled: true,
        sounds: {
          ...DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds,
          start: customSound('start.wav'),
          complete: customSound('complete.wav'),
        },
      });
      playSound.mockClear();

      service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');
      expect(playSound).toHaveBeenCalledWith(customSound('start.wav'));
      playSound.mockClear();

      service.handleScheduleEvent({
        type: 'silenced',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 's1',
      });
      service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, doneEvent());

      expect(playSound).not.toHaveBeenCalled();
      const lastState = publish.mock.calls.at(-1)?.[0];
      expect(lastState?.displayPolicy).toBe('closed');
      expect(lastState?.totalCount).toBe(0);
      vi.runOnlyPendingTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses a silenced scheduler completion even when the early silenced event was missed', async () => {
    vi.useFakeTimers();
    try {
      const { AgentIslandService } = await import('../service.js');
      const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
        void frameOrFrames;
        return state.visible;
      });
      const service = new AgentIslandService({
        getMainWindow: () => null,
        nativeHost: { failed: false, publish },
      });
      syncEnabledForTest(service, publish);

      service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'silent run');
      service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, doneEvent());
      const stateAfterDoneBeforeSchedulerCompletion = publish.mock.calls.at(-1)?.[0];
      expect(stateAfterDoneBeforeSchedulerCompletion?.pillSnapshot.unreadCompletedCount).toBe(1);
      expect(stateAfterDoneBeforeSchedulerCompletion?.totalCount).toBe(1);

      service.handleScheduleEvent({
        type: 'completed',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 's1',
        silenced: true,
      });

      const stateAfterSilencedCompletion = publish.mock.calls.at(-1)?.[0];
      expect(stateAfterSilencedCompletion?.displayPolicy).toBe('closed');
      expect(stateAfterSilencedCompletion?.pillSnapshot.unreadCompletedCount).toBe(0);
      expect(stateAfterSilencedCompletion?.totalCount).toBe(0);
      vi.runOnlyPendingTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not leave a silenced scheduler completion in running state when completion arrives before done', async () => {
    vi.useFakeTimers();
    try {
      const { AgentIslandService } = await import('../service.js');
      const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
        void frameOrFrames;
        return state.visible;
      });
      const service = new AgentIslandService({
        getMainWindow: () => null,
        nativeHost: { failed: false, publish },
      });
      syncEnabledForTest(service, publish);

      service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'silent run');
      expect(publish.mock.calls.at(-1)?.[0].sessions[0]?.phase).toBe('running');

      service.handleScheduleEvent({
        type: 'completed',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 's1',
        silenced: true,
      });

      const stateAfterCompletedOnlySilence = publish.mock.calls.at(-1)?.[0];
      expect(stateAfterCompletedOnlySilence?.displayPolicy).toBe('closed');
      expect(stateAfterCompletedOnlySilence?.totalCount).toBe(0);
      expect(stateAfterCompletedOnlySilence?.sessions.some((session) => session.phase === 'running')).toBe(false);
      vi.runOnlyPendingTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves older attention when only the final silenced scheduler completion arrives', async () => {
    vi.useFakeTimers();
    try {
      const { AgentIslandService } = await import('../service.js');
      const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
        void frameOrFrames;
        return state.visible;
      });
      const playSound = vi.fn<(sound: AgentIslandSoundChoice) => boolean>(() => true);
      const service = new AgentIslandService({
        getMainWindow: () => null,
        nativeHost: { failed: false, publish, playSound },
      });
      syncEnabledForTest(service, publish);
      service.setSoundSettings({
        enabled: true,
        sounds: {
          ...DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds,
          start: customSound('start.wav'),
          complete: customSound('complete.wav'),
        },
      });

      service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'previous run');
      service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, doneEvent());
      const stateWithOlderAttention = publish.mock.calls.at(-1)?.[0];
      expect(stateWithOlderAttention?.pillSnapshot.unreadCompletedCount).toBe(1);
      expect(stateWithOlderAttention?.totalCount).toBe(1);

      playSound.mockClear();
      service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'silent run');
      service.handleScheduleEvent({
        type: 'completed',
        scheduleId: 'schedule-1',
        runId: 'run-2',
        sessionId: 's1',
        silenced: true,
      });

      const stateAfterCompletedOnlySilence = publish.mock.calls.at(-1)?.[0];
      expect(stateAfterCompletedOnlySilence?.sessions[0]?.phase).toBe('completed');
      expect(stateAfterCompletedOnlySilence?.pillSnapshot.unreadCompletedCount).toBe(1);

      playSound.mockClear();
      service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, doneEvent());
      expect(playSound).not.toHaveBeenCalled();
      const stateAfterSilencedDone = publish.mock.calls.at(-1)?.[0];
      expect(stateAfterSilencedDone?.pillSnapshot.unreadCompletedCount).toBe(1);
      expect(stateAfterSilencedDone?.totalCount).toBe(1);
      vi.runOnlyPendingTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not mute a normal follow-up completion during the prior silenced linger window', async () => {
    vi.useFakeTimers();
    try {
      const { AgentIslandService } = await import('../service.js');
      const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
        void frameOrFrames;
        return state.visible;
      });
      const playSound = vi.fn<(sound: AgentIslandSoundChoice) => boolean>(() => true);
      const service = new AgentIslandService({
        getMainWindow: () => null,
        nativeHost: { failed: false, publish, playSound },
      });
      syncEnabledForTest(service, publish);
      service.setSoundSettings({
        enabled: true,
        sounds: {
          ...DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds,
          start: customSound('start.wav'),
          complete: customSound('complete.wav'),
        },
      });

      service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'silent run');
      service.handleScheduleEvent({
        type: 'silenced',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 's1',
      });
      service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, doneEvent());
      service.handleScheduleEvent({
        type: 'completed',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 's1',
        silenced: true,
      });
      expect(publish.mock.calls.at(-1)?.[0].totalCount).toBe(0);
      playSound.mockClear();

      service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'normal follow-up');
      service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, doneEvent());

      expect(playSound).toHaveBeenCalledWith(customSound('complete.wav'));
      const lastState = publish.mock.calls.at(-1)?.[0];
      expect(lastState?.pillSnapshot.unreadCompletedCount).toBe(1);
      expect(lastState?.totalCount).toBe(1);
      vi.runOnlyPendingTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves older session attention without playing completion sound for a silenced run', async () => {
    vi.useFakeTimers();
    try {
      const { markSessionNeedsAttention, clearSessionAttention } = await import('../../appBadgeService.js');
      const { AgentIslandService } = await import('../service.js');
      const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
        void frameOrFrames;
        return state.visible;
      });
      const playSound = vi.fn<(sound: AgentIslandSoundChoice) => boolean>(() => true);
      const service = new AgentIslandService({
        getMainWindow: () => null,
        nativeHost: { failed: false, publish, playSound },
      });
      syncEnabledForTest(service, publish);
      service.setSoundSettings({
        enabled: true,
        sounds: {
          ...DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds,
          start: customSound('start.wav'),
          complete: customSound('complete.wav'),
        },
      });
      markSessionNeedsAttention('s1');
      playSound.mockClear();

      service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');
      service.handleScheduleEvent({
        type: 'silenced',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 's1',
      });
      playSound.mockClear();
      service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, doneEvent());

      expect(playSound).not.toHaveBeenCalled();
      const lastState = publish.mock.calls.at(-1)?.[0];
      expect(lastState?.pillSnapshot.unreadCompletedCount).toBe(1);
      expect(lastState?.totalCount).toBe(1);

      service.handleScheduleEvent({
        type: 'completed',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 's1',
        silenced: true,
      });
      const stateAfterCompleted = publish.mock.calls.at(-1)?.[0];
      expect(stateAfterCompleted?.pillSnapshot.unreadCompletedCount).toBe(1);
      expect(stateAfterCompleted?.totalCount).toBe(1);

      clearSessionAttention('s1');
      vi.runOnlyPendingTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses island attention rather than app badge state for silenced run baselines', async () => {
    vi.useFakeTimers();
    try {
      const { AgentIslandService } = await import('../service.js');
      const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
        void frameOrFrames;
        return state.visible;
      });
      const service = new AgentIslandService({
        getMainWindow: () => null,
        nativeHost: { failed: false, publish },
      });
      syncEnabledForTest(service, publish);

      service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'previous run');
      service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, doneEvent());
      const stateWithOlderAttention = publish.mock.calls.at(-1)?.[0];
      expect(stateWithOlderAttention?.pillSnapshot.unreadCompletedCount).toBe(1);
      expect(stateWithOlderAttention?.totalCount).toBe(1);

      service.handleScheduleEvent({
        type: 'silenced',
        scheduleId: 'schedule-1',
        runId: 'run-2',
        sessionId: 's1',
      });
      service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'silent run');
      service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, doneEvent());
      const stateAfterSilencedDone = publish.mock.calls.at(-1)?.[0];
      expect(stateAfterSilencedDone?.pillSnapshot.unreadCompletedCount).toBe(1);
      expect(stateAfterSilencedDone?.totalCount).toBe(1);

      service.handleScheduleEvent({
        type: 'completed',
        scheduleId: 'schedule-1',
        runId: 'run-2',
        sessionId: 's1',
        silenced: true,
      });
      const stateAfterSilencedCompleted = publish.mock.calls.at(-1)?.[0];
      expect(stateAfterSilencedCompleted?.pillSnapshot.unreadCompletedCount).toBe(1);
      expect(stateAfterSilencedCompleted?.totalCount).toBe(1);

      vi.runOnlyPendingTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves older unread attention when scheduler silence arrives after a new run starts', async () => {
    vi.useFakeTimers();
    try {
      const { AgentIslandService } = await import('../service.js');
      const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
        void frameOrFrames;
        return state.visible;
      });
      const service = new AgentIslandService({
        getMainWindow: () => null,
        nativeHost: { failed: false, publish },
      });
      syncEnabledForTest(service, publish);

      service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'previous run');
      service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, doneEvent());
      const stateWithOlderAttention = publish.mock.calls.at(-1)?.[0];
      expect(stateWithOlderAttention?.pillSnapshot.unreadCompletedCount).toBe(1);
      expect(stateWithOlderAttention?.totalCount).toBe(1);

      service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'silent run');
      const stateAfterSilentRunStarted = publish.mock.calls.at(-1)?.[0];
      expect(stateAfterSilentRunStarted?.sessions[0]?.phase).toBe('running');
      expect(stateAfterSilentRunStarted?.pillSnapshot.unreadCompletedCount).toBe(0);

      service.handleScheduleEvent({
        type: 'silenced',
        scheduleId: 'schedule-1',
        runId: 'run-2',
        sessionId: 's1',
      });
      service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, doneEvent());
      const stateAfterSilencedDone = publish.mock.calls.at(-1)?.[0];
      expect(stateAfterSilencedDone?.pillSnapshot.unreadCompletedCount).toBe(1);
      expect(stateAfterSilencedDone?.totalCount).toBe(1);

      service.handleScheduleEvent({
        type: 'completed',
        scheduleId: 'schedule-1',
        runId: 'run-2',
        sessionId: 's1',
        silenced: true,
      });
      const stateAfterSilencedCompleted = publish.mock.calls.at(-1)?.[0];
      expect(stateAfterSilencedCompleted?.pillSnapshot.unreadCompletedCount).toBe(1);
      expect(stateAfterSilencedCompleted?.totalCount).toBe(1);

      vi.runOnlyPendingTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not play transition sounds when Agent Island sounds are disabled', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const playSound = vi.fn<(sound: AgentIslandSoundChoice) => boolean>(() => true);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish, playSound },
    });
    syncEnabledForTest(service, publish);
    service.setSoundSettings({
      ...DEFAULT_AGENT_ISLAND_SOUND_SETTINGS,
      enabled: false,
    });

    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');

    expect(playSound).not.toHaveBeenCalled();
  });

  it('dispatches expanded top bar commands with command-specific window activation', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const send = vi.fn();
    const restore = vi.fn();
    const show = vi.fn();
    const focus = vi.fn();
    const mainWindow = {
      isDestroyed: () => false,
      isMinimized: () => true,
      restore,
      show,
      focus,
      webContents: { send },
    } as unknown as BrowserWindow;
    const service = new AgentIslandService({
      getMainWindow: () => mainWindow,
      nativeHost: { failed: false, publish },
    });
    const dispatchCommand = (
      service as unknown as {
        dispatchMainWindowCommand(
          command: 'open-agent-island-settings' | 'new-maker' | 'toggle-agent-island-sound',
        ): void;
      }
    ).dispatchMainWindowCommand.bind(service);

    dispatchCommand('toggle-agent-island-sound');

    expect(restore).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('app-menu:command', 'toggle-agent-island-sound');

    dispatchCommand('open-agent-island-settings');
    dispatchCommand('new-maker');

    expect(restore).toHaveBeenCalledTimes(2);
    expect(show).toHaveBeenCalledTimes(2);
    expect(focus).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(2, 'app-menu:command', 'open-agent-island-settings');
    expect(send).toHaveBeenNthCalledWith(3, 'app-menu:command', 'new-maker');
  });

  it('does not route already visible secondary sessions through the main window', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const send = vi.fn();
    const restore = vi.fn();
    const show = vi.fn();
    const focus = vi.fn();
    const mainWindow = {
      isDestroyed: () => false,
      isMinimized: () => true,
      restore,
      show,
      focus,
      webContents: { send },
    } as unknown as BrowserWindow;
    const secondaryWindow = {
      isDestroyed: () => false,
      isFocused: () => true,
    } as unknown as BrowserWindow;
    const service = new AgentIslandService({
      getMainWindow: () => mainWindow,
      nativeHost: { failed: false, publish },
    });
    syncEnabledForTest(service, publish);
    service.registerIpc();
    service.setAppFocused(true);
    service.handleUserPrompt({ sessionId: 'secondary-session', agentKind: 'codex' }, 'run tests');
    const expand = (
      service as unknown as {
        handleNativeExpand(): void;
      }
    ).handleNativeExpand.bind(service);
    const focusSession = (
      service as unknown as {
        focusSession(sessionId: string): void;
      }
    ).focusSession.bind(service);

    mocks.browserWindowFromWebContents.mockReturnValue(secondaryWindow);
    await registeredIpcHandler(AGENT_ISLAND_SET_VISIBLE_SESSION_CHANNEL)(
      { sender: {} },
      'secondary-session',
    );
    expand();
    publish.mockClear();

    focusSession('secondary-session');

    expect(restore).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({
      mode: 'compact',
      currentSessionId: 'secondary-session',
    });
  });

  it('keeps compact and expanded resize widths independent', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });
    syncEnabledForTest(service, publish);
    const setLayoutPreference = (
      service as unknown as {
        handleNativeLayoutPreference(preference: AgentIslandLayoutPreference): void;
      }
    ).handleNativeLayoutPreference.bind(service);

    setLayoutPreference({ compactContentWidth: 250 });
    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({ mode: 'compact' });
    expect(latestNativeFrame(publish)).toMatchObject({ width: 290 });

    const request: InteractionRequest = {
      kind: 'permission',
      requestId: 'r1',
      toolName: 'Bash',
      input: { command: 'pnpm test' },
      displayName: 'Run command',
    };
    handleInteractionRequestForTest(service, { sessionId: 's1', agentKind: 'codex' }, request);
    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({ mode: 'expanded' });
    expect(latestNativeFrame(publish)).toMatchObject({ width: 800 });

    setLayoutPreference({ expandedContentWidth: 700 });
    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({ mode: 'expanded' });
    expect(latestNativeFrame(publish)).toMatchObject({ width: 860 });

    service.handleInteractionDismissed('s1', 'r1');
    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({ mode: 'compact' });
    expect(latestNativeFrame(publish)).toMatchObject({ width: 290 });
    expect(mocks.writeLayoutPreference).toHaveBeenCalledWith(1, expect.objectContaining({
      compactContentWidth: 250,
    }));
    expect(mocks.writeLayoutPreference).toHaveBeenCalledWith(1, expect.objectContaining({
      expandedContentWidth: 700,
    }));
  });

  it('republishes expanded height from native content measurement', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });
    syncEnabledForTest(service, publish);
    const expand = (
      service as unknown as {
        handleNativeExpand(): void;
      }
    ).handleNativeExpand.bind(service);
    const setContentHeight = (
      service as unknown as {
        handleNativeContentHeight(height: number): void;
      }
    ).handleNativeContentHeight.bind(service);

    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');
    expand();
    expect(latestNativeFrame(publish)).toMatchObject({ height: 270 });

    setContentHeight(126);

    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({ measuredContentHeight: 126 });
    expect(latestNativeFrame(publish)).toMatchObject({ height: 214 });
  });

  it('publishes native frames for every display in all-displays render mode', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const secondaryDisplay = {
      id: 2,
      label: 'Studio Display',
      bounds: { x: 1728, y: 0, width: 1512, height: 982 },
      internal: true,
    };
    mocks.displays.splice(0, mocks.displays.length, mocks.primaryDisplay, secondaryDisplay);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });
    syncEnabledForTest(service, publish);

    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');

    expect(latestNativeFrames(publish).map((frame) => frame.displayId)).toEqual([1, 2]);
  });

  it('expands only the hovered display when multiple display islands are visible', async () => {
    vi.useFakeTimers();
    try {
      const { AgentIslandService } = await import('../service.js');
      const publish = vi.fn((
        state: AgentIslandDisplayState,
        frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[],
        statesByDisplayId?: Record<string, AgentIslandDisplayState>,
      ) => {
        void state;
        void frameOrFrames;
        void statesByDisplayId;
        return true;
      });
      const secondaryDisplay = {
        id: 2,
        bounds: { x: 1728, y: 0, width: 1512, height: 982 },
        internal: true,
      };
      mocks.displays.splice(0, mocks.displays.length, mocks.primaryDisplay, secondaryDisplay);
      const service = new AgentIslandService({
        getMainWindow: () => null,
        nativeHost: { failed: false, publish },
      });
      syncEnabledForTest(service, publish);
      const setPointerZones = (
        service as unknown as {
          handleNativePointerZones(zones: { menuBar: boolean; panel: boolean; displayId?: number | null }): void;
        }
      ).handleNativePointerZones.bind(service);

      service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');
      setPointerZones({ menuBar: true, panel: false, displayId: 2 });
      vi.advanceTimersByTime(560);

      const statesByDisplayId = latestNativeStatesByDisplayId(publish);
      expect(statesByDisplayId?.['1']).toMatchObject({
        mode: 'compact',
        displayPolicy: 'peek',
        expandedDisplayId: null,
      });
      expect(statesByDisplayId?.['2']).toMatchObject({
        mode: 'expanded',
        displayPolicy: 'manualExpanded',
        expandedDisplayId: 2,
      });

      const framesById = new Map(latestNativeFrames(publish).map((frame) => [frame.displayId, frame]));
      expect(framesById.get(1)).toMatchObject({ width: 368 });
      expect(framesById.get(2)).toMatchObject({ width: 800 });
      vi.runOnlyPendingTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes native frames only for the selected display target', async () => {
    const { AgentIslandService } = await import('../service.js');
    const prepare = vi.fn();
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const secondaryDisplay = {
      id: 2,
      label: 'Studio Display',
      bounds: { x: 1728, y: 0, width: 1512, height: 982 },
      internal: true,
    };
    mocks.displays.splice(0, mocks.displays.length, mocks.primaryDisplay, secondaryDisplay);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish, prepare },
    });
    syncEnabledForTest(service, publish);
    service.registerIpc();

    await registeredIpcHandler(AGENT_ISLAND_SET_DISPLAY_TARGET_CHANNEL)(null, { mode: 'display', displayId: 2 });
    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');

    expect(latestNativeFrames(publish).map((frame) => frame.displayId)).toEqual([2]);

    const options = await registeredIpcHandler(AGENT_ISLAND_GET_DISPLAY_OPTIONS_CHANNEL)(null);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(options).toEqual({
      ok: true,
      options: [
        {
          id: 1,
          index: 1,
          name: 'Built-in Retina Display',
          isPrimary: true,
          internal: false,
          bounds: mocks.primaryDisplay.bounds,
        },
        {
          id: 2,
          index: 2,
          name: 'Studio Display',
          isPrimary: false,
          internal: true,
          bounds: secondaryDisplay.bounds,
        },
      ],
      target: {
        mode: 'display',
        displayId: 2,
        displayName: 'Studio Display',
        displayIndex: 2,
        displayInternal: true,
        displayBounds: secondaryDisplay.bounds,
      },
    });
  });

  it('falls back to the best current display when the selected display is disconnected', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });
    syncEnabledForTest(service, publish);
    service.registerIpc();

    await registeredIpcHandler(AGENT_ISLAND_SET_DISPLAY_TARGET_CHANNEL)(null, {
      mode: 'display',
      displayId: 99,
      displayName: 'Disconnected Display',
      displayIndex: 2,
      displayInternal: false,
      displayBounds: { x: 1728, y: 0, width: 1512, height: 982 },
    });
    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');

    expect(latestNativeFrames(publish).map((frame) => frame.displayId)).toEqual([1]);

    const options = await registeredIpcHandler(AGENT_ISLAND_GET_DISPLAY_OPTIONS_CHANNEL)(null);
    expect(options).toMatchObject({
      target: {
        mode: 'display',
        displayId: 99,
        displayName: 'Disconnected Display',
      },
    });
  });

  it('remaps by persisted identity before trusting a reused display id', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const wrongDisplayWithReusedId = {
      id: 2,
      label: 'Other Display',
      bounds: { x: 1728, y: 0, width: 1512, height: 982 },
      internal: false,
    };
    const reenumeratedDisplay = {
      id: 7,
      label: 'Studio Display',
      bounds: { x: 3240, y: 0, width: 1512, height: 982 },
      internal: false,
    };
    mocks.displays.splice(0, mocks.displays.length, mocks.primaryDisplay, wrongDisplayWithReusedId, reenumeratedDisplay);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });
    syncEnabledForTest(service, publish);
    service.registerIpc();

    await registeredIpcHandler(AGENT_ISLAND_SET_DISPLAY_TARGET_CHANNEL)(null, {
      mode: 'display',
      displayId: 2,
      displayName: 'Studio Display',
      displayIndex: 3,
      displayInternal: false,
      displayBounds: reenumeratedDisplay.bounds,
    });
    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');

    expect(latestNativeFrames(publish).map((frame) => frame.displayId)).toEqual([7]);
    const options = await registeredIpcHandler(AGENT_ISLAND_GET_DISPLAY_OPTIONS_CHANNEL)(null);
    expect(options).toMatchObject({
      target: {
        mode: 'display',
        displayId: 7,
        displayName: 'Studio Display',
      },
    });
  });

  it('uses bounds to disambiguate identical display names', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const firstDisplay = {
      id: 2,
      label: 'Studio Display',
      bounds: { x: 1728, y: 0, width: 1512, height: 982 },
      internal: false,
    };
    const secondDisplay = {
      id: 7,
      label: 'Studio Display',
      bounds: { x: 3240, y: 0, width: 1512, height: 982 },
      internal: false,
    };
    mocks.displays.splice(0, mocks.displays.length, mocks.primaryDisplay, firstDisplay, secondDisplay);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });
    syncEnabledForTest(service, publish);
    service.registerIpc();

    await registeredIpcHandler(AGENT_ISLAND_SET_DISPLAY_TARGET_CHANNEL)(null, {
      mode: 'display',
      displayId: 99,
      displayName: 'Studio Display',
      displayIndex: 3,
      displayInternal: false,
      displayBounds: secondDisplay.bounds,
    });
    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');

    expect(latestNativeFrames(publish).map((frame) => frame.displayId)).toEqual([7]);
  });

  it('stores and applies layout preferences independently per display', async () => {
    vi.useFakeTimers();
    try {
      const { AgentIslandService } = await import('../service.js');
      const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
        void state;
        void frameOrFrames;
        return true;
      });
      const secondaryDisplay = {
        id: 2,
        bounds: { x: 1728, y: 0, width: 1512, height: 982 },
        internal: true,
      };
      mocks.displays.splice(0, mocks.displays.length, mocks.primaryDisplay, secondaryDisplay);
      const service = new AgentIslandService({
        getMainWindow: () => null,
        nativeHost: { failed: false, publish },
      });
      syncEnabledForTest(service, publish);
      const setLayoutPreference = (
        service as unknown as {
          handleNativeLayoutPreference(preference: AgentIslandLayoutPreference): void;
        }
      ).handleNativeLayoutPreference.bind(service);
      const setLayoutDragActive = (
        service as unknown as {
          handleNativeLayoutDragActive(active: boolean): void;
        }
      ).handleNativeLayoutDragActive.bind(service);

      setLayoutDragActive(true);
      setLayoutPreference({ displayId: 2, compactContentWidth: 420, centerXRatio: 0.25 });

      let framesById = new Map(latestNativeFrames(publish).map((frame) => [frame.displayId, frame]));
      expect(framesById.get(1)).not.toMatchObject({ width: 460 });
      expect(framesById.get(2)).toMatchObject({ width: 460 });
      expect(mocks.writeLayoutPreference).not.toHaveBeenCalled();

      vi.advanceTimersByTime(150);
      expect(mocks.writeLayoutPreference).toHaveBeenCalledWith(2, expect.objectContaining({
        centerXRatio: 0.25,
        compactContentWidth: 420,
      }));

      setLayoutPreference({ displayId: 1, compactContentWidth: 300 });

      framesById = new Map(latestNativeFrames(publish).map((frame) => [frame.displayId, frame]));
      expect(framesById.get(1)).toMatchObject({ width: 340 });
      expect(framesById.get(2)).toMatchObject({ width: 460 });
      expect(mocks.writeLayoutPreference).toHaveBeenCalledTimes(1);

      setLayoutDragActive(false);
      expect(mocks.writeLayoutPreference).toHaveBeenCalledWith(1, expect.objectContaining({
        compactContentWidth: 300,
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('loads saved layout preferences per display', async () => {
    mocks.readLayoutPreferences.mockReturnValueOnce(new Map<number, AgentIslandLayoutPreference>([
      [1, { compactContentWidth: 300 }],
      [2, { compactContentWidth: 420 }],
    ]));
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const secondaryDisplay = {
      id: 2,
      bounds: { x: 1728, y: 0, width: 1512, height: 982 },
      internal: true,
    };
    mocks.displays.splice(0, mocks.displays.length, mocks.primaryDisplay, secondaryDisplay);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });
    syncEnabledForTest(service, publish);

    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');

    const framesById = new Map(latestNativeFrames(publish).map((frame) => [frame.displayId, frame]));
    expect(framesById.get(1)).toMatchObject({ width: 340 });
    expect(framesById.get(2)).toMatchObject({ width: 460 });
  });

  it('applies native layout preferences to the emitting display instead of the current target display', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const notchedDisplay = {
      id: 2,
      bounds: { x: 1728, y: 0, width: 1512, height: 982 },
      internal: true,
    };
    mocks.displays.splice(0, mocks.displays.length, mocks.primaryDisplay, notchedDisplay);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });
    syncEnabledForTest(service, publish);
    const setNativeScreenMetrics = (
      service as unknown as {
        handleNativeScreenMetrics(metrics: {
          screens: Array<{
            displayId: number;
            frame: { x: number; y: number; width: number; height: number };
            hasNotch: boolean;
            notchWidth: number;
            topBarHeight: number;
            menuBarHeight: number;
            safeAreaTop: number;
            isMain: boolean;
            signature: string;
          }>;
          preferredDisplayId: number | null;
        }): void;
      }
    ).handleNativeScreenMetrics.bind(service);
    const setLayoutPreference = (
      service as unknown as {
        handleNativeLayoutPreference(preference: AgentIslandLayoutPreference): void;
      }
    ).handleNativeLayoutPreference.bind(service);

    setNativeScreenMetrics({
      preferredDisplayId: 2,
      screens: [
        {
          displayId: 1,
          frame: { x: 0, y: 0, width: 1728, height: 1117 },
          hasNotch: false,
          notchWidth: 240,
          topBarHeight: 25,
          menuBarHeight: 25,
          safeAreaTop: 0,
          isMain: false,
          signature: 'external',
        },
        {
          displayId: 2,
          frame: { x: 1728, y: 0, width: 1512, height: 982 },
          hasNotch: true,
          notchWidth: 256,
          topBarHeight: 37,
          menuBarHeight: 37,
          safeAreaTop: 37,
          isMain: true,
          signature: 'builtin-notch',
        },
      ],
    });

    setLayoutPreference({ displayId: 1, compactContentWidth: 500, centerXRatio: 0.5 });
    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');

    expect(mocks.writeLayoutPreference).toHaveBeenLastCalledWith(1, {
      compactContentWidth: 500,
      centerXRatio: 0.5,
    });
    const framesById = new Map(latestNativeFrames(publish).map((frame) => [frame.displayId, frame]));
    expect(framesById.get(1)).toMatchObject({ width: 540, contentWidth: 500 });
    expect(framesById.get(2)).toMatchObject({ width: 360, contentWidth: 320 });
  });

  it('uses native notched-display metrics when computing display frames', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const notchedDisplay = {
      id: 2,
      bounds: { x: 1728, y: 0, width: 1512, height: 982 },
      internal: true,
    };
    mocks.displays.splice(0, mocks.displays.length, mocks.primaryDisplay, notchedDisplay);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });
    syncEnabledForTest(service, publish);
    const setNativeScreenMetrics = (
      service as unknown as {
        handleNativeScreenMetrics(metrics: {
          screens: Array<{
            displayId: number;
            frame: { x: number; y: number; width: number; height: number };
            hasNotch: boolean;
            notchWidth: number;
            topBarHeight: number;
            menuBarHeight: number;
            safeAreaTop: number;
            isMain: boolean;
            signature: string;
          }>;
          preferredDisplayId: number | null;
        }): void;
      }
    ).handleNativeScreenMetrics.bind(service);

    setNativeScreenMetrics({
      preferredDisplayId: 2,
      screens: [
        {
          displayId: 1,
          frame: { x: 0, y: 0, width: 1728, height: 1117 },
          hasNotch: false,
          notchWidth: 240,
          topBarHeight: 25,
          menuBarHeight: 25,
          safeAreaTop: 0,
          isMain: false,
          signature: 'external',
        },
        {
          displayId: 2,
          frame: { x: 1728, y: 0, width: 1512, height: 982 },
          hasNotch: true,
          notchWidth: 256,
          topBarHeight: 37,
          menuBarHeight: 37,
          safeAreaTop: 37,
          isMain: true,
          signature: 'builtin-notch',
        },
      ],
    });

    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');

    const framesById = new Map(latestNativeFrames(publish).map((frame) => [frame.displayId, frame]));
    expect(framesById.get(2)).toMatchObject({
      displayId: 2,
      displayBounds: notchedDisplay.bounds,
      width: 360,
    });
  });

  it('keeps expanded controls outside the hardware notch when centered on a notched display', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const notchedDisplay = {
      id: 2,
      bounds: { x: 1728, y: 0, width: 1512, height: 982 },
      internal: true,
    };
    mocks.displays.splice(0, mocks.displays.length, mocks.primaryDisplay, notchedDisplay);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });
    syncEnabledForTest(service, publish);
    const setNativeScreenMetrics = (
      service as unknown as {
        handleNativeScreenMetrics(metrics: {
          screens: Array<{
            displayId: number;
            frame: { x: number; y: number; width: number; height: number };
            hasNotch: boolean;
            notchWidth: number;
            topBarHeight: number;
            menuBarHeight: number;
            safeAreaTop: number;
            isMain: boolean;
            signature: string;
          }>;
          preferredDisplayId: number | null;
        }): void;
      }
    ).handleNativeScreenMetrics.bind(service);
    const setLayoutPreference = (
      service as unknown as {
        handleNativeLayoutPreference(preference: AgentIslandLayoutPreference): void;
      }
    ).handleNativeLayoutPreference.bind(service);

    setNativeScreenMetrics({
      preferredDisplayId: 2,
      screens: [
        {
          displayId: 2,
          frame: { x: 1728, y: 0, width: 1512, height: 982 },
          hasNotch: true,
          notchWidth: 256,
          topBarHeight: 37,
          menuBarHeight: 37,
          safeAreaTop: 37,
          isMain: true,
          signature: 'builtin-notch',
        },
      ],
    });
    setLayoutPreference({ displayId: 2, centerXRatio: 0.5, expandedContentWidth: 360 });
    const request: InteractionRequest = {
      kind: 'permission',
      requestId: 'r1',
      toolName: 'Bash',
      input: { command: 'pnpm test' },
      displayName: 'Run command',
    };

    handleInteractionRequestForTest(service, { sessionId: 's1', agentKind: 'codex' }, request);

    const framesById = new Map(latestNativeFrames(publish).map((frame) => [frame.displayId, frame]));
    expect(framesById.get(2)).toMatchObject({
      contentWidth: 484,
      width: 644,
    });
  });

  it('snaps true-notch compact widths only when centered', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const notchedDisplay = {
      id: 2,
      bounds: { x: 1728, y: 0, width: 1512, height: 982 },
      internal: true,
    };
    mocks.displays.splice(0, mocks.displays.length, mocks.primaryDisplay, notchedDisplay);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });
    syncEnabledForTest(service, publish);
    const setNativeScreenMetrics = (
      service as unknown as {
        handleNativeScreenMetrics(metrics: {
          screens: Array<{
            displayId: number;
            frame: { x: number; y: number; width: number; height: number };
            hasNotch: boolean;
            notchWidth: number;
            topBarHeight: number;
            menuBarHeight: number;
            safeAreaTop: number;
            isMain: boolean;
            signature: string;
          }>;
          preferredDisplayId: number | null;
        }): void;
      }
    ).handleNativeScreenMetrics.bind(service);
    const setLayoutPreference = (
      service as unknown as {
        handleNativeLayoutPreference(preference: AgentIslandLayoutPreference): void;
      }
    ).handleNativeLayoutPreference.bind(service);

    setNativeScreenMetrics({
      preferredDisplayId: 2,
      screens: [
        {
          displayId: 1,
          frame: { x: 0, y: 0, width: 1728, height: 1117 },
          hasNotch: false,
          notchWidth: 240,
          topBarHeight: 25,
          menuBarHeight: 25,
          safeAreaTop: 0,
          isMain: false,
          signature: 'external',
        },
        {
          displayId: 2,
          frame: { x: 1728, y: 0, width: 1512, height: 982 },
          hasNotch: true,
          notchWidth: 180,
          topBarHeight: 37,
          menuBarHeight: 37,
          safeAreaTop: 37,
          isMain: true,
          signature: 'builtin-notch',
        },
      ],
    });
    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');

    setLayoutPreference({ displayId: 2, centerXRatio: 0.25 });
    let framesById = new Map(latestNativeFrames(publish).map((frame) => [frame.displayId, frame]));
    expect(framesById.get(2)).toMatchObject({
      width: 340,
    });
    expect(framesById.get(2)?.contentWidth).toBeCloseTo(299.68);

    setLayoutPreference({ displayId: 2, centerXRatio: 0.5, compactContentWidth: 180 });
    framesById = new Map(latestNativeFrames(publish).map((frame) => [frame.displayId, frame]));
    expect(framesById.get(2)).toMatchObject({
      contentWidth: 180,
      width: 220,
    });

    setLayoutPreference({ displayId: 2, compactContentWidth: 230 });
    framesById = new Map(latestNativeFrames(publish).map((frame) => [frame.displayId, frame]));
    expect(framesById.get(2)).toMatchObject({
      contentWidth: 244,
      width: 284,
    });

    setLayoutPreference({ displayId: 2, compactContentWidth: 250 });
    framesById = new Map(latestNativeFrames(publish).map((frame) => [frame.displayId, frame]));
    expect(framesById.get(2)).toMatchObject({
      contentWidth: 250,
      width: 290,
    });

    setLayoutPreference({ displayId: 2, compactContentWidth: 80 });
    framesById = new Map(latestNativeFrames(publish).map((frame) => [frame.displayId, frame]));
    expect(framesById.get(2)).toMatchObject({
      contentWidth: 180,
      width: 220,
    });

    setLayoutPreference({ displayId: 2, centerXRatio: 0.25, compactContentWidth: 180 });
    framesById = new Map(latestNativeFrames(publish).map((frame) => [frame.displayId, frame]));
    expect(framesById.get(2)).toMatchObject({
      contentWidth: 180,
      width: 220,
    });

    setLayoutPreference({ displayId: 2, compactContentWidth: 80 });
    framesById = new Map(latestNativeFrames(publish).map((frame) => [frame.displayId, frame]));
    expect(framesById.get(2)).toMatchObject({
      contentWidth: 80,
      width: 120,
    });

    setLayoutPreference({ displayId: 2, compactContentWidth: 250 });
    framesById = new Map(latestNativeFrames(publish).map((frame) => [frame.displayId, frame]));
    expect(framesById.get(2)).toMatchObject({
      contentWidth: 250,
      width: 290,
    });
  });
});

describe('AgentIslandService session attention cleared bridge (error read semantics)', () => {
  it('ignores passive-default clears for unread error sessions and honors explicit clears', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publishSpy = vi.fn(() => true);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: {
        failed: false,
        headless: true,
        publish: publishSpy,
        suspend: () => undefined,
      },
    });

    service.setEnabled(true);
    service.handleAgentEvent({ sessionId: 's-err', agentKind: 'codex' }, terminalErrorEvent('boom'));
    const publishCountAfterError = publishSpy.mock.calls.length;
    expect(publishCountAfterError).toBeGreaterThan(0);

    // 未声明 source 的桥接清除 = passive(fail-safe 默认):未读 error 免疫,无状态变化。
    service.handleSessionAttentionCleared('s-err');
    expect(publishSpy.mock.calls.length).toBe(publishCountAfterError);

    // 显式清除(renderer 确认报错 UI 真实展示):生效并重新 publish。
    service.handleSessionAttentionCleared('s-err', 'explicit');
    expect(publishSpy.mock.calls.length).toBeGreaterThan(publishCountAfterError);
  });
});
