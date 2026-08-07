#!/usr/bin/env node

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const PROTOCOL_VERSION = 1;
const DEFAULT_API_BASE = 'http://localhost:3333';
const DEFAULT_DEVICE_ID = 'mobile-e2e-host';
const DEFAULT_DEVICE_NAME = 'XDMaker Mock Mac';
const DEFAULT_SESSION_ID = 'mock-session-1';
const MOCK_WORKTREE_BRANCHES = ['main', 'feature/mobile-worktree', 'release/mobile'];

// 日志脱敏:session id 可能来自 env / 真实本地 db,只打印首尾预览,不落明文
// (CodeQL js/clear-text-logging)。
function idPreview(value) {
  const s = String(value ?? '');
  if (s.length <= 8) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}
const DEFAULT_REAL_DB_LIMIT = 200;
const MOCK_IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAABaAgMAAABCqLXBAAAADFBMVEX9/f2BgoIgISTY2NXfCK5xAAAACXBIWXMAAAsTAAALEwEAmpwYAAACCklEQVR42uWXsU7DMBBAk1rqgKyy9xM6nVSJoQv9BJaKlbVh4QcQfEIXWMsQiSZFav8Ao0hMGVhY+IRMmTogVebslsah1Hd0QYKrYrXOq+98Pp99QcAW+bUDPrtF9U5gt8q7kGfmgRwlAwGmxW7zLjdvu931v5lqxYCSU2VY6KWkPNgBIxpMFI7ZSknVg3SOIzZjei7tETa9OQ22jJGdPg2GE2wKjh+n+Aw54PAPguFmUWM/6MSP8oKdCrz2gk6gjbygE3l3vwzWN8doJxjWN0y8E2zUwcmeYFIueKrR5IIzmQS/HXHcE2O+CjngSAaZUUmCNmoKBtjPJECbAdqfBzSYyACEbNLgNMiEyYAM0ORpBmjWM8gaDFBIUEGDqVpybASQ1WRe3fx9UXcPHmKgntdgLdGf1B0uXIf7wD5OZrOEHtXmIJEmtdBhBqvI5gSueuIELnsrmC0UscCbarv6wUtmkkp0wQPv9bvhbklwrJfWABLUWkfGgLOtJcS7hxtmCL6l6Uy/bAUFigPOEET3POrSC0ZIoFgDvKo7htC6mK7B3Ufc1IKLMTbKe2jOLLi8wqb0HsPHuhIvqJmgcEHlAQ9dsPSAronf616Dej9QccHyn1y5aDn/ydWVfRlmX6/ZF3ZWCYDHuWQVFXZcVpmCKV7Rhc/AFj6C48esqtrIoktIQYuE1XhAfgL4ANer/BnN/IZTAAAAAElFTkSuQmCC';

const options = parseArgs(process.argv.slice(2));
const apiBase = normalizeBaseUrl(options.apiBase ?? process.env.XDT_MOBILE_E2E_API_BASE_URL ?? DEFAULT_API_BASE);
const deviceLinkApiBase = normalizeBaseUrl(
  options.deviceLinkBase
    ?? process.env.XDT_MOBILE_E2E_DEVICE_LINK_API_BASE_URL
    ?? process.env.EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL
    ?? deriveDeviceLinkApiBase(apiBase),
);
const deviceId = options.deviceId ?? process.env.XDT_MOBILE_E2E_HOST_DEVICE_ID ?? DEFAULT_DEVICE_ID;
const deviceName = options.deviceName ?? process.env.XDT_MOBILE_E2E_HOST_DEVICE_NAME ?? DEFAULT_DEVICE_NAME;
const sessionId = options.sessionId ?? process.env.XDT_MOBILE_E2E_SESSION_ID ?? DEFAULT_SESSION_ID;
const scenario = options.scenario ?? process.env.XDT_MOBILE_E2E_MOCK_SCENARIO ?? 'basic';
const realDbPath = options.realDb ?? process.env.XDT_MOBILE_E2E_REAL_DB_PATH ?? null;
const realDbLimit = parsePositiveInteger(options.realDbLimit ?? process.env.XDT_MOBILE_E2E_REAL_DB_LIMIT, DEFAULT_REAL_DB_LIMIT);
const startedAt = new Date();
const state = realDbPath
  ? createRealDbState({ dbPath: realDbPath, sessionId, deviceId, deviceName, startedAt, limit: realDbLimit })
  : createMockState({ deviceId, sessionId, deviceName, scenario, startedAt });
const mockWorktree = createMockWorktreeState(state);
const controllerTopics = new Map();
const revokedControllers = new Set();
const visualTransitionKeys = new Set();
const debug = process.env.XDT_MOBILE_E2E_DEBUG === '1';

let ws = null;
let stopped = false;
let reconnectTimer = null;

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

if (options.dryRun) {
  console.log('mock-device-link-host dry run');
  console.log(`- api base: ${apiBase}`);
  console.log(`- device-link api base: ${deviceLinkApiBase}`);
  console.log(`- device id: ${deviceId}`);
  console.log(`- device name: ${deviceName}`);
  console.log(`- session id: ${idPreview(state.sessionId ?? sessionId)}`); // lgtm[js/clear-text-logging]
  console.log(`- source: ${realDbPath ? 'real-db' : `mock:${scenario}`}`);
  if (realDbPath) {
    console.log(`- real db: ${state.realDb?.dbPath ?? realDbPath}`);
    console.log(`- real db session preview: ${state.sessions.length}`);
  } else {
    console.log(`- scenario: ${scenario}`);
  }
  process.exit(0);
}

await connectLoop();

async function connectLoop() {
  while (!stopped) {
    try {
      const login = await requestJson(`${apiBase}/api/auth/dev-login`, {
        method: 'POST',
        body: { deviceId },
        timeoutMs: 5_000,
      });
      await openWebSocket(login.accessToken);
      return;
    } catch (err) {
      console.error(`[mock-device-link-host] waiting for server: ${errorMessage(err)}`);
      await sleep(1_000);
    }
  }
}

function openWebSocket(accessToken) {
  return new Promise((resolve, reject) => {
    const wsUrl = `${deviceLinkApiBase.replace(/^http/, 'ws')}/api/device-link/ws`;
    const socket = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    let settled = false;

    socket.on('open', () => {
      ws = socket;
      send({
        v: PROTOCOL_VERSION,
        kind: 'hello',
        payload: {
          deviceName,
          platform: 'darwin',
          appVersion: '0.0.0-mobile-e2e',
          remoteControlEnabled: true,
          busy: false,
        },
      });
    });

    socket.on('message', (raw) => {
      void handleFrame(String(raw));
    });

    socket.on('close', (code) => {
      if (ws === socket) ws = null;
      if (!settled) {
        settled = true;
        reject(new Error(`websocket closed before hello-ack (${code})`));
      }
      if (!stopped) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          void connectLoop();
        }, 1_000);
      }
    });

    socket.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      } else {
        console.error(`[mock-device-link-host] websocket error: ${errorMessage(err)}`);
      }
    });

    function markReady(payload) {
      if (!settled) {
        settled = true;
        console.log(
          [
            'mock-device-link-host ready',
            `deviceId=${payload?.deviceId ?? deviceId}`,
            `sessionId=${idPreview(state.sessionId ?? sessionId)}`,
            realDbPath ? 'source=real-db' : `scenario=${scenario}`,
          ].join(' '),
        );
        resolve();
      }
    }

    socket.__markReady = markReady;
  });
}

async function handleFrame(raw) {
  let env;
  try {
    env = JSON.parse(raw);
  } catch {
    console.error('[mock-device-link-host] dropped non-json frame');
    return;
  }

  if (env.kind === 'hello-ack') {
    ws?.__markReady?.(env.payload);
    return;
  }
  if (env.kind === 'ping') {
    send({ v: PROTOCOL_VERSION, kind: 'pong' });
    return;
  }
  if (env.kind === 'link-open') {
    const controllerId = env.src;
    if (controllerId) controllerTopics.set(controllerId, new Set());
    if (revokedControllers.has(controllerId)) {
      send({
        v: PROTOCOL_VERSION,
        kind: 'link-close',
        id: env.id,
        dst: controllerId,
        payload: { reason: 'revoked' },
      });
      return;
    }
    send({
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: env.id,
      dst: controllerId,
      payload: {
        appVersion: '0.0.0-mobile-e2e',
        allowlistHash: 'mobilee2e',
      },
    });
    return;
  }
  if (env.kind === 'link-close') {
    if (env.src) controllerTopics.delete(env.src);
    return;
  }
  if (env.kind !== 'invoke') return;

  const controllerId = env.src;
  const payload = env.payload ?? {};
  const channel = typeof payload.channel === 'string' ? payload.channel : '';
  const args = Array.isArray(payload.args) ? payload.args : [];
  if (debug) {
    console.error(`[mock-device-link-host] invoke channel=${channel} arg0=${JSON.stringify(args[0])}`);
  }
  try {
    const result = await handleInvoke(controllerId, channel, args);
    sendInvokeResult(controllerId, env.id, { ok: true, result });
  } catch (err) {
    const code = err?.code && typeof err.code === 'string' ? err.code : 'IPC_ERROR';
    sendInvokeResult(controllerId, env.id, {
      ok: false,
      error: {
        code,
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

async function handleInvoke(controllerId, channel, args) {
  if (controllerId && revokedControllers.has(controllerId)) {
    const err = new Error('[ACCESS_REVOKED] visual fixture revoked controller access');
    err.code = 'ACCESS_REVOKED';
    throw err;
  }
  switch (channel) {
    case 'device-link:subscribe':
      trackTopics(controllerId, args[0]?.topics);
      return { ok: true };
    case 'device-link:unsubscribe':
      untrackTopics(controllerId, args[0]?.topics);
      return { ok: true };
    case 'local-db:sessions:list':
      return listSessions(args[1], args[0]);
    case 'local-db:sessions:get': {
      const targetSessionId = String(args[0] ?? sessionId);
      maybeThrowVisualSessionFailure(targetSessionId);
      return getSession(targetSessionId);
    }
    case 'local-db:sessions:patch-meta':
      return patchSession(String(args[0] ?? sessionId), args[1]);
    case 'local-db:messages:list': {
      const targetSessionId = String(args[0] ?? sessionId);
      maybeThrowVisualSessionFailure(targetSessionId);
      return listMessages(targetSessionId, args[1]);
    }
    case 'maker:get-pending-interactions': {
      const targetSessionId = String(args[0] ?? sessionId);
      maybeThrowVisualSessionFailure(targetSessionId);
      const list = state.pendingInteractions.get(targetSessionId) ?? [];
      if (debug) {
        console.error(`[mock-device-link-host] pending sessionId=${idPreview(targetSessionId)} count=${list.length}`); // lgtm[js/clear-text-logging]
      }
      return list;
    }
    case 'maker:resolve-interaction':
      dismissInteraction(String(args[0] ?? ''));
      return undefined;
    case 'maker:input:get-projection': {
      const targetSessionId = String(args[0] ?? sessionId);
      maybeThrowVisualSessionFailure(targetSessionId);
      return projectionFor(targetSessionId);
    }
    case 'maker:input:enqueue':
      return enqueueMessage(controllerId, String(args[0] ?? sessionId), args[1]);
    case 'maker:input:stop':
      return updateProjection(String(args[0] ?? sessionId), { queuePaused: true, queueAbortPending: true });
    case 'maker:input:resume':
      return updateProjection(String(args[0] ?? sessionId), { queuePaused: false, queueAbortPending: false });
    case 'maker:input:retry-last-error':
    case 'maker:input:clear-error':
      return updateProjection(String(args[0] ?? sessionId), { error: null, errorRetryText: null, recovery: null });
    case 'maker:input:remove':
      return removeQueued(String(args[0] ?? sessionId), String(args[1] ?? ''));
    case 'maker:input:update-text':
      return updateQueuedText(String(args[0] ?? sessionId), String(args[1] ?? ''), String(args[2] ?? ''));
    case 'maker:input:move':
    case 'maker:input:set-expanded':
    case 'maker:input:set-interaction-lock':
    case 'maker:input:set-edit-lock':
    case 'maker:input:clear-session':
      return projectionFor(String(args[0] ?? sessionId));
    case 'maker:input:steer':
      await enqueueMessage(controllerId, String(args[0] ?? sessionId), args[1]);
      return true;
    case 'maker:create-session':
      return createSession(args[0]);
    case 'maker:get-capabilities':
      return agentCapabilities(String(args[0] ?? 'claude-code'));
    case 'maker:provider:list':
      return mockProviders();
    case 'maker:get-new-maker-defaults':
      return { worktreeEnabled: mockWorktree.enabled };
    case 'maker:apply-new-maker-worktree-pref':
      return applyMockWorktreePreference(args[0]);
    case 'maker:get-new-maker-worktree-branch-pref':
      return getMockWorktreeBranchPreference(args[0]);
    case 'maker:apply-new-maker-worktree-branch-pref':
      return applyMockWorktreeBranchPreference(args[0]);
    case 'maker:switch-session-agent':
      return registerAgentSwitchIntent(
        String(args[0] ?? sessionId),
        String(args[1] ?? ''),
        String(args[2] ?? ''),
        args[3],
        args[4],
        args[5],
      );
    case 'maker:get-session-agent-switch-intent':
      return agentSwitchIntents().get(String(args[0] ?? sessionId)) ?? null;
    case 'maker:set-model':
      return setSessionModel(String(args[0] ?? sessionId), String(args[1] ?? ''), args[2]);
    case 'maker:set-effort':
      return patchAndBroadcast(String(args[0] ?? sessionId), { effort: String(args[1] ?? '') });
    case 'maker:set-permission-mode':
      return patchAndBroadcast(String(args[0] ?? sessionId), { permissionMode: String(args[1] ?? '') });
    case 'maker:set-fast-mode':
      return patchAndBroadcast(String(args[0] ?? sessionId), { fastMode: args[1] === true });
    case 'maker:set-extra-dirs':
    case 'maker:close-session':
      return undefined;
    case 'maker:get-context-usage':
      return { contextTokens: 12_000, maxContextTokens: 200_000, percent: 0.06 };
    case 'maker:fork':
      return forkSession(String(args[0] ?? sessionId));
    case 'maker:rewind:preview':
      return { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 };
    case 'maker:rewind:commit':
      return getSession(String(args[0] ?? sessionId));
    case 'maker:list-agent-commands':
      return { success: true, commands: [{ kind: 'agent-builtin', name: 'compact', description: 'Compact context' }] };
    case 'maker:list-agent-skills':
      return { success: true, skills: [] };
    case 'maker:scan-at-resources':
      return { success: true, truncated: false, items: [{ type: 'file', name: 'README.md', relPath: 'README.md' }] };
    case 'fs:list-dir':
      return listDir(args[0]?.path);
    case 'fs:stat-path':
      return statPath(args[0]?.path);
    case 'fs:mkdir-p':
      return { resolvedPath: String(args[0]?.path ?? '/tmp') };
    case 'worktree:detect-cwd':
      return detectMockWorktreeCwd(args[0]);
    case 'worktree:list-branches':
      return listMockWorktreeBranches(args[0]);
    case 'worktree:suggest-name':
      return suggestMockWorktreeName(args[0]);
    case 'worktree:create':
      return createMockWorktree(args[0]);
    case 'worktree:discard-precreated':
      return discardMockPrecreatedWorktree(args[0]);
    case 'text-file:read-preview':
      return readTextFilePreview(args[0]?.filePath);
    case 'maker:schedule:list':
      return state.schedules;
    case 'maker:schedule:get':
      return state.schedules.find((item) => item.id === args[0]) ?? null;
    case 'maker:schedule:list-templates':
      return state.templates;
    case 'maker:schedule:create-from-template':
      return createScheduleFromTemplate(args[0]);
    case 'maker:schedule:create':
      return createSchedule(args[0]);
    case 'maker:schedule:update':
      return patchSchedule(String(args[0]), args[1]);
    case 'maker:schedule:list-runs':
      return state.runs.filter((item) => item.scheduleId === args[0]);
    case 'maker:schedule:get-inflight-count':
      return state.runs.filter((item) => item.scheduleId === args[0] && item.status === 'running').length;
    case 'maker:schedule:run-now':
      state.runs.unshift({
        id: `run-${Date.now()}`,
        scheduleId: String(args[0]),
        sessionId,
        status: 'running',
        firedAt: Date.now(),
      });
      return undefined;
    case 'maker:schedule:pause':
      return patchSchedule(String(args[0]), { status: 'paused' });
    case 'maker:schedule:resume':
      return patchSchedule(String(args[0]), { status: 'active' });
    case 'maker:schedule:delete':
      state.schedules = state.schedules.filter((item) => item.id !== args[0]);
      return undefined;
    case 'maker:project-automation:remove-schedule':
      state.schedules = state.schedules.filter((item) => {
        if (item.source !== 'project') return true;
        return item.projectConfigId !== args[0]?.id || item.workingDir !== args[0]?.workingDir;
      });
      return { ok: true };
    case 'maker:schedule:mark-run-read':
      markRunRead(String(args[0]));
      return undefined;
    case 'maker:schedule:mark-schedule-runs-read':
      markScheduleRunsRead(String(args[0]));
      return undefined;
    case 'maker:schedule:delete-run':
      deleteScheduleRun(String(args[0]));
      return undefined;
    case 'device-link:media:fetch':
      return mockMediaFetch(args[0]);
    case 'device-link:voice:transcribe':
      return {
        text: 'mock mobile voice transcript',
        provider: 'litellm-batch',
        model: 'elevenlabs/scribe_v2',
        audioBytes: 4096,
      };
    case 'device-link:voice:credential-sync': {
      // 与 desktop dispatch 语义对齐:穿透 credential 同步已下线,手机语音改走
      // Cindy 官方托管服务;旧手机据此拿到可读错误而不是 CHANNEL_NOT_ALLOWED。
      const err = new Error('手机语音输入已改用 Cindy 官方语音服务,请升级手机版。');
      err.code = 'VOICE_CREDENTIAL_SYNC_REMOVED';
      throw err;
    }
    case 'device-link:voice:dictionary-learning':
      return {
        ok: true,
        actions: [],
        elapsedMs: 0,
        ignoreReason: 'mock-host',
      };
    default: {
      const err = new Error(`[CHANNEL_NOT_ALLOWED] ${channel}`);
      err.code = 'CHANNEL_NOT_ALLOWED';
      throw err;
    }
  }
}

function createMockState({ deviceId, sessionId, deviceName, scenario, startedAt }) {
  if (scenario === 'visual') {
    return createVisualMockState({ deviceId, sessionId, deviceName, startedAt });
  }

  const session = {
    id: sessionId,
    userId: 'dev-local-user',
    title: 'Mobile E2E Mock Session',
    workingDir: '/tmp/xdt-maker-mobile-e2e',
    workspaceKind: 'project',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    permissionMode: 'ask',
    fastMode: false,
    status: 'active',
    agentKind: 'cc',
    pinnedAt: null,
    userSendAt: startedAt.toISOString(),
    createdAt: new Date(startedAt.getTime() - 60_000).toISOString(),
    updatedAt: startedAt.toISOString(),
    _count: { messages: 0 },
  };
  const messages = [
    message(sessionId, 'mock-m1', 'user', 'hello from mock desktop', -50_000),
    message(sessionId, 'mock-m2', 'assistant', `ready from ${deviceName}`, -40_000),
    toolUse(sessionId, 'mock-todo-tool', 'TodoWrite', {
      todos: [
        { content: '确认手机端待处理请求布局', status: 'completed' },
        { content: '检查 Todo 内联列表和三态图标', status: 'in_progress', activeForm: '正在用 iOS Simulator 截图复核。' },
        { content: '补 Android smoke profile', status: 'pending' },
        { content: '建立视觉基线', status: 'pending' },
      ],
    }, -36_000),
    toolUse(sessionId, 'mock-edit-tool', 'Edit', {
      file_path: '/tmp/xdt-maker-mobile-e2e/fixtures/mock-spec.md',
      old_string: 'status: draft',
      new_string: 'status: reviewed',
    }, -32_000),
    toolResult(sessionId, 'mock-edit-result', 'mock-edit-tool', { ok: true }, -31_500),
    toolUse(sessionId, 'mock-video-tool', 'VideoPreview', { file_path: '/tmp/xdt-maker-mobile-e2e/fixtures/demo.mp4' }, -30_000),
    toolResult(sessionId, 'mock-video-result', 'mock-video-tool', {
      xdt_video_url: 'xdt-video://mock-fixtures/demo.mp4',
    }, -29_000),
    toolUse(sessionId, 'mock-audio-tool', 'AudioPreview', { file_path: '/tmp/xdt-maker-mobile-e2e/fixtures/demo.mp3' }, -28_000),
    toolResult(sessionId, 'mock-audio-result', 'mock-audio-tool', {
      _xdt_audio_tracks: [{
        title: 'Mock audio fixture',
        xdt_audio_url: 'xdt-audio://mock-fixtures/demo.mp3',
      }],
    }, -27_000),
    message(sessionId, 'mock-image-message', 'user', JSON.stringify({
      text: 'Mock image fixture',
      images: [{
        name: 'mock-image-fixture.png',
        originalName: 'Mock image fixture',
        mimeType: 'image/png',
        url: MOCK_IMAGE_DATA_URL,
      }],
      files: [{
        name: 'mock-spec.md',
        path: '/tmp/xdt-maker-mobile-e2e/fixtures/mock-spec.md',
        mimeType: 'text/markdown',
      }, {
        name: 'mock-spec.pdf',
        path: '/tmp/xdt-maker-mobile-e2e/fixtures/mock-spec.pdf',
        mimeType: 'application/pdf',
      }, {
        name: 'workflow.drawio',
        path: '/tmp/xdt-maker-mobile-e2e/fixtures/workflow.drawio',
        mimeType: 'application/xml',
      }],
    }), -25_000),
  ];
  if (scenario === 'markdown') {
    messages.push(message(
      sessionId,
      'mock-markdown-structure',
      'assistant',
      [
        '## 移动端检查项',
        '',
        '> 这条消息用于验证标题、引用和任务列表在手机端的可读性。',
        '',
        '- [x] 保留桌面端消息层级',
        '- [ ] 截图复核移动端展示',
      ].join('\n'),
      -8_000,
    ));
  }
  if (scenario === 'streaming') {
    messages.push(message(
      sessionId,
      'mock-streaming-assistant',
      'assistant',
      { text: '正在整理桌面端的最新输出，先不要复制或 Fork 这条未完成消息。', isStreaming: true },
      -5_000,
      { agentMeta: { isStreaming: true } },
    ));
  }
  session._count = { messages: messages.length };
  const projection = emptyProjection(sessionId);
  const pendingInteractions = new Map();
  if (scenario === 'controls') {
    projection.pendingQueue = [queuedMessage(session, 'mock-queue-1', 'Review the fixture queue item before sending.')];
    projection.queueExpanded = true;
    pendingInteractions.set(sessionId, [
      {
        request: {
          kind: 'permission',
          requestId: 'mock-permission-1',
          toolName: 'Bash',
          input: { command: 'pnpm --filter mobile test' },
          suggestions: [{ destination: 'session', toolName: 'Bash', pattern: 'pnpm --filter mobile *' }],
        },
      },
      {
        request: {
          kind: 'ask_user_question',
          requestId: 'mock-ask-1',
          questions: [{
            header: 'Mock',
            question: 'Continue the mobile fixture?',
            options: [
              { label: 'Continue', description: 'Keep the fixture moving.' },
              { label: 'Pause', description: 'Stop after this step.' },
            ],
          }],
        },
      },
      {
        request: {
          kind: 'plan_review',
          requestId: 'mock-plan-1',
          planFilePath: '/tmp/xdt-maker-mobile-e2e/PLAN.md',
          plan: [
            '# Mobile Fixture Plan',
            '',
            '## Verify queue',
            'Edit and keep the queued item.',
            '',
            '## Resolve interactions',
            'Approve the pending desktop prompts from mobile.',
          ].join('\n'),
        },
      },
    ]);
  }

  return {
    sessions: [session],
    messages: new Map([[sessionId, messages]]),
    pendingInteractions,
    projections: new Map([[sessionId, projection]]),
    schedules: [{
      id: 'mock-schedule-1',
      name: 'Mobile E2E Schedule',
      prompt: 'Run local smoke',
      status: 'active',
      recurring: false,
      manual: true,
      agentKind: 'claude-code',
      workspaceKind: 'project',
      workingDir: session.workingDir,
      updatedAt: startedAt.getTime(),
      lastFiredAt: startedAt.getTime() - 120_000,
      nextFireAt: null,
    }],
    templates: [{
      id: 'mock-daily-report',
      name: 'Mock Daily Report',
      description: 'Create a daily status report from the mock desktop',
      category: 'status-reports',
      source: 'builtin',
      prompt: 'Write a daily report for {{project}}',
      cronExpr: '0 9 * * *',
      timezone: 'Asia/Shanghai',
      recurring: true,
      agentKind: 'claude-code',
      useWorktree: false,
      notify: { desktop: true, feishu: false },
      parameters: [{
        key: 'project',
        label: 'Project',
        type: 'string',
        required: true,
        default: 'XDMaker',
        placeholder: 'Project name',
      }],
    }],
    runs: [{
      id: 'mock-run-1',
      scheduleId: 'mock-schedule-1',
      sessionId,
      status: 'success',
      firedAt: startedAt.getTime() - 120_000,
      finishedAt: startedAt.getTime() - 110_000,
      resultText: 'Mock run completed',
      readAt: undefined,
    }],
  };
}

function createVisualMockState({ deviceId, sessionId, deviceName, startedAt }) {
  const idleSession = visualSession(sessionId, 'Visual Idle Session', startedAt);
  const runningSession = visualSession('visual-running', 'Visual Running Session', startedAt, {
    userSendAt: new Date(startedAt.getTime() - 5_000).toISOString(),
  });
  const pendingSession = visualSession('visual-pending', 'Visual Pending Session', startedAt);
  const askSession = visualSession('visual-ask', 'Visual Ask Session', startedAt);
  const queueSession = visualSession('visual-queue', 'Visual Queue Session', startedAt);
  const offlineSession = visualSession('visual-offline', 'Visual Offline Session', startedAt, {
    updatedAt: new Date(startedAt.getTime() + 3_000).toISOString(),
    userSendAt: new Date(startedAt.getTime() + 3_000).toISOString(),
  });
  const revokedSession = visualSession('visual-revoked', 'Visual Revoked Session', startedAt, {
    updatedAt: new Date(startedAt.getTime() + 2_000).toISOString(),
    userSendAt: new Date(startedAt.getTime() + 2_000).toISOString(),
  });
  const automationRunningSession = visualSession('visual-automation-running', '[Schedule] Visual Running Automation', startedAt, {
    source: 'scheduler',
    updatedAt: new Date(startedAt.getTime() - 90_000).toISOString(),
    userSendAt: new Date(startedAt.getTime() - 90_000).toISOString(),
  });
  const automationUnreadSession = visualSession('visual-automation-unread', '[Schedule] Visual Unread Automation', startedAt, {
    source: 'scheduler',
    updatedAt: new Date(startedAt.getTime() - 180_000).toISOString(),
    userSendAt: new Date(startedAt.getTime() - 180_000).toISOString(),
  });
  const sessions = [
    idleSession,
    runningSession,
    pendingSession,
    queueSession,
    automationRunningSession,
    automationUnreadSession,
    offlineSession,
    revokedSession,
    askSession,
  ];
  promoteVisualSessionForFlow(sessions, deviceId, startedAt);
  const messages = new Map([
    [idleSession.id, [
      message(idleSession.id, 'visual-idle-user', 'user', 'Open the mobile visual baseline.', -55_000),
      message(idleSession.id, 'visual-idle-assistant', 'assistant', `Idle visual baseline from ${deviceName}.`, -45_000),
      toolUse(idleSession.id, 'visual-idle-todo', 'TodoWrite', {
        todos: [
          { content: '锁定 Session idle 状态', status: 'completed' },
          { content: '继续采集 running / pending / queue', status: 'in_progress' },
          { content: '补 offline / revoked 降级截图', status: 'pending' },
        ],
      }, -35_000),
      message(idleSession.id, 'visual-payload-image', 'user', JSON.stringify({
        text: 'Visual payload fixture',
        images: [{
          name: 'visual-payload.png',
          originalName: 'Visual payload fixture',
          mimeType: 'image/png',
          url: MOCK_IMAGE_DATA_URL,
        }],
      }), -25_000),
    ]],
    [runningSession.id, [
      message(runningSession.id, 'visual-running-user', 'user', 'Keep this turn visibly running.', -30_000),
      message(
        runningSession.id,
        'visual-running-assistant',
        'assistant',
        { text: '正在从被控电脑持续回传输出,用于锁定手机 running 状态。', isStreaming: true },
        -5_000,
        { agentMeta: { isStreaming: true } },
      ),
    ]],
    [pendingSession.id, [
      message(pendingSession.id, 'visual-pending-user', 'user', 'Request a mobile approval.', -45_000),
      message(pendingSession.id, 'visual-pending-assistant', 'assistant', '我需要你在手机端确认权限后继续。', -35_000),
    ]],
    [askSession.id, [
      message(askSession.id, 'visual-ask-user', 'user', 'Ask a question on mobile.', -45_000),
      message(askSession.id, 'visual-ask-assistant', 'assistant', '我需要你选择下一步优先覆盖的交互。', -35_000),
    ]],
    [queueSession.id, [
      message(queueSession.id, 'visual-queue-user', 'user', 'Queue this follow-up before sending.', -45_000),
      message(queueSession.id, 'visual-queue-assistant', 'assistant', '队列里还有一条待发送消息。', -35_000),
    ]],
    [automationRunningSession.id, [
      message(automationRunningSession.id, 'visual-automation-running-user', 'user', 'Run the visual baseline automation.', -95_000),
      message(automationRunningSession.id, 'visual-automation-running-assistant', 'assistant', '自动化任务正在执行，手机端需要显示运行态。', -90_000),
    ]],
    [automationUnreadSession.id, [
      message(automationUnreadSession.id, 'visual-automation-unread-user', 'user', 'Finish the visual baseline automation.', -185_000),
      message(automationUnreadSession.id, 'visual-automation-unread-assistant', 'assistant', '自动化运行已完成但还没有在手机端标记已读。', -180_000),
    ]],
    [offlineSession.id, [
      message(offlineSession.id, 'visual-offline-user', 'user', 'Simulate target offline.', -45_000),
      message(offlineSession.id, 'visual-offline-assistant', 'assistant', '打开这个会话后 mock host 会下线。', -35_000),
    ]],
    [revokedSession.id, [
      message(revokedSession.id, 'visual-revoked-user', 'user', 'Simulate access revoked.', -45_000),
      message(revokedSession.id, 'visual-revoked-assistant', 'assistant', '打开这个会话后 mock host 会撤销手机访问。', -35_000),
    ]],
  ]);
  for (const session of sessions) {
    session._count = { messages: messages.get(session.id)?.length ?? 0 };
  }

  const projections = new Map(sessions.map((session) => [session.id, emptyProjection(session.id)]));
  projections.set(queueSession.id, {
    ...emptyProjection(queueSession.id),
    pendingQueue: [queuedMessage(queueSession, 'visual-queue-1', 'Review the visual baseline queue item before sending.')],
    queueExpanded: true,
  });

  const visualAskInteraction = {
    request: {
      kind: 'ask_user_question',
      requestId: 'visual-ask-1',
      questions: [{
        question: 'iOS 视觉回归先覆盖哪一类交互?',
        header: '测试计划',
        options: [
          { label: 'Pending 队列', description: '覆盖当前和后续待处理请求。' },
          { label: '消息渲染', description: '覆盖会话内容的展示模型。' },
        ],
      }],
    },
  };
  const pendingInteractions = new Map([
    [pendingSession.id, [
      {
        request: {
          kind: 'permission',
          requestId: 'visual-permission-1',
          toolName: 'Bash',
          input: { command: 'pnpm --filter mobile test:e2e:visual' },
          suggestions: [{ destination: 'session', toolName: 'Bash', pattern: 'pnpm --filter mobile test:e2e:*' }],
        },
      },
      visualAskInteraction,
      {
        request: {
          kind: 'plan_review',
          requestId: 'visual-plan-1',
          planFilePath: '/tmp/xdt-maker-mobile-visual/mobile-v1-plan.md',
          plan: [
            '# Mobile Remote Control',
            '先把 iOS 端远程控制流程做成稳定、可回归的体验。',
            '',
            '## Shared Core',
            '- 使用桌面端同源的 pending interaction 排序。',
            '- 输出移动端只负责渲染的展示模型。',
            '',
            '## iOS Interaction',
            '- 头部显示当前请求和后续请求。',
            '- 计划、授权、提问都保留桌面端语义。',
            '',
            '## Automation',
            '- 视觉基线覆盖真实手机布局。',
            '- Android 先保持简单护栏，不引入 iOS 专属假设。',
          ].join('\n'),
        },
      },
    ]],
    [askSession.id, [visualAskInteraction]],
  ]);

  return {
    sessions,
    messages,
    pendingInteractions,
    projections,
    schedules: [{
      id: 'visual-schedule-1',
      name: 'Visual Baseline Schedule',
      prompt: 'Keep visual fixtures fresh',
      status: 'active',
      recurring: false,
      manual: true,
      agentKind: 'claude-code',
      workspaceKind: 'project',
      workingDir: idleSession.workingDir,
      updatedAt: startedAt.getTime(),
      lastFiredAt: startedAt.getTime() - 120_000,
      nextFireAt: null,
    }],
    templates: [],
    runs: [
      {
        id: 'visual-run-running',
        scheduleId: 'visual-schedule-1',
        sessionId: automationRunningSession.id,
        status: 'running',
        firedAt: startedAt.getTime() - 90_000,
        finishedAt: undefined,
        resultText: undefined,
        readAt: undefined,
      },
      {
        id: 'visual-run-unread',
        scheduleId: 'visual-schedule-1',
        sessionId: automationUnreadSession.id,
        status: 'success',
        firedAt: startedAt.getTime() - 180_000,
        finishedAt: startedAt.getTime() - 170_000,
        resultText: 'Visual automation completed',
        readAt: undefined,
      },
    ],
  };
}

function createRealDbState({ dbPath, sessionId, deviceId, deviceName, startedAt, limit }) {
  const realDb = createRealDbAdapter({ dbPath, limit });
  const activeSessions = realDb.listSessions('active', limit);
  const sessions = activeSessions.length > 0 ? activeSessions : realDb.listSessions('all', limit);
  const selectedSession = sessions.find((item) => item.id === sessionId) ?? sessions[0] ?? fallbackRealSession(sessionId, startedAt);
  const projections = new Map(sessions.map((session) => [session.id, emptyProjection(session.id)]));
  if (!projections.has(selectedSession.id)) projections.set(selectedSession.id, emptyProjection(selectedSession.id));

  return {
    sessionId: selectedSession.id,
    sessions: sessions.length > 0 ? sessions : [selectedSession],
    messages: new Map(),
    pendingInteractions: new Map(),
    projections,
    schedules: [],
    templates: [],
    runs: [],
    realDb,
    realDbKnownSessionIds: new Set(sessions.map((session) => session.id)),
    sessionPatches: new Map(),
    deviceId,
    deviceName,
  };
}

function createRealDbAdapter({ dbPath, limit }) {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (err) {
    throw new Error(`better-sqlite3 is required for --real-db: ${errorMessage(err)}`);
  }

  const resolvedPath = resolveRealDbPath(dbPath, Database);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`--real-db file does not exist: ${resolvedPath}`);
  }
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) {
    throw new Error(`--real-db must point to a SQLite file: ${resolvedPath}`);
  }

  const db = new Database(resolvedPath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  db.pragma('busy_timeout = 1000');
  db.prepare('select 1 from sessions limit 1').get();
  db.prepare('select 1 from messages limit 1').get();

  return {
    dbPath: resolvedPath,
    listSessions: (statusFilter, requestedLimit) => {
      const { where, params } = realSessionFilter(statusFilter);
      const rows = db.prepare(`
        select
          ${realSessionSelect()}
        from sessions s
        where ${where}
        order by
          case when s.pinned_at is null then 1 else 0 end,
          coalesce(s.user_send_at, s.updated_at, s.created_at) desc,
          s.created_at desc
        limit ?
      `).all(...params, parsePositiveInteger(requestedLimit, limit));
      return rows.map(realSessionRowToCamel);
    },
    getSession: (id) => {
      const row = db.prepare(`
        select
          ${realSessionSelect()}
        from sessions s
        where s.id = ?
        limit 1
      `).get(id);
      return row ? realSessionRowToCamel(row) : null;
    },
    listMessages: (id, opts = {}) => {
      const beforeMs = parseIsoMs(opts?.before);
      const requestedLimit = parsePositiveInteger(opts?.limit, 80);
      const params = beforeMs === null ? [id, requestedLimit] : [id, beforeMs, requestedLimit];
      const beforeClause = beforeMs === null ? '' : 'and created_at < ?';
      const rows = db.prepare(`
        select
          id,
          client_id as clientId,
          session_id as sessionId,
          role,
          content,
          tool_use_id as toolUseId,
          agent_meta as agentMeta,
          created_at as createdAt
        from messages
        where session_id = ?
          and rewind_at is null
          ${beforeClause}
        order by created_at desc, id desc
        limit ?
      `).all(...params);
      return rows.reverse().map(realMessageRowToCamel);
    },
  };
}

function resolveRealDbPath(dbPath, Database) {
  const rawPath = String(dbPath ?? '').trim();
  if (rawPath && rawPath !== 'auto') return path.resolve(rawPath);

  const candidates = listRealDbCandidates();
  const scored = [];
  for (const candidate of candidates) {
    let db = null;
    try {
      db = new Database(candidate, { readonly: true, fileMustExist: true });
      db.pragma('query_only = ON');
      db.pragma('busy_timeout = 500');
      const sessionCount = Number(db.prepare('select count(*) as count from sessions').get()?.count ?? 0);
      const messageCount = Number(db.prepare('select count(*) as count from messages').get()?.count ?? 0);
      if (sessionCount <= 0) continue;
      const stat = fs.statSync(candidate);
      scored.push({ path: candidate, sessionCount, messageCount, mtimeMs: stat.mtimeMs });
    } catch {
      // Ignore unrelated SQLite files or old DBs that do not match the current schema.
    } finally {
      try {
        db?.close();
      } catch {
        // best effort
      }
    }
  }

  scored.sort((a, b) =>
    Number(b.messageCount > 0) - Number(a.messageCount > 0)
    || b.sessionCount - a.sessionCount
    || b.mtimeMs - a.mtimeMs,
  );
  const selected = scored[0]?.path;
  if (!selected) {
    throw new Error('--real-db auto could not find a readable XDMaker SQLite DB with sessions');
  }
  return selected;
}

function listRealDbCandidates() {
  const appSupportDirs = [];
  const home = process.env.HOME;
  if (process.platform === 'darwin' && home) {
    appSupportDirs.push(
      path.join(home, 'Library', 'Application Support', 'xdt-maker'),
      path.join(home, 'Library', 'Application Support', 'xdt-maker-dev'),
      path.join(home, 'Library', 'Application Support', 'xdt-maker-dev-B'),
    );
  }
  const appData = process.env.APPDATA;
  if (process.platform === 'win32' && appData) {
    appSupportDirs.push(
      path.join(appData, 'xdt-maker'),
      path.join(appData, 'xdt-maker-dev'),
      path.join(appData, 'xdt-maker-dev-B'),
    );
  }

  const candidates = [];
  for (const dir of appSupportDirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/^xdt-maker-.+\.db$/.test(entry)) continue;
      candidates.push(path.join(dir, entry));
    }
  }
  return candidates;
}

function realSessionSelect() {
  return `
    s.id as id,
    s.title as title,
    s.working_dir as workingDir,
    s.workspace_kind as workspaceKind,
    s.model as model,
    s.effort as effort,
    s.permission_mode as permissionMode,
    s.status as status,
    s.sdk_session_id as sdkSessionId,
    s.total_token_usage as totalTokenUsage,
    s.total_cost_usd as totalCostUsd,
    s.context_tokens as contextTokens,
    s.context_window as contextWindow,
    s.fast_mode as fastMode,
    s.cleared_at as clearedAt,
    s.pinned_at as pinnedAt,
    s.user_send_at as userSendAt,
    s.agent_kind as agentKind,
    s.source as source,
    s.orca_role as orcaRole,
    s.parent_session_id as parentSessionId,
    s.forked_at_message_id as forkedAtMessageId,
    s.worktree_path as worktreePath,
    s.used_project_context as usedProjectContext,
    s.extra_dirs as extraDirs,
    s.remote_host_id as remoteHostId,
    s.created_at as createdAt,
    s.updated_at as updatedAt,
    (
      select count(*)
      from messages m
      where m.session_id = s.id
        and m.rewind_at is null
    ) as messageCount
  `;
}

function realSessionFilter(statusFilter) {
  if (statusFilter === 'archived') return { where: 's.status = ?', params: ['archived'] };
  if (statusFilter === 'all') return { where: 's.status <> ?', params: ['deleted'] };
  if (statusFilter === 'automation') {
    return { where: 's.status <> ? and s.source = ?', params: ['deleted', 'scheduler'] };
  }
  return { where: 's.status = ?', params: ['active'] };
}

function realSessionRowToCamel(row) {
  const createdAt = msToIso(row.createdAt) ?? new Date().toISOString();
  return {
    id: String(row.id),
    userId: '',
    title: typeof row.title === 'string' && row.title.trim() ? row.title : 'New Maker',
    workingDir: row.workingDir ?? null,
    workspaceKind: row.workspaceKind === 'dialogue' ? 'dialogue' : 'project',
    model: typeof row.model === 'string' ? row.model : 'claude-sonnet-4-6',
    effort: typeof row.effort === 'string' ? row.effort : 'medium',
    permissionMode: typeof row.permissionMode === 'string' ? row.permissionMode : 'ask',
    status: normalizeSessionStatus(row.status),
    sdkSessionId: row.sdkSessionId ?? null,
    totalTokenUsage: numberOrZero(row.totalTokenUsage),
    totalCostUsd: numberOrZero(row.totalCostUsd),
    contextTokens: numberOrZero(row.contextTokens),
    contextWindow: numberOrZero(row.contextWindow),
    fastMode: row.fastMode === 1 || row.fastMode === true,
    clearedAt: msToIso(row.clearedAt),
    pinnedAt: msToIso(row.pinnedAt),
    userSendAt: msToIso(row.userSendAt),
    agentKind: row.agentKind === 'codex' ? 'codex' : 'cc',
    source: normalizeSessionSource(row.source),
    orcaRole: row.orcaRole ?? null,
    parentSessionId: row.parentSessionId ?? null,
    forkedAtMessageId: row.forkedAtMessageId ?? null,
    worktreePath: row.worktreePath ?? null,
    usedProjectContext: row.usedProjectContext === 1 || row.usedProjectContext === true,
    extraDirs: safeParseStringArray(row.extraDirs),
    remoteHostId: row.remoteHostId ?? null,
    createdAt,
    updatedAt: msToIso(row.updatedAt) ?? createdAt,
    _count: { messages: numberOrZero(row.messageCount) },
  };
}

function realMessageRowToCamel(row) {
  return {
    id: String(row.id),
    clientId: String(row.clientId ?? row.id),
    sessionId: String(row.sessionId),
    role: normalizeMessageRole(row.role),
    content: safeJsonParse(row.content, row.content),
    toolUseId: row.toolUseId ?? null,
    agentMeta: row.agentMeta == null ? null : safeJsonParse(row.agentMeta, null),
    createdAt: msToIso(row.createdAt) ?? new Date().toISOString(),
  };
}

function fallbackRealSession(sessionId, startedAt) {
  const nowIso = startedAt.toISOString();
  return {
    id: sessionId,
    userId: '',
    title: 'XDMaker Local DB',
    workingDir: null,
    workspaceKind: 'project',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    permissionMode: 'ask',
    fastMode: false,
    status: 'active',
    agentKind: 'cc',
    source: 'desktop',
    pinnedAt: null,
    userSendAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    _count: { messages: 0 },
  };
}

function promoteVisualSessionForFlow(sessions, hostDeviceId, startedAt) {
  const preferredSessionId = preferredVisualSessionId(hostDeviceId);
  if (!preferredSessionId) return;
  const preferred = sessions.find((session) => session.id === preferredSessionId);
  if (!preferred) return;
  const promotedAt = new Date(startedAt.getTime() + 10_000).toISOString();
  preferred.updatedAt = promotedAt;
  preferred.userSendAt = promotedAt;
}

function preferredVisualSessionId(hostDeviceId) {
  if (hostDeviceId.includes('visual-session-running')) return 'visual-running';
  if (hostDeviceId.includes('visual-session-queue')) return 'visual-queue';
  if (hostDeviceId.includes('visual-session-pending')) return 'visual-pending';
  if (hostDeviceId.includes('visual-session-permission')) return 'visual-pending';
  if (hostDeviceId.includes('visual-session-ask')) return 'visual-ask';
  if (hostDeviceId.includes('visual-session-offline')) return 'visual-offline';
  if (hostDeviceId.includes('visual-session-revoked')) return 'visual-revoked';
  return null;
}

function visualSession(id, title, startedAt, patch = {}) {
  return {
    id,
    userId: 'dev-local-user',
    title,
    workingDir: '/tmp/xdt-maker-mobile-visual',
    workspaceKind: 'project',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    permissionMode: 'ask',
    fastMode: false,
    status: 'active',
    agentKind: 'cc',
    pinnedAt: null,
    userSendAt: startedAt.toISOString(),
    createdAt: new Date(startedAt.getTime() - 120_000).toISOString(),
    updatedAt: startedAt.toISOString(),
    _count: { messages: 0 },
    ...patch,
  };
}

function listSessions(statusFilter, limit) {
  if (state.realDb) {
    const remoteSessions = state.realDb
      .listSessions(statusFilter, limit)
      .map(applySessionPatch);
    for (const session of remoteSessions) state.realDbKnownSessionIds.add(session.id);
    const remoteIds = new Set(remoteSessions.map((session) => session.id));
    const syntheticSessions = state.sessions.filter((item) =>
      !state.realDbKnownSessionIds.has(item.id)
      && !remoteIds.has(item.id)
      && sessionMatchesStatus(item, statusFilter)
    );
    state.sessions = [...remoteSessions, ...syntheticSessions];
    return state.sessions;
  }
  return state.sessions.filter((item) => sessionMatchesStatus(item, statusFilter));
}

function getSession(id) {
  if (state.realDb) {
    const local = state.sessions.find((item) => item.id === id);
    const remote = state.realDb.getSession(id);
    const found = remote ? applySessionPatch(remote) : local;
    if (found) {
      upsertSession(found);
      return found;
    }
  }
  const found = state.sessions.find((item) => item.id === id);
  if (found) return found;
  return state.sessions[0];
}

function patchSession(id, patch) {
  const safePatch = pick(patch, ['title', 'status', 'pinnedAt', 'model', 'effort', 'permissionMode', 'fastMode']);
  return patchAndBroadcast(id, safePatch);
}

function patchAndBroadcast(id, patch) {
  if (state.realDb) {
    const source = state.sessions.find((item) => item.id === id)
      ?? state.realDb.getSession(id)
      ?? state.sessions[0];
    if (!source) return null;
    const existingPatch = state.sessionPatches.get(id) ?? {};
    const updatedAt = new Date().toISOString();
    const nextPatch = { ...existingPatch, ...patch, updatedAt };
    const next = { ...source, ...nextPatch };
    state.sessionPatches.set(id, nextPatch);
    upsertSession(next);
    broadcast('local-db:sessions:patched', { sessionId: id, patch });
    return next;
  }
  const index = state.sessions.findIndex((item) => item.id === id);
  if (index === -1) return state.sessions[0];
  const next = { ...state.sessions[index], ...patch, updatedAt: new Date().toISOString() };
  state.sessions[index] = next;
  broadcast('local-db:sessions:patched', { sessionId: id, patch });
  return next;
}

function listMessages(id, opts = {}) {
  if (state.realDb) {
    const remoteMessages = state.realDb.listMessages(id, opts);
    const localMessages = state.messages.get(id) ?? [];
    if (localMessages.length === 0) return remoteMessages;

    const beforeMs = parseIsoMs(opts?.before);
    const limit = parsePositiveInteger(opts?.limit, 80);
    const merged = [
      ...remoteMessages,
      ...localMessages.filter((item) => beforeMs === null || createdAtMs(item) < beforeMs),
    ].sort((a, b) => createdAtMs(a) - createdAtMs(b));
    return merged.slice(-limit);
  }
  const all = state.messages.get(id) ?? [];
  const before = typeof opts?.before === 'string' ? opts.before : null;
  const limit = Number.isFinite(opts?.limit) ? Math.max(1, Math.floor(opts.limit)) : 80;
  const filtered = before ? all.filter((item) => item.createdAt < before && item.id !== before) : all;
  return filtered.slice(-limit);
}

/**
 * Native E2E does not create real git directories, but the worktree fixture mirrors the
 * Desktop IPC response shapes and ownership transition closely enough to exercise the
 * mobile two-step flow: pre-create a worktree, then claim it with maker:create-session.
 */
function createMockWorktreeState(mockState) {
  const baseRepos = new Set(
    mockState.sessions
      .filter((session) => session.workspaceKind !== 'dialogue')
      .map((session) => typeof session.workingDir === 'string' ? session.workingDir.trim() : '')
      .filter((workingDir) => path.isAbsolute(workingDir)),
  );
  if (baseRepos.size === 0) baseRepos.add('/tmp/xdt-maker-mobile-e2e');
  return {
    baseRepos,
    branches: [...MOCK_WORKTREE_BRANCHES],
    currentBranch: MOCK_WORKTREE_BRANCHES[0],
    enabled: false,
    nameSequence: 0,
    branchPreferenceRevision: new Map(),
    branchPreferences: new Map(),
    bySessionId: new Map(),
  };
}

function mockIpcError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireMockObject(value, description) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw mockIpcError('INVALID_PARAMS', `${description} required`);
  }
  return value;
}

function requireMockString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw mockIpcError('INVALID_PARAMS', `${field} required`);
  }
  return value.trim();
}

function applyMockWorktreePreference(raw) {
  const pref = requireMockObject(raw, 'worktree preference');
  if (typeof pref.worktreeEnabled !== 'boolean') {
    throw mockIpcError('INVALID_PARAMS', 'worktreeEnabled must be boolean');
  }
  mockWorktree.enabled = pref.worktreeEnabled;
  return undefined;
}

function getMockWorktreeBranchPreference(raw) {
  const input = requireMockObject(raw, 'worktree branch preference request');
  const baseRepo = requireMockString(input.baseRepo, 'baseRepo');
  return mockWorktree.branchPreferences.get(path.normalize(baseRepo)) ?? null;
}

function applyMockWorktreeBranchPreference(raw) {
  const input = requireMockObject(raw, 'worktree branch preference request');
  const baseRepo = path.normalize(requireMockString(input.baseRepo, 'baseRepo'));
  const sourceBranch = requireMockString(input.sourceBranch, 'sourceBranch');
  if (!mockWorktree.baseRepos.has(baseRepo)) {
    throw mockIpcError('NOT_GIT_REPO', 'baseRepo is not a known mock git repository');
  }
  if (sourceBranch !== 'HEAD' && !mockWorktree.branches.includes(sourceBranch)) {
    throw mockIpcError('INVALID_PARAMS', 'sourceBranch is not a known mock branch');
  }
  const revision = (mockWorktree.branchPreferenceRevision.get(baseRepo) ?? 0) + 1;
  const snapshot = { baseRepo, sourceBranch, revision };
  mockWorktree.branchPreferenceRevision.set(baseRepo, revision);
  mockWorktree.branchPreferences.set(baseRepo, snapshot);
  broadcast('maker:new-maker-worktree-branch:changed', snapshot);
  return snapshot;
}

function managedWorktreeRepoRoot(cwd) {
  const normalized = path.normalize(cwd);
  const marker = `${path.sep}.cindy-worktrees${path.sep}`;
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex > 0) {
    const inferredBaseRepo = normalized.slice(0, markerIndex);
    if (mockWorktree.baseRepos.has(inferredBaseRepo)) return inferredBaseRepo;
  }
  const candidates = [...mockWorktree.baseRepos]
    .filter((repo) => normalized === repo || normalized.startsWith(`${repo}${path.sep}`))
    .sort((a, b) => b.length - a.length);
  return candidates[0] ?? null;
}

function detectMockWorktreeCwd(raw) {
  const input = requireMockObject(raw, 'worktree detect request');
  const cwd = requireMockString(input.cwd, 'cwd');
  if (!path.isAbsolute(cwd)) {
    return {
      isGitRepo: false,
      isInsideWorktree: false,
      gitInstalled: true,
      supportsRecoveryKeyDiscard: true,
    };
  }
  const repoRoot = managedWorktreeRepoRoot(cwd);
  if (!repoRoot) {
    return {
      isGitRepo: false,
      isInsideWorktree: false,
      gitInstalled: true,
      supportsRecoveryKeyDiscard: true,
    };
  }
  return {
    isGitRepo: true,
    isInsideWorktree: path.normalize(cwd).includes(`${path.sep}.cindy-worktrees${path.sep}`),
    gitInstalled: true,
    currentBranch: mockWorktree.currentBranch,
    repoRoot,
    supportsRecoveryKeyDiscard: true,
  };
}

function listMockWorktreeBranches(raw) {
  const input = requireMockObject(raw, 'worktree branch request');
  const baseRepo = requireMockString(input.baseRepo, 'baseRepo');
  if (!path.isAbsolute(baseRepo)) {
    throw mockIpcError('INVALID_PARAMS', 'baseRepo must be absolute');
  }
  if (!mockWorktree.baseRepos.has(path.normalize(baseRepo))) {
    throw mockIpcError('NOT_GIT_REPO', 'baseRepo is not a known mock git repository');
  }
  return {
    branches: [...mockWorktree.branches],
    current: mockWorktree.currentBranch,
  };
}

function suggestMockWorktreeName(raw) {
  const input = requireMockObject(raw, 'worktree name request');
  requireMockString(input.baseRepo, 'baseRepo');
  mockWorktree.nameSequence += 1;
  return { name: `mobile-e2e-${mockWorktree.nameSequence}` };
}

function createMockWorktree(raw) {
  const input = requireMockObject(raw, 'worktree create request');
  const sessionId = requireMockString(input.sessionId, 'sessionId');
  const baseRepo = requireMockString(input.baseRepo, 'baseRepo');
  const name = requireMockString(input.name, 'name');
  const sourceBranch = requireMockString(input.sourceBranch, 'sourceBranch');
  const recoveryKey = input.recoveryKey === undefined
    ? undefined
    : requireMockString(input.recoveryKey, 'recoveryKey');

  if (!/^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/.test(name) || name.includes('--')) {
    return {
      ok: false,
      error: {
        kind: 'unknown',
        message: 'worktree 名称非法',
        hint: '名称只能包含小写字母、数字和单个连字符，且不超过 20 个字符',
      },
    };
  }
  if (sourceBranch !== 'HEAD' && !mockWorktree.branches.includes(sourceBranch)) {
    return {
      ok: false,
      error: {
        kind: 'unknown',
        message: `源分支 "${sourceBranch}" 不存在`,
        hint: '请刷新分支列表或选择其他源分支',
      },
    };
  }

  const normalizedBaseRepo = path.normalize(baseRepo);
  const meta = {
    sessionId,
    name,
    path: path.join(normalizedBaseRepo, '.cindy-worktrees', name),
    baseRepo: normalizedBaseRepo,
    branch: `xdt/${name}`,
    sourceBranch,
    createdAt: new Date().toISOString(),
    ...(recoveryKey ? { recoveryKey } : {}),
  };
  mockWorktree.baseRepos.add(normalizedBaseRepo);
  mockWorktree.bySessionId.set(sessionId, { meta, claimed: false });
  return { ok: true, meta };
}

function discardMockPrecreatedWorktree(raw) {
  const input = requireMockObject(raw, 'discard pre-created worktree request');
  const sessionId = requireMockString(input.sessionId, 'sessionId');
  const hasPath = input.path !== undefined;
  const hasRecoveryKey = input.recoveryKey !== undefined;
  if (hasPath === hasRecoveryKey) {
    throw mockIpcError(
      'INVALID_PARAMS',
      'discard pre-created worktree requires exactly one recovery locator',
    );
  }

  const record = mockWorktree.bySessionId.get(sessionId);
  if (!record) return { discarded: true };
  if (record.claimed) {
    throw mockIpcError('PRECONDITION_FAILED', '会话已认领该 worktree，拒绝补偿回收');
  }
  if (hasPath && requireMockString(input.path, 'path') !== record.meta.path) {
    throw mockIpcError('PERMISSION_DENIED', '预创建 worktree 路径与登记记录不匹配');
  }
  if (
    hasRecoveryKey
    && requireMockString(input.recoveryKey, 'recoveryKey') !== record.meta.recoveryKey
  ) {
    throw mockIpcError('PERMISSION_DENIED', '预创建 worktree 恢复关联键与登记记录不匹配');
  }
  mockWorktree.bySessionId.delete(sessionId);
  return { discarded: true, branchDeleted: true };
}

async function enqueueMessage(controllerId, id, queued) {
  applyPendingAgentSwitchIntent(id);
  const text = typeof queued?.text === 'string' ? queued.text : 'mobile message';
  const userMessage = message(id, `mock-user-${Date.now()}`, 'user', text, 0);
  const assistantMessage = message(id, `mock-assistant-${Date.now()}`, 'assistant', `Mock desktop received: ${text}`, 300);
  state.messages.set(id, [...(state.messages.get(id) ?? []), userMessage, assistantMessage]);
  patchAndBroadcast(id, { userSendAt: userMessage.createdAt, updatedAt: assistantMessage.createdAt });
  const projection = updateProjection(id, { pendingQueue: [], queuePaused: false, queueAbortPending: false });
  if (controllerId) {
    push(controllerId, 'maker:input:projection', projection);
    push(controllerId, 'local-db:messages:created', { sessionId: id, message: userMessage });
    setTimeout(() => push(controllerId, 'local-db:messages:created', { sessionId: id, message: assistantMessage }), 250);
  }
  return projection;
}

function createSession(opts = {}) {
  // 对齐真实被控端 readCreateSessionOpts:控制端预生成的 id 原样采用(maker-core
  // 对 provided id 幂等),缺省才由 mock 生成——新建会话乐观管线依赖这一契约。
  const id = typeof opts?.id === 'string' && opts.id ? opts.id : `mock-created-${Date.now()}`;
  const workingDir = typeof opts?.workingDir === 'string' ? opts.workingDir : '/tmp/xdt-maker-mobile-e2e';
  const precreatedWorktree = mockWorktree.bySessionId.get(id);
  const claimedWorktree = precreatedWorktree?.meta.path === workingDir
    ? precreatedWorktree
    : null;
  if (claimedWorktree) claimedWorktree.claimed = true;
  const session = {
    ...state.sessions[0],
    id,
    title: 'Mobile Created Mock Session',
    workingDir,
    worktreePath: claimedWorktree?.meta.path ?? null,
    workspaceKind: opts?.workspaceKind === 'dialogue' ? 'dialogue' : 'project',
    model: typeof opts?.model === 'string' ? opts.model : state.sessions[0].model,
    effort: typeof opts?.effort === 'string' ? opts.effort : state.sessions[0].effort,
    permissionMode: typeof opts?.permissionMode === 'string' ? opts.permissionMode : state.sessions[0].permissionMode,
    fastMode: opts?.fastMode === true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userSendAt: null,
    _count: { messages: 0 },
  };
  state.sessions.unshift(session);
  state.messages.set(id, []);
  state.projections.set(id, emptyProjection(id));
  broadcast('local-db:sessions:created', { sessionId: id });
  const agentKind = opts?.agentKind ?? 'claude-code';
  return { sessionId: id, agentKind, workDir: workingDir, capabilities: agentCapabilities(agentKind), usedProjectContext: true };
}

function agentCapabilities(agentKind) {
  if (agentKind === 'codex') {
    return {
      availableModels: [{
        id: 'gpt-5.2-codex',
        displayName: 'GPT-5.2 Codex',
        contextWindow: 400_000,
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
        supportsFastMode: true,
      }],
      hasFastMode: true,
      effortLevels: [
        { id: 'low', displayName: 'Low' },
        { id: 'medium', displayName: 'Medium' },
        { id: 'high', displayName: 'High' },
      ],
      permissionModes: [
        { id: 'ask', displayName: 'Ask' },
        { id: 'acceptEdits', displayName: 'Accept Edits' },
      ],
      supportsSessionAgentSwitch: true,
    };
  }
  return {
    availableModels: [
      {
        id: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        contextWindow: 200_000,
        efforts: ['low', 'medium', 'high', 'xhigh'],
        effortDisplayNames: { xhigh: 'Max' },
        defaultEffort: 'medium',
        supportsFastMode: true,
      },
      {
        id: 'claude-haiku-4-6',
        displayName: 'Claude Haiku 4.6',
        contextWindow: 200_000,
        efforts: [],
        defaultEffort: null,
        supportsFastMode: false,
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
    supportsSessionAgentSwitch: true,
  };
}

function mockProviders() {
  return {
    providers: [
      {
        id: 'anthropic',
        name: 'Anthropic',
        source: 'builtin',
        agents: ['claude-code'],
        auth: { method: 'oauth' },
        routing: {},
        connected: true,
        models: {
          'claude-code': [
            {
              id: 'claude-sonnet-4-6',
              name: 'Claude Sonnet 4.6',
              contextWindow: 200_000,
              efforts: ['low', 'medium', 'high', 'xhigh'],
              defaultEffort: 'medium',
              supportsFastMode: true,
            },
            {
              id: 'claude-haiku-4-6',
              name: 'Claude Haiku 4.6',
              contextWindow: 200_000,
              efforts: [],
              defaultEffort: null,
              supportsFastMode: false,
            },
          ],
        },
      },
      {
        id: 'openai',
        name: 'OpenAI',
        source: 'builtin',
        agents: ['codex'],
        auth: { method: 'oauth' },
        routing: {},
        connected: true,
        models: {
          codex: [{
            id: 'gpt-5.2-codex',
            name: 'GPT-5.2 Codex',
            contextWindow: 400_000,
            efforts: ['low', 'medium', 'high'],
            defaultEffort: 'medium',
            supportsFastMode: true,
          }],
        },
      },
    ],
  };
}

function agentSwitchIntents() {
  state.agentSwitchIntents ??= new Map();
  return state.agentSwitchIntents;
}

function registerAgentSwitchIntent(id, targetAgentKind, model, providerId, effort, fastMode) {
  const current = getSession(id);
  if (!current) throw new Error(`session ${id} not found`);
  const currentAgentKind = current.agentKind === 'codex' ? 'codex' : 'claude-code';
  if (targetAgentKind !== 'claude-code' && targetAgentKind !== 'codex') {
    throw new Error('targetAgentKind must be claude-code | codex');
  }
  if (!model) throw new Error('model required');
  if (targetAgentKind === currentAgentKind) {
    agentSwitchIntents().delete(id);
    broadcast('local-db:sessions:patched', { sessionId: id, patch: { agentSwitchIntent: null } });
    return { switched: false, agentKind: targetAgentKind, model, engineReady: true };
  }
  const intent = {
    targetAgentKind,
    model,
    providerId: typeof providerId === 'string' ? providerId : null,
    ...(typeof effort === 'string' && effort ? { effort } : {}),
    ...(typeof fastMode === 'boolean' ? { fastMode } : {}),
  };
  agentSwitchIntents().set(id, intent);
  broadcast('local-db:sessions:patched', { sessionId: id, patch: { agentSwitchIntent: intent } });
  return { switched: false, agentKind: targetAgentKind, model, engineReady: true, deferred: true };
}

function setSessionModel(id, model, providerId) {
  agentSwitchIntents().delete(id);
  return patchAndBroadcast(id, {
    model,
    ...(typeof providerId === 'string' ? { providerId } : {}),
    agentSwitchIntent: null,
  });
}

function applyPendingAgentSwitchIntent(id) {
  const intent = agentSwitchIntents().get(id);
  if (!intent) return;
  agentSwitchIntents().delete(id);
  patchAndBroadcast(id, {
    agentKind: intent.targetAgentKind === 'codex' ? 'codex' : 'cc',
    model: intent.model,
    providerId: intent.providerId,
    ...(intent.effort ? { effort: intent.effort } : {}),
    ...(typeof intent.fastMode === 'boolean' ? { fastMode: intent.fastMode } : {}),
    agentSwitchIntent: null,
  });
}

function forkSession(id) {
  const source = getSession(id);
  const forked = { ...source, id: `mock-fork-${Date.now()}`, title: `Fork of ${source.title}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  state.sessions.unshift(forked);
  state.messages.set(forked.id, [...(state.messages.get(id) ?? [])]);
  state.projections.set(forked.id, emptyProjection(forked.id));
  broadcast('local-db:sessions:created', { sessionId: forked.id });
  return forked;
}

function projectionFor(id) {
  if (!state.projections.has(id)) state.projections.set(id, emptyProjection(id));
  return state.projections.get(id);
}

function updateProjection(id, patch) {
  const next = { ...projectionFor(id), ...patch, sessionId: id };
  state.projections.set(id, next);
  return next;
}

function removeQueued(id, clientId) {
  const projection = projectionFor(id);
  return updateProjection(id, {
    pendingQueue: projection.pendingQueue.filter((item) => item.clientId !== clientId),
  });
}

function updateQueuedText(id, clientId, text) {
  const projection = projectionFor(id);
  return updateProjection(id, {
    pendingQueue: projection.pendingQueue.map((item) => (
      item.clientId === clientId ? { ...item, text } : item
    )),
  });
}

function emptyProjection(id) {
  return {
    sessionId: id,
    pendingQueue: [],
    steeringQueueClientIds: [],
    queuePaused: false,
    queueExpanded: false,
    queueInteractionLocks: [],
    queueEditLocks: [],
    queueAbortPending: false,
    error: null,
    errorRetryText: null,
  };
}

function message(sessionId, id, role, content, offsetMs, patch = {}) {
  return {
    id,
    clientId: id,
    sessionId,
    role,
    content,
    toolUseId: null,
    agentMeta: null,
    createdAt: new Date(Date.now() + offsetMs).toISOString(),
    ...patch,
  };
}

function queuedMessage(session, clientId, text) {
  return {
    clientId,
    text,
    persistedContent: JSON.stringify({ text }),
    model: session.model,
    effort: session.effort,
    permissionMode: session.permissionMode,
    workingDir: session.workingDir,
    createOpts: {
      agentKind: 'claude-code',
      workingDir: session.workingDir,
      model: session.model,
      effort: session.effort,
      permissionMode: session.permissionMode,
      fastMode: session.fastMode,
    },
    chatMessage: {
      clientId,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    },
  };
}

function toolUse(sessionId, id, toolName, input, offsetMs) {
  return {
    ...message(sessionId, id, 'tool_use', { toolUseId: id, toolName, input }, offsetMs),
    toolUseId: id,
  };
}

function toolResult(sessionId, id, toolUseId, content, offsetMs) {
  return {
    ...message(sessionId, id, 'tool_result', JSON.stringify(content), offsetMs),
    toolUseId,
  };
}

function listDir(path) {
  const resolvedPath = typeof path === 'string' && path ? path : '/tmp';
  return {
    resolvedPath,
    parent: resolvedPath === '/' ? null : '/tmp',
    entries: [
      { name: 'xdt-maker', kind: 'dir', path: `${resolvedPath.replace(/\/$/, '')}/xdt-maker` },
      { name: 'fixtures', kind: 'dir', path: `${resolvedPath.replace(/\/$/, '')}/fixtures` },
      { name: 'about.txt', kind: 'file', path: `${resolvedPath.replace(/\/$/, '')}/about.txt` },
      { name: 'spec.pdf', kind: 'file', path: `${resolvedPath.replace(/\/$/, '')}/spec.pdf` },
      { name: 'demo.mp4', kind: 'file', path: `${resolvedPath.replace(/\/$/, '')}/demo.mp4` },
      { name: 'demo.mp3', kind: 'file', path: `${resolvedPath.replace(/\/$/, '')}/demo.mp3` },
    ],
  };
}

function statPath(path) {
  const resolvedPath = typeof path === 'string' && path ? path : '/tmp';
  const fileLike = /\.(pdf|txt|md|png|jpg|jpeg|webp|gif|mp4|mov|m4v|mp3|wav|m4a)$/i.test(resolvedPath);
  return { kind: fileLike ? 'file' : 'dir', resolvedPath };
}

function readTextFilePreview(filePath) {
  const resolvedPath = typeof filePath === 'string' && filePath ? filePath : '';
  if (!resolvedPath) {
    return { success: false, reason: 'forbidden', error: 'Path must be absolute', size: 0, limitMb: 10 };
  }
  if (resolvedPath.includes('missing')) {
    return { success: false, reason: 'not_found', error: 'File not found', size: 0, limitMb: 10 };
  }
  if (resolvedPath.includes('large')) {
    return { success: false, reason: 'oversize', size: 12 * 1024 * 1024, limitMb: 10 };
  }
  const data = [
    '# Mock remote file',
    '',
    `Path: ${resolvedPath}`,
    '',
    'This text is served by mock-device-link-host through text-file:read-preview.',
  ].join('\n');
  return { success: true, data, size: Buffer.byteLength(data), limitMb: 10 };
}

function mockMediaFetch(url) {
  const source = typeof url === 'string' ? url : '';
  if (source.startsWith('xdt-video://')) {
    return { ossKey: 'xdt-maker/device-link/dev-local/demo.mp4', mimeType: 'video/mp4', size: 1024 * 1024 };
  }
  if (source.startsWith('xdt-audio://')) {
    return { ossKey: 'xdt-maker/device-link/dev-local/demo.mp3', mimeType: 'audio/mpeg', size: 512 * 1024 };
  }
  return { ossKey: 'xdt-maker/device-link/dev-local/mock.png', mimeType: 'image/png', size: 1024 };
}

function createSchedule(input = {}) {
  const now = Date.now();
  const id = `mock-schedule-${now}`;
  const schedule = {
    id,
    name: typeof input?.name === 'string' && input.name.trim() ? input.name.trim() : 'Mobile Created Schedule',
    prompt: typeof input?.prompt === 'string' ? input.prompt : '',
    status: 'active',
    kind: 'cron',
    cronExpr: typeof input?.cronExpr === 'string' && input.cronExpr.trim() ? input.cronExpr.trim() : '0 9 * * *',
    timezone: typeof input?.timezone === 'string' && input.timezone.trim() ? input.timezone.trim() : 'Asia/Shanghai',
    recurring: input?.recurring !== false,
    manual: input?.manual === true,
    intervalMs: Number.isFinite(input?.intervalMs) ? input.intervalMs : undefined,
    agentKind: input?.agentKind === 'codex' ? 'codex' : 'claude-code',
    model: typeof input?.model === 'string' ? input.model : undefined,
    effort: typeof input?.effort === 'string' ? input.effort : undefined,
    fastMode: input?.fastMode === true,
    workspaceKind: input?.workspaceKind === 'dialogue' ? 'dialogue' : 'project',
    workingDir: typeof input?.workingDir === 'string' ? input.workingDir : state.sessions[0]?.workingDir,
    useWorktree: input?.useWorktree === true,
    targetSessionId: typeof input?.targetSessionId === 'string' ? input.targetSessionId : undefined,
    persistentSession: input?.persistentSession === true,
    silentWhenIdle: input?.silentWhenIdle === true,
    notify: {
      desktop: input?.notify?.desktop !== false,
      feishu: input?.notify?.feishu === true,
    },
    createdAt: now,
    updatedAt: now,
    lastFiredAt: undefined,
    nextFireAt: input?.manual === true ? null : now + (Number.isFinite(input?.intervalMs) ? input.intervalMs : 60 * 60_000),
  };
  state.schedules.unshift(schedule);
  broadcast('maker:schedule:event', { scheduleId: id, type: 'changed' });
  return schedule;
}

function createScheduleFromTemplate(payload = {}) {
  const template = state.templates.find((item) => item.id === payload?.templateId);
  if (!template) {
    const err = new Error(`[NOT_FOUND] template ${payload?.templateId} not found`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  const paramValues = payload?.paramValues && typeof payload.paramValues === 'object'
    ? payload.paramValues
    : {};
  const overrides = payload?.overrides && typeof payload.overrides === 'object'
    ? payload.overrides
    : {};
  const prompt = applyTemplateParams(template.prompt ?? '', paramValues, template.parameters);
  return createSchedule({
    name: overrides.name ?? template.name,
    prompt: overrides.prompt ?? prompt,
    kind: overrides.kind ?? 'cron',
    cronExpr: overrides.cronExpr ?? template.cronExpr,
    timezone: overrides.timezone ?? template.timezone,
    recurring: overrides.recurring ?? template.recurring ?? true,
    manual: overrides.manual,
    intervalMs: overrides.intervalMs,
    agentKind: overrides.agentKind ?? template.agentKind ?? 'claude-code',
    model: overrides.model ?? template.model,
    effort: overrides.effort ?? template.effort,
    fastMode: overrides.fastMode ?? template.fastMode,
    workspaceKind: overrides.workspaceKind,
    workingDir: overrides.workingDir,
    useWorktree: overrides.useWorktree ?? template.useWorktree ?? false,
    targetSessionId: overrides.targetSessionId,
    persistentSession: overrides.persistentSession ?? template.persistentSession,
    silentWhenIdle: overrides.silentWhenIdle,
    notify: overrides.notify ?? template.notify ?? { desktop: true, feishu: false },
  });
}

function patchSchedule(id, patch) {
  const index = state.schedules.findIndex((item) => item.id === id);
  if (index === -1) return null;
  state.schedules[index] = {
    ...state.schedules[index],
    ...(patch && typeof patch === 'object' ? patch : {}),
    id,
    updatedAt: Date.now(),
  };
  broadcast('maker:schedule:event', { scheduleId: id, type: 'changed' });
  return state.schedules[index];
}

function applyTemplateParams(prompt, params = {}, definitions = []) {
  for (const definition of definitions ?? []) {
    const provided = Object.prototype.hasOwnProperty.call(params, definition.key) && params[definition.key] !== '';
    const hasDefault = definition.default !== undefined && definition.default !== '';
    if (definition.required && !provided && !hasDefault) {
      const err = new Error(`[INVALID_PARAMS] Missing required template parameter: ${definition.key}`);
      err.code = 'INVALID_PARAMS';
      throw err;
    }
  }
  return String(prompt).replace(/\{\{([A-Za-z0-9_-]+)\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(params, key) && params[key] !== '') return params[key];
    const definition = definitions.find((item) => item.key === key);
    if (definition?.default !== undefined) return definition.default;
    return definition ? '' : match;
  });
}

function markRunRead(id) {
  const run = state.runs.find((item) => item.id === id);
  if (run) run.readAt = Date.now();
}

function markScheduleRunsRead(id) {
  for (const run of state.runs) {
    if (run.scheduleId === id && run.status !== 'running') run.readAt = Date.now();
  }
}

function deleteScheduleRun(id) {
  const run = state.runs.find((item) => item.id === id);
  state.runs = state.runs.filter((item) => item.id !== id);
  if (run) {
    broadcast('maker:schedule:event', { scheduleId: run.scheduleId, type: 'changed' });
  }
}

function dismissInteraction(requestId) {
  for (const [id, list] of state.pendingInteractions) {
    const next = list.filter((item) => item.request?.requestId !== requestId);
    if (next.length !== list.length) {
      state.pendingInteractions.set(id, next);
      broadcast('maker:interaction-dismissed', { sessionId: id, requestId });
    }
  }
}

function trackTopics(controllerId, topics) {
  if (!controllerId) return;
  const set = controllerTopics.get(controllerId) ?? new Set();
  for (const topic of Array.isArray(topics) ? topics : []) {
    if (typeof topic === 'string') {
      set.add(topic);
      maybeScheduleVisualTransition(controllerId, topic);
    }
  }
  controllerTopics.set(controllerId, set);
}

function maybeScheduleVisualTransition(controllerId, topic) {
  if (scenario !== 'visual') return;
  if (topic !== 'session:visual-offline' && topic !== 'session:visual-revoked') return;
  if (topic === 'session:visual-offline') return;
  const key = `${controllerId}:${topic}`;
  if (visualTransitionKeys.has(key)) return;
  visualTransitionKeys.add(key);
  setTimeout(() => {
    if (topic === 'session:visual-revoked') {
      revokedControllers.add(controllerId);
      send({
        v: PROTOCOL_VERSION,
        kind: 'link-close',
        dst: controllerId,
        payload: { reason: 'revoked' },
      });
      return;
    }
  }, 800);
}

function maybeThrowVisualSessionFailure(targetSessionId) {
  if (debug) {
    console.error(`[mock-device-link-host] maybe visual failure scenario=${scenario} target=${idPreview(targetSessionId)}`); // lgtm[js/clear-text-logging]
  }
  if (scenario !== 'visual' || targetSessionId !== 'visual-offline') return;
  const err = new Error('[NOT_CONNECTED] visual offline fixture');
  err.code = 'NOT_CONNECTED';
  throw err;
}

function untrackTopics(controllerId, topics) {
  if (!controllerId) return;
  const set = controllerTopics.get(controllerId);
  if (!set) return;
  for (const topic of Array.isArray(topics) ? topics : []) set.delete(topic);
}

function broadcast(channel, payload) {
  for (const [controllerId] of controllerTopics) push(controllerId, channel, payload);
}

function push(controllerId, channel, payload) {
  send({ v: PROTOCOL_VERSION, kind: 'push', dst: controllerId, payload: { channel, payload } });
}

function sendInvokeResult(dst, id, payload) {
  send({ v: PROTOCOL_VERSION, kind: 'invoke-result', id, dst, payload });
}

function send(env) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(env));
}

function pick(value, keys) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]]));
}

function upsertSession(session) {
  const index = state.sessions.findIndex((item) => item.id === session.id);
  if (index === -1) {
    state.sessions.unshift(session);
    return;
  }
  state.sessions[index] = session;
}

function applySessionPatch(session) {
  const patch = state.sessionPatches?.get(session.id);
  return patch ? { ...session, ...patch } : session;
}

function sessionMatchesStatus(session, statusFilter) {
  if (statusFilter === 'archived') return session.status === 'archived';
  if (statusFilter === 'all') return session.status !== 'deleted';
  if (statusFilter === 'automation') return session.status !== 'deleted' && session.source === 'scheduler';
  return session.status === 'active';
}

function parsePositiveInteger(value, fallback) {
  const raw = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.max(1, Math.floor(raw));
}

function parseIsoMs(value) {
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function createdAtMs(message) {
  const parsed = Date.parse(message?.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function msToIso(ms) {
  if (ms === null || ms === undefined) return null;
  const parsed = Number(ms);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeSessionStatus(value) {
  if (value === 'archived' || value === 'deleted') return value;
  return 'active';
}

function normalizeSessionSource(value) {
  if (value === 'feishu' || value === 'slack' || value === 'scheduler') return value;
  return 'desktop';
}

function normalizeMessageRole(value) {
  if (
    value === 'assistant'
    || value === 'tool_use'
    || value === 'tool_result'
    || value === 'ask_user'
    || value === 'plan_review'
    || value === 'thinking'
    || value === 'system'
  ) {
    return value;
  }
  return 'user';
}

function safeParseStringArray(raw) {
  if (raw == null || raw === '') return [];
  const parsed = safeJsonParse(raw, []);
  return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
}

function safeJsonParse(raw, fallback) {
  if (typeof raw !== 'string') return raw ?? fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  try {
    const headers = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(`${response.status}: ${text}`);
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

function stop() {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, 'fixture stopped');
  process.exit(0);
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--api-base') {
      parsed.apiBase = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--device-link-base') {
      parsed.deviceLinkBase = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--device-id') {
      parsed.deviceId = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--device-name') {
      parsed.deviceName = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--session-id') {
      parsed.sessionId = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--scenario') {
      parsed.scenario = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--real-db') {
      parsed.realDb = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--real-db-limit') {
      parsed.realDbLimit = readValue(args, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return parsed;
}

function readValue(args, index, flag) {
  const value = args[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function normalizeBaseUrl(value) {
  return value.trim().replace(/\/$/, '');
}

// deriveDeviceLinkApiBase 收敛至共享 lib(仅本地 3333→3335 端口推导;生产域名分支已随 apiBaseUrl 退役删除)
import { deriveDeviceLinkApiBase } from './lib/device-link-base.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
