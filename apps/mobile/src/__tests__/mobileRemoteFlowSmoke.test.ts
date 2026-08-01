import { describe, expect, it, vi } from 'vitest';
import { DeviceLinkError, type DeviceView } from '@cindy/device-link';
import { createMobileMakerTransport, type RemoteInvoke } from '@/device-link/mobileMakerTransport';
import { toDeviceListItems } from '@/device-link/devices';
import { formatRemoteError, describeRemoteError } from '@/device-link/remoteStatus';
import { createRemoteSyncRunner } from '@/device-link/remoteSyncTask';
import {
  DELETE_PREVIEW_RUN_LIMIT,
  buildGeneratedSessionDispositionPatch,
  buildScheduleDeletePreview,
} from '@/scheduler/scheduleDelete';
import {
  countUnreadRuns,
  displayRunsForMobile,
  normalizeScheduleList,
  normalizeScheduleRuns,
  sortSchedulesForMobile,
  summarizeSchedule,
} from '@/scheduler/scheduleModel';
import type { RemoteSchedule, RemoteScheduleRun, RemoteScheduleTemplate } from '@/scheduler/types';
import {
  buildMobileRemoteFileAttachment,
} from '@/session/attachments';
import {
  buildAskUserQuestionDecision,
  buildPermissionDecision,
  buildPlanReviewDecision,
  encodeMultiSelectAnswer,
} from '@/session/interactionModel';
import { buildQueuedTextMessage } from '@/session/inputProjection';
import {
  buildSessionRuntimeOptions,
  normalizeMobileAgentCapabilities,
} from '@/session/agentCapabilities';
import { normalizeRemoteMessages } from '@/session/messageNormalize';
import {
  buildRemoteCreateSessionOptions,
  normalizeCreateSessionResult,
  DEFAULT_NEW_SESSION_DRAFT,
} from '@/session/newSession';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { resolveMobileRemoteMedia } from '@/session/remoteMedia';
import { buildRewindPreviewState, isCommitReadyRewindState } from '@/session/rewindPreview';
import { buildContextUsageCreateOpts, summarizeContextUsage } from '@/session/sessionControls';
import { buildRemoteSessionSections } from '@/session/sessionList';
import type { InputProjection, PendingInteraction, QueuedRemoteMessage, RemoteMessage, RemoteSession } from '@/session/types';

const DEVICE_ID = 'host-mac';
const SESSION_ID = 'smoke-session-1';

function device(patch: Partial<DeviceView> = {}): DeviceView {
  return {
    deviceId: DEVICE_ID,
    name: 'CaroldeMacBook-Pro.local',
    platform: 'darwin',
    appVersion: '0.0.0-test',
    lastSeenAt: '2026-06-16T10:00:00.000Z',
    online: true,
    busy: false,
    remoteControlEnabled: true,
    isSelf: false,
    ...patch,
  };
}

function session(patch: Partial<RemoteSession> = {}): RemoteSession {
  return {
    id: SESSION_ID,
    userId: 'user-1',
    title: 'Mobile smoke session',
    workingDir: '/repo/xdt-maker',
    workspaceKind: 'project',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    permissionMode: 'ask',
    fastMode: false,
    status: 'active',
    agentKind: 'cc',
    pinnedAt: null,
    userSendAt: '2026-06-16T10:00:00.000Z',
    createdAt: '2026-06-16T09:59:00.000Z',
    updatedAt: '2026-06-16T10:00:00.000Z',
    _count: { messages: 2 },
    ...patch,
  };
}

function message(id: string, role: RemoteMessage['role'], content: unknown, seconds: number): RemoteMessage {
  return {
    id,
    clientId: id,
    sessionId: SESSION_ID,
    role,
    content,
    toolUseId: null,
    agentMeta: null,
    createdAt: `2026-06-16T10:00:${seconds.toString().padStart(2, '0')}.000Z`,
  };
}

function agentCapabilities(agentKind: string) {
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
  };
}

describe('mobile remote-control headless UI flow smoke', () => {
  it('covers dev-login follow-up flow from device list to session send and permission resolve', async () => {
    remoteSessionStore.clear();
    const pending: PendingInteraction = {
      request: { kind: 'permission', requestId: 'perm-1', toolName: 'Bash', input: { command: 'pwd' } },
    };
    const decisions: Array<{ requestId: string; decision: Record<string, unknown> }> = [];
    const remoteMessages = [
      message('m1', 'user', { text: 'hello from desktop' }, 1),
      message('m2', 'assistant', 'ready from desktop', 2),
    ];
    const remoteSchedules: RemoteSchedule[] = [{
      id: 'sched-1',
      name: '移动端巡检',
      prompt: '检查项目状态',
      status: 'active',
      recurring: true,
      manual: false,
      cronExpr: '0 9 * * *',
      agentKind: 'claude-code',
      workspaceKind: 'project',
      workingDir: '/repo/xdt-maker',
      updatedAt: Date.parse('2026-06-16T09:40:00.000Z'),
      lastFiredAt: Date.parse('2026-06-16T09:30:00.000Z'),
      nextFireAt: Date.parse('2026-06-16T11:00:00.000Z'),
    }];
    const remoteRuns: RemoteScheduleRun[] = [{
      id: 'run-1',
      scheduleId: 'sched-1',
      sessionId: SESSION_ID,
      status: 'success',
      firedAt: Date.parse('2026-06-16T09:30:00.000Z'),
      finishedAt: Date.parse('2026-06-16T09:31:00.000Z'),
      resultText: '巡检完成',
      readAt: undefined,
    }];
    const remoteTemplates: RemoteScheduleTemplate[] = [{
      id: 'standup-summary',
      name: '站会摘要',
      description: '总结昨天的 git 活动',
      category: 'status-reports',
      source: 'builtin',
      prompt: '总结 {{project}} 的昨天进展',
      cronExpr: '0 9 * * 1-5',
      timezone: 'Asia/Shanghai',
      recurring: true,
      agentKind: 'claude-code',
      useWorktree: false,
      notify: { desktop: true, feishu: false },
      parameters: [
        { key: 'project', label: '项目', type: 'string', required: true, default: 'XDMaker' },
      ],
    }];
    let projection: InputProjection = {
      sessionId: SESSION_ID,
      pendingQueue: [],
      steeringQueueClientIds: [],
      queuePaused: false,
      queueExpanded: false,
      queueInteractionLocks: [],
      queueEditLocks: [],
      queueAbortPending: false,
      error: null,
      errorRetryText: null,
    credentialSwitchWait: null,
    };
    const subscriptions: string[] = [];
    const openLink = vi.fn(async (_deviceId: string) => undefined);
    const subscribe = vi.fn(async (_deviceId: string, topics: string[]) => {
      subscriptions.push(...topics);
    });
    const invoke: RemoteInvoke = vi.fn(async (_deviceId, channel, args) => {
      if (channel === 'local-db:sessions:list') return [session()];
      if (channel === 'local-db:sessions:get') return session({ id: String(args?.[0]) });
      if (channel === 'local-db:sessions:patch-meta') {
        return session(args?.[1] as Partial<RemoteSession>);
      }
      if (channel === 'local-db:messages:list') return remoteMessages;
      if (channel === 'maker:create-session') {
        return {
          sessionId: 'mobile-created-session',
          agentKind: 'claude-code',
          workDir: '/repo/xdt-maker',
          capabilities: agentCapabilities('claude-code'),
          usedProjectContext: true,
        };
      }
      if (channel === 'maker:get-capabilities') return agentCapabilities(String(args?.[0] ?? 'claude-code'));
      if (channel === 'maker:schedule:list') return remoteSchedules;
      if (channel === 'maker:schedule:get') {
        return remoteSchedules.find((item) => item.id === args?.[0]);
      }
      if (channel === 'maker:schedule:list-templates') return remoteTemplates;
      if (channel === 'maker:schedule:create-from-template') {
        const payload = args?.[0] as {
          templateId?: string;
          paramValues?: Record<string, string>;
          overrides?: Partial<RemoteSchedule>;
        };
        const template = remoteTemplates.find((item) => item.id === payload.templateId)!;
        const project = payload.paramValues?.project || 'XDMaker';
        const overrides = payload.overrides ?? {};
        const created: RemoteSchedule = {
          id: 'sched-template',
          name: overrides.name ?? template.name,
          prompt: `总结 ${project} 的昨天进展`,
          status: 'active',
          kind: 'cron',
          cronExpr: overrides.cronExpr ?? template.cronExpr,
          timezone: overrides.timezone ?? template.timezone,
          recurring: overrides.recurring ?? template.recurring,
          manual: overrides.manual,
          intervalMs: overrides.intervalMs,
          agentKind: overrides.agentKind ?? template.agentKind,
          workspaceKind: overrides.workspaceKind ?? 'project',
          workingDir: overrides.workingDir,
          useWorktree: overrides.useWorktree ?? template.useWorktree,
          notify: overrides.notify ?? template.notify,
          updatedAt: Date.parse('2026-06-16T10:00:13.000Z'),
        } as RemoteSchedule;
        remoteSchedules.unshift(created);
        return created;
      }
      if (channel === 'maker:schedule:create') {
        const input = args?.[0] as Partial<RemoteSchedule>;
        const created: RemoteSchedule = {
          id: 'sched-created',
          name: input.name ?? 'Created',
          prompt: input.prompt,
          status: 'active',
          kind: 'cron',
          cronExpr: input.cronExpr,
          timezone: input.timezone,
          recurring: input.recurring,
          manual: input.manual,
          intervalMs: input.intervalMs,
          agentKind: input.agentKind,
          workspaceKind: input.workspaceKind,
          workingDir: input.workingDir,
          useWorktree: input.useWorktree,
          notify: input.notify,
          updatedAt: Date.parse('2026-06-16T10:00:12.000Z'),
        } as RemoteSchedule;
        remoteSchedules.unshift(created);
        return created;
      }
      if (channel === 'maker:schedule:update') {
        const scheduleId = String(args?.[0]);
        const patch = args?.[1] as Partial<RemoteSchedule>;
        const idx = remoteSchedules.findIndex((item) => item.id === scheduleId);
        if (idx >= 0) remoteSchedules[idx] = { ...remoteSchedules[idx], ...patch };
        return remoteSchedules[idx];
      }
      if (channel === 'maker:schedule:list-runs') return remoteRuns;
      if (channel === 'maker:schedule:get-inflight-count') return 0;
      if (channel === 'maker:schedule:run-now') {
        remoteRuns.unshift({
          id: 'run-now-1',
          scheduleId: String(args?.[0]),
          status: 'running',
          firedAt: Date.parse('2026-06-16T10:00:10.000Z'),
        });
        return undefined;
      }
      if (channel === 'maker:schedule:pause') {
        remoteSchedules[0] = { ...remoteSchedules[0], status: 'paused' };
        return remoteSchedules[0];
      }
      if (channel === 'maker:schedule:resume') {
        remoteSchedules[0] = { ...remoteSchedules[0], status: 'active' };
        return remoteSchedules[0];
      }
      if (channel === 'maker:schedule:delete') {
        const scheduleId = String(args?.[0]);
        const idx = remoteSchedules.findIndex((item) => item.id === scheduleId);
        if (idx >= 0) remoteSchedules.splice(idx, 1);
        return undefined;
      }
      if (channel === 'maker:schedule:mark-run-read') {
        const runId = String(args?.[0]);
        const run = remoteRuns.find((item) => item.id === runId);
        if (run) run.readAt = Date.parse('2026-06-16T10:00:11.000Z');
        return undefined;
      }
      if (channel === 'maker:schedule:mark-schedule-runs-read') {
        const scheduleId = String(args?.[0]);
        for (const run of remoteRuns) {
          if (run.scheduleId === scheduleId && run.status !== 'running') {
            run.readAt = Date.parse('2026-06-16T10:00:11.000Z');
          }
        }
        return undefined;
      }
      if (channel === 'maker:schedule:delete-run') {
        const runId = String(args?.[0]);
        const idx = remoteRuns.findIndex((item) => item.id === runId);
        if (idx >= 0) remoteRuns.splice(idx, 1);
        return undefined;
      }
      if (channel === 'maker:set-model') return undefined;
      if (channel === 'maker:set-permission-mode') return undefined;
      if (channel === 'maker:set-extra-dirs') return ['/repo/docs'];
      if (channel === 'maker:list-agent-commands') {
        return {
          success: true,
          commands: [{ kind: 'agent-builtin', name: 'compact', description: 'Compact context' }],
        };
      }
      if (channel === 'maker:list-agent-skills') {
        return {
          success: true,
          skills: [{ kind: 'agent-skill', name: 'review', source: 'user', description: 'Review code' }],
        };
      }
      if (channel === 'maker:scan-at-resources') {
        return {
          success: true,
          truncated: false,
          items: [
            { type: 'file', name: 'sessions.ts', relPath: 'apps/desktop/src/main/localDb/ipc/sessions.ts' },
            { type: 'agent', name: 'reviewer', relPath: '.claude/agents/reviewer.md', description: 'Review agent' },
          ],
        };
      }
      if (channel === 'device-link:media:fetch') {
        return {
          ossKey: 'cindy/device-link/user-1/tool-image.png',
          mimeType: 'image/png',
          size: 2048,
        };
      }
      if (channel === 'device-link:voice:transcribe') {
        return {
          text: 'mock mobile voice transcript',
          provider: 'litellm-batch',
          model: 'elevenlabs/scribe_v2',
          audioBytes: 4096,
        };
      }
      if (channel === 'device-link:voice:dictionary-learning') {
        return {
          ok: true,
          actions: [],
          elapsedMs: 0,
          ignoreReason: 'smoke-mock',
        };
      }
      if (channel === 'fs:list-dir') {
        return {
          resolvedPath: '/Users/alice/Code',
          parent: '/Users/alice',
          entries: [
            { name: 'xdt-maker', kind: 'dir', path: '/Users/alice/Code/xdt-maker' },
            { name: 'shared', kind: 'symlink', path: '/Users/alice/Code/shared' },
          ],
        };
      }
      if (channel === 'fs:stat-path') {
        const requestedPath = String((args?.[0] as { path?: string })?.path ?? '');
        return {
          kind: requestedPath.endsWith('.pdf') ? 'file' : 'dir',
          resolvedPath: requestedPath,
        };
      }
      if (channel === 'fs:mkdir-p') return { resolvedPath: String((args?.[0] as { path?: string })?.path ?? '') };
      if (channel === 'maker:get-context-usage') return { contextTokens: 12000, maxContextTokens: 200000, percent: 0.06 };
      if (channel === 'maker:fork') return session({ id: 'forked-session', title: 'Forked from mobile' });
      if (channel === 'maker:rewind:preview') {
        return { canRewind: true, filesChanged: ['apps/mobile/App.tsx'], insertions: 2, deletions: 1 };
      }
      if (channel === 'maker:rewind:commit') {
        const anchorClientId = String(args?.[1]);
        const anchorIndex = remoteMessages.findIndex((item) => item.clientId === anchorClientId);
        if (anchorIndex >= 0) remoteMessages.splice(anchorIndex);
        return session({ updatedAt: '2026-06-16T10:00:20.000Z' });
      }
      if (channel === 'maker:get-pending-interactions') return [pending];
      if (channel === 'maker:input:get-projection') return projection;
      if (channel === 'maker:input:enqueue') {
        const queued = args?.[1] as QueuedRemoteMessage;
        projection = { ...projection, sessionId: String(args?.[0]), pendingQueue: [queued] };
        return projection;
      }
      if (channel === 'maker:input:stop') {
        projection = { ...projection, queuePaused: true, queueAbortPending: true };
        return projection;
      }
      if (channel === 'maker:input:resume') {
        projection = { ...projection, queuePaused: false, queueAbortPending: false };
        return projection;
      }
      if (channel === 'maker:input:retry-last-error') {
        projection = { ...projection, recovery: null, error: null, errorRetryText: null };
        return projection;
      }
      if (channel === 'maker:input:clear-error') {
        projection = { ...projection, recovery: null, error: null, errorRetryText: null };
        return projection;
      }
      if (channel === 'maker:input:update-text') {
        const clientId = String(args?.[1]);
        const nextText = String(args?.[2]);
        projection = {
          ...projection,
          pendingQueue: projection.pendingQueue.map((item) =>
            item.clientId === clientId ? { ...item, text: nextText } : item,
          ),
        };
        return projection;
      }
      if (channel === 'maker:input:set-edit-lock') {
        const clientId = String(args?.[1]);
        const locked = args?.[2] === true;
        projection = {
          ...projection,
          queueEditLocks: locked
            ? Array.from(new Set([...projection.queueEditLocks, clientId]))
            : projection.queueEditLocks.filter((id) => id !== clientId),
        };
        return projection;
      }
      if (channel === 'maker:input:move') {
        return projection;
      }
      if (channel === 'maker:input:remove') {
        const clientId = String(args?.[1]);
        projection = {
          ...projection,
          pendingQueue: projection.pendingQueue.filter((item) => item.clientId !== clientId),
        };
        return projection;
      }
      if (channel === 'maker:input:steer') {
        const queued = args?.[1] as QueuedRemoteMessage;
        projection = { ...projection, pendingQueue: [] };
        remoteMessages.push(message('m3', 'user', queued.text, 3));
        return true;
      }
      if (channel === 'maker:resolve-interaction') {
        decisions.push({
          requestId: String(args?.[0]),
          decision: args?.[1] as Record<string, unknown>,
        });
        return undefined;
      }
      throw new DeviceLinkError('CHANNEL_NOT_ALLOWED', channel);
    }) as RemoteInvoke;
    const maker = createMobileMakerTransport({ deviceId: DEVICE_ID, invoke });

    const devices = [
      device({ deviceId: 'self', isSelf: true, name: 'iPhone 17 Pro', platform: 'ios' }),
      device(),
      device({ deviceId: 'offline', online: false }),
      device({ deviceId: 'disabled', remoteControlEnabled: false }),
    ];
    const rows = toDeviceListItems(devices, Date.parse('2026-06-16T10:00:10.000Z'));
    expect(rows.map((item) => [item.device.deviceId, item.state, item.canOpen])).toEqual([
      [DEVICE_ID, 'ready', true],
      ['disabled', 'remote_disabled', false],
      ['offline', 'offline', false],
    ]);

    const syncDevice = createRemoteSyncRunner(async () => {
      await subscribe(DEVICE_ID, ['sessions']);
      const sessions = await invoke<RemoteSession[]>(DEVICE_ID, 'local-db:sessions:list', [
        200,
        'active',
        { includePinned: true },
      ]);
      remoteSessionStore.setDeviceSessions(DEVICE_ID, 'CaroldeMacBook-Pro.local', sessions);
    });
    const firstDeviceSync = syncDevice.run();
    const secondDeviceSync = syncDevice.run();
    await firstDeviceSync;
    await secondDeviceSync;

    expect(openLink).not.toHaveBeenCalled();
    expect(subscriptions).toEqual(['sessions', 'sessions']);
    expect(buildRemoteSessionSections(remoteSessionStore.getSessions()).map((section) => [
      section.key,
      section.data.map((item) => item.session.id),
    ])).toEqual([['project:/repo/xdt-maker', [SESSION_ID]]]);
    remoteSessionStore.renameDevice(DEVICE_ID, 'Studio Mac');
    expect(remoteSessionStore.getSessions()[0]).toMatchObject({
      deviceLinkDeviceId: DEVICE_ID,
      deviceLinkDeviceName: 'Studio Mac',
    });

    const syncSession = createRemoteSyncRunner(async () => {
      await openLink(DEVICE_ID);
      await subscribe(DEVICE_ID, ['sessions', `session:${SESSION_ID}`]);
      const [history, interactions] = await Promise.all([
        maker.listMessages(SESSION_ID, { limit: 80 }),
        maker.getPendingInteractions(SESSION_ID),
        maker.input.getProjection(SESSION_ID),
      ]);
      remoteSessionStore.mergeMessages(SESSION_ID, history);
      remoteSessionStore.setPendingInteractions(SESSION_ID, interactions);
      remoteSessionStore.setInputProjection(SESSION_ID, projection);
    });
    await Promise.all([syncSession.run(), syncSession.run(), syncSession.run()]);
    expect(openLink).toHaveBeenCalledTimes(2);

    expect(normalizeRemoteMessages(remoteSessionStore.getMessages(SESSION_ID)).map((item) => item.body)).toEqual([
      'hello from desktop',
      'ready from desktop',
    ]);
    expect(remoteSessionStore.getPendingInteractions(SESSION_ID)).toEqual([pending]);

    await expect(resolveMobileRemoteMedia({
      kind: 'image',
      url: 'xdt-image://lizi-art-media-images/tool-image.png',
    }, {
      fetchRemoteMedia: maker.fetchRemoteMedia,
      presignGet: async (ossKey) => ({
        getUrl: `https://oss.example/${encodeURIComponent(ossKey)}`,
        expiresAt: '2026-06-16T11:00:00.000Z',
      }),
    })).resolves.toMatchObject({
      url: 'https://oss.example/cindy%2Fdevice-link%2Fuser-1%2Ftool-image.png',
      previewable: true,
      mimeType: 'image/png',
      size: 2048,
    });
    await expect(maker.recordVoiceDictionaryLearning({
      source: 'mobile',
      rawTranscriptText: 'xd maker',
      beforeText: 'XD Maker',
      afterText: 'XDMaker',
      context: {
        uiLanguage: 'zh-CN',
        sourceLanguage: 'zh-CN',
        selectionBefore: '请打开 ',
        selectionAfter: ' 项目',
      },
    })).resolves.toMatchObject({
      ok: true,
      actions: [],
      ignoreReason: 'smoke-mock',
    });

    await expect(maker.fs.listDir('~')).resolves.toMatchObject({
      resolvedPath: '/Users/alice/Code',
      parent: '/Users/alice',
      entries: [
        { name: 'xdt-maker', kind: 'dir', path: '/Users/alice/Code/xdt-maker' },
        { name: 'shared', kind: 'symlink', path: '/Users/alice/Code/shared' },
      ],
    });
    await expect(maker.fs.statPath('/Users/alice/Code/xdt-maker')).resolves.toMatchObject({
      kind: 'dir',
      resolvedPath: '/Users/alice/Code/xdt-maker',
    });
    await expect(maker.fs.statPath('/repo/xdt-maker/spec.pdf')).resolves.toMatchObject({
      kind: 'file',
      resolvedPath: '/repo/xdt-maker/spec.pdf',
    });

    const runtimeOptions = buildSessionRuntimeOptions(
      remoteSessionStore.getSessions()[0],
      normalizeMobileAgentCapabilities(await maker.getCapabilities('claude-code')),
    );
    expect(runtimeOptions.modelOptions.map((item) => item.id)).toContain('claude-sonnet-4-6');
    expect(runtimeOptions.effortOptions.map((item) => item.id)).toContain('xhigh');
    expect(runtimeOptions.fastModeSupported).toBe(true);

    await maker.setModel(SESSION_ID, 'claude-opus-4-7');
    remoteSessionStore.applyRemotePush(DEVICE_ID, 'local-db:sessions:patched', {
      sessionId: SESSION_ID,
      patch: { model: 'claude-opus-4-7' },
    });
    expect(remoteSessionStore.getSessions()[0].model).toBe('claude-opus-4-7');

    await maker.setPermissionMode(SESSION_ID, 'plan');
    remoteSessionStore.applyRemotePush(DEVICE_ID, 'local-db:sessions:patched', {
      sessionId: SESSION_ID,
      patch: { permissionMode: 'plan' },
    });
    expect(remoteSessionStore.getSessions()[0].permissionMode).toBe('plan');

    await maker.setExtraDirs(SESSION_ID, ['/repo/docs', '/repo/rejected']);
    remoteSessionStore.applyRemotePush(DEVICE_ID, 'local-db:sessions:patched', {
      sessionId: SESSION_ID,
      patch: { extraDirs: ['/repo/docs'] },
    });
    expect(remoteSessionStore.getSessions()[0].extraDirs).toEqual(['/repo/docs']);

    await expect(maker.listAgentCommands('claude-code')).resolves.toMatchObject({
      commands: [{ name: 'compact' }],
    });
    await expect(maker.listAgentSkills('claude-code', { workingDir: '/repo/xdt-maker' })).resolves.toMatchObject({
      skills: [{ name: 'review' }],
    });
    const atResources = await maker.scanAtResources('claude-code', {
      workingDir: '/repo/xdt-maker',
      cap: 2000,
      query: 'session',
    });
    expect(atResources.items?.[0]).toMatchObject({
      relPath: 'apps/desktop/src/main/localDb/ipc/sessions.ts',
    });

    const renamed = await maker.patchSessionMeta(SESSION_ID, { title: 'Renamed from mobile' });
    remoteSessionStore.applySessionPatch(DEVICE_ID, SESSION_ID, renamed);
    expect(remoteSessionStore.getSessions()[0].title).toBe('Renamed from mobile');

    expect(summarizeContextUsage(await maker.getContextUsage(
      SESSION_ID,
      buildContextUsageCreateOpts(remoteSessionStore.getSessions()[0]),
    )).detail).toContain('12,000 / 200,000 tokens');

    const newSessionCreateOpts = buildRemoteCreateSessionOptions({
      ...DEFAULT_NEW_SESSION_DRAFT,
      workingDir: '/repo/xdt-maker',
      firstMessage: 'start from mobile',
    });
    const created = normalizeCreateSessionResult(await maker.createSession(newSessionCreateOpts));
    expect(created).toMatchObject({
      sessionId: 'mobile-created-session',
      workDir: '/repo/xdt-maker',
    });
    const createdSession = await maker.getSession(created!.sessionId);
    remoteSessionStore.upsertDeviceSession(DEVICE_ID, 'CaroldeMacBook-Pro.local', createdSession);
    const createdAttachment = buildMobileRemoteFileAttachment('/repo/xdt-maker/spec.pdf', { id: 'mobile-created-file-1' });
    expect(createdAttachment).not.toBeNull();
    remoteSessionStore.setInputProjection(
      created!.sessionId,
      await maker.input.enqueue(
        created!.sessionId,
        buildQueuedTextMessage(createdSession, '', new Date('2026-06-16T10:00:02.000Z'), 'mobile-created-q-1', {
          attachments: [createdAttachment!],
        }),
      ),
    );
    expect(remoteSessionStore.getSessions()[0]).toMatchObject({
      id: 'mobile-created-session',
      deviceLinkDeviceId: DEVICE_ID,
    });
    expect(remoteSessionStore.getInputProjection(created!.sessionId).pendingQueue[0]).toMatchObject({
      clientId: 'mobile-created-q-1',
      text: '',
      files: [{ name: 'spec.pdf', path: '/repo/xdt-maker/spec.pdf', mimeType: 'application/pdf' }],
      chatMessage: { files: [{ name: 'spec.pdf', path: '/repo/xdt-maker/spec.pdf' }] },
    });

    const schedules = sortSchedulesForMobile(normalizeScheduleList(await maker.schedule.list()));
    expect(summarizeSchedule(
      schedules[0],
      normalizeScheduleRuns(await maker.schedule.listRuns('sched-1', 50)),
      Date.parse('2026-06-16T10:00:00.000Z'),
    )).toMatchObject({
      title: '移动端巡检',
      unreadCount: 1,
      detail: 'cron 0 9 * * * · 新任务 · Claude · xdt-maker',
      runSessionDetail: null,
      runSessionLabel: '新任务',
    });
    await maker.schedule.markScheduleRunsRead('sched-1');
    expect(countUnreadRuns(normalizeScheduleRuns(await maker.schedule.listRuns('sched-1', 50)))).toBe(0);
    await maker.schedule.runNow('sched-1');
    expect(displayRunsForMobile(normalizeScheduleRuns(await maker.schedule.listRuns('sched-1', 50)))[0]).toMatchObject({
      id: 'run-now-1',
      status: 'running',
    });
    await maker.schedule.deleteRun('run-now-1');
    expect(normalizeScheduleRuns(await maker.schedule.listRuns('sched-1', 50)).some((run) => run.id === 'run-now-1'))
      .toBe(false);
    expect(await maker.schedule.pause('sched-1')).toMatchObject({ status: 'paused' });
    expect(await maker.schedule.resume('sched-1')).toMatchObject({ status: 'active' });
    const createdSchedule = await maker.schedule.create({
      name: '手机创建巡检',
      prompt: 'from mobile',
      kind: 'cron',
      cronExpr: '*/30 * * * *',
      timezone: 'Asia/Shanghai',
      recurring: true,
      intervalMs: 1_800_000,
      agentKind: 'claude-code',
      workspaceKind: 'project',
      workingDir: '/repo/xdt-maker',
      useWorktree: false,
      notify: { desktop: true, feishu: false },
    });
    expect(createdSchedule).toMatchObject({ id: 'sched-created', name: '手机创建巡检' });
    expect(await maker.schedule.update('sched-created', { name: '手机编辑巡检' })).toMatchObject({
      name: '手机编辑巡检',
    });
    expect(await maker.schedule.listTemplates()).toHaveLength(1);
    const templateSchedule = await maker.schedule.createFromTemplate({
      templateId: 'standup-summary',
      paramValues: { project: 'Mobile' },
      overrides: {
        workingDir: '/repo/xdt-maker',
        workspaceKind: 'project',
        useWorktree: false,
      },
    });
    expect(templateSchedule).toMatchObject({
      id: 'sched-template',
      prompt: '总结 Mobile 的昨天进展',
    });
    await maker.schedule.markRunRead('run-1');
    await maker.schedule.delete('sched-template');
    await maker.schedule.delete('sched-created');
    const deletePreview = buildScheduleDeletePreview(
      normalizeScheduleRuns(await maker.schedule.listRuns('sched-1', DELETE_PREVIEW_RUN_LIMIT)),
      await maker.schedule.getInflightCount('sched-1'),
    );
    expect(deletePreview.sessionIds).toContain(SESSION_ID);
    await maker.schedule.delete('sched-1');
    const archivePatch = buildGeneratedSessionDispositionPatch('archive')!;
    for (const sessionId of deletePreview.sessionIds) {
      await maker.patchSessionMeta(sessionId, archivePatch);
      remoteSessionStore.applySessionPatch(DEVICE_ID, sessionId, archivePatch);
    }
    expect(remoteSessionStore.getSessions().some((item) => item.id === SESSION_ID)).toBe(false);
    expect(normalizeScheduleList(await maker.schedule.list())).toEqual([]);
    remoteSessionStore.upsertDeviceSession(
      DEVICE_ID,
      'CaroldeMacBook-Pro.local',
      await maker.getSession(SESSION_ID),
    );
    expect(remoteSessionStore.getSessions().some((item) => item.id === SESSION_ID)).toBe(true);

    const forked = await maker.fork(SESSION_ID, 'm2');
    remoteSessionStore.upsertDeviceSession(DEVICE_ID, 'CaroldeMacBook-Pro.local', forked);
    expect(remoteSessionStore.getSessions().map((item) => item.id).slice(0, 3)).toEqual([
      'forked-session',
      SESSION_ID,
      'mobile-created-session',
    ]);

    const queued = buildQueuedTextMessage(session(), 'mobile says hi', new Date('2026-06-16T10:00:03.000Z'), 'mobile-q-1');
    remoteSessionStore.setInputProjection(
      SESSION_ID,
      await maker.input.enqueue(SESSION_ID, queued, { sendAtMs: Date.parse('2026-06-16T10:00:03.000Z') }),
    );
    expect(remoteSessionStore.getInputProjection(SESSION_ID).pendingQueue.map((item) => item.text)).toEqual([
      'mobile says hi',
    ]);

    const attachment = buildMobileRemoteFileAttachment('/repo/xdt-maker/spec.pdf', { id: 'mobile-file-1' });
    expect(attachment).not.toBeNull();
    remoteSessionStore.setInputProjection(
      SESSION_ID,
      await maker.input.enqueue(
        SESSION_ID,
        buildQueuedTextMessage(session(), '', new Date('2026-06-16T10:00:04.000Z'), 'mobile-q-file', {
          attachments: [attachment!],
        }),
      ),
    );
    expect(remoteSessionStore.getInputProjection(SESSION_ID).pendingQueue[0]).toMatchObject({
      clientId: 'mobile-q-file',
      text: '',
      files: [{ name: 'spec.pdf', path: '/repo/xdt-maker/spec.pdf', mimeType: 'application/pdf' }],
      chatMessage: { files: [{ name: 'spec.pdf', path: '/repo/xdt-maker/spec.pdf' }] },
    });

    remoteSessionStore.setInputProjection(
      SESSION_ID,
      await maker.input.enqueue(SESSION_ID, queued, { sendAtMs: Date.parse('2026-06-16T10:00:03.000Z') }),
    );

    remoteSessionStore.setInputProjection(
      SESSION_ID,
      await maker.input.stop(SESSION_ID, { keepQueue: true, pauseQueue: true }),
    );
    expect(remoteSessionStore.getInputProjection(SESSION_ID)).toMatchObject({
      queuePaused: true,
      queueAbortPending: true,
    });

    remoteSessionStore.setInputProjection(SESSION_ID, await maker.input.resume(SESSION_ID));
    expect(remoteSessionStore.getInputProjection(SESSION_ID).queuePaused).toBe(false);

    remoteSessionStore.setInputProjection(
      SESSION_ID,
      await maker.input.updateText(SESSION_ID, 'mobile-q-1', 'mobile says hi edited'),
    );
    expect(remoteSessionStore.getInputProjection(SESSION_ID).pendingQueue[0]?.text).toBe('mobile says hi edited');

    remoteSessionStore.setInputProjection(
      SESSION_ID,
      await maker.input.setEditLock(SESSION_ID, 'mobile-q-1', true),
    );
    expect(remoteSessionStore.getInputProjection(SESSION_ID).queueEditLocks).toEqual(['mobile-q-1']);
    remoteSessionStore.setInputProjection(
      SESSION_ID,
      await maker.input.setEditLock(SESSION_ID, 'mobile-q-1', false),
    );
    expect(remoteSessionStore.getInputProjection(SESSION_ID).queueEditLocks).toEqual([]);

    await maker.input.move(SESSION_ID, 'mobile-q-1', 0);
    const accepted = await maker.input.steer(
      SESSION_ID,
      remoteSessionStore.getInputProjection(SESSION_ID).pendingQueue[0],
      { removeFromQueue: true, touchUserSend: true },
    );
    expect(accepted).toBe(true);
    remoteSessionStore.setInputProjection(SESSION_ID, await maker.input.getProjection(SESSION_ID));
    remoteSessionStore.applyRemotePush(DEVICE_ID, 'local-db:messages:created', {
      sessionId: SESSION_ID,
      message: remoteMessages[remoteMessages.length - 1],
    });
    expect(normalizeRemoteMessages(remoteSessionStore.getMessages(SESSION_ID)).map((item) => item.body)).toEqual([
      'hello from desktop',
      'ready from desktop',
      'mobile says hi edited',
    ]);

    const rewindPreview = buildRewindPreviewState(
      'm3',
      'mobile says hi edited',
      await maker.rewindPreview(SESSION_ID, 'm3'),
    );
    expect(rewindPreview).toMatchObject({
      kind: 'default',
      filesChanged: ['apps/mobile/App.tsx'],
      insertions: 2,
      deletions: 1,
    });
    expect(isCommitReadyRewindState(rewindPreview)).toBe(true);
    const rewound = await maker.rewindCommit(SESSION_ID, 'm3');
    remoteSessionStore.applySessionPatch(DEVICE_ID, SESSION_ID, rewound);
    remoteSessionStore.setMessages(SESSION_ID, await maker.listMessages(SESSION_ID, { limit: 80 }));
    expect(normalizeRemoteMessages(remoteSessionStore.getMessages(SESSION_ID)).map((item) => item.body)).toEqual([
      'hello from desktop',
      'ready from desktop',
    ]);

    const removeQueued = buildQueuedTextMessage(session(), 'remove me', new Date('2026-06-16T10:00:04.000Z'), 'mobile-q-2');
    remoteSessionStore.setInputProjection(SESSION_ID, await maker.input.enqueue(SESSION_ID, removeQueued));
    remoteSessionStore.setInputProjection(SESSION_ID, await maker.input.remove(SESSION_ID, 'mobile-q-2'));
    expect(remoteSessionStore.getInputProjection(SESSION_ID).pendingQueue).toEqual([]);

    projection = {
      ...projection,
      recovery: { kind: 'active-turn', item: queued },
      error: '发送失败',
      errorRetryText: queued.text,
    };
    remoteSessionStore.setInputProjection(SESSION_ID, projection);
    expect(remoteSessionStore.getInputProjection(SESSION_ID).errorRetryText).toBe('mobile says hi');
    remoteSessionStore.setInputProjection(SESSION_ID, await maker.input.retryLastError(SESSION_ID));
    expect(remoteSessionStore.getInputProjection(SESSION_ID).error).toBeNull();
    projection = { ...projection, error: '再次失败', errorRetryText: null };
    remoteSessionStore.setInputProjection(SESSION_ID, projection);
    remoteSessionStore.setInputProjection(SESSION_ID, await maker.input.clearError(SESSION_ID));
    expect(remoteSessionStore.getInputProjection(SESSION_ID).error).toBeNull();

    await maker.resolveInteraction('perm-1', buildPermissionDecision('allow'));
    remoteSessionStore.applyRemotePush(DEVICE_ID, 'maker:interaction-dismissed', {
      sessionId: SESSION_ID,
      requestId: 'perm-1',
    });
    expect(remoteSessionStore.getPendingInteractions(SESSION_ID)).toEqual([]);

    remoteSessionStore.applyRemotePush(DEVICE_ID, 'maker:interaction-request', {
      sessionId: SESSION_ID,
      request: {
        kind: 'permission',
        requestId: 'perm-queued',
        toolName: 'Write',
      },
    });
    remoteSessionStore.applyRemotePush(DEVICE_ID, 'maker:interaction-request', {
      sessionId: SESSION_ID,
      request: {
        kind: 'ask_user_question',
        requestId: 'ask-queued',
        questions: [{
          question: '先处理哪个?',
          options: [{ label: '第二个' }],
        }],
      },
    });
    await maker.resolveInteraction('ask-queued', buildAskUserQuestionDecision({ '先处理哪个?': '第二个' }));
    remoteSessionStore.applyRemotePush(DEVICE_ID, 'maker:interaction-dismissed', {
      sessionId: SESSION_ID,
      requestId: 'ask-queued',
    });
    expect(remoteSessionStore.getPendingInteractions(SESSION_ID).map((item) => item.request.requestId)).toEqual([
      'perm-queued',
    ]);
    remoteSessionStore.applyRemotePush(DEVICE_ID, 'maker:interaction-dismissed', {
      sessionId: SESSION_ID,
      requestId: 'perm-queued',
    });
    expect(remoteSessionStore.getPendingInteractions(SESSION_ID)).toEqual([]);

    remoteSessionStore.applyRemotePush(DEVICE_ID, 'maker:interaction-request', {
      sessionId: SESSION_ID,
      request: {
        kind: 'ask_user_question',
        requestId: 'ask-1',
        questions: [{
          question: '选哪些能力?',
          multiSelect: true,
          options: [{ label: '队列' }, { label: '计划' }],
        }],
      },
    });
    const askAnswer = encodeMultiSelectAnswer([{ label: '队列' }, { label: '计划' }], new Set(['队列']), '权限');
    await maker.resolveInteraction('ask-1', buildAskUserQuestionDecision({ '选哪些能力?': askAnswer }));
    remoteSessionStore.applyRemotePush(DEVICE_ID, 'maker:interaction-dismissed', {
      sessionId: SESSION_ID,
      requestId: 'ask-1',
    });

    remoteSessionStore.applyRemotePush(DEVICE_ID, 'maker:interaction-request', {
      sessionId: SESSION_ID,
      request: {
        kind: 'plan_review',
        requestId: 'plan-1',
        plan: '# Plan\n- Do it',
        planFilePath: '/repo/plan.md',
      },
    });
    await maker.resolveInteraction('plan-1', buildPlanReviewDecision(true, '# Plan\n- Do it edited'));
    remoteSessionStore.applyRemotePush(DEVICE_ID, 'maker:interaction-dismissed', {
      sessionId: SESSION_ID,
      requestId: 'plan-1',
    });

    expect(remoteSessionStore.getPendingInteractions(SESSION_ID)).toEqual([]);
    expect(decisions).toEqual([
      { requestId: 'perm-1', decision: { kind: 'permission', behavior: 'allow', updatedInput: undefined, reason: undefined, permissionUpdates: undefined } },
      { requestId: 'ask-queued', decision: { kind: 'ask_user_question', answers: { '先处理哪个?': '第二个' } } },
      { requestId: 'ask-1', decision: { kind: 'ask_user_question', answers: { '选哪些能力?': JSON.stringify(['队列', '权限']) } } },
      { requestId: 'plan-1', decision: { kind: 'plan_review', behavior: 'allow', editedPlan: '# Plan\n- Do it edited', reason: undefined } },
    ]);

    const remoteDisabled = formatRemoteError(new DeviceLinkError('REMOTE_DISABLED', 'remote disabled'));
    expect(describeRemoteError(remoteDisabled)).toContain('关闭允许远程控制');
  });
});
