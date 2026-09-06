import { SHARED_REMOTE_CONTROL_FIXTURE } from '@cindy/maker-shared/fixtures';
import { ApiError, type ApiFetchOptions } from '@/api/client';
import type { DeviceView, LinkAcceptPayload } from '@cindy/device-link';
import type { MobileUser } from '@/auth/AuthContext';
import { MOBILE_VISUAL_MOCK_REALDATA_URL } from '@/config/env';
import type { DeviceLinkContextValue } from '@/device-link/DeviceLinkContext';
import type {
  FileBrowserListAllFilesResult,
  FileBrowserReadFileResult,
  FileBrowserSearchCollectResult,
  FileBrowserThumbnailResult,
  FileBrowserCapsResult,
  MobileMakerTransport,
  RemoteDirectoryListResult,
  RemotePathStatResult,
  RemoteTextFilePreviewResult,
} from '@/device-link/mobileMakerTransport';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type { InputProjection, PendingInteraction, RemoteMessage, RemoteSession } from '@/session/types';

export const VISUAL_MOCK_DEVICE_ID = 'cindy-visual-mock-mac';
export const VISUAL_MOCK_DEVICE_NAME = 'CINDY Visual Mock Mac';
export const VISUAL_MOCK_OFFLINE_DEVICE_ID = 'cindy-visual-mock-offline-mac';
const VISUAL_MOCK_REALDATA_DEVICE_ID = 'cindy-realdata-mac';
const VISUAL_MOCK_REALDATA_DEVICE_NAME = 'CINDY Real Data Mac';
export const VISUAL_MOCK_SESSION_ID = 'session-primary';

interface VisualRealDataSnapshot {
  schema: 'cindy-mobile-visual-realdata-v1';
  device: {
    deviceId: string;
    name: string;
    platform?: string;
    appVersion?: string;
  };
  selectedSessionId: string | null;
  sessions: RemoteSession[];
  messagesBySession: Record<string, RemoteMessage[]>;
  pendingInteractionsBySession?: Record<string, PendingInteraction[]>;
  projectionsBySession?: Record<string, InputProjection>;
}

const NOW = Date.parse('2026-07-18T08:00:00.000Z');
const ISO_NOW = new Date(NOW).toISOString();
const IMAGE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAABaAgMAAABCqLXBAAAADFBMVEX9/f2BgoIgISTY2NXfCK5xAAAACXBIWXMAAAsTAAALEwEAmpwYAAACCklEQVR42uWXsU7DMBBAk1rqgKyy9xM6nVSJoQv9BJaKlbVh4QcQfEIXWMsQiSZFav8Ao0hMGVhY+IRMmTogVebslsah1Hd0QYKrYrXOq+98Pp99QcAW+bUDPrtF9U5gt8q7kGfmgRwlAwGmxW7zLjdvu931v5lqxYCSU2VY6KWkPNgBIxpMFI7ZSknVg3SOIzZjei7tETa9OQ22jJGdPg2GE2wKjh+n+Aw54PAPguFmUWM/6MSP8oKdCrz2gk6gjbygE3l3vwzWN8doJxjWN0y8E2zUwcmeYFIueKrR5IIzmQS/HXHcE2O+CjngSAaZUUmCNmoKBtjPJECbAdqfBzSYyACEbNLgNMiEyYAM0ORpBmjWM8gaDFBIUEGDqVpybASQ1WRe3fx9UXcPHmKgntdgLdGf1B0uXIf7wD5OZrOEHtXmIJEmtdBhBqvI5gSueuIELnsrmC0UscCbarv6wUtmkkp0wQPv9bvhbklwrJfWABLUWkfGgLOtJcS7hxtmCL6l6Uy/bAUFigPOEET3POrSC0ZIoFgDvKo7htC6mK7B3Ufc1IKLMTbKe2jOLLi8wqb0HsPHuhIvqJmgcEHlAQ9dsPSAronf616Dej9QccHyn1y5aDn/ydWVfRlmX6/ZF3ZWCYDHuWQVFXZcVpmCKV7Rhc/AFj6C48esqtrIoktIQYuE1XhAfgL4ANer/BnN/IZTAAAAAElFTkSuQmCC';

export const visualMockUser: MobileUser = {
  id: 'visual-mock-user',
  name: 'Visual Mock User',
  avatar: null,
  email: 'visual-mock@cindy.local',
  defaultModel: 'claude-sonnet-4-6',
  defaultEffort: 'medium',
  membershipKind: 'personal',
  membershipRole: 'owner',
  orgId: null,
  orgName: null,
  orgLogoUrl: null,
  passportId: 'visual-mock-passport',
};

let realDataSnapshot: VisualRealDataSnapshot | null = null;
let realDataLoadPromise: Promise<VisualRealDataSnapshot | null> | null = null;
let didWarnRealDataLoad = false;
const deletedDeviceIds = new Set<string>();
const renamedDevices = new Map<string, string>();

export function visualMockDevices(): DeviceView[] {
  const realData = realDataSnapshot;
  const desktopDevice = realData
    ? {
        deviceId: realData.device.deviceId,
        name: realData.device.name,
        platform: realData.device.platform ?? 'darwin',
        appVersion: realData.device.appVersion ?? '0.0.0-realdata-preview',
      }
    : {
        deviceId: MOBILE_VISUAL_MOCK_REALDATA_URL ? VISUAL_MOCK_REALDATA_DEVICE_ID : VISUAL_MOCK_DEVICE_ID,
        name: MOBILE_VISUAL_MOCK_REALDATA_URL ? VISUAL_MOCK_REALDATA_DEVICE_NAME : VISUAL_MOCK_DEVICE_NAME,
        platform: 'darwin',
        appVersion: MOBILE_VISUAL_MOCK_REALDATA_URL ? '0.0.0-realdata-preview' : '0.0.0-visual-mock',
      };
  return [
    {
      deviceId: 'visual-mock-phone',
      name: 'iPhone 17 Pro',
      platform: 'ios',
      appVersion: '1.0.0',
      lastSeenAt: ISO_NOW,
      online: true,
      busy: false,
      remoteControlEnabled: false,
      isSelf: true,
    },
    {
      deviceId: desktopDevice.deviceId,
      name: desktopDevice.name,
      platform: desktopDevice.platform,
      appVersion: desktopDevice.appVersion,
      lastSeenAt: ISO_NOW,
      online: true,
      busy: false,
      remoteControlEnabled: true,
      isSelf: false,
    },
    {
      deviceId: VISUAL_MOCK_OFFLINE_DEVICE_ID,
      name: 'CINDY Offline Mock Mac',
      platform: 'darwin',
      appVersion: '0.0.0-visual-mock',
      lastSeenAt: ISO_NOW,
      online: false,
      busy: false,
      remoteControlEnabled: false,
      isSelf: false,
    },
  ].filter((device) => !deletedDeviceIds.has(device.deviceId))
    .map((device) => ({ ...device, name: renamedDevices.get(device.deviceId) ?? device.name }));
}

export function seedVisualMockStore(): void {
  const seededRealData = seedRealDataStore(realDataSnapshot);
  if (seededRealData) return;

  const sessions = visualMockSessions();
  remoteSessionStore.setDeviceIdentity(visualMockDevices().map((device) => ({
    deviceId: device.deviceId,
    name: device.name,
  })));
  remoteSessionStore.setDeviceSessions(VISUAL_MOCK_DEVICE_ID, VISUAL_MOCK_DEVICE_NAME, sessions);
  for (const session of sessions) {
    remoteSessionStore.setMessages(session.id, visualMockMessages(session.id));
    remoteSessionStore.setInputProjection(session.id, visualMockProjection(session.id));
    remoteSessionStore.setPendingInteractions(session.id, visualMockPendingInteractions(session.id));
  }
  remoteSessionStore.setActiveSessionSnapshots(VISUAL_MOCK_DEVICE_ID, [
    { sessionId: 'visual-running', isTurnRunning: true },
    { sessionId: 'visual-automation-running', isTurnRunning: true },
  ]);
  void loadVisualRealDataSnapshot().then((snapshot) => {
    seedRealDataStore(snapshot);
  });
}

export function createVisualMockDeviceLinkContext(): DeviceLinkContextValue {
  const realData = realDataSnapshot;
  const deviceId = realData?.device.deviceId
    ?? (MOBILE_VISUAL_MOCK_REALDATA_URL ? VISUAL_MOCK_REALDATA_DEVICE_ID : VISUAL_MOCK_DEVICE_ID);
  const deviceName = realData?.device.name
    ?? (MOBILE_VISUAL_MOCK_REALDATA_URL ? VISUAL_MOCK_REALDATA_DEVICE_NAME : VISUAL_MOCK_DEVICE_NAME);
  return {
    status: 'online',
    connectionIssue: null,
    presenceVersion: 1,
    connectionEpoch: 1,
    getSubscriptionIdentity: () => 1,
    lastPresenceSnapshot: {
      deviceId,
      deviceName,
      platform: realData?.device.platform ?? 'darwin',
      appVersion: realData?.device.appVersion ?? '0.0.0-visual-mock',
      online: true,
      remoteControlEnabled: true,
      busy: false,
      lastSeenAt: NOW,
    },
    getPresenceAvailability: (candidateDeviceId: string) => (
      candidateDeviceId === deviceId ? true : null
    ),
    openLink: async (): Promise<LinkAcceptPayload> => ({
      appVersion: '0.0.0-visual-mock',
      allowlistHash: 'visual-mock',
    }),
    reopenLink: async (): Promise<LinkAcceptPayload> => ({
      appVersion: '0.0.0-visual-mock',
      allowlistHash: 'visual-mock',
    }),
    closeLink: () => undefined,
    invoke: visualMockInvoke,
    subscribe: async () => undefined,
    unsubscribe: async () => undefined,
    onAgentsChanged: () => () => undefined,
  };
}

async function visualMockInvoke<T = unknown>(
  _deviceId: string,
  channel: string,
  args: unknown[] = [],
): Promise<T> {
  const realData = await loadVisualRealDataSnapshot();
  if (realData) {
    switch (channel) {
      case 'local-db:sessions:list':
        return realDataSessions(realData, args[0] as string | undefined) as T;
      case 'local-db:sessions:get':
        return realDataSession(realData, String(args[0] ?? realData.selectedSessionId ?? '')) as T;
      case 'local-db:messages:list':
        return (realData.messagesBySession[String(args[0] ?? realData.selectedSessionId ?? '')] ?? []) as T;
      case 'maker:get-pending-interactions':
        return (realData.pendingInteractionsBySession?.[String(args[0] ?? realData.selectedSessionId ?? '')] ?? []) as T;
      case 'maker:input:get-projection':
        return realDataProjection(realData, String(args[0] ?? realData.selectedSessionId ?? '')) as T;
      case 'maker:list-active':
        return [] as T;
    }
  }
  switch (channel) {
    case 'local-db:sessions:list':
      return visualMockSessions(args[0] as string | undefined) as T;
    case 'local-db:sessions:get':
      return visualMockSession(String(args[0] ?? VISUAL_MOCK_SESSION_ID)) as T;
    case 'local-db:messages:list':
      return visualMockMessages(String(args[0] ?? VISUAL_MOCK_SESSION_ID)) as T;
    case 'maker:get-pending-interactions':
      return visualMockPendingInteractions(String(args[0] ?? VISUAL_MOCK_SESSION_ID)) as T;
    case 'maker:input:get-projection':
      return visualMockProjection(String(args[0] ?? VISUAL_MOCK_SESSION_ID)) as T;
    case 'maker:list-active':
      return [
        { sessionId: 'visual-running', agentKind: 'cc', isTurnRunning: true },
        { sessionId: 'visual-automation-running', agentKind: 'cc', isTurnRunning: true },
      ] as T;
    case 'maker:get-capabilities':
      return visualMockCapabilities() as T;
    case 'maker:provider:list':
      return { providers: [] } as T;
    case 'maker:api-key:present':
      return { present: true } as T;
    case 'maker:usage:model-pricing':
      return {
        'claude-sonnet-4-6': { inputUsdPerMtok: 3, outputUsdPerMtok: 15 },
        'gpt-5.5': { inputUsdPerMtok: 2, outputUsdPerMtok: 10 },
      } as T;
    case 'maker:usage:account':
      return {
        windows: [
          { label: '5h', used: 42, limit: 100 },
          { label: 'weekly', used: 180, limit: 500 },
        ],
      } as T;
    case 'maker:schedule:list':
      return visualMockSchedules() as T;
    case 'maker:schedule:get':
      return (visualMockSchedules().find((item) => item.id === args[0]) ?? visualMockSchedules()[0]) as T;
    case 'maker:schedule:list-runs':
      return visualMockScheduleRuns(String(args[0] ?? 'visual-schedule-1')) as T;
    case 'maker:schedule:list-templates':
      return visualMockScheduleTemplates() as T;
    case 'file-browser:remote-op':
      return handleVisualMockFileBrowser(args[0]) as T;
    case 'fs:list-dir':
      return visualMockDirectory() as T;
    case 'fs:stat-path':
      return { kind: 'dir', resolvedPath: '/repo/xdt-maker' } satisfies RemotePathStatResult as T;
    case 'text-file:read-preview':
      return visualMockTextPreview() as T;
    case 'maker:list-agent-commands':
      return { success: true, commands: [{ kind: 'agent-builtin', name: 'status', description: 'Show status' }] } as T;
    case 'maker:list-agent-skills':
      return { success: true, skills: [{ kind: 'agent-skill', name: 'visual-check', source: 'skill' }] } as T;
    case 'maker:scan-at-resources':
      return { success: true, items: [{ type: 'file', name: 'README.md', relPath: 'README.md' }] } as T;
    case 'maker:goal:get-status':
      return null as T;
    default:
      return {} as T;
  }
}

export async function visualMockApiFetch<T>(path: string, options?: Omit<ApiFetchOptions, 'token'>): Promise<T> {
  await loadVisualRealDataSnapshot();
  if (path === '/api/device-link/devices') return { devices: visualMockDevices() } as T;
  if (path.startsWith('/api/device-link/devices/')) {
    const device = visualMockDevices().find((item) => path === `/api/device-link/devices/${encodeURIComponent(item.deviceId)}`);
    if (!device) throw new ApiError('NOT_FOUND', 404, 'Device not found');
    if (options?.method === 'DELETE') {
      if (device.online) throw new ApiError('ALREADY_EXISTS', 409, 'Device is online');
      deletedDeviceIds.add(device.deviceId);
      renamedDevices.delete(device.deviceId);
      return { deviceId: device.deviceId, deleted: true } as T;
    }
    if (options?.method === 'PATCH') {
      const name = (options.body as { name?: unknown } | undefined)?.name;
      if (typeof name !== 'string' || !name.trim()) throw new ApiError('INVALID_ARGUMENT', 400, 'Device name is required');
      renamedDevices.set(device.deviceId, name.trim());
    }
    return { deviceId: device.deviceId, name: renamedDevices.get(device.deviceId) ?? device.name } as T;
  }
  if (path === '/api/device-link/media/presign-get') return { url: IMAGE_DATA_URL } as T;
  if (path === '/api/device-link/media/presign-put') return { url: IMAGE_DATA_URL, key: 'visual-mock-upload' } as T;
  if (path === '/api/device-link/media') return { url: IMAGE_DATA_URL } as T;
  return {} as T;
}

async function loadVisualRealDataSnapshot(): Promise<VisualRealDataSnapshot | null> {
  if (!MOBILE_VISUAL_MOCK_REALDATA_URL) return null;
  if (realDataSnapshot) return realDataSnapshot;
  if (!realDataLoadPromise) {
    realDataLoadPromise = fetch(MOBILE_VISUAL_MOCK_REALDATA_URL, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return normalizeRealDataSnapshot(await response.json());
      })
      .then((snapshot) => {
        realDataSnapshot = snapshot;
        return snapshot;
      })
      .catch((error) => {
        if (!didWarnRealDataLoad) {
          didWarnRealDataLoad = true;
          console.warn('[visualMock] failed to load real data snapshot', error);
        }
        return null;
      });
  }
  return realDataLoadPromise;
}

function normalizeRealDataSnapshot(raw: unknown): VisualRealDataSnapshot {
  const snapshot = raw as Partial<VisualRealDataSnapshot> | null;
  if (
    !snapshot
    || snapshot.schema !== 'cindy-mobile-visual-realdata-v1'
    || !snapshot.device
    || typeof snapshot.device.deviceId !== 'string'
    || typeof snapshot.device.name !== 'string'
    || !Array.isArray(snapshot.sessions)
    || !snapshot.messagesBySession
  ) {
    throw new Error('invalid real data snapshot');
  }
  return {
    schema: 'cindy-mobile-visual-realdata-v1',
    device: snapshot.device,
    selectedSessionId: typeof snapshot.selectedSessionId === 'string' ? snapshot.selectedSessionId : null,
    sessions: snapshot.sessions,
    messagesBySession: snapshot.messagesBySession,
    pendingInteractionsBySession: snapshot.pendingInteractionsBySession ?? {},
    projectionsBySession: snapshot.projectionsBySession ?? {},
  };
}

function seedRealDataStore(snapshot: VisualRealDataSnapshot | null): boolean {
  if (!snapshot) return false;
  remoteSessionStore.setDeviceIdentity(visualMockDevices().map((device) => ({
    deviceId: device.deviceId,
    name: device.name,
  })));
  remoteSessionStore.setDeviceSessions(snapshot.device.deviceId, snapshot.device.name, snapshot.sessions);
  for (const session of snapshot.sessions) {
    remoteSessionStore.setMessages(session.id, snapshot.messagesBySession[session.id] ?? []);
    remoteSessionStore.setInputProjection(session.id, realDataProjection(snapshot, session.id));
    remoteSessionStore.setPendingInteractions(
      session.id,
      snapshot.pendingInteractionsBySession?.[session.id] ?? [],
    );
  }
  remoteSessionStore.setActiveSessionSnapshots(snapshot.device.deviceId, []);
  return true;
}

function realDataSessions(snapshot: VisualRealDataSnapshot, statusFilter?: string): RemoteSession[] {
  if (statusFilter === 'automation') return snapshot.sessions.filter((session) => session.source === 'scheduler');
  if (statusFilter === 'archived') return snapshot.sessions.filter((session) => session.status === 'archived');
  return snapshot.sessions;
}

function realDataSession(snapshot: VisualRealDataSnapshot, sessionId: string): RemoteSession {
  return snapshot.sessions.find((session) => session.id === sessionId)
    ?? snapshot.sessions.find((session) => session.id === snapshot.selectedSessionId)
    ?? snapshot.sessions[0];
}

function realDataProjection(snapshot: VisualRealDataSnapshot, sessionId: string): InputProjection {
  return snapshot.projectionsBySession?.[sessionId] ?? {
    ...visualMockProjection(sessionId),
    pendingQueue: [],
    queueExpanded: false,
  };
}

function visualMockSessions(statusFilter?: string): RemoteSession[] {
  const sessions = [
    sessionFromShared(SHARED_REMOTE_CONTROL_FIXTURE.sessions.primary, {
      preview: '请检查手机版远程控制的 shared core 迁移。',
      pinnedAt: '2026-07-18T07:59:00.000Z',
    }),
    visualSession('visual-running', 'Visual Running Session', -70_000, {
      userSendAt: new Date(NOW - 8_000).toISOString(),
      preview: '正在从被控电脑持续回传输出。',
    }),
    visualSession('visual-pending', 'Visual Pending Session', -80_000, {
      preview: '等待手机端确认权限后继续。',
    }),
    visualSession('visual-queue', 'Visual Queue Session', -90_000, {
      preview: '队列里还有一条待发送消息。',
    }),
    visualSession('visual-automation-running', '[Schedule] Visual Running Automation', -100_000, {
      source: 'scheduler',
      preview: '自动化任务正在执行。',
    }),
    visualSession('visual-automation-unread', '[Schedule] Visual Unread Automation', -110_000, {
      source: 'scheduler',
      preview: '自动化运行已完成但还没有在手机端标记已读。',
    }),
    sessionFromShared(SHARED_REMOTE_CONTROL_FIXTURE.sessions.orcaLead, {
      preview: 'Lead 正在分配移动端 UI 检查任务。',
    }),
    sessionFromShared(SHARED_REMOTE_CONTROL_FIXTURE.sessions.orcaWorker, {
      preview: 'Worker 正在回传截图证据。',
    }),
  ];
  if (statusFilter === 'automation') return sessions.filter((session) => session.source === 'scheduler');
  if (statusFilter === 'archived') return [];
  return sessions;
}

function visualMockSession(id: string): RemoteSession {
  return visualMockSessions('all').find((session) => session.id === id) ?? visualMockSessions()[0];
}

function sessionFromShared(
  source: typeof SHARED_REMOTE_CONTROL_FIXTURE.sessions.primary,
  patch: Partial<RemoteSession> = {},
): RemoteSession {
  return {
    ...source,
    userId: visualMockUser.id,
    source: source.orcaRole ? 'orca' : 'desktop',
    pinnedAt: null,
    userSendAt: new Date(NOW - 30_000).toISOString(),
    createdAt: new Date(NOW - 300_000).toISOString(),
    updatedAt: new Date(NOW - 20_000).toISOString(),
    _count: { messages: source.id === VISUAL_MOCK_SESSION_ID ? SHARED_REMOTE_CONTROL_FIXTURE.rawMessages.length : 2 },
    ...patch,
  };
}

function visualSession(id: string, title: string, offsetMs: number, patch: Partial<RemoteSession> = {}): RemoteSession {
  const updatedAt = new Date(NOW + offsetMs).toISOString();
  return {
    id,
    userId: visualMockUser.id,
    title,
    workingDir: '/repo/xdt-maker',
    workspaceKind: 'project',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    permissionMode: 'ask',
    fastMode: false,
    status: 'active',
    agentKind: 'cc',
    pinnedAt: null,
    userSendAt: updatedAt,
    createdAt: new Date(NOW - 360_000).toISOString(),
    updatedAt,
    _count: { messages: 2 },
    ...patch,
  };
}

function visualMockMessages(sessionId: string): RemoteMessage[] {
  if (sessionId === VISUAL_MOCK_SESSION_ID) {
    return SHARED_REMOTE_CONTROL_FIXTURE.rawMessages.map((message) => ({
      ...message,
      sessionId,
      role: message.role === 'tool_use' ? 'tool_use' : message.role,
    } as RemoteMessage));
  }
  const title = visualMockSession(sessionId).title;
  const running = sessionId.includes('running');
  return [
    message(sessionId, `${sessionId}-user`, 'user', `Open ${title} on iOS.`, -50_000),
    message(
      sessionId,
      `${sessionId}-assistant`,
      'assistant',
      running
        ? { text: '正在从被控电脑持续回传输出,用于锁定手机 running 状态。', isStreaming: true }
        : `Mock desktop fixture for ${title}.`,
      -30_000,
      running ? { agentMeta: { isStreaming: true } } : {},
    ),
  ];
}

function message(
  sessionId: string,
  clientId: string,
  role: RemoteMessage['role'],
  content: unknown,
  offsetMs: number,
  patch: Partial<RemoteMessage> = {},
): RemoteMessage {
  return {
    id: clientId,
    clientId,
    sessionId,
    role,
    content,
    toolUseId: null,
    agentMeta: null,
    createdAt: new Date(NOW + offsetMs).toISOString(),
    ...patch,
  };
}

function visualMockPendingInteractions(sessionId: string): PendingInteraction[] {
  if (sessionId !== 'visual-pending') return [];
  return [
    {
      request: {
        kind: 'permission',
        requestId: 'visual-permission-1',
        toolName: 'Bash',
        input: { command: 'pnpm --filter mobile test:e2e:visual' },
      },
    },
    {
      request: {
        kind: 'ask_user_question',
        requestId: 'visual-ask-1',
        header: '测试计划',
        questions: [{
          question: 'iOS 视觉回归先覆盖哪一类交互?',
          options: [
            { label: 'Pending 队列', description: '覆盖当前和后续待处理请求。' },
            { label: '消息渲染', description: '覆盖会话内容的展示模型。' },
          ],
        }],
      },
    },
  ];
}

function visualMockProjection(sessionId: string): InputProjection {
  return {
    sessionId,
    pendingQueue: sessionId === 'visual-queue'
      ? [{
          clientId: 'visual-queue-1',
          text: 'Review the visual baseline queue item before sending.',
          persistedContent: 'Review the visual baseline queue item before sending.',
          model: 'claude-sonnet-4-6',
          effort: 'medium',
          permissionMode: 'ask',
          workingDir: '/repo/xdt-maker',
          createOpts: {
            agentKind: 'claude-code',
            workingDir: '/repo/xdt-maker',
            model: 'claude-sonnet-4-6',
            effort: 'medium',
            permissionMode: 'ask',
          },
          chatMessage: {
            clientId: 'visual-queue-1',
            role: 'user',
            content: 'Review the visual baseline queue item before sending.',
            createdAt: ISO_NOW,
          },
        }]
      : [],
    steeringQueueClientIds: [],
    queuePaused: false,
    queueExpanded: sessionId === 'visual-queue',
    queueInteractionLocks: [],
    queueEditLocks: [],
    queueAbortPending: false,
    error: null,
    errorRetryText: null,
    credentialSwitchWait: null,
  };
}

function visualMockCapabilities(): unknown {
  return {
    availableModels: [
      {
        id: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        description: 'Default remote Claude model',
        contextWindow: 200000,
        efforts: ['low', 'medium', 'high', 'xhigh'],
        effortDisplayNames: { xhigh: 'Max' },
        defaultEffort: 'medium',
        supportsFastMode: true,
      },
      {
        id: 'gpt-5.5',
        displayName: 'GPT-5.5',
        contextWindow: 200000,
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
        supportsFastMode: true,
      },
    ],
    hasFastMode: true,
    effortLevels: [
      { id: 'low', displayName: 'Low' },
      { id: 'medium', displayName: 'Medium' },
      { id: 'high', displayName: 'High' },
      { id: 'xhigh', displayName: 'Extra High' },
    ],
    permissionModes: [
      { id: 'ask', displayName: 'Ask' },
      { id: 'acceptEdits', displayName: 'Accept Edits' },
      { id: 'plan', displayName: 'Plan' },
    ],
  };
}

function visualMockSchedules(): ReturnType<MobileMakerTransport['schedule']['list']> extends Promise<infer T> ? T : never {
  return [
    {
      id: 'visual-schedule-1',
      name: 'Visual Baseline Schedule',
      prompt: 'Keep visual fixtures fresh',
      status: 'active',
      recurring: false,
      manual: true,
      agentKind: 'claude-code',
      workspaceKind: 'project',
      workingDir: '/repo/xdt-maker',
      updatedAt: NOW,
      lastFiredAt: NOW - 120000,
      nextFireAt: null,
    },
  ];
}

function visualMockScheduleRuns(_scheduleId: string): ReturnType<MobileMakerTransport['schedule']['listRuns']> extends Promise<infer T> ? T : never {
  return [
    {
      id: 'visual-run-running',
      scheduleId: 'visual-schedule-1',
      sessionId: 'visual-automation-running',
      status: 'running',
      firedAt: NOW - 90000,
    },
    {
      id: 'visual-run-unread',
      scheduleId: 'visual-schedule-1',
      sessionId: 'visual-automation-unread',
      status: 'success',
      firedAt: NOW - 180000,
      finishedAt: NOW - 170000,
      resultText: 'Visual automation completed',
    },
  ];
}

function visualMockScheduleTemplates(): ReturnType<MobileMakerTransport['schedule']['listTemplates']> extends Promise<infer T> ? T : never {
  return [
    {
      id: 'visual-template',
      name: 'Mobile visual check',
      description: 'Run iOS UI parity checks',
      category: 'quality',
      source: 'builtin',
      prompt: 'Check {{target}}',
      cronExpr: '0 10 * * *',
      timezone: 'Asia/Shanghai',
      recurring: true,
      agentKind: 'claude-code',
      parameters: [{ key: 'target', label: 'Target', type: 'string', required: true, default: 'mobile' }],
    },
  ];
}

function handleVisualMockFileBrowser(input: unknown): unknown {
  const op = input && typeof input === 'object' && 'op' in input ? String(input.op) : '';
  if (op === 'caps') return { ok: true, gzip: true } satisfies FileBrowserCapsResult;
  if (op === 'listDir') return visualMockFileBrowserEntries();
  if (op === 'listAllFiles') {
    return {
      files: ['README.md', 'apps/mobile/app/_layout.tsx', 'packages/maker-shared/src/fixtures.ts'],
      truncated: false,
      elapsedMs: 8,
    } satisfies FileBrowserListAllFilesResult;
  }
  if (op === 'readFile') return visualMockReadFile();
  if (op === 'searchCollect') {
    return {
      matches: [
        { relPath: 'README.md', lineNumber: 1, lineText: '# CINDY visual mock fixture' },
        { relPath: 'apps/mobile/app/_layout.tsx', lineNumber: 18, lineText: 'DeviceLinkProvider' },
      ],
      truncated: false,
      totalMatches: 2,
      totalFiles: 3,
    } satisfies FileBrowserSearchCollectResult;
  }
  if (op === 'thumbnail') {
    return {
      ok: true,
      dataBase64: IMAGE_DATA_URL.replace(/^data:image\/png;base64,/, ''),
      mimeType: 'image/webp',
      width: 160,
      height: 90,
      size: 512,
      mtimeMs: NOW,
    } satisfies FileBrowserThumbnailResult;
  }
  return visualMockFileBrowserEntries();
}

function visualMockDirectory(): RemoteDirectoryListResult {
  return {
    resolvedPath: '/repo/xdt-maker',
    parent: '/repo',
    entries: [
      { kind: 'dir', name: 'apps', path: '/repo/xdt-maker/apps' },
      { kind: 'dir', name: 'packages', path: '/repo/xdt-maker/packages' },
      { kind: 'file', name: 'README.md', path: '/repo/xdt-maker/README.md' },
      { kind: 'file', name: 'visual-report.md', path: '/repo/xdt-maker/visual-report.md' },
      { kind: 'file', name: 'demo.mp4', path: '/repo/xdt-maker/demo.mp4' },
    ],
  };
}

function visualMockFileBrowserEntries() {
  return [
    { type: 'directory', name: 'apps', relPath: 'apps', size: 0, mtimeMs: NOW - 1_800_000 },
    { type: 'directory', name: 'packages', relPath: 'packages', size: 0, mtimeMs: NOW - 1_500_000 },
    { type: 'file', name: 'README.md', relPath: 'README.md', size: 4820, mtimeMs: NOW - 900_000 },
    { type: 'file', name: 'visual-report.md', relPath: 'visual-report.md', size: 78, mtimeMs: NOW - 300_000 },
    { type: 'file', name: 'chart.png', relPath: 'chart.png', size: 48_112, mtimeMs: NOW - 240_000 },
    { type: 'file', name: 'demo.mp4', relPath: 'demo.mp4', size: 4_820_000, mtimeMs: NOW - 120_000 },
  ];
}

function visualMockReadFile(): FileBrowserReadFileResult {
  return {
    ok: true,
    data: {
      relPath: 'visual-report.md',
      content: '# Visual mock\n\nThis file preview is served by the mobile dev-only visual mock.',
      size: 78,
      mtimeMs: NOW,
    },
  };
}

function visualMockTextPreview(): RemoteTextFilePreviewResult {
  return { success: true, data: '# Visual mock\n\nPreview text from fixture.', size: 42, limitMb: 5 };
}
