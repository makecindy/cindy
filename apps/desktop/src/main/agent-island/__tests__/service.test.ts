import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { ScriptTarget, transpileModule } from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { SESSION_ACTIVITY_CHANNEL } from '@cindy/device-link';
import type { AgentEvent, InteractionRequest } from '@cindy/maker-core';
import { BRAND_NAME } from '@cindy/maker-shared/branding';

import { computeAgentIslandWindowBounds, type AgentIslandLayoutPreference } from '../geometry.js';
import {
  AGENT_ISLAND_CONSUME_ENTRY_ALERT_CHANNEL,
  AGENT_ISLAND_GET_DISPLAY_OPTIONS_CHANNEL,
  AGENT_ISLAND_PREVIEW_SOUND_CHANNEL,
  AGENT_ISLAND_SET_DISPLAY_TARGET_CHANNEL,
  AGENT_ISLAND_SET_MASCOT_SKIN_CHANNEL,
  AGENT_ISLAND_SET_REMOTE_SESSIONS_CHANNEL,
  AGENT_ISLAND_SET_COMPANION_CHATS_CHANNEL,
  AGENT_ISLAND_READ_COMPANION_CHAT_CHANNEL,
  AGENT_ISLAND_SET_SOUND_SETTINGS_CHANNEL,
  AGENT_ISLAND_SET_VISIBLE_SESSION_CHANNEL,
  DEFAULT_AGENT_ISLAND_SOUND_SETTINGS,
  computeAgentIslandContentHeight,
  type AgentIslandDisplayState,
  type AgentIslandSessionActivity,
  type AgentIslandSoundChoice,
  type AgentIslandSoundSettings,
} from '../../../shared/agentIsland.js';
import { AGENT_ISLAND_DISPLAY_CONFIG } from '../displayConfig.js';
import type { AgentIslandNativeFrame } from '../MacAgentIslandNativeHost.js';
import { markAppContentWindow } from '../../windowFocusClassifier.js';
import type { AgentIslandService } from '../service.js';
import type { AgentIslandCompanionIdentity } from '../companionIdentity.js';
import { setDeepLinkMainWindow, takePendingDeepLink } from '../../deepLink.js';
import { runDeviceLinkInvokeContext } from '../../device-link/invoke-context.js';

// Keep the real implementation; record each instance so its scheduled publishing
// cannot outlive a test and run against reset Electron mocks in the next test.
const serviceInstances = vi.hoisted(() => new Set<AgentIslandService>());
vi.mock('../service.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../service.js')>();
  return {
    ...actual,
    AgentIslandService: class extends actual.AgentIslandService {
      constructor(...args: ConstructorParameters<typeof actual.AgentIslandService>) {
        super(...args);
        serviceInstances.add(this);
      }
    },
  };
});

afterEach(() => {
  for (const service of serviceInstances) service.resetRuntimeState();
  serviceInstances.clear();
});

const REMOTE_DAEMON_CLOSED_REASON = 'remote_daemon_closed';

vi.mock('../../appSessionState', () => ({
  getActiveAppSession: () => ({ dataOwnerId: 'test-owner', generation: 1, mode: 'local' }),
}));

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
  attached: vi.fn(),
  confirmIslandArchive: vi.fn(),
  patchSessionMetaInDb: vi.fn(),
  remoteInvoke: vi.fn(),
  getSessionRowSnapshot: vi.fn<() => Promise<{
    status: string;
    title: string | null;
    userSendAt: number | null;
    workingDir: string | null;
    workspaceKind: string | null;
    source?: string | null;
  } | null>>(() => Promise.resolve(null)),
  /** 「消息免打扰」同步索引:默认不静音,用例按需覆写。 */
  isSessionNotificationsMutedSync: vi.fn((_sessionId: string) => false),
  readAgentIslandCompanion: vi.fn<(sessionId: string) => Promise<AgentIslandCompanionIdentity | null>>(() => Promise.resolve(null)),
  companionAvatarThumbnail: vi.fn<(avatar: string, deviceId?: string | null) => Promise<string | undefined>>(() => Promise.resolve(undefined)),
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
  readDetachedLayoutPreferences: vi.fn<() => AgentIslandLayoutPreference[]>(() => []),
  writeLayoutPreference: vi.fn(),
  writeLayoutPreferences: vi.fn(),
  tapWindowBroadcast: vi.fn(),
  showMessageBox: vi.fn(),
  openExternal: vi.fn(),
  readdir: vi.fn<(...args: unknown[]) => Promise<string[]>>(() => Promise.resolve([])),
  assertTrustedAppRendererEvent: vi.fn(),
}));

vi.mock('../../security/trustedAppRenderer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../security/trustedAppRenderer.js')>()),
  assertTrustedAppRendererEvent: mocks.assertTrustedAppRendererEvent,
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
      focus: vi.fn(),
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
  patchSessionMetaInDb: mocks.patchSessionMetaInDb,
}));

vi.mock('../../localDb/sessionFlagRegistry', () => ({
  isSessionNotificationsMutedSync: mocks.isSessionNotificationsMutedSync,
}));

vi.mock('../../device-link/index.js', () => ({ remoteInvoke: mocks.remoteInvoke }));
vi.mock('../archiveConfirmation.js', () => ({ confirmIslandArchive: mocks.confirmIslandArchive }));
vi.mock('../../im/binding.js', () => ({ bindingStore: { findByTarget: mocks.attached } }));

vi.mock('../companionIdentity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../companionIdentity.js')>()),
  readAgentIslandCompanion: mocks.readAgentIslandCompanion,
  companionAvatarThumbnail: mocks.companionAvatarThumbnail,
}));

vi.mock('../layoutPreferenceStore.js', () => ({
  readAgentIslandDetachedLayoutPreferences: mocks.readDetachedLayoutPreferences,
  readAgentIslandLayoutPreferences: mocks.readLayoutPreferences,
  writeAgentIslandLayoutPreference: mocks.writeLayoutPreference,
  writeAgentIslandLayoutPreferences: mocks.writeLayoutPreferences,
}));

vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({ ownerStamp: { dataOwnerId: 'test-owner', ownerGeneration: 1 } }),
  isDataOwnerBroadcastScopeCurrent: () => true,
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  tapWindowBroadcast: mocks.tapWindowBroadcast,
}));

import { resetEpermGuidanceForTest } from '../../file-access/permissions.js';

beforeEach(() => {
  mocks.attached.mockReset().mockReturnValue(null);
  mocks.confirmIslandArchive.mockReset().mockResolvedValue(true);
  mocks.patchSessionMetaInDb.mockReset();
  mocks.remoteInvoke.mockReset();
  setDeepLinkMainWindow(null);
  takePendingDeepLink();
  mocks.getSessionRowSnapshot.mockReset();
  mocks.getSessionRowSnapshot.mockResolvedValue(null);
  mocks.readAgentIslandCompanion.mockReset();
  mocks.readAgentIslandCompanion.mockResolvedValue(null);
  mocks.companionAvatarThumbnail.mockReset();
  mocks.companionAvatarThumbnail.mockResolvedValue(undefined);
  mocks.displays.splice(0, mocks.displays.length, mocks.primaryDisplay);
  mocks.getPrimaryDisplay.mockReset();
  mocks.getDisplayMatching.mockReset();
  mocks.getAllDisplays.mockReset();
  mocks.getPreferredSystemLanguages.mockReset();
  mocks.getLocale.mockReset();
  mocks.ipcHandle.mockReset();
  mocks.assertTrustedAppRendererEvent.mockReset();
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
  mocks.readDetachedLayoutPreferences.mockReset();
  mocks.readDetachedLayoutPreferences.mockReturnValue([]);
  mocks.writeLayoutPreference.mockReset();
  mocks.writeLayoutPreferences.mockReset();
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
      x: 724,
      y: -900,
      width: 480,
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
      x: 664,
      y: -900,
      width: 600,
      height: 640,
    });
  });

  it('uses measured content height for the carrier frame when available', () => {
    const display = {
      bounds: { x: 100, y: -900, width: 1728, height: 1117 },
    };

    expect(computeAgentIslandWindowBounds(display, { expanded: true, contentHeight: 240 })).toEqual({
      x: 664,
      y: -900,
      width: 600,
      height: 320,
    });
  });

  it('clamps dragged horizontal position so the expanded island still fits', () => {
    const display = {
      bounds: { x: 100, y: -900, width: 1728, height: 1117 },
    };

    expect(computeAgentIslandWindowBounds(display, { expanded: false, centerXRatio: 1 })).toEqual({
      x: 1288,
      y: -900,
      width: 480,
      height: 580,
    });

    expect(computeAgentIslandWindowBounds(display, { expanded: true, centerXRatio: 1 })).toEqual({
      x: 1228,
      y: -900,
      width: 600,
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
  beforeEach(async () => {
    // Load after the outer mock setup, outside the first behavior test's budget.
    // Cold Vite transforms can otherwise consume its entire 5-second timeout.
    await import('../service.js');
  }, 60_000);

  // Unit: native click -> existing chat deep link must preserve unread; group cards never
  // have task archive/read actions, sounds or relay rows. Existing tests only clicked tasks.
  it('opens the exact group/thread message without reading it, and falls back when native publishing fails', async () => {
    const { AgentIslandService } = await import('../service.js');
    setDeepLinkMainWindow(null);
    takePendingDeepLink();
    const publish = vi.fn<(state: AgentIslandDisplayState) => boolean>(() => true);
    const playSound = vi.fn();
    const nativeHost = { failed: false, available: false, publish, playSound, suspend: () => undefined };
    const service = new AgentIslandService({ getMainWindow: () => null, nativeHost });
    syncEnabledForTest(service, publish);
    const input = { groupId: 'group', name: 'Product', messageId: 'message', threadRootId: 'topic',
      mentioned: true, preview: 'Chris: hello', lastMessageAt: 1, members: [] };
    service.setGroupChat(input.groupId, input);
    expect(publish.mock.calls.at(-1)![0].mode).toBe('compact');
    expect(service.notifyGroupChat(input.groupId)).toBe(false);
    expect(publish.mock.calls.at(-1)![0].mode).toBe('compact');
    nativeHost.available = true;
    expect(service.notifyGroupChat(input.groupId)).toBe(true);
    expect(publish.mock.calls.at(-1)![0].displayPolicy).toBe('transient');
    expect(playSound).not.toHaveBeenCalled();
    expect(service.getSessionActivitySnapshot('chat-group:group')).toBeNull();
    (service as unknown as { focusSession(id: string): void }).focusSession('chat-group:group');
    expect(takePendingDeepLink()).toEqual({ type: 'chat-message', groupId: 'group', messageId: 'message', threadRootId: 'topic' });
    expect(publish.mock.calls.at(-1)![0].pillSnapshot.attentionCount).toBe(1);
    expect(await service.handleCompletionAction('chat-group:group', 'mark-read', 'forged')).toBe(false);
    nativeHost.failed = true;
    expect(service.notifyGroupChat(input.groupId)).toBe(false);
    nativeHost.failed = false;
    publish.mockReturnValue(false);
    expect(service.notifyGroupChat(input.groupId)).toBe(false);
    service.setGroupChat(input.groupId, null);
    expect(publish.mock.calls.at(-1)![0].pillSnapshot.attentionCount).toBe(0);
    service.resetRuntimeState();
  });

  it('defers to native notifications when disabled or headless and keeps late avatar reads out of cleared cards', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn<(state: AgentIslandDisplayState) => boolean>(() => true);
    const service = new AgentIslandService({ getMainWindow: () => null, nativeHost: { failed: false, publish } });
    syncEnabledForTest(service, publish);
    let avatar!: (value: string) => void;
    mocks.companionAvatarThumbnail.mockReturnValueOnce(new Promise(resolve => { avatar = resolve; }));
    const input = { groupId: 'group', name: 'Product', messageId: 'message', mentioned: false,
      preview: 'hello', lastMessageAt: 1, members: [{ name: 'Cindy', avatar: 'cindy://avatar/preset/cindy', avatarColor: 'blue' }] };
    service.setGroupChat('group', input);
    service.setEnabled(false);
    expect(service.notifyGroupChat('group')).toBe(false);
    service.setGroupChat('group', null);
    avatar('late-avatar');
    await Promise.resolve();
    service.setEnabled(true);
    expect(publish.mock.calls.at(-1)![0].pillSnapshot.attentionCount).toBe(0);
    service.resetRuntimeState();
    const headless = new AgentIslandService({ getMainWindow: () => null, nativeHost: { headless: true, failed: false, publish } });
    headless.setGroupChat('group', { ...input, members: [] });
    headless.setEnabled(true);
    expect(headless.notifyGroupChat('group')).toBe(false);
    headless.resetRuntimeState();
  });

  it('keeps group lane approvals but lets chat unread own the successful reply reminder', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn<(state: AgentIslandDisplayState) => boolean>(() => true);
    const playSound = vi.fn();
    mocks.getSessionRowSnapshot.mockResolvedValue({ status: 'active', title: 'Chris', userSendAt: null,
      workingDir: '/home', workspaceKind: null, source: 'bot' });
    mocks.readAgentIslandCompanion.mockResolvedValue({ botId: 'bot', groupId: 'group',
      companion: { name: 'Chris', groupName: 'Product', hue: 'blue', glyph: 'C', glyphIsInitial: true } });
    const service = new AgentIslandService({ getMainWindow: () => null, nativeHost: { failed: false, publish, playSound } });
    syncEnabledForTest(service, publish);
    service.handleUserPrompt({ sessionId: 'lane' }, 'please help');
    await vi.waitFor(() => expect(publish.mock.calls.at(-1)?.[0].sessions[0]?.companion?.groupName).toBe('Product'));
    handleInteractionRequestForTest(service, { sessionId: 'lane' }, { kind: 'ask_user_question', requestId: 'q', questions: [] });
    expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({ phase: 'needs-interaction', attention: true });
    service.handleInteractionDismissed('lane', 'q');
    playSound.mockClear();
    service.handleAgentEvent({ sessionId: 'lane' }, { type: 'done', source: 'codex', data: { result: 'done' } });
    expect(publish.mock.calls.at(-1)?.[0].sessions).toEqual([]);
    expect(playSound).not.toHaveBeenCalled();
    service.setGroupChat('group', { groupId: 'group', name: 'Product', messageId: 'reply', mentioned: false,
      preview: 'Chris: done', lastMessageAt: Date.now(), members: [] });
    expect(publish.mock.calls.at(-1)?.[0].pillSnapshot.attentionCount).toBe(1);
    service.resetRuntimeState();
  });

  // #7307 review: accepted group input provenance exists before the avatar/identity read.
  // Unit: done arriving during that read must never emit completion attention or sound.
  it('silences a fast group reply before companion identity finishes loading', async () => {
    const { AgentIslandService } = await import('../service.js');
    let finishIdentity!: (identity: AgentIslandCompanionIdentity | null) => void;
    mocks.getSessionRowSnapshot.mockResolvedValue({ status: 'active', title: 'Chris', userSendAt: null,
      workingDir: '/home', workspaceKind: null, source: 'bot' });
    mocks.readAgentIslandCompanion.mockReturnValueOnce(new Promise(resolve => { finishIdentity = resolve; }));
    const publish = vi.fn<(state: AgentIslandDisplayState) => boolean>(() => true);
    const playSound = vi.fn();
    const service = new AgentIslandService({ getMainWindow: () => null, nativeHost: { failed: false, publish, playSound } });
    syncEnabledForTest(service, publish);
    service.handleUserPrompt({ sessionId: 'fast-lane' }, 'please help');
    await vi.waitFor(() => expect(finishIdentity).toBeTypeOf('function'));
    playSound.mockClear();
    service.handleAgentEvent({ sessionId: 'fast-lane' }, { type: 'done', source: 'codex',
      agentMeta: { botGroupLane: true }, data: { result: 'done' } });
    expect(publish.mock.calls.at(-1)?.[0].sessions).toEqual([]);
    expect(service.getSessionActivitySnapshot('fast-lane')).toBeNull();
    expect(playSound).not.toHaveBeenCalled();
    finishIdentity({ botId: 'bot', groupId: 'group', companion: { name: 'Chris', groupName: 'Product', hue: 'blue', glyph: 'C', glyphIsInitial: true } });
    await vi.waitFor(() => expect((service as unknown as {
      metadataCache: Map<string, { companion?: AgentIslandCompanionIdentity | null }>;
    }).metadataCache.get('fast-lane')?.companion?.groupId).toBe('group'));
    expect(publish.mock.calls.at(-1)?.[0].sessions).toEqual([]);
    expect(playSound).not.toHaveBeenCalled();
    service.resetRuntimeState();
  });

  // Old unread has no runtime event after restart. Verify the real IPC -> native -> read
  // route, including owner fencing and stale-card rejection; existing event tests miss this (unit).
  it('restores companion chats from the owner snapshot and reads offline chats locally', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn<(state: AgentIslandDisplayState) => boolean>(() => true);
    const send = vi.fn();
    const mainWindow = { webContents: { send }, isDestroyed: () => false } as unknown as BrowserWindow;
    const service = new AgentIslandService({ getMainWindow: () => mainWindow,
      nativeHost: { failed: false, publish, suspend: () => undefined } });
    syncEnabledForTest(service, publish);
    service.registerDeviceSessionIpc();
    const sync = registeredIpcHandler(AGENT_ISLAND_SET_COMPANION_CHATS_CHANNEL);
    const chat = { sessionId: 'offline-chat', botId: 'remote-bot', deviceId: 'offline-home',
      companion: { name: 'Cindy', avatar: 'cindy://avatar/preset/cindy', avatarColor: 'blue' }, visible: true, unread: true,
      lastMessageAt: 1, preview: 'Unread reply' };
    const snapshot = { dataOwnerId: 'test-owner', ownerGeneration: 1, chats: [chat] };
    sync({ sender: mainWindow.webContents }, { ...snapshot, ownerGeneration: 0 });
    expect(publish).not.toHaveBeenCalled();
    sync({ sender: {} }, snapshot);
    expect(publish).not.toHaveBeenCalled();
    sync({ sender: mainWindow.webContents }, snapshot);
    const display = publish.mock.calls.at(-1)![0];
    expect(display.pillSnapshot.attentionCount).toBe(1);
    expect(service.getSessionActivitySnapshot(chat.sessionId)).toBeNull();
    const token = display.sessions[0].completionToken!;
    await Promise.resolve();
    mocks.companionAvatarThumbnail.mockResolvedValueOnce('restored-avatar');
    sync({ sender: mainWindow.webContents }, snapshot);
    await Promise.resolve();
    expect(publish.mock.calls.at(-1)![0].sessions[0].companion?.imageJpeg).toBe('restored-avatar');
    expect(publish.mock.calls.at(-1)![0].sessions[0].completionToken).toBe(token);
    expect(await service.handleCompletionAction(chat.sessionId, 'archive', token)).toBe(false);
    expect(await service.handleCompletionAction(chat.sessionId, 'mark-read', token)).toBe(true);
    expect(send).toHaveBeenCalledWith(AGENT_ISLAND_READ_COMPANION_CHAT_CHANNEL,
      { ...chat, readThroughAt: chat.lastMessageAt }, { dataOwnerId: 'test-owner', ownerGeneration: 1 });
    expect(mocks.remoteInvoke).not.toHaveBeenCalled();
    expect(publish.mock.calls.at(-1)![0].pillSnapshot.attentionCount).toBe(0);
    sync({ sender: mainWindow.webContents }, { ...snapshot, chats: [{ ...chat, lastMessageAt: 2 }] });
    expect(await service.handleCompletionAction(chat.sessionId, 'mark-read', token)).toBe(false);
    expect(publish.mock.calls.at(-1)![0].pillSnapshot.attentionCount).toBe(1);
    service.resetRuntimeState();
    service.setEnabled(true);
    expect(publish.mock.calls.at(-1)![0].pillSnapshot.attentionCount).toBe(0);
  });

  // Unit regression #7134: the earlier test only checked sound after an unread snapshot arrived.
  it.each([false, true])('keeps fresh completion sounds before chat unread=%s and clears explicit reads', async (unread) => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn<(state: AgentIslandDisplayState) => boolean>(() => true);
    const playSound = vi.fn(() => true);
    const mainWindow = { webContents: { send: vi.fn() }, isDestroyed: () => false } as unknown as BrowserWindow;
    const service = new AgentIslandService({ getMainWindow: () => mainWindow,
      nativeHost: { failed: false, publish, playSound, suspend: () => undefined } });
    syncEnabledForTest(service, publish);
    service.setSoundSettings({ enabled: true, sounds: { ...DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds,
      complete: customSound('complete.wav') } });
    const input = { sessionId: 'local-chat', botId: 'local-bot', deviceId: null,
      companion: { name: 'Cindy', avatar: '', avatarColor: 'blue' }, visible: true, unread: false,
      lastMessageAt: 1, preview: '' };
    service.setCompanionChats([input]);
    service.handleUserPrompt({ sessionId: input.sessionId }, 'hello');
    playSound.mockClear();
    service.handleAgentEvent({ sessionId: input.sessionId }, doneEvent());
    expect(playSound).toHaveBeenCalledWith(customSound('complete.wav'));
    if (!unread) {
      service.setCompanionChats([input]);
      expect(playSound).toHaveBeenCalledTimes(1);
      expect(publish.mock.calls.at(-1)![0].sessions).toEqual([]);
      service.resetRuntimeState();
      return;
    }
    const runtimeToken = (service.getSessionActivitySnapshot(input.sessionId) as AgentIslandSessionActivity).completionToken!;
    service.setCompanionChats([{ ...input, unread: true, lastMessageAt: Date.now(), preview: 'Reply' }]);
    expect(playSound).toHaveBeenCalledWith(customSound('complete.wav'));
    expect(await service.handleCompletionAction(input.sessionId, 'mark-read', runtimeToken)).toBe(false);
    const token = publish.mock.calls.at(-1)![0].sessions[0].completionToken!;
    expect(await service.handleCompletionAction(input.sessionId, 'mark-read', token)).toBe(true);
    expect(service.getSessionActivitySnapshot(input.sessionId)?.attention ?? false).toBe(false);
    expect(publish.mock.calls.at(-1)![0].pillSnapshot.attentionCount).toBe(0);
    service.resetRuntimeState();
  });

  // Unit: the menu bar must observe the final chat projection even with the island hidden.
  it.each([true, false])('publishes shared attention counts with island enabled=%s', async (enabled) => {
    const { AgentIslandService } = await import('../service.js');
    const service = new AgentIslandService({ getMainWindow: () => null,
      nativeHost: { failed: false, publish: () => true, suspend: () => undefined } });
    service.setEnabled(enabled);
    const counts = vi.fn();
    const unsubscribe = service.subscribeAttentionCount(counts);
    const chat = { sessionId: 'unread-chat', botId: 'bot', deviceId: 'offline-home',
      companion: { name: 'Cindy', avatar: '', avatarColor: 'blue' }, visible: true, unread: true,
      lastMessageAt: 1, preview: 'Unread reply' };
    service.handleUserPrompt({ sessionId: 'running-task' }, 'work');
    expect(service.getAttentionCount()).toBe(0);
    service.setCompanionChats([chat]);
    expect(service.getAttentionCount()).toBe(1);
    expect(counts.mock.calls).toEqual([[1]]);
    service.setCompanionChats([chat]);
    expect(counts).toHaveBeenCalledTimes(1);
    service.setCompanionChats([{ ...chat, unread: false }]);
    expect(counts.mock.calls).toEqual([[1], [0]]);
    service.setCompanionChats([chat]);
    service.resetRuntimeState();
    expect(service.getAttentionCount()).toBe(0);
    expect(counts.mock.calls).toEqual([[1], [0], [1], [0]]);
    unsubscribe();
    service.setEnabled(enabled);
    service.setCompanionChats([chat]);
    expect(counts).toHaveBeenCalledTimes(4);
    service.resetRuntimeState();
  });

  it.each([true, false])('waits across status Done → native done for the shared local/remote completion decision (%s)', async handled => {
    const { AgentIslandService } = await import('../service.js');
    const remoteEvents: string[] = [];
    const controller = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, headless: true, publish: () => true, suspend: () => undefined },
      onDeviceSessionEvent: event => remoteEvents.push(event.kind),
    });
    controller.setEnabled(false);
    mocks.tapWindowBroadcast.mockImplementation((channel, payload) => {
      if (channel !== SESSION_ACTIVITY_CHANNEL) return;
      controller.setDeviceSessions([{
        ...payload,
        deviceId: 'execution-host',
        deviceName: 'Host',
        title: 'Delegated task',
        detail: payload.compactDetail,
      }]);
    });
    let settlement: Promise<boolean> | undefined;
    let resolve!: (handled: boolean) => void;
    const check = vi.fn(async () => await settlement ?? false);
    const source = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, headless: true, publish: () => true, suspend: () => undefined },
      isCompletionHandledByTeammate: check,
    });
    source.setEnabled(false);
    const meta = { sessionId: 'delegated-status-done', agentKind: 'codex' as const };
    source.handleUserPrompt(meta, 'run task');
    source.handleAgentEvent(meta, textEvent('Final result', true));
    source.handleAgentEvent(meta, { type: 'status', source: 'codex', data: { status: 'Done', isRunning: false } });
    // Native events cross separate iterator awaits. A microtask delay at status
    // Done alone must never decide ownership before the later done boundary.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(check).not.toHaveBeenCalled();
    expect(remoteEvents).toEqual([]);
    const localDecision = source.waitForCompletionNotification(meta.sessionId);
    expect(localDecision).toBeDefined();
    expect(source.getSessionActivitySnapshot(meta.sessionId)).toMatchObject({ phase: 'completed', attention: true });
    source.handleAgentEvent(meta, doneEvent());
    // The synchronous terminal adapter registers settlement after island delivery.
    settlement = new Promise<boolean>(r => { resolve = r; });
    await Promise.resolve();
    expect(check).toHaveBeenCalledOnce();
    expect(remoteEvents).toEqual([]);
    resolve(handled);
    await expect(localDecision).resolves.toBe(handled);
    expect(remoteEvents).toEqual(handled ? [] : ['done']);
    source.handleAgentEvent(meta, doneEvent());
    source.replaySessionActivity();
    expect(check).toHaveBeenCalledOnce();
    expect(remoteEvents).toEqual(handled ? [] : ['done']);
    expect(source.getSessionActivitySnapshot(meta.sessionId)).toMatchObject({ phase: 'completed', attention: true });
    source.resetRuntimeState(); controller.resetRuntimeState();
    mocks.tapWindowBroadcast.mockReset();
  });

  // Swipe actions must use the real lifecycle entry and retain attention on failure.
  // Existing focus tests do not cover background completion actions (unit tier).
  it('reads or archives completed tasks without focusing, and retains failed archives', async () => {
    const { AgentIslandService } = await import('../service.js');
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, headless: true, publish: () => true, suspend: () => undefined },
    });
    service.setEnabled(false);
    const meta = { sessionId: 'swipe-task', agentKind: 'codex' as const };
    service.handleUserPrompt(meta, 'run');
    await service.handleCompletionAction(meta.sessionId, 'archive', 'missing');
    expect(mocks.patchSessionMetaInDb).not.toHaveBeenCalled();
    service.handleAgentEvent(meta, doneEvent());
    const token = (service.getSessionActivitySnapshot(meta.sessionId) as AgentIslandSessionActivity).completionToken!;
    mocks.patchSessionMetaInDb.mockRejectedValueOnce(new Error('offline'));
    await service.handleCompletionAction(meta.sessionId, 'archive', token);
    expect(service.getSessionActivitySnapshot(meta.sessionId)).toMatchObject({ attention: true });
    expect(mocks.showMessageBox).toHaveBeenCalled();
    mocks.patchSessionMetaInDb.mockResolvedValueOnce({ status: 'archived' });
    await service.handleCompletionAction(meta.sessionId, 'archive', token);
    expect(mocks.patchSessionMetaInDb).toHaveBeenLastCalledWith(meta.sessionId, { status: 'archived' }, {
      routeLockHeld: true, beforeWrite: expect.any(Function),
    });
    expect(service.getSessionActivitySnapshot(meta.sessionId)?.attention ?? false).toBe(false);
    service.handleUserPrompt(meta, 'again');
    service.handleAgentEvent(meta, doneEvent());
    const nextToken = (service.getSessionActivitySnapshot(meta.sessionId) as AgentIslandSessionActivity).completionToken!;
    await service.handleCompletionAction(meta.sessionId, 'mark-read', nextToken);
    expect(service.getSessionActivitySnapshot(meta.sessionId)?.attention ?? false).toBe(false);
    expect(mocks.patchSessionMetaInDb).toHaveBeenCalledTimes(2);
    service.resetRuntimeState();
  });

  it('routes remote swipe actions to their owner and excludes companion archives', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn<(state: AgentIslandDisplayState) => boolean>(() => true);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish, suspend: () => undefined },
    });
    syncEnabledForTest(service, publish);
    const input = { sessionId: 'remote-swipe', deviceId: 'owner-device', deviceName: 'Mac',
      completionToken: 'owner-completion',
      title: 'Task', workingDir: null, workspaceKind: null, agentKind: 'codex', detail: '' };
    const complete = () => {
      service.setDeviceSessions([{ ...input, phase: 'running' }]);
      service.setDeviceSessions([{ ...input, phase: 'completed' }]);
    };
    complete();
    mocks.remoteInvoke.mockResolvedValueOnce({ ok: false, error: { message: 'offline' } });
    await service.handleCompletionAction(input.sessionId, 'mark-read', input.completionToken);
    expect(publish.mock.calls.at(-1)?.[0].sessions).toContainEqual(expect.objectContaining({ sessionId: input.sessionId, attention: true }));
    mocks.remoteInvoke.mockResolvedValue({ ok: true, result: true });
    await service.handleCompletionAction(input.sessionId, 'mark-read', input.completionToken);
    expect(mocks.remoteInvoke).toHaveBeenLastCalledWith('owner-device', 'agent-island:completion-action', ['remote-swipe', 'mark-read', input.completionToken]);
    expect(publish.mock.calls.at(-1)?.[0].sessions.some(s => s.sessionId === input.sessionId && s.attention)).toBe(false);
    complete();
    await service.handleCompletionAction(input.sessionId, 'archive', input.completionToken);
    expect(mocks.remoteInvoke).toHaveBeenLastCalledWith('owner-device', 'agent-island:completion-action', ['remote-swipe', 'archive', input.completionToken]);
    const count = mocks.remoteInvoke.mock.calls.length;
    service.setDeviceSessions([{ ...input, phase: 'completed', companion: { name: 'Teammate', avatar: '', avatarColor: 'teal' } }]);
    await service.handleCompletionAction(input.sessionId, 'archive', input.completionToken);
    expect(mocks.remoteInvoke).toHaveBeenCalledTimes(count);
    expect(mocks.patchSessionMetaInDb).not.toHaveBeenCalled();
    service.resetRuntimeState();
  });

  // IPC security §5: a valid completion token cannot authorize a foreign frame.
  // The same owner mutation remains available through authenticated device-link.
  it.each(['mark-read', 'archive'] as const)('rejects an untrusted %s sender before side effects and accepts its tunneled equivalent', async action => {
    const { AgentIslandService } = await import('../service.js');
    const service = new AgentIslandService({ getMainWindow: () => null });
    service.setEnabled(false);
    service.registerDeviceSessionIpc();
    const meta = { sessionId: 'sender-guard', agentKind: 'codex' as const };
    service.handleUserPrompt(meta, 'run');
    service.handleAgentEvent(meta, doneEvent());
    const token = (service.getSessionActivitySnapshot(meta.sessionId) as AgentIslandSessionActivity).completionToken!;
    const handler = registeredIpcHandler('agent-island:completion-action');
    const event = { senderFrame: null };
    mocks.assertTrustedAppRendererEvent.mockImplementation(() => { throw new Error('[FORBIDDEN] Untrusted renderer'); });
    try {
      expect(() => handler(event, meta.sessionId, action, token)).toThrow('[FORBIDDEN]');
      expect(mocks.assertTrustedAppRendererEvent).toHaveBeenCalledWith(event);
      expect(mocks.patchSessionMetaInDb).not.toHaveBeenCalled();
      expect(service.getSessionActivitySnapshot(meta.sessionId)).toMatchObject({ attention: true });
      mocks.assertTrustedAppRendererEvent.mockClear();
      expect(await runDeviceLinkInvokeContext({ controllerDeviceId: 'paired', channel: 'agent-island:completion-action' },
        () => handler(null, meta.sessionId, action, token))).toBe(true);
      expect(mocks.assertTrustedAppRendererEvent).not.toHaveBeenCalled();
      expect(mocks.patchSessionMetaInDb).toHaveBeenCalledTimes(action === 'archive' ? 1 : 0);
      expect(service.getSessionActivitySnapshot(meta.sessionId)?.attention ?? false).toBe(false);
    } finally {
      service.resetRuntimeState();
    }
  });

  // Owner handler + existing send lock: stale network/queue deliveries must not
  // archive or acknowledge the next completion, even in the same millisecond.
  it.each(['mark-read', 'archive'] as const)('rejects an old %s on the owning device after its route wait', async action => {
    const { AgentIslandService } = await import('../service.js');
    const { setSessionRouteLockImplementation } = await import('../../localDb/sessionRouteLock.js');
    const service = new AgentIslandService({ getMainWindow: () => null });
    service.setEnabled(false);
    service.registerDeviceSessionIpc();
    const meta = { sessionId: 'owner-race', agentKind: 'codex' as const };
    const complete = () => { service.handleUserPrompt(meta, 'run'); service.handleAgentEvent(meta, doneEvent()); };
    complete();
    const token = (service.getSessionActivitySnapshot(meta.sessionId) as AgentIslandSessionActivity).completionToken!;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    setSessionRouteLockImplementation(async (_id, task) => { await blocked; return task(); });
    try {
      const actionPromise = runDeviceLinkInvokeContext({ controllerDeviceId: 'paired', channel: 'agent-island:completion-action' },
        () => registeredIpcHandler('agent-island:completion-action')(null, meta.sessionId, action, token));
      complete();
      release();
      expect(await actionPromise).toBe(false);
      expect(mocks.patchSessionMetaInDb).not.toHaveBeenCalled();
      expect(service.getSessionActivitySnapshot(meta.sessionId)).toMatchObject({ attention: true });
      expect((service.getSessionActivitySnapshot(meta.sessionId) as AgentIslandSessionActivity).completionToken).not.toBe(token);
    } finally {
      setSessionRouteLockImplementation(null);
      service.resetRuntimeState();
    }
  });

  it('keeps a cancelled archive and rechecks its card after confirmation and worktree waits', async () => {
    const { AgentIslandService } = await import('../service.js');
    const service = new AgentIslandService({ getMainWindow: () => null });
    service.setEnabled(false);
    const meta = { sessionId: 'archive-wait', agentKind: 'codex' as const };
    const complete = () => { service.handleUserPrompt(meta, 'run'); service.handleAgentEvent(meta, doneEvent()); };
    complete();
    const token = () => (service.getSessionActivitySnapshot(meta.sessionId) as AgentIslandSessionActivity).completionToken!;
    mocks.confirmIslandArchive.mockResolvedValueOnce(false);
    expect(await service.handleCompletionAction(meta.sessionId, 'archive', token())).toBe(false);
    expect(mocks.patchSessionMetaInDb).not.toHaveBeenCalled();
    mocks.confirmIslandArchive.mockImplementationOnce(async () => { complete(); return true; });
    expect(await service.handleCompletionAction(meta.sessionId, 'archive', token())).toBe(false);
    expect(mocks.patchSessionMetaInDb).not.toHaveBeenCalled();
    mocks.attached.mockReturnValueOnce({ channel: 'feishu' });
    expect(await service.handleCompletionAction(meta.sessionId, 'archive', token())).toBe(false);
    expect(mocks.patchSessionMetaInDb).not.toHaveBeenCalled();
    mocks.patchSessionMetaInDb.mockImplementationOnce(async (_id, _patch, options) => {
      complete();
      options.beforeWrite();
      throw new Error('unreachable');
    });
    expect(await service.handleCompletionAction(meta.sessionId, 'archive', token())).toBe(false);
    expect(service.getSessionActivitySnapshot(meta.sessionId)).toMatchObject({ attention: true });
    service.resetRuntimeState();
  });

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
    // 首个动态 import('../service.js') 在高并行 worker 下可能超过 vitest 默认 5s，
    // 显式放宽本用例的超时(用例本身是纯同步断言，不是真长跑)。
  }, 20_000);

  it('「消息免打扰」只把任务从岛面拿掉，侧栏活动快照照旧保留', async () => {
    const { AgentIslandService } = await import('../service.js');
    const published: AgentIslandDisplayState[] = [];
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: {
        failed: false,
        headless: false,
        publish: (display) => {
          published.push(display);
          return true;
        },
        suspend: () => undefined,
      },
    });

    service.setEnabled(true);
    mocks.isSessionNotificationsMutedSync.mockImplementation((id: string) => id === 'muted-task');
    service.handleUserPrompt({ sessionId: 'muted-task', agentKind: 'codex' }, 'run tests');

    // 岛面（含菜单栏与提示音）里没有它。
    expect(published.at(-1)?.sessions).toEqual([]);
    // 但侧栏卡片与远端活动镜像仍有实时活动：静音不是把任务藏起来。
    expect(service.getSessionActivitySnapshots()).toEqual([
      expect.objectContaining({ sessionId: 'muted-task', phase: 'running' }),
    ]);

    // 取消静音 → 重发展示面，任务回到岛上，状态一直都在。
    mocks.isSessionNotificationsMutedSync.mockReturnValue(false);
    service.handleNotificationMuteChanged();
    expect(published.at(-1)?.sessions.map((session) => session.sessionId)).toEqual(['muted-task']);
  }, 20_000);

  it('取消静音时不为静音期间已经发生的旧状态补播提示音', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn(() => true);
    const playSound = vi.fn<(sound: AgentIslandSoundChoice) => boolean>(() => true);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: {
        failed: false,
        headless: false,
        publish,
        suspend: () => undefined,
        playSound,
      },
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

    // 静音期间任务跑完：岛面看不到它，自然也不响。
    mocks.isSessionNotificationsMutedSync.mockImplementation((id: string) => id === 'muted-task');
    playSound.mockClear();
    service.handleUserPrompt({ sessionId: 'muted-task', agentKind: 'codex' }, 'run tests');
    service.handleAgentEvent({ sessionId: 'muted-task', agentKind: 'codex' }, doneEvent());
    expect(playSound).not.toHaveBeenCalled();

    // 取消静音 → 任务带着「已完成」重新出现在岛面上，但那是旧状态，不该补播完成音。
    mocks.isSessionNotificationsMutedSync.mockReturnValue(false);
    service.handleNotificationMuteChanged();
    expect(playSound).not.toHaveBeenCalled();
  }, 20_000);

  it('exposes the canonical snapshot and emits per-session transition edges', async () => {
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
    const transitions = vi.fn();
    const unsubscribe = service.subscribeSessionActivity(transitions);

    service.setEnabled(false);
    service.handleUserPrompt(
      {
        sessionId: 'canonical',
        agentKind: 'codex',
      },
      'run tests',
    );
    service.handleSessionMetadataPatch('canonical', {
      title: '🚧#2804 会话控制面 · 待bot',
    });

    const canonicalSnapshot = service.getSessionActivitySnapshot('canonical');
    expect(canonicalSnapshot).toMatchObject({
      sessionId: 'canonical',
      phase: 'running',
      recordStatus: 'active',
      currentActionSummary: '正在处理新消息',
      source: 'live',
      workflow: {
        key: 'awaiting-bot',
        label: '待bot',
        waitingOn: 'automation',
      },
    });
    expect(canonicalSnapshot).not.toHaveProperty('compactDetail');
    expect(JSON.stringify(canonicalSnapshot)).not.toContain('run tests');
    expect(transitions).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId: 'canonical',
      previous: null,
      current: expect.objectContaining({ phase: 'running' }),
      changedAtMs: expect.any(Number),
    }));
    expect(transitions).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'canonical',
      previous: expect.objectContaining({ workflow: null }),
      current: expect.objectContaining({
        workflow: expect.objectContaining({ key: 'awaiting-bot' }),
      }),
    }));

    service.resetRuntimeState();
    expect(transitions).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'canonical',
      previous: expect.objectContaining({ phase: 'running' }),
      current: null,
    }));

    unsubscribe();
    transitions.mockClear();
    service.handleUserPrompt({ sessionId: 'after-unsubscribe', agentKind: 'codex' }, 'continue');
    expect(transitions).not.toHaveBeenCalled();
  });

  it('resets the canonical turn start time when a completed session starts again', async () => {
    vi.useFakeTimers();
    try {
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
      const meta = { sessionId: 'reused', agentKind: 'codex' as const };

      vi.setSystemTime(1_000);
      service.handleUserPrompt(meta, 'first');
      expect(service.getSessionActivitySnapshot(meta.sessionId)?.startedAtMs).toBe(1_000);
      service.handleAgentEvent(meta, doneEvent());

      vi.setSystemTime(2_000);
      service.handleUserPrompt(meta, 'second');
      expect(service.getSessionActivitySnapshot(meta.sessionId)).toMatchObject({
        phase: 'running',
        startedAtMs: 2_000,
        lastActivityAtMs: 2_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets the canonical turn start time when a new turn is first observed from an agent event', async () => {
    vi.useFakeTimers();
    try {
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
      const meta = { sessionId: 'event-reused', agentKind: 'codex' as const };

      vi.setSystemTime(1_000);
      service.handleUserPrompt(meta, 'first');
      service.handleAgentEvent(meta, doneEvent());

      vi.setSystemTime(2_000);
      service.handleAgentEvent(meta, {
        type: 'status',
        source: 'codex',
        data: { isRunning: true, status: 'Thinking...' },
      });
      expect(service.getSessionActivitySnapshot(meta.sessionId)).toMatchObject({
        phase: 'running',
        startedAtMs: 2_000,
        lastActivityAtMs: 2_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not emit a canonical transition for display-only detail changes', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
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
      const transitions = vi.fn();
      service.subscribeSessionActivity(transitions);
      service.setEnabled(false);

      service.handleUserPrompt({ sessionId: 'detail-only', agentKind: 'codex' }, 'first body');
      expect(transitions).toHaveBeenCalledTimes(1);
      transitions.mockClear();

      service.handleUserPrompt({ sessionId: 'detail-only', agentKind: 'codex' }, 'second body');
      expect(service.getSessionActivitySnapshot('detail-only')).toMatchObject({
        phase: 'running',
        currentActionSummary: '正在处理新消息',
      });
      expect(transitions).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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

  it('hides unread completion from the island at TTL while remote attention stays until ack even when island UI is off', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const { AgentIslandService } = await import('../service.js');
      const { AGENT_ISLAND_UNREAD_TRANSIENT_TTL_MS } = await import('../state.js');
      const publish = vi.fn((state: AgentIslandDisplayState) => {
        void state;
        return true;
      });
      const service = new AgentIslandService({
        getMainWindow: () => null,
        nativeHost: { failed: false, headless: true, publish, suspend: () => undefined },
      });

      service.setEnabled(false);
      service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');
      service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, textEvent('Tests pass.', true));
      service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, doneEvent());
      const sessions = (
        service as unknown as { state: { sessions: Map<string, unknown>; remoteUnreadTerminals: Map<string, unknown> } }
      ).state;
      expect(sessions.sessions.has('s1')).toBe(true);
      mocks.tapWindowBroadcast.mockClear();

      await vi.advanceTimersByTimeAsync(AGENT_ISLAND_UNREAD_TRANSIENT_TTL_MS + 50);
      expect(sessions.sessions.has('s1')).toBe(false);
      expect(sessions.remoteUnreadTerminals.has('s1')).toBe(true);
      expect(mocks.tapWindowBroadcast).toHaveBeenCalledWith(
        SESSION_ACTIVITY_CHANNEL,
        expect.objectContaining({ sessionId: 's1', phase: 'completed', attention: true }),
      );

      mocks.tapWindowBroadcast.mockClear();
      mocks.getSessionRowSnapshot.mockClear();
      service.handleSessionAttentionCleared('s1', 'passive');
      expect(mocks.tapWindowBroadcast).toHaveBeenCalledWith(
        SESSION_ACTIVITY_CHANNEL,
        expect.objectContaining({ sessionId: 's1', attention: false }),
      );
      expect(mocks.getSessionRowSnapshot).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('hides unread completion from the island at TTL while remote attention stays until ack', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const { AgentIslandService } = await import('../service.js');
      const { AGENT_ISLAND_UNREAD_TRANSIENT_TTL_MS } = await import('../state.js');
      const publish = vi.fn((state: AgentIslandDisplayState) => {
        void state;
        return true;
      });
      const service = new AgentIslandService({
        getMainWindow: () => null,
        nativeHost: { failed: false, publish, suspend: () => undefined },
      });

      service.setEnabled(true);
      service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');
      service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, textEvent('Tests pass.', true));
      service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, doneEvent());
      expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({
        totalCount: 1,
        sessions: [expect.objectContaining({ sessionId: 's1', phase: 'completed' })],
      });
      mocks.tapWindowBroadcast.mockClear();

      await vi.advanceTimersByTimeAsync(AGENT_ISLAND_UNREAD_TRANSIENT_TTL_MS + 50);
      expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({ totalCount: 0 });
      expect(mocks.tapWindowBroadcast).toHaveBeenCalledWith(
        SESSION_ACTIVITY_CHANNEL,
        expect.objectContaining({ sessionId: 's1', phase: 'completed', attention: true }),
      );

      mocks.tapWindowBroadcast.mockClear();
      mocks.getSessionRowSnapshot.mockClear();
      service.handleSessionAttentionCleared('s1', 'passive');
      expect(mocks.tapWindowBroadcast).toHaveBeenCalledWith(
        SESSION_ACTIVITY_CHANNEL,
        expect.objectContaining({ sessionId: 's1', attention: false }),
      );
      expect(mocks.getSessionRowSnapshot).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a stale not-found receipt clear a newer unread completion', async () => {
    const { AgentIslandService } = await import('../service.js');
    let releaseSnapshot: ((row: { status: string; title: string | null; userSendAt: number | null; workingDir: string | null; workspaceKind: string | null } | null) => void) | undefined;
    mocks.getSessionRowSnapshot.mockImplementationOnce(
      () => new Promise((resolve) => {
        releaseSnapshot = resolve;
      }),
    );
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, headless: true, publish: () => true, suspend: () => undefined },
    });
    service.setEnabled(false);

    service.handleSessionAttentionCleared('s1', 'passive');
    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');
    service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, doneEvent());
    mocks.tapWindowBroadcast.mockClear();

    releaseSnapshot?.({
      status: 'active',
      title: 'new',
      userSendAt: null,
      workingDir: '/tmp/x',
      workspaceKind: null,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.tapWindowBroadcast).not.toHaveBeenCalledWith(
      SESSION_ACTIVITY_CHANNEL,
      expect.objectContaining({ sessionId: 's1', attention: false }),
    );
  });

  it('does not let a stale not-found receipt clear a newer unread error', async () => {
    const { AgentIslandService } = await import('../service.js');
    let releaseSnapshot: ((row: { status: string; title: string | null; userSendAt: number | null; workingDir: string | null; workspaceKind: string | null } | null) => void) | undefined;
    mocks.getSessionRowSnapshot.mockImplementationOnce(
      () => new Promise((resolve) => {
        releaseSnapshot = resolve;
      }),
    );
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, headless: true, publish: () => true, suspend: () => undefined },
    });
    service.setEnabled(false);

    service.handleSessionAttentionCleared('s1', 'passive');
    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');
    service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, terminalErrorEvent('boom'));
    mocks.tapWindowBroadcast.mockClear();

    releaseSnapshot?.({
      status: 'active',
      title: 'new-err',
      userSendAt: null,
      workingDir: '/tmp/x',
      workspaceKind: null,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.tapWindowBroadcast).not.toHaveBeenCalledWith(
      SESSION_ACTIVITY_CHANNEL,
      expect.objectContaining({ sessionId: 's1', attention: false }),
    );
  });

  it('does not let a retrying error bump generation and drop a stale not-found clear', async () => {
    const { AgentIslandService } = await import('../service.js');
    let releaseSnapshot: ((row: { status: string; title: string | null; userSendAt: number | null; workingDir: string | null; workspaceKind: string | null } | null) => void) | undefined;
    mocks.getSessionRowSnapshot.mockImplementationOnce(
      () => new Promise((resolve) => {
        releaseSnapshot = resolve;
      }),
    );
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, headless: true, publish: () => true, suspend: () => undefined },
    });
    service.setEnabled(false);

    service.handleSessionAttentionCleared('s1', 'passive');
    // 重启后内存空、只有异步 not-found 查询在飞。可恢复 error 会建一条
    // running:false 的临时条目并立刻被 prune,不得因此 bump generation 把旧收尾包作废。
    service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, recoverableErrorEvent('retrying'));
    mocks.tapWindowBroadcast.mockClear();

    releaseSnapshot?.({
      status: 'active',
      title: 'stale',
      userSendAt: null,
      workingDir: '/tmp/x',
      workspaceKind: null,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.tapWindowBroadcast).toHaveBeenCalledWith(
      SESSION_ACTIVITY_CHANNEL,
      expect.objectContaining({ sessionId: 's1', attention: false }),
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

  // #7566 review, unit: verify the actual producer marks converted text so a
  // second host can retain literal code instead of applying Markdown twice.
  it('relays the last reply as a plain-text completion summary for other devices', async () => {
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
    const meta = { sessionId: 'summary', agentKind: 'codex' as const };

    service.handleUserPrompt(meta, 'fix the login bug');
    service.handleAgentEvent(meta, textEvent('**Fixed**: `foo_bar **literal**`', true));
    service.handleAgentEvent(meta, doneEvent());

    expect(mocks.tapWindowBroadcast).toHaveBeenLastCalledWith(
      SESSION_ACTIVITY_CHANNEL,
      expect.objectContaining({
        sessionId: 'summary',
        phase: 'completed',
        compactDetail: 'Fixed: foo_bar **literal**',
        summaryFormat: 'plain-text',
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

  // Companion Sessions are Bot Sessions whose title and home folder are not what the user
  // knows them by; the island must load the companion and follow its renames.
  it('loads a companion identity for Bot Sessions and refreshes it when the companion changes', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const workingDir = '/Users/alice/Library/Application Support/Cindy/owners/o1/bots/b1/workspace';
    const identity = (name: string): AgentIslandCompanionIdentity => ({
      botId: 'b1',
      companion: { name, hue: 'violet', glyph: name[0]!, glyphIsInitial: true },
    });
    mocks.getSessionRowSnapshot.mockImplementation(async () => ({
      status: 'active', title: 'Opus', userSendAt: null, workingDir, workspaceKind: null, source: 'bot',
    }));
    mocks.readAgentIslandCompanion.mockResolvedValue(identity('Opus'));
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });
    syncEnabledForTest(service, publish);

    service.handleUserPrompt({ sessionId: 's1', agentKind: 'claude-code', workingDir }, 'hi');
    await vi.waitFor(() => expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      title: 'Opus',
      projectName: null,
      companion: identity('Opus').companion,
    }));

    // A title patch must not drop the companion that was already resolved.
    service.handleSessionMetadataPatch('s1', { title: 'Renamed task' });
    expect(publish.mock.calls.at(-1)?.[0].sessions[0]?.companion?.name).toBe('Opus');

    service.handleCompanionProfileChanged('another-bot');
    expect(mocks.readAgentIslandCompanion).toHaveBeenCalledTimes(1);

    mocks.readAgentIslandCompanion.mockResolvedValue(identity('Sonnet'));
    service.handleCompanionProfileChanged('b1');
    await vi.waitFor(() => expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      title: 'Sonnet',
      companion: { name: 'Sonnet' },
    }));
  });

  // Review of #6436: a group rename never reached open group-lane cards, an older slow read
  // could overwrite a newer one, and a failed remote avatar read stayed a glyph forever.
  it('refreshes group-lane cards on a group rename, keeping only the latest of overlapping reads', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const lane = (groupName: string): AgentIslandCompanionIdentity => ({
      botId: 'b1', groupId: 'g1', companion: { name: 'Opus', groupName, hue: 'teal', glyph: 'O', glyphIsInitial: true },
    });
    mocks.getSessionRowSnapshot.mockImplementation(async () => ({
      status: 'active', title: 'Opus', userSendAt: null, workingDir: '/home', workspaceKind: null, source: 'bot',
    }));
    mocks.readAgentIslandCompanion.mockResolvedValue(lane('旧群名'));
    const service = new AgentIslandService({ getMainWindow: () => null, nativeHost: { failed: false, publish } });
    syncEnabledForTest(service, publish);
    service.handleUserPrompt({ sessionId: 's1', agentKind: 'claude-code', workingDir: '/home' }, 'hi');
    await vi.waitFor(() => expect(publish.mock.calls.at(-1)?.[0].sessions[0]?.projectName).toBe('旧群名'));

    service.handleBotGroupChanged('other-group');
    expect(mocks.readAgentIslandCompanion).toHaveBeenCalledTimes(1);

    let releaseSlow!: (identity: AgentIslandCompanionIdentity) => void;
    mocks.readAgentIslandCompanion.mockImplementationOnce(() => new Promise((resolve) => { releaseSlow = resolve; }));
    service.handleBotGroupChanged('g1');
    mocks.readAgentIslandCompanion.mockResolvedValueOnce(lane('新群名'));
    service.handleBotGroupChanged('g1');
    await vi.waitFor(() => expect(publish.mock.calls.at(-1)?.[0].sessions[0]?.projectName).toBe('新群名'));
    releaseSlow(lane('过期群名'));
    await Promise.resolve();
    await Promise.resolve();
    expect(publish.mock.calls.at(-1)?.[0].sessions[0]?.projectName).toBe('新群名');
  });

  // Review of #6436 (round 5): a rename landing while the FIRST identity read was still
  // encoding the avatar found no resolved companion to refresh, then the stale read committed.
  it('re-reads an identity whose first load overlapped a companion change', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const named = (name: string): AgentIslandCompanionIdentity => ({
      botId: 'b1', companion: { name, hue: 'teal', glyph: name[0]!, glyphIsInitial: true },
    });
    mocks.getSessionRowSnapshot.mockImplementation(async () => ({
      status: 'active', title: 'x', userSendAt: null, workingDir: '/home', workspaceKind: null, source: 'bot',
    }));
    let releaseFirst!: (identity: AgentIslandCompanionIdentity) => void;
    mocks.readAgentIslandCompanion.mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }));
    mocks.readAgentIslandCompanion.mockResolvedValue(named('新名字'));
    const service = new AgentIslandService({ getMainWindow: () => null, nativeHost: { failed: false, publish } });
    syncEnabledForTest(service, publish);
    service.handleUserPrompt({ sessionId: 's1', agentKind: 'claude-code', workingDir: '/home' }, 'hi');
    await vi.waitFor(() => expect(mocks.readAgentIslandCompanion).toHaveBeenCalledTimes(1));

    // Several edits during one slow first read: only a read that saw none of them may commit.
    service.handleCompanionProfileChanged('b1');
    service.handleCompanionProfileChanged('b1');
    service.handleCompanionProfileChanged('b1');
    let releaseSecond!: (identity: AgentIslandCompanionIdentity) => void;
    mocks.readAgentIslandCompanion.mockImplementationOnce(() => new Promise((resolve) => { releaseSecond = resolve; }));
    releaseFirst(named('旧名字'));
    await vi.waitFor(() => expect(mocks.readAgentIslandCompanion).toHaveBeenCalledTimes(2));
    service.handleCompanionProfileChanged('b1');
    releaseSecond(named('中间名字'));
    await vi.waitFor(() => expect(publish.mock.calls.at(-1)?.[0].sessions[0]?.title).toBe('新名字'));
    expect(mocks.readAgentIslandCompanion).toHaveBeenCalledTimes(3);
  });

  it('retries a remote companion avatar after a failed read instead of keeping the glyph forever', async () => {
    vi.useFakeTimers();
    try {
      const { AgentIslandService } = await import('../service.js');
      const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
        void state;
        void frameOrFrames;
        return true;
      });
      const service = new AgentIslandService({ getMainWindow: () => null, nativeHost: { failed: false, publish } });
      syncEnabledForTest(service, publish);
      const input = {
        sessionId: 'r1', deviceId: 'd1', deviceName: 'Studio', title: 'Opus', workingDir: null, workspaceKind: null,
        agentKind: null, phase: 'running' as const, detail: 'x',
        companion: { name: 'Opus', avatar: 'cindy-media://blobs/' + 'a'.repeat(64) + '.png', avatarColor: 'teal' },
      };
      service.setDeviceSessions([input]);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.companionAvatarThumbnail).toHaveBeenCalledTimes(1);
      service.setDeviceSessions([input]);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.companionAvatarThumbnail).toHaveBeenCalledTimes(1);

      mocks.companionAvatarThumbnail.mockResolvedValue('JPEGDATA');
      await vi.advanceTimersByTimeAsync(61_000);
      service.setDeviceSessions([input]);
      await vi.advanceTimersByTimeAsync(0);
      expect(publish.mock.calls.at(-1)?.[0].sessions[0]?.companion?.imageJpeg).toBe('JPEGDATA');
    } finally {
      vi.useRealTimers();
    }
  });

  // Review of #6436: a fixed 64-entry FIFO thrashed once more companions than that were active.
  it('keeps every remote companion identity stable when more than 64 are active', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void state;
      void frameOrFrames;
      return true;
    });
    const service = new AgentIslandService({ getMainWindow: () => null, nativeHost: { failed: false, publish } });
    syncEnabledForTest(service, publish);
    const inputs = Array.from({ length: 70 }, (_, index) => ({
      sessionId: `r${index}`, deviceId: 'd1', deviceName: 'Studio', title: `Bot${index}`, workingDir: null, workspaceKind: null,
      agentKind: null, phase: 'running' as const, detail: 'x',
      companion: { name: `Bot${index}`, avatar: '🦊', avatarColor: 'teal' },
    }));
    service.setDeviceSessions(inputs);
    const first = publish.mock.calls.at(-1)?.[0].sessions.map((session) => session.companion);
    const publishedBefore = publish.mock.calls.length;
    service.setDeviceSessions(inputs);
    expect(publish.mock.calls.length).toBe(publishedBefore);
    expect(first).toHaveLength(70);
    expect(new Set(first).size).toBe(70);
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
    // cache-miss 加载路径同样要过显示投影:发给 native 的是本地化兜底文案,而不是
    // DB 里那个 locale-independent 的英文哨兵(PR #1031 review P1)。此前只有读路径
    // hydrateMeta 做了投影,这条断言正好固化了漏掉的那一半。
    await vi.waitFor(() => expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      title: 'Untitled session',
      projectName: null,
    }));
    // 另一条写路径(metadata patch)同样过投影;权威标题到达后照常原样发布 ——
    // 投影只作用于哨兵,不会把真实标题也顶掉。
    service.handleSessionMetadataPatch('s1', { title: '登录失败排查' });
    await vi.waitFor(() => expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      title: '登录失败排查',
    }));
    service.handleSessionMetadataPatch('s1', { title: 'New Maker' });
    await vi.waitFor(() => expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      title: 'Untitled session',
    }));
    // 切换应用语言后必须**立刻**换语言:投影发生在构建 payload 那一刻,而 state / cache
    // 存的是原始哨兵,所以 refreshLocalization() 的这次 republish 自然带新语言。若把投影
    // 固化进 state,这里会一直停在上一语言,直到下一次 metadata 事件(PR #1031 review P1)。
    {
      const { setMainLocale } = await import('../../i18n.js');
      setMainLocale('zh-CN');
      service.refreshLocalization();
      await vi.waitFor(() => expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
        title: '未命名任务',
      }));
      setMainLocale('en');
      service.refreshLocalization();
      await vi.waitFor(() => expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
        title: 'Untitled session',
      }));
    }
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
      isVisible: () => true,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      moveTop: vi.fn(),
      webContents: { send, isLoading: () => false },
    } as unknown as BrowserWindow;
    setDeepLinkMainWindow(mainWindow);
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

    expect(send).toHaveBeenCalledWith('deep-link:navigate', { type: 'session', id: 'target-session' });
    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({
      mode: 'compact',
      currentSessionId: 'target-session',
    });
  });

  it('collapses a completion before opening a loading window and retains its navigation', async () => {
    const { AgentIslandService } = await import('../service.js');
    const send = vi.fn();
    const mainWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      isVisible: () => false,
      isFocused: () => true,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      moveTop: vi.fn(),
      webContents: { send, isLoading: () => true },
    } as unknown as BrowserWindow;
    setDeepLinkMainWindow(mainWindow);
    const publish = vi.fn((_state: AgentIslandDisplayState) => true);
    const service = new AgentIslandService({
      getMainWindow: () => mainWindow,
      nativeHost: { failed: false, publish },
    });
    syncEnabledForTest(service, publish);
    service.registerIpc();
    service.handleUserPrompt({ sessionId: 'completed-session', agentKind: 'codex' }, 'run tests');
    service.handleAgentEvent({ sessionId: 'completed-session', agentKind: 'codex' }, doneEvent());
    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({ mode: 'expanded' });
    const focusSession = (service as unknown as { focusSession(id: string): void }).focusSession.bind(service);

    vi.mocked(mainWindow.show).mockImplementation(() => {
      expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({ mode: 'compact' });
    });
    focusSession('completed-session');
    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({ mode: 'compact' });

    // A loading renderer has no notification listener. The existing deep-link
    // pull-on-mount path must retain the click instead of sending it into the gap.
    expect(send).not.toHaveBeenCalled();
    expect(mainWindow.show).toHaveBeenCalled();
    expect(mainWindow.focus).toHaveBeenCalled();
    // The click on an unread card also carries its click id for disposal on landing.
    expect(takePendingDeepLink()).toEqual({
      type: 'session',
      id: 'completed-session',
      islandEntryId: expect.any(String),
    });
    expect(takePendingDeepLink()).toBeNull();

    service.setAppFocused(true);
    mocks.browserWindowFromWebContents.mockReturnValue(mainWindow);
    await registeredIpcHandler(AGENT_ISLAND_SET_VISIBLE_SESSION_CHANNEL)(
      { sender: {} },
      'completed-session',
    );
    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({ mode: 'compact' });
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

  it('plays the start sound on user prompt without waiting for an isRunning status event', async () => {
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

    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');

    expect(playSound).toHaveBeenCalledWith(customSound('start.wav'));
    expect(publish.mock.calls.at(-1)?.[0].sessions[0]).toMatchObject({
      sessionId: 's1',
      phase: 'running',
    });
  });

  it('keeps the first rollback snapshot when the same clientId is previewed again', async () => {
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
    const meta = { sessionId: 's1', agentKind: 'codex' as const };

    service.handleUserPrompt(meta, 'first preview', { clientId: 'c1' });
    playSound.mockClear();
    service.handleUserPrompt(meta, 'persist preview', { clientId: 'c1' });
    expect(playSound).not.toHaveBeenCalled();
    service.rollbackUserPrompt(meta.sessionId, 'c1');

    expect(publish.mock.calls.at(-1)?.[0].sessions).toEqual([]);
  });

  it('does not rewind another session reveal when rolling back a blocked preview', async () => {
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

    service.handleUserPrompt({ sessionId: 'session-a', agentKind: 'codex' }, 'task a', {
      clientId: 'client-a',
    });
    service.handleUserPrompt({ sessionId: 'session-b', agentKind: 'codex' }, 'task b', {
      clientId: 'client-b',
    });
    service.rollbackUserPrompt('session-a', 'client-a');

    const sessionIds = (publish.mock.calls.at(-1)?.[0].sessions ?? []).map(
      (session) => session.sessionId,
    );
    expect(sessionIds).toContain('session-b');
    expect(sessionIds).not.toContain('session-a');
  });

  it('restores the same session completion reveal after a blocked follow-up preview', async () => {
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
    service.setAppFocused(false);

    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');
    service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, doneEvent());
    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({
      displaySurface: 'completionCard',
      currentSessionId: 's1',
    });

    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'follow up', {
      clientId: 'follow',
    });
    service.rollbackUserPrompt('s1', 'follow');

    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({
      displaySurface: 'completionCard',
      currentSessionId: 's1',
    });
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

  it('uses the same replacement boundary when auto-resume withheld the old error', async () => {
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
        complete: customSound('complete.wav'),
      },
    });
    const meta = { sessionId: 'auto-resume-replacement', agentKind: 'claude-code' as const };
    service.handleUserPrompt(meta, 'first turn');
    service.handleUserPrompt(meta, 'continue automatically', {
      clientId: 'auto-retry-1',
      replacesCurrentTurn: true,
    });
    service.handleUserPromptDispatching(meta.sessionId);
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

  it('keeps a deferred completion running for activity consumers until it is replayed', async () => {
    const { AgentIslandService } = await import('../service.js');
    let deferCompletion = true;
    const publish = vi.fn((state: AgentIslandDisplayState, frameOrFrames: AgentIslandNativeFrame | AgentIslandNativeFrame[]) => {
      void frameOrFrames;
      return state.visible;
    });
    const playSound = vi.fn<(sound: AgentIslandSoundChoice) => boolean>(() => true);
    const onSessionActivityChange = vi.fn();
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish, playSound },
      onSessionActivityChange,
    });
    service.setCompletionDeferResolver(() => deferCompletion);
    syncEnabledForTest(service, publish);
    service.setSoundSettings({
      enabled: true,
      sounds: {
        ...DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds,
        complete: customSound('complete.wav'),
      },
    });

    // An Orca Lead turn that only dispatched Workers ends while their reports are owed.
    service.handleUserPrompt({ sessionId: 'lead', agentKind: 'codex' }, 'split the work');
    service.handleAgentEvent({ sessionId: 'lead', agentKind: 'codex' }, doneEvent());
    playSound.mockClear();

    expect(onSessionActivityChange.mock.calls.at(-1)?.[0]).toEqual([
      expect.objectContaining({ sessionId: 'lead', phase: 'running', attention: false }),
    ]);

    // Still owed: a replay attempt keeps the Lead running.
    service.notifyQueueEmptied('lead');
    expect(playSound).not.toHaveBeenCalled();

    deferCompletion = false;
    service.notifyQueueEmptied('lead');

    expect(playSound).toHaveBeenCalledWith(customSound('complete.wav'));
    expect(onSessionActivityChange.mock.calls.at(-1)?.[0]).toEqual([
      expect.objectContaining({ sessionId: 'lead', phase: 'completed', attention: true }),
    ]);
  });

  it.each([
    [false, 'user'], [true, 'user'], [false, 'scheduler'], [true, 'scheduler'],
  ] as const)('keeps direct IM completions quiet (headless=%s, kind=%s)', async (headless, kind) => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn(() => true);
    const playSound = vi.fn(() => true);
    const onSessionActivityChange = vi.fn();
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, headless, publish, playSound },
      onSessionActivityChange,
    });
    syncEnabledForTest(service, publish);
    service.setSoundSettings({ enabled: true, sounds: {
      ...DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds,
      complete: customSound('complete.wav'),
    } });
    const meta = { sessionId: 'im', agentKind: 'codex' as const };
    const turnOrigin = { kind, surface: 'im' } as const;
    // Both IM runners send directly without the App's handleUserPrompt path.
    service.handleAgentEvent(meta, { type: 'status', data: { isRunning: true }, turnOrigin });
    service.setCompletionDeferResolver(() => true);
    playSound.mockClear();
    service.handleAgentEvent(meta, { type: 'status', data: { isRunning: false, status: 'Done' }, turnOrigin });
    service.handleAgentEvent(meta, { ...doneEvent(), turnOrigin });
    service.notifyQueueEmptied(meta.sessionId);
    expect(playSound).not.toHaveBeenCalled();
    // Quiet completions are removed from the compact activity list, like silent schedules.
    expect(onSessionActivityChange.mock.calls.at(-1)?.[0]).toEqual([]);

    service.setCompletionDeferResolver(() => false);
    service.handleUserPrompt(meta, 'App message');
    service.handleAgentEvent(meta, doneEvent());
    expect(onSessionActivityChange.mock.calls.at(-1)?.[0]).toEqual([
      expect.objectContaining({ sessionId: 'im', phase: 'completed', attention: true }),
    ]);
    // A later IM reply must not erase the earlier unread App reply.
    service.handleAgentEvent(meta, { type: 'status', data: { isRunning: true }, turnOrigin });
    service.handleAgentEvent(meta, { type: 'status', data: { isRunning: false, status: 'Done' }, turnOrigin });
    service.handleAgentEvent(meta, { ...doneEvent(), turnOrigin });
    expect(onSessionActivityChange.mock.calls.at(-1)?.[0]).toEqual([
      expect.objectContaining({ sessionId: 'im', attention: true }),
    ]);
    service.resetRuntimeState();
    syncEnabledForTest(service, publish);
    service.handleAgentEvent(meta, { type: 'status', data: { isRunning: true }, turnOrigin });
    service.handleAgentEvent(meta, {
      type: 'error', data: { message: 'model unavailable' }, turnOrigin,
    });
    expect(onSessionActivityChange.mock.calls.at(-1)?.[0]).toEqual([
      expect.objectContaining({ sessionId: 'im', phase: 'error', attention: true }),
    ]);
    service.handleAgentEvent(meta, { type: 'status', data: { isRunning: true }, turnOrigin });
    service.handleAgentEvent(meta, { ...doneEvent(), turnOrigin });
    expect(onSessionActivityChange.mock.calls.at(-1)?.[0]).toEqual([
      expect.objectContaining({ sessionId: 'im', attention: true }),
    ]);
    // Reading the old result during the IM turn must not resurrect it on completion.
    service.handleAgentEvent(meta, { type: 'status', data: { isRunning: true }, turnOrigin });
    service.handleSessionAttentionCleared(meta.sessionId, 'explicit');
    service.handleAgentEvent(meta, { type: 'status', data: { isRunning: false, status: 'Done' }, turnOrigin });
    service.handleAgentEvent(meta, { ...doneEvent(), turnOrigin });
    expect(onSessionActivityChange.mock.calls.at(-1)?.[0]).toEqual([]);
    service.resetRuntimeState();
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

  it('keeps a silenced run quiet across intermediate agent dones without scheduler completed', async () => {
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

      service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'silent run');
      service.handleScheduleEvent({
        type: 'silenced',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 's1',
      });
      service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, doneEvent());
      expect(playSound).not.toHaveBeenCalledWith(customSound('complete.wav'));
      expect(publish.mock.calls.at(-1)?.[0].displayPolicy).toBe('closed');
      playSound.mockClear();

      // 续 turn / 后台 subagent 完成后再起一轮。没有 scheduler completed，
      // 不能因为中间那次 done 就把静默当成已经收口。
      service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'continued work');
      service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, doneEvent());

      expect(playSound).not.toHaveBeenCalledWith(customSound('complete.wav'));
      const lastState = publish.mock.calls.at(-1)?.[0];
      expect(lastState?.pillSnapshot.unreadCompletedCount).toBe(0);
      expect(lastState?.displayPolicy).toBe('closed');
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

  it.each([false, true])('keeps scheduled completions silent on source and remote devices (oldUnread=%s)', async oldUnread => {
    vi.useFakeTimers();
    const { AgentIslandService } = await import('../service.js');
    const sourcePublish = vi.fn((state: AgentIslandDisplayState) => state.visible);
    const sourceSound = vi.fn(() => true);
    const remotePublish = vi.fn((state: AgentIslandDisplayState) => state.visible);
    const remoteSound = vi.fn(() => true);
    const desktopEvent = vi.fn();
    const source = new AgentIslandService({ getMainWindow: () => null, nativeHost: { failed: false, publish: sourcePublish, playSound: sourceSound }, isCompletionHandledByTeammate: async () => false });
    const remote = new AgentIslandService({ getMainWindow: () => null, nativeHost: { failed: false, publish: remotePublish, playSound: remoteSound } });
    const desktop = new AgentIslandService({ getMainWindow: () => null, nativeHost: { failed: false, publish: () => false }, onDeviceSessionEvent: desktopEvent });
    try {
      syncEnabledForTest(source, sourcePublish);
      syncEnabledForTest(remote, remotePublish);
      for (const service of [source, remote]) service.setSoundSettings({ enabled: true, sounds: { ...DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds, complete: customSound('complete.wav') } });
      mocks.tapWindowBroadcast.mockImplementation((channel, raw) => {
        if (channel !== SESSION_ACTIVITY_CHANNEL) return;
        const p = raw as { sessionId: string; phase: 'running' | 'needs-interaction' | 'completed' | 'error'; compactDetail: string; attention: boolean; completionNotification?: 'pending' | 'teammate' | 'silent' };
        const keep = p.phase === 'running' || p.phase === 'needs-interaction' || p.attention;
        const inputs = keep ? [{ sessionId: p.sessionId, deviceId: 'source', deviceName: 'Source', title: 'Task', workingDir: null, workspaceKind: 'conversation' as const, agentKind: 'cc' as const, phase: p.phase, detail: p.compactDetail, completionNotification: p.completionNotification }] : [];
        remote.setDeviceSessions(inputs);
        desktop.setDeviceSessions(inputs);
      });
      const meta = { sessionId: 'scheduled-silent', agentKind: 'codex' };
      if (oldUnread) {
        source.handleUserPrompt(meta, 'Earlier manual task');
        source.handleAgentEvent(meta, doneEvent());
        await vi.advanceTimersByTimeAsync(2000);
      }
      source.handleScheduleEvent({ type: 'silenced', scheduleId: 'schedule', runId: 'run', sessionId: meta.sessionId });
      source.handleUserPrompt(meta, 'Scheduled check');
      await vi.advanceTimersByTimeAsync(2000);
      sourceSound.mockClear(); remoteSound.mockClear(); desktopEvent.mockClear();
      source.handleAgentEvent(meta, doneEvent());
      source.handleScheduleEvent({ type: 'completed', scheduleId: 'schedule', runId: 'run', sessionId: meta.sessionId, silenced: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(sourceSound).not.toHaveBeenCalled();
      expect(desktopEvent).not.toHaveBeenCalled();
      expect(remoteSound).not.toHaveBeenCalled();
      expect(remotePublish.mock.calls.at(-1)?.[0].pillSnapshot.unreadCompletedCount).toBe(oldUnread ? 1 : 0);

      source.handleUserPrompt(meta, 'Manual follow-up');
      await vi.advanceTimersByTimeAsync(2000);
      source.handleAgentEvent(meta, doneEvent());
      await vi.advanceTimersByTimeAsync(0);
      expect(sourceSound).toHaveBeenCalledWith(customSound('complete.wav'));
      expect(remoteSound).toHaveBeenCalledWith(customSound('complete.wav'));
      expect(desktopEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'done' }));
    } finally {
      source.resetRuntimeState(); remote.resetRuntimeState(); desktop.resetRuntimeState();
      mocks.tapWindowBroadcast.mockReset();
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
    expect(latestNativeFrame(publish)).toMatchObject({ width: 600 });

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

  it('collapses a click-expanded island from the compact-position click', async () => {
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
    const collapse = (
      service as unknown as {
        handleNativeCollapse(): void;
      }
    ).handleNativeCollapse.bind(service);

    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');
    expand();
    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({
      mode: 'expanded',
      displayPolicy: 'manualExpanded',
    });

    collapse();
    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({
      mode: 'compact',
      displaySurface: 'collapsed',
    });
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
      expect(framesById.get(2)).toMatchObject({ width: 600 });
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

  it('does not reuse an identity-less compact width on a multi-display notch screen', async () => {
    mocks.readLayoutPreferences.mockReturnValueOnce(new Map<number, AgentIslandLayoutPreference>([
      [1, { compactContentWidth: 500, centerXRatio: 0.25 }],
    ]));
    const builtInDisplay = {
      id: 1,
      label: 'Built-in Retina Display',
      bounds: { x: 0, y: 0, width: 1728, height: 1117 },
      internal: false,
    };
    const externalDisplay = {
      id: 2,
      label: 'Mi Monitor',
      bounds: { x: 1728, y: 0, width: 1512, height: 982 },
      internal: false,
    };
    mocks.displays.splice(0, mocks.displays.length, builtInDisplay, externalDisplay);

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
      preferredDisplayId: 1,
      screens: [
        {
          displayId: 1,
          frame: builtInDisplay.bounds,
          hasNotch: true,
          notchWidth: 256,
          topBarHeight: 37,
          menuBarHeight: 37,
          safeAreaTop: 37,
          isMain: true,
          signature: 'builtin-notch',
        },
        {
          displayId: 2,
          frame: externalDisplay.bounds,
          hasNotch: false,
          notchWidth: 0,
          topBarHeight: 25,
          menuBarHeight: 25,
          safeAreaTop: 0,
          isMain: false,
          signature: 'external',
        },
      ],
    });

    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');

    const framesById = new Map(latestNativeFrames(publish).map((frame) => [frame.displayId, frame]));
    expect(framesById.get(1)).toMatchObject({ x: 684, width: 360, contentWidth: 320 });
    expect(framesById.get(2)).toMatchObject({ width: 250, contentWidth: 210 });
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
      displayName: 'Built-in Retina Display',
      displayIndex: 1,
      displayInternal: false,
      displayBounds: mocks.primaryDisplay.bounds,
    });
    const framesById = new Map(latestNativeFrames(publish).map((frame) => [frame.displayId, frame]));
    expect(framesById.get(1)).toMatchObject({ width: 540, contentWidth: 500 });
    expect(framesById.get(2)).toMatchObject({ width: 360, contentWidth: 320 });
  });

  it('trusts matching native display ids when vertical frame coordinates differ', async () => {
    const lowerDisplay = {
      id: 1,
      label: 'Mi Monitor',
      bounds: { x: 0, y: 0, width: 1512, height: 982 },
      internal: false,
    };
    const upperDisplay = {
      id: 2,
      label: 'Built-in Retina Display',
      bounds: { x: 0, y: -982, width: 1512, height: 982 },
      internal: true,
    };
    mocks.displays.splice(0, mocks.displays.length, lowerDisplay, upperDisplay);
    mocks.getPrimaryDisplay.mockReturnValue(lowerDisplay);

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
          frame: { x: 0, y: 0, width: 1512, height: 982 },
          hasNotch: false,
          notchWidth: 0,
          topBarHeight: 25,
          menuBarHeight: 25,
          safeAreaTop: 0,
          isMain: true,
          signature: 'lower',
        },
        {
          displayId: 2,
          frame: { x: 0, y: 982, width: 1512, height: 982 },
          hasNotch: true,
          notchWidth: 256,
          topBarHeight: 37,
          menuBarHeight: 37,
          safeAreaTop: 37,
          isMain: false,
          signature: 'upper-notch',
        },
      ],
    });
    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');

    const framesById = new Map(
      latestNativeFrames(publish).map((frame) => [frame.displayId, frame]),
    );
    expect(framesById.get(2)).toMatchObject({ contentWidth: 320 });

    setLayoutPreference({ displayId: 2, compactContentWidth: 500, centerXRatio: 0.5 });
    expect(mocks.writeLayoutPreference).toHaveBeenLastCalledWith(
      2,
      expect.objectContaining({
        compactContentWidth: 500,
        displayName: 'Built-in Retina Display',
      }),
    );
  });

  it('remaps saved layout preferences by display identity when runtime ids change', async () => {
    mocks.readLayoutPreferences.mockReturnValueOnce(new Map<number, AgentIslandLayoutPreference>([
      [1, {
        compactContentWidth: 500,
        displayName: 'Mi Monitor',
        displayIndex: 2,
        displayInternal: false,
        displayBounds: { x: 1728, y: 0, width: 1512, height: 982 },
      }],
    ]));
    const builtInDisplay = {
      id: 1,
      label: 'Built-in Retina Display',
      bounds: { x: 0, y: 0, width: 1728, height: 1117 },
      internal: true,
    };
    const externalDisplay = {
      id: 2,
      label: 'Mi Monitor',
      bounds: { x: 1728, y: 0, width: 1512, height: 982 },
      internal: false,
    };
    mocks.displays.splice(0, mocks.displays.length, builtInDisplay, externalDisplay);

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
      preferredDisplayId: 1,
      screens: [
        {
          displayId: 1,
          frame: builtInDisplay.bounds,
          hasNotch: true,
          notchWidth: 256,
          topBarHeight: 37,
          menuBarHeight: 37,
          safeAreaTop: 37,
          isMain: true,
          signature: 'builtin-notch',
        },
        {
          displayId: 2,
          frame: externalDisplay.bounds,
          hasNotch: false,
          notchWidth: 0,
          topBarHeight: 25,
          menuBarHeight: 25,
          safeAreaTop: 0,
          isMain: false,
          signature: 'external',
        },
      ],
    });

    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');

    const framesById = new Map(latestNativeFrames(publish).map((frame) => [frame.displayId, frame]));
    expect(framesById.get(1)).toMatchObject({ width: 360, contentWidth: 320 });
    expect(framesById.get(2)).toMatchObject({ width: 540, contentWidth: 500 });
    const persisted = mocks.writeLayoutPreferences.mock.calls.at(-1)?.[0] as Map<number, AgentIslandLayoutPreference> | undefined;
    expect(persisted?.get(2)).toEqual(expect.objectContaining({
      compactContentWidth: 500,
      displayName: 'Mi Monitor',
    }));
    expect(persisted?.has(1)).toBe(false);
  });

  it('moves exchanged display preferences as one atomic snapshot', async () => {
    const builtInDisplay = {
      id: 1,
      label: 'Built-in Retina Display',
      bounds: { x: 0, y: 0, width: 1728, height: 1117 },
      internal: false,
    };
    const externalDisplay = {
      id: 2,
      label: 'Mi Monitor',
      bounds: { x: 1728, y: 0, width: 1512, height: 982 },
      internal: false,
    };
    mocks.readLayoutPreferences.mockReturnValueOnce(new Map<number, AgentIslandLayoutPreference>([
      [1, {
        compactContentWidth: 500,
        displayName: 'Mi Monitor',
        displayIndex: 2,
        displayInternal: false,
        displayBounds: externalDisplay.bounds,
      }],
      [2, {
        compactContentWidth: 300,
        displayName: 'Built-in Retina Display',
        displayIndex: 1,
        displayInternal: false,
        displayBounds: builtInDisplay.bounds,
      }],
    ]));
    mocks.displays.splice(0, mocks.displays.length, builtInDisplay, externalDisplay);

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
      preferredDisplayId: 1,
      screens: [
        {
          displayId: 1,
          frame: builtInDisplay.bounds,
          hasNotch: true,
          notchWidth: 256,
          topBarHeight: 37,
          menuBarHeight: 37,
          safeAreaTop: 37,
          isMain: true,
          signature: 'builtin-notch',
        },
        {
          displayId: 2,
          frame: externalDisplay.bounds,
          hasNotch: false,
          notchWidth: 0,
          topBarHeight: 25,
          menuBarHeight: 25,
          safeAreaTop: 0,
          isMain: false,
          signature: 'external',
        },
      ],
    });

    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');

    const framesById = new Map(latestNativeFrames(publish).map((frame) => [frame.displayId, frame]));
    expect(framesById.get(1)).toMatchObject({ width: 360, contentWidth: 320 });
    expect(framesById.get(2)).toMatchObject({ width: 540, contentWidth: 500 });
    expect(mocks.writeLayoutPreferences).toHaveBeenCalledTimes(1);
    const persisted = mocks.writeLayoutPreferences.mock.calls[0]?.[0] as Map<number, AgentIslandLayoutPreference>;
    expect(Array.from(persisted.keys())).toEqual([2, 1]);
    expect(persisted.get(1)).toEqual(expect.objectContaining({
      compactContentWidth: 300,
      displayName: 'Built-in Retina Display',
    }));
    expect(persisted.get(2)).toEqual(expect.objectContaining({
      compactContentWidth: 500,
      displayName: 'Mi Monitor',
    }));
    expect(mocks.writeLayoutPreferences.mock.calls[0]?.[1]).toEqual([]);
  });

  it('preserves a disconnected display preference when its old runtime id is reused', async () => {
    const externalBounds = { x: 1728, y: 0, width: 1512, height: 982 };
    mocks.readLayoutPreferences.mockReturnValueOnce(
      new Map<number, AgentIslandLayoutPreference>([
        [
          1,
          {
            compactContentWidth: 500,
            centerXRatio: 0.25,
            displayName: 'Mi Monitor',
            displayIndex: 2,
            displayInternal: false,
            displayBounds: externalBounds,
          },
        ],
        [
          2,
          {
            compactContentWidth: 300,
            centerXRatio: 0.5,
            displayName: 'Built-in Retina Display',
            displayIndex: 1,
            displayInternal: false,
            displayBounds: mocks.primaryDisplay.bounds,
          },
        ],
      ]),
    );
    mocks.displays.splice(0, mocks.displays.length, mocks.primaryDisplay);

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
    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');

    let persistedCall = mocks.writeLayoutPreferences.mock.calls.at(-1);
    let persisted = persistedCall?.[0] as Map<number, AgentIslandLayoutPreference>;
    expect(persisted.get(1)).toEqual(
      expect.objectContaining({
        compactContentWidth: 300,
        displayName: 'Built-in Retina Display',
      }),
    );
    expect(persistedCall?.[1]).toEqual([
      expect.objectContaining({
        compactContentWidth: 500,
        displayName: 'Mi Monitor',
      }),
    ]);
    expect(latestNativeFrame(publish)).toMatchObject({ displayId: 1, contentWidth: 300 });

    const reconnectedDisplay = {
      id: 2,
      label: 'Mi Monitor',
      bounds: externalBounds,
      internal: false,
    };
    mocks.displays.splice(0, mocks.displays.length, mocks.primaryDisplay, reconnectedDisplay);
    service.handleUserPrompt({ sessionId: 's2', agentKind: 'codex' }, 'run more tests');

    persistedCall = mocks.writeLayoutPreferences.mock.calls.at(-1);
    persisted = persistedCall?.[0] as Map<number, AgentIslandLayoutPreference>;
    expect(persisted.get(1)).toEqual(expect.objectContaining({ compactContentWidth: 300 }));
    expect(persisted.get(2)).toEqual(expect.objectContaining({ compactContentWidth: 500 }));
    expect(persistedCall?.[1]).toEqual([]);
    const framesById = new Map(
      latestNativeFrames(publish).map((frame) => [frame.displayId, frame]),
    );
    expect(framesById.get(1)).toMatchObject({ contentWidth: 300 });
    expect(framesById.get(2)).toMatchObject({ contentWidth: 500 });
  });

  it('restores a detached display preference when the display is connected at startup', async () => {
    const externalDisplay = {
      id: 2,
      label: 'Mi Monitor',
      bounds: { x: 1728, y: 0, width: 1512, height: 982 },
      internal: false,
    };
    mocks.readDetachedLayoutPreferences.mockReturnValueOnce([
      {
        compactContentWidth: 500,
        centerXRatio: 0.25,
        displayName: 'Mi Monitor',
        displayIndex: 3,
        displayInternal: false,
        displayBounds: { x: 1000, y: 0, width: 1512, height: 982 },
      },
    ]);
    mocks.displays.splice(0, mocks.displays.length, mocks.primaryDisplay, externalDisplay);

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
    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');

    const persistedCall = mocks.writeLayoutPreferences.mock.calls.at(-1);
    const persisted = persistedCall?.[0] as Map<number, AgentIslandLayoutPreference>;
    expect(persisted.get(2)).toEqual(
      expect.objectContaining({
        compactContentWidth: 500,
        displayBounds: externalDisplay.bounds,
        displayIndex: 2,
        displayName: 'Mi Monitor',
      }),
    );
    expect(persistedCall?.[1]).toEqual([]);
    const framesById = new Map(
      latestNativeFrames(publish).map((frame) => [frame.displayId, frame]),
    );
    expect(framesById.get(2)).toMatchObject({ contentWidth: 500 });
  });

  it('keeps an ambiguous preference detached when display order and bounds change', async () => {
    const firstExternal = {
      id: 1,
      label: 'Mi Monitor',
      bounds: { x: 0, y: 0, width: 1512, height: 982 },
      internal: false,
    };
    const secondExternal = {
      id: 2,
      label: 'Mi Monitor',
      bounds: { x: 1512, y: 0, width: 1512, height: 982 },
      internal: false,
    };
    mocks.readLayoutPreferences.mockReturnValueOnce(
      new Map<number, AgentIslandLayoutPreference>([
        [
          9,
          {
            compactContentWidth: 500,
            centerXRatio: 0.25,
            displayName: 'Mi Monitor',
            displayIndex: 2,
            displayInternal: false,
            displayBounds: { x: 1728, y: 0, width: 1512, height: 982 },
          },
        ],
      ]),
    );
    mocks.displays.splice(0, mocks.displays.length, firstExternal, secondExternal);
    mocks.getPrimaryDisplay.mockReturnValue(firstExternal);

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
    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');

    const persistedCall = mocks.writeLayoutPreferences.mock.calls.at(-1);
    const persisted = persistedCall?.[0] as Map<number, AgentIslandLayoutPreference>;
    expect(persisted.size).toBe(0);
    expect(persistedCall?.[1]).toEqual([
      expect.objectContaining({
        compactContentWidth: 500,
        displayIndex: 2,
        displayName: 'Mi Monitor',
      }),
    ]);
  });

  it('moves a pending layout write into detached storage when the display disconnects', async () => {
    vi.useFakeTimers();
    try {
      const externalDisplay = {
        id: 2,
        label: 'Mi Monitor',
        bounds: { x: 1728, y: 0, width: 1512, height: 982 },
        internal: false,
      };
      mocks.displays.splice(0, mocks.displays.length, mocks.primaryDisplay, externalDisplay);

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
      setLayoutPreference({ displayId: 2, compactContentWidth: 525, centerXRatio: 0.25 });
      expect(mocks.writeLayoutPreference).not.toHaveBeenCalled();

      mocks.displays.splice(0, mocks.displays.length, mocks.primaryDisplay);
      service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');

      const persistedCall = mocks.writeLayoutPreferences.mock.calls.at(-1);
      const persisted = persistedCall?.[0] as Map<number, AgentIslandLayoutPreference>;
      expect(persisted.has(2)).toBe(false);
      expect(persistedCall?.[1]).toEqual([
        expect.objectContaining({
          compactContentWidth: 525,
          centerXRatio: 0.25,
          displayName: 'Mi Monitor',
        }),
      ]);

      await vi.advanceTimersByTimeAsync(150);
      expect(mocks.writeLayoutPreference).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconciles all connected displays while rendering only the selected display', async () => {
    const builtInDisplay = {
      id: 1,
      label: 'Built-in Retina Display',
      bounds: { x: 0, y: 0, width: 1728, height: 1117 },
      internal: false,
    };
    const externalDisplay = {
      id: 2,
      label: 'Mi Monitor',
      bounds: { x: 1728, y: 0, width: 1512, height: 982 },
      internal: false,
    };
    mocks.readLayoutPreferences.mockReturnValueOnce(
      new Map<number, AgentIslandLayoutPreference>([
        [
          1,
          {
            compactContentWidth: 500,
            displayName: 'Mi Monitor',
            displayIndex: 2,
            displayInternal: false,
            displayBounds: externalDisplay.bounds,
          },
        ],
        [
          2,
          {
            compactContentWidth: 300,
            displayName: 'Built-in Retina Display',
            displayIndex: 1,
            displayInternal: false,
            displayBounds: builtInDisplay.bounds,
          },
        ],
      ]),
    );
    mocks.displays.splice(0, mocks.displays.length, builtInDisplay, externalDisplay);
    mocks.getPrimaryDisplay.mockReturnValue(builtInDisplay);

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
    service.setDisplayTarget({ mode: 'display', displayId: 1 });
    syncEnabledForTest(service, publish);
    service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');

    expect(latestNativeFrames(publish).map((frame) => frame.displayId)).toEqual([1]);
    const persistedCall = mocks.writeLayoutPreferences.mock.calls.at(-1);
    const persisted = persistedCall?.[0] as Map<number, AgentIslandLayoutPreference>;
    expect(persisted.get(1)).toEqual(
      expect.objectContaining({
        compactContentWidth: 300,
        displayName: 'Built-in Retina Display',
      }),
    );
    expect(persisted.get(2)).toEqual(
      expect.objectContaining({
        compactContentWidth: 500,
        displayName: 'Mi Monitor',
      }),
    );
    expect(persistedCall?.[1]).toEqual([]);
  });

  it('persists a pending layout write in the migrated snapshot without a stale single write', async () => {
    vi.useFakeTimers();
    try {
      const externalDisplay = {
        id: 2,
        label: 'Mi Monitor',
        bounds: { x: 1728, y: 0, width: 1512, height: 982 },
        internal: false,
      };
      mocks.displays.splice(0, mocks.displays.length, mocks.primaryDisplay, externalDisplay);

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
      setLayoutPreference({ displayId: 2, compactContentWidth: 500, centerXRatio: 0.25 });
      expect(mocks.writeLayoutPreference).not.toHaveBeenCalled();

      const reenumeratedExternal = { ...externalDisplay, id: 1 };
      const reenumeratedBuiltIn = { ...mocks.primaryDisplay, id: 2 };
      mocks.displays.splice(0, mocks.displays.length, reenumeratedExternal, reenumeratedBuiltIn);
      mocks.getPrimaryDisplay.mockReturnValue(reenumeratedBuiltIn);
      service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');

      const migrated = mocks.writeLayoutPreferences.mock.calls.at(-1)?.[0] as Map<
        number,
        AgentIslandLayoutPreference
      >;
      expect(migrated.get(1)).toEqual(
        expect.objectContaining({
          compactContentWidth: 500,
          displayIndex: 1,
          displayName: 'Mi Monitor',
        }),
      );
      expect(migrated.has(2)).toBe(false);

      await vi.advanceTimersByTimeAsync(150);
      expect(mocks.writeLayoutPreference).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-publishes native frames when a wake refresh keeps the same screen signature', async () => {
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
          forceRefresh?: boolean;
        }): void;
      }
    ).handleNativeScreenMetrics.bind(service);
    const metrics = {
      preferredDisplayId: mocks.primaryDisplay.id,
      screens: [{
        displayId: mocks.primaryDisplay.id,
        frame: mocks.primaryDisplay.bounds,
        hasNotch: false,
        notchWidth: 0,
        topBarHeight: 24,
        menuBarHeight: 24,
        safeAreaTop: 0,
        isMain: true,
        signature: 'primary',
      }],
    };

    publish.mockClear();
    setNativeScreenMetrics(metrics);
    expect(publish).toHaveBeenCalledTimes(1);

    setNativeScreenMetrics(metrics);
    expect(publish).toHaveBeenCalledTimes(1);

    setNativeScreenMetrics({ ...metrics, forceRefresh: true });
    expect(publish).toHaveBeenCalledTimes(2);
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

// 群专线 / 只读历史 / 不可用的伙伴任务没有报错横幅:灵动岛点击落地后由 renderer 请求
// 处置,main 只处置被点的那一张卡(点击时记下的身份),不碰之后出现的新提醒。
describe('AgentIslandService island-entry alert disposal', () => {
  async function setup() {
    const { AgentIslandService } = await import('../service.js');
    const { initAppBadgeService, clearAllSessionAttention } = await import('../../appBadgeService.js');
    clearAllSessionAttention();
    const mainWindow = {
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      isFocused: () => true,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      moveTop: vi.fn(),
      webContents: { send: vi.fn(), isLoading: () => true },
    } as unknown as BrowserWindow;
    setDeepLinkMainWindow(mainWindow);
    const publish = vi.fn((state: AgentIslandDisplayState) => {
      void state;
      return true;
    });
    const service = new AgentIslandService({
      getMainWindow: () => mainWindow,
      nativeHost: { failed: false, publish },
    });
    initAppBadgeService({
      getWindow: () => null,
      onSessionAttentionCleared: (sessionId, intent) => service.handleSessionAttentionCleared(sessionId, intent),
    });
    syncEnabledForTest(service, publish);
    service.registerIpc();
    /** A real island click; returns the click id main put into the deep link (null = none). */
    const click = (sessionId: string): string | null => {
      (service as unknown as { focusSession(id: string): void }).focusSession(sessionId);
      const payload = takePendingDeepLink() as { type: string; id?: string; islandEntryId?: string } | null;
      expect(payload).toMatchObject({ type: 'session', id: sessionId });
      return payload?.islandEntryId ?? null;
    };
    const consume = (sessionId: unknown, entryId: unknown, sender: unknown = mainWindow.webContents) =>
      registeredIpcHandler(AGENT_ISLAND_CONSUME_ENTRY_ALERT_CHANNEL)({ sender }, sessionId, entryId) as {
        ok: true;
        consumed: boolean;
      };
    const shown = () => (publish.mock.calls.at(-1)?.[0]?.sessions ?? []).map((session) => session.sessionId);
    const island = (service as unknown as {
      state: { sessions: Map<string, { phase: string; unread: boolean; pendingInteractionIds: Set<string> }> };
    }).state;
    return { service, click, consume, shown, island, mainWindow };
  }
  const lane = { sessionId: 'lane', agentKind: 'codex' as const };
  const other = { sessionId: 'other-err', agentKind: 'codex' as const };

  it('disposes only the clicked card for that click, once', async () => {
    const { service, click, consume, shown, island } = await setup();
    service.handleAgentEvent(lane, terminalErrorEvent('400 invalid_request_error'));
    service.handleAgentEvent(other, terminalErrorEvent('boom'));
    service.handleUserPrompt({ sessionId: 'done', agentKind: 'codex' }, 'run');
    service.handleAgentEvent({ sessionId: 'done', agentKind: 'codex' }, doneEvent());
    service.handleUserPrompt({ sessionId: 'running', agentKind: 'codex' }, 'run');
    handleInteractionRequestForTest(service, { sessionId: 'ask', agentKind: 'codex' }, {
      kind: 'permission',
      requestId: 'ask-r1',
      toolName: 'Bash',
      input: { command: 'pnpm test' },
    } as InteractionRequest);

    // URL-only entries carry no click id; a guessed one is not a click either.
    expect(consume('lane', '1')).toEqual({ ok: true, consumed: false });
    expect(island.sessions.get('lane')).toMatchObject({ phase: 'error', unread: true });

    const entryId = click('lane');
    expect(entryId).toEqual(expect.any(String));
    expect(consume('lane', entryId)).toEqual({ ok: true, consumed: true });
    expect(island.sessions.has('lane')).toBe(false);
    expect(shown()).not.toContain('lane');
    expect(shown()).toEqual(expect.arrayContaining(['other-err', 'done', 'running', 'ask']));
    expect(island.sessions.get('other-err')).toMatchObject({ phase: 'error', unread: true });
    expect(island.sessions.get('ask')?.pendingInteractionIds.has('ask-r1')).toBe(true);
    // The same click cannot dispose twice; clicking a card that is gone records nothing.
    expect(consume('lane', entryId)).toEqual({ ok: true, consumed: false });
    expect(click('lane')).toBeNull();
    // App badge / pending-alert re-marking the same old error cannot revive the card.
    service.handleSessionAttentionMarked('lane');
    expect(island.sessions.has('lane')).toBe(false);
  });

  it('a newer click on another card supersedes the earlier one, including a later manual visit', async () => {
    const { service, click, consume, island } = await setup();
    service.handleAgentEvent(lane, terminalErrorEvent('lane failure'));
    service.handleAgentEvent(other, terminalErrorEvent('other failure'));
    const laneEntry = click('lane');
    const otherEntry = click('other-err');
    // The unavailable page / any late request for A, inside the TTL, after B was clicked.
    expect(consume('lane', laneEntry)).toEqual({ ok: true, consumed: false });
    expect(island.sessions.get('lane')).toMatchObject({ phase: 'error', unread: true });
    // A stale request for A does not cancel B's own disposal.
    expect(consume('other-err', otherEntry)).toEqual({ ok: true, consumed: true });
    expect(island.sessions.get('lane')).toMatchObject({ phase: 'error', unread: true });
  });

  it('two clicks on the same card: a late first request never takes the second click', async () => {
    const { service, click, consume, island } = await setup();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      service.handleAgentEvent(lane, terminalErrorEvent('first failure'));
      const first = click('lane');
      vi.setSystemTime(1_000_500);
      service.handleUserPrompt(lane, 'try again');
      vi.setSystemTime(1_001_000);
      service.handleAgentEvent(lane, terminalErrorEvent('second failure'));
      const second = click('lane');
      expect(first).not.toEqual(second);
      // The first click's navigation lands after the second click was recorded.
      expect(consume('lane', first)).toEqual({ ok: true, consumed: false });
      expect(island.sessions.get('lane')).toMatchObject({ phase: 'error', unread: true });
      expect(consume('lane', second)).toEqual({ ok: true, consumed: true });
      expect(island.sessions.has('lane')).toBe(false);

      // Unchanged card clicked twice: only the latest click disposes it.
      vi.setSystemTime(1_002_000);
      service.handleUserPrompt(lane, 'again');
      service.handleAgentEvent(lane, terminalErrorEvent('third failure'));
      const third = click('lane');
      const fourth = click('lane');
      expect(consume('lane', third)).toEqual({ ok: true, consumed: false });
      expect(consume('lane', fourth)).toEqual({ ok: true, consumed: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a failure that arrived after the click, and alerts on it normally', async () => {
    const { service, click, consume, island } = await setup();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      service.handleAgentEvent(lane, terminalErrorEvent('first failure'));
      const first = click('lane');
      vi.setSystemTime(1_000_500);
      service.handleUserPrompt(lane, 'try again');
      // Still running when the stale click lands: the old card is no longer what it showed.
      expect(consume('lane', first)).toEqual({ ok: true, consumed: false });
      vi.setSystemTime(1_001_000);
      service.handleAgentEvent(lane, terminalErrorEvent('second failure'));
      expect(island.sessions.get('lane')).toMatchObject({ phase: 'error', unread: true });

      const second = click('lane');
      vi.setSystemTime(1_001_500);
      service.handleAgentEvent(lane, terminalErrorEvent('third failure'));
      expect(consume('lane', second)).toEqual({ ok: true, consumed: false });
      expect(island.sessions.get('lane')).toMatchObject({ phase: 'error', unread: true });
    } finally {
      vi.useRealTimers();
    }
  });

  // Review P1:重试在同一毫秒内又落新终态时,毫秒时间戳的身份会撞上,旧点击会误处置
  // 新提醒。卡片身份用无碰撞的活动代数后,新报错卡必须留下。
  it('a same-millisecond terminal after the click never gets consumed by the old click', async () => {
    const { service, click, consume, island } = await setup();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      service.handleAgentEvent(lane, terminalErrorEvent('first failure'));
      const entryId = click('lane');
      // 同一毫秒内重试并再次失败:新的报错卡是新的提醒。
      service.handleUserPrompt(lane, 'try again');
      service.handleAgentEvent(lane, terminalErrorEvent('second failure'));
      expect(consume('lane', entryId)).toEqual({ ok: true, consumed: false });
      expect(island.sessions.get('lane')).toMatchObject({ phase: 'error', unread: true });
    } finally {
      vi.useRealTimers();
    }
  });

  // Review P1 后续:失败 turn 的收尾记账 done 保留同一张错误卡(completeAgentIslandSession
  // 主动 early-return),不得驱逐被点击的那张,否则迟到的处置会失败、卡留着。
  it('a trailing bookkeeping done keeps the clicked error card disposable', async () => {
    const { service, click, consume, island } = await setup();
    service.handleAgentEvent(lane, terminalErrorEvent('boom'));
    const entryId = click('lane');
    // 配对的收尾 done 不换卡(未获准替换报错)。
    service.handleAgentEvent(lane, doneEvent());
    expect(island.sessions.get('lane')).toMatchObject({ phase: 'error', unread: true });
    expect(consume('lane', entryId)).toEqual({ ok: true, consumed: true });
    expect(island.sessions.has('lane')).toBe(false);
  });

  // The read-only history page reports its session as visible; a click on that card
  // must still reach the renderer, whose navigator disposes it on the open target.
  it('delivers the click id even when the target is the visible, focused session', async () => {
    const { service, click, consume, island, mainWindow } = await setup();
    const history = { sessionId: 'history', agentKind: 'codex' as const };
    service.handleAgentEvent(history, terminalErrorEvent('history failure'));
    service.setAppFocused(true);
    mocks.browserWindowFromWebContents.mockReturnValue(mainWindow);
    await registeredIpcHandler(AGENT_ISLAND_SET_VISIBLE_SESSION_CHANNEL)({ sender: mainWindow.webContents }, 'history');
    // Passive visibility never clears an unread error.
    expect(island.sessions.get('history')).toMatchObject({ phase: 'error', unread: true });
    const entryId = click('history');
    expect(entryId).toEqual(expect.any(String));
    expect(consume('history', entryId)).toEqual({ ok: true, consumed: true });
    expect(island.sessions.has('history')).toBe(false);
  });

  // Run the production preload bridge source against the real registered handler, so
  // the renderer → main argument order (sessionId, islandEntryId) cannot drift.
  it('the production preload bridge reaches the handler with this click id', async () => {
    const preloadSource = readFileSync(new URL('../../../preload/preload.ts', import.meta.url), 'utf8');
    const start = preloadSource.indexOf('    consumeEntryAlert: (');
    const end = preloadSource.indexOf('\n', preloadSource.indexOf('AGENT_ISLAND_CONSUME_ENTRY_ALERT_CHANNEL, sessionId', start));
    expect(start).toBeGreaterThan(0);
    const compiled = transpileModule(`const bridge = {${preloadSource.slice(start, end)}};`, {
      compilerOptions: { target: ScriptTarget.ES2022 },
    }).outputText;
    const { service, click, island, mainWindow } = await setup();
    const ipcRenderer = {
      invoke: (channel: string, ...args: unknown[]) =>
        Promise.resolve(registeredIpcHandler(channel)({ sender: mainWindow.webContents }, ...args)),
    };
    const bridge = new Function('ipcRenderer', 'AGENT_ISLAND_CONSUME_ENTRY_ALERT_CHANNEL', `${compiled}; return bridge;`)(
      ipcRenderer,
      AGENT_ISLAND_CONSUME_ENTRY_ALERT_CHANNEL,
    ) as { consumeEntryAlert(sessionId: string, islandEntryId: string): Promise<{ ok: true; consumed: boolean }> };
    service.handleAgentEvent(lane, terminalErrorEvent('lane failure'));
    const entryId = click('lane');
    await expect(bridge.consumeEntryAlert('lane', 'not-this-click')).resolves.toEqual({ ok: true, consumed: false });
    await expect(bridge.consumeEntryAlert('lane', entryId!)).resolves.toEqual({ ok: true, consumed: true });
    expect(island.sessions.has('lane')).toBe(false);
  });

  it('expires an unconsumed click and rejects senders other than the main window', async () => {
    const { service, click, consume, island } = await setup();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(2_000_000);
      service.handleAgentEvent(lane, terminalErrorEvent('boom'));
      const entryId = click('lane');
      expect(consume('lane', entryId, { other: true })).toEqual({ ok: true, consumed: false });
      vi.setSystemTime(2_000_000 + 60_001);
      expect(consume('lane', entryId)).toEqual({ ok: true, consumed: false });
      expect(island.sessions.get('lane')).toMatchObject({ phase: 'error', unread: true });
      expect(() => consume('', entryId)).toThrow();
      expect(() => consume('x'.repeat(129), entryId)).toThrow();
      expect(() => consume('lane', undefined)).toThrow();
      expect(() => consume('lane', 'x'.repeat(33))).toThrow();
      expect(mocks.assertTrustedAppRendererEvent).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('会话关闭原因决定条目去留', () => {
  it('进程关闭保留仍在展示的完成卡片,归档/删除照常硬删', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn(() => true);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });
    syncEnabledForTest(service, publish);
    const sessions = (
      service as unknown as { state: { sessions: Map<string, unknown> } }
    ).state.sessions;

    // 临时会话调度的真实时序:done 之后 runner 的 fire finally 立刻 closeSession。
    // 此刻完成卡片刚弹出来,硬删条目会让它当场消失(用户看到「弹一下就收起」)。
    service.handleAgentEvent({ sessionId: 'ephemeral' }, doneEvent());
    expect(sessions.has('ephemeral')).toBe(true);
    service.handleSessionClosed('ephemeral', { reason: 'process-closed' });
    expect(sessions.has('ephemeral')).toBe(true);

    // 会话被归档 / 删除(默认 reason)语义是「这条记录不该再存在」→ 照常硬删。
    service.handleSessionClosed('ephemeral');
    expect(sessions.has('ephemeral')).toBe(false);
  });

  it('进程关闭时若已无展示需求,条目照常删除', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn(() => true);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
    });
    syncEnabledForTest(service, publish);
    const sessions = (
      service as unknown as { state: { sessions: Map<string, unknown> } }
    ).state.sessions;

    // 只是跑起来、没有任何终态未读 → 进程一关就没有保留价值。
    service.handleUserPrompt({ sessionId: 'plain', agentKind: 'codex' }, 'hi');
    expect(sessions.has('plain')).toBe(true);

    service.handleSessionClosed('plain', { reason: 'process-closed' });
    expect(sessions.has('plain')).toBe(false);
  });

  it('drops unread generation when a session is discarded without leftover attention', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn(() => true);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, headless: true, publish, suspend: () => undefined },
    });
    service.setEnabled(false);
    service.handleUserPrompt({ sessionId: 'gone', agentKind: 'codex' }, 'run tests');
    service.handleAgentEvent({ sessionId: 'gone', agentKind: 'codex' }, doneEvent());
    const generations = (
      service as unknown as { unreadAttentionGenerationBySession: Map<string, number> }
    ).unreadAttentionGenerationBySession;
    expect(generations.has('gone')).toBe(true);

    service.handleSessionClosed('gone');
    expect(generations.has('gone')).toBe(false);
  });

  it('TTL prune 后再 Stop 会清账本并立刻给远端发收尾包', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const { AgentIslandService } = await import('../service.js');
      const { AGENT_ISLAND_UNREAD_TRANSIENT_TTL_MS } = await import('../state.js');
      const publish = vi.fn(() => true);
      const service = new AgentIslandService({
        getMainWindow: () => null,
        nativeHost: { failed: false, headless: true, publish, suspend: () => undefined },
      });
      service.setEnabled(false);
      service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');
      service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, doneEvent());
      await vi.advanceTimersByTimeAsync(AGENT_ISLAND_UNREAD_TRANSIENT_TTL_MS + 50);
      const islandState = (
        service as unknown as { state: { sessions: Map<string, unknown>; remoteUnreadTerminals: Map<string, unknown> } }
      ).state;
      expect(islandState.sessions.has('s1')).toBe(false);
      expect(islandState.remoteUnreadTerminals.has('s1')).toBe(true);

      mocks.tapWindowBroadcast.mockClear();
      service.handleSessionStopped('s1');
      expect(islandState.remoteUnreadTerminals.has('s1')).toBe(false);
      expect(mocks.tapWindowBroadcast).toHaveBeenCalledWith(
        SESSION_ACTIVITY_CHANNEL,
        expect.objectContaining({ sessionId: 's1', attention: false }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('TTL prune 后再 process-close 仍保留远程未读,直到真正 ack', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const { AgentIslandService } = await import('../service.js');
      const { AGENT_ISLAND_UNREAD_TRANSIENT_TTL_MS } = await import('../state.js');
      const publish = vi.fn(() => true);
      const service = new AgentIslandService({
        getMainWindow: () => null,
        nativeHost: { failed: false, headless: true, publish, suspend: () => undefined },
      });
      service.setEnabled(false);
      service.handleUserPrompt({ sessionId: 's1', agentKind: 'codex' }, 'run tests');
      service.handleAgentEvent({ sessionId: 's1', agentKind: 'codex' }, doneEvent());
      await vi.advanceTimersByTimeAsync(AGENT_ISLAND_UNREAD_TRANSIENT_TTL_MS + 50);
      const islandState = (
        service as unknown as { state: { sessions: Map<string, unknown>; remoteUnreadTerminals: Map<string, unknown> } }
      ).state;
      expect(islandState.sessions.has('s1')).toBe(false);
      expect(islandState.remoteUnreadTerminals.has('s1')).toBe(true);

      mocks.tapWindowBroadcast.mockClear();
      service.handleSessionClosed('s1', { reason: 'process-closed' });
      expect(islandState.remoteUnreadTerminals.has('s1')).toBe(true);
      expect(mocks.tapWindowBroadcast).not.toHaveBeenCalledWith(
        SESSION_ACTIVITY_CHANNEL,
        expect.objectContaining({ sessionId: 's1', attention: false }),
      );

      mocks.tapWindowBroadcast.mockClear();
      service.handleSessionAttentionCleared('s1', 'passive');
      expect(islandState.remoteUnreadTerminals.has('s1')).toBe(false);
      expect(mocks.tapWindowBroadcast).toHaveBeenCalledWith(
        SESSION_ACTIVITY_CHANNEL,
        expect.objectContaining({ sessionId: 's1', attention: false }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('ledger-only error 在新一轮 running 被 App badge 镜像后,passive 仍免疫', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { markSessionNeedsAttention, clearAllSessionAttention } = await import('../../appBadgeService.js');
    try {
      const { AgentIslandService } = await import('../service.js');
      const { AGENT_ISLAND_UNREAD_TRANSIENT_TTL_MS } = await import('../state.js');
      const publish = vi.fn(() => true);
      const service = new AgentIslandService({
        getMainWindow: () => null,
        nativeHost: { failed: false, headless: true, publish, suspend: () => undefined },
      });
      service.setEnabled(false);
      service.handleUserPrompt({ sessionId: 's-err', agentKind: 'codex' }, 'run tests');
      service.handleAgentEvent({ sessionId: 's-err', agentKind: 'codex' }, terminalErrorEvent('boom'));
      markSessionNeedsAttention('s-err');
      await vi.advanceTimersByTimeAsync(AGENT_ISLAND_UNREAD_TRANSIENT_TTL_MS + 50);
      const islandState = (
        service as unknown as { state: { sessions: Map<string, { phase: string; unread: boolean }>; remoteUnreadTerminals: Map<string, { phase: string }> } }
      ).state;
      expect(islandState.sessions.has('s-err')).toBe(false);
      expect(islandState.remoteUnreadTerminals.get('s-err')?.phase).toBe('error');

      service.handleUserPrompt({ sessionId: 's-err', agentKind: 'codex' }, 'retry');
      expect(islandState.sessions.get('s-err')?.phase).toBe('running');
      expect(islandState.sessions.get('s-err')?.unread).toBe(true);
      expect(islandState.remoteUnreadTerminals.get('s-err')?.phase).toBe('error');

      mocks.tapWindowBroadcast.mockClear();
      service.handleSessionAttentionCleared('s-err', 'passive');
      expect(islandState.remoteUnreadTerminals.get('s-err')?.phase).toBe('error');
      expect(islandState.sessions.get('s-err')?.unread).toBe(true);
      expect(mocks.tapWindowBroadcast).not.toHaveBeenCalledWith(
        SESSION_ACTIVITY_CHANNEL,
        expect.objectContaining({ sessionId: 's-err', attention: false }),
      );

      mocks.tapWindowBroadcast.mockClear();
      service.handleSessionAttentionCleared('s-err', 'explicit');
      expect(islandState.remoteUnreadTerminals.has('s-err')).toBe(false);
      expect(islandState.sessions.get('s-err')?.unread).toBe(false);
    } finally {
      clearAllSessionAttention();
      vi.useRealTimers();
    }
  });
});

describe('Agent Island device sessions', () => {
  // 有的用例会按 id 把静音索引指到某个任务；失败时也要还原，避免污染后面的用例。
  afterEach(() => {
    mocks.isSessionNotificationsMutedSync.mockReturnValue(false);
  });

  function deviceSession(
    phase: 'running' | 'needs-interaction' | 'completed' | 'error',
    sessionId = 'remote-1',
  ) {
    return {
      sessionId,
      deviceId: 'device-a',
      deviceName: 'Studio Mac',
      title: 'Fix login',
      workingDir: '/Users/me/code/cindy',
      workspaceKind: 'project',
      agentKind: 'codex',
      phase,
      detail: '',
    };
  }

  it('stays silent for first-seen remote tasks and sounds on observed completion', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn(() => true);
    const playSound = vi.fn<(sound: AgentIslandSoundChoice) => boolean>(() => true);
    const onDeviceSessionEvent = vi.fn();
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish, playSound },
      onDeviceSessionEvent,
    });
    syncEnabledForTest(service, publish);

    service.setDeviceSessions([deviceSession('running'), deviceSession('completed', 'remote-2')]);
    expect(publish).toHaveBeenCalled();
    expect(playSound).not.toHaveBeenCalled();

    service.setDeviceSessions([deviceSession('completed'), deviceSession('completed', 'remote-2')]);
    expect(playSound).toHaveBeenCalledWith(DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds.complete);
    // 岛面开启时由岛展示,不再另发桌面通知。
    expect(onDeviceSessionEvent).not.toHaveBeenCalled();
    // 不进入本机活动快照,也就不会被 relay 回推给控制端。
    expect(service.getSessionActivitySnapshots()).toEqual([]);
    expect(mocks.tapWindowBroadcast).not.toHaveBeenCalledWith(
      SESSION_ACTIVITY_CHANNEL,
      expect.objectContaining({ sessionId: 'remote-1' }),
    );
  });

  it('本机同 id 任务被静音时不吞掉其它设备投影来的任务', async () => {
    const { AgentIslandService } = await import('../service.js');
    const published: AgentIslandDisplayState[] = [];
    const publish = vi.fn((display: AgentIslandDisplayState) => {
      published.push(display);
      return true;
    });
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish, playSound: () => true },
    });
    syncEnabledForTest(service, publish);

    // 还原/复制过的库里可能留着同 id 的本地任务行；那一行的静音标记属于另一条任务，
    // 不能压掉其它设备发来的卡片与提示音。
    mocks.isSessionNotificationsMutedSync.mockImplementation((id: string) => id === 'remote-1');
    service.setDeviceSessions([deviceSession('needs-interaction')]);

    expect(published.at(-1)?.sessions.map((session) => session.sessionId)).toEqual(['remote-1']);
  });

  it('keeps first-seen remote tasks silent when they arrive before the island setting syncs', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn(() => true);
    const playSound = vi.fn<(sound: AgentIslandSoundChoice) => boolean>(() => true);
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish, playSound },
    });

    service.setDeviceSessions([deviceSession('running'), deviceSession('completed', 'remote-2')]);
    service.setEnabled(true);
    expect(playSound).not.toHaveBeenCalled();

    service.setDeviceSessions([deviceSession('completed'), deviceSession('completed', 'remote-2')]);
    expect(playSound).toHaveBeenCalledWith(DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds.complete);
  });

  it('registers the remote-session channel on platforms without the native island', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const { initAgentIslandService } = await import('../service.js');
      initAgentIslandService({ getMainWindow: () => null });
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }

    const channels = mocks.ipcHandle.mock.calls.map(([channel]) => channel);
    expect(channels).toContain(AGENT_ISLAND_SET_REMOTE_SESSIONS_CHANNEL);
    // 原生岛面专属的 IPC 仍只在支持的平台注册。
    expect(channels).not.toContain(AGENT_ISLAND_SET_SOUND_SETTINGS_CHANNEL);
  });

  it('keeps the originating device when a remote island card opens its task', async () => {
    const { AgentIslandService } = await import('../service.js');
    setDeepLinkMainWindow(null);
    const service = new AgentIslandService({ getMainWindow: () => null, nativeHost: { failed: false, publish: () => true } });
    service.setDeviceSessions([deviceSession('completed')]);
    (service as unknown as { focusSession(id: string): void }).focusSession('remote-1');
    expect(takePendingDeepLink()).toMatchObject({ type: 'session', id: 'remote-1', deviceId: 'device-a' });
    service.resetRuntimeState();
  });

  it('hands observed transitions to desktop notifications when the island is off', async () => {
    const { AgentIslandService } = await import('../service.js');
    const publish = vi.fn(() => true);
    const onDeviceSessionEvent = vi.fn();
    const service = new AgentIslandService({
      getMainWindow: () => null,
      nativeHost: { failed: false, publish },
      onDeviceSessionEvent,
    });
    service.setEnabled(false);

    service.setDeviceSessions([deviceSession('running')]);
    expect(onDeviceSessionEvent).not.toHaveBeenCalled();

    service.setDeviceSessions([deviceSession('completed')]);
    expect(onDeviceSessionEvent).toHaveBeenCalledTimes(1);
    expect(onDeviceSessionEvent).toHaveBeenCalledWith({
      sessionId: 'remote-1',
      deviceId: 'device-a',
      title: 'Fix login',
      deviceName: 'Studio Mac',
      kind: 'done',
    });
  });
});

it('does not sound or mark attention for internal coordination completion, but surfaces a failure', async () => {
  const { AgentIslandService } = await import('../service.js');
  const publish = vi.fn(() => true);
  const playSound = vi.fn(() => true);
  const service = new AgentIslandService({ getMainWindow: () => null, nativeHost: { failed: false, publish, playSound } });
  syncEnabledForTest(service, publish);
  service.setSoundSettings({ enabled: true, sounds: { ...DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds,
    complete: customSound('complete.wav'), error: customSound('error.wav') } });
  const meta = { sessionId: 'coordination', agentKind: 'codex' as const };
  service.handleAgentEvent(meta, { type: 'status', source: 'codex', data: { isRunning: true } });
  playSound.mockClear();
  service.handleAgentEvent(meta, { ...doneEvent(), agentMeta: { botTaskCoordination: true, botPrivateReply: false } });
  expect(playSound).not.toHaveBeenCalled();
  expect(service.getSessionActivitySnapshot(meta.sessionId)?.attention).not.toBe(true);
  service.handleAgentEvent(meta, terminalErrorEvent('User action required'));
  expect(playSound).toHaveBeenCalledWith(customSound('error.wav'));
});
