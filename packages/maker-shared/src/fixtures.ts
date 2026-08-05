import type {
  RemoteDirectoryEntryLike,
  RemoteDirectoryListResultLike,
  RemotePathStatResultLike,
} from './fileBrowser';
import type { RemoteTextFilePreviewResultLike } from './filePreview';
import type { PendingInteractionLike } from './interaction';
import type {
  MessageRenderNormalizedMessage,
  MessageRenderSourceMessageLike,
} from './messageRender';
import type { QueueProjectionLike } from './queue';
import type { RemoteSchedule, RemoteScheduleRun, RemoteScheduleTemplate } from './scheduleTypes';

export interface RemoteControlSessionFixture {
  id: string;
  title: string;
  workingDir: string | null;
  workspaceKind: 'project' | 'dialogue';
  status: 'active' | 'archived' | 'deleted';
  agentKind: 'cc' | 'codex';
  model: string;
  effort: string;
  permissionMode: string;
  fastMode: boolean;
  orcaRole?: 'lead' | 'worker' | null;
  parentSessionId?: string | null;
}

export interface RemoteMediaFixture {
  url: string;
  kind: 'image' | 'video' | 'audio';
  mimeType: string;
  name: string;
}

export type SharedRawDesktopMessageRole =
  | 'user'
  | 'assistant'
  | 'tool_use'
  | 'tool_result'
  | 'ask_user'
  | 'plan_review'
  | 'thinking'
  | 'system';

export interface SharedRawDesktopMessage {
  id: string;
  clientId: string;
  sessionId: string;
  role: SharedRawDesktopMessageRole;
  content: unknown;
  toolUseId: string | null;
  agentMeta: Record<string, unknown> | null;
  createdAt: string;
  systemCardData?: Record<string, unknown>;
  systemCardType?: 'help' | 'context' | 'cost' | 'pwd' | 'status' | 'compact' | 'cmd';
}

export interface SharedRemoteControlFixture {
  sessions: {
    primary: RemoteControlSessionFixture;
    orcaLead: RemoteControlSessionFixture;
    orcaWorker: RemoteControlSessionFixture;
  };
  messages: MessageRenderNormalizedMessage[];
  pendingInteractions: PendingInteractionLike[];
  queue: QueueProjectionLike;
  schedules: RemoteSchedule[];
  scheduleRuns: RemoteScheduleRun[];
  scheduleTemplate: RemoteScheduleTemplate;
  files: {
    directories: RemoteDirectoryEntryLike[];
    stats: RemotePathStatResultLike[];
  };
  media: RemoteMediaFixture[];
  rawMessages: SharedRawDesktopMessage[];
  rawSchedulePayloads: {
    list: unknown[];
    runs: unknown[];
    boundSessionSchedule: RemoteSchedule;
  };
  rawFilePayloads: {
    listDir: RemoteDirectoryListResultLike;
    stats: unknown[];
    textPreviewResults: RemoteTextFilePreviewResultLike[];
  };
}

type FixtureMessagePatch = Partial<MessageRenderNormalizedMessage<MessageRenderSourceMessageLike>> & {
  content?: unknown;
};

const CREATED_AT = '2026-06-17T08:00:00.000Z';
const UPDATED_AT = '2026-06-17T08:05:00.000Z';
const BASE_TS = Date.parse(CREATED_AT);

export const SHARED_REMOTE_CONTROL_FIXTURE: SharedRemoteControlFixture = {
  sessions: {
    primary: {
      id: 'session-primary',
      title: 'Mobile shared-core fixture',
      workingDir: '/repo/xdt-maker',
      workspaceKind: 'project',
      status: 'active',
      agentKind: 'cc',
      model: 'claude-sonnet-4-6',
      effort: 'medium',
      permissionMode: 'ask',
      fastMode: false,
    },
    orcaLead: {
      id: 'session-orca-lead',
      title: 'Orca lead fixture',
      workingDir: '/repo/xdt-maker',
      workspaceKind: 'project',
      status: 'active',
      agentKind: 'cc',
      model: 'claude-sonnet-4-6',
      effort: 'medium',
      permissionMode: 'ask',
      fastMode: false,
      orcaRole: 'lead',
    },
    orcaWorker: {
      id: 'session-orca-worker',
      title: 'Orca worker fixture',
      workingDir: '/repo/xdt-maker',
      workspaceKind: 'project',
      status: 'active',
      agentKind: 'codex',
      model: 'gpt-5.5',
      effort: 'medium',
      permissionMode: 'ask',
      fastMode: true,
      orcaRole: 'worker',
      parentSessionId: 'session-orca-lead',
    },
  },
  messages: [
    message('user-1', 'user', '请检查手机版远程控制的 shared core 迁移。', {
      content: '请检查手机版远程控制的 shared core 迁移。',
    }),
    message('thinking-1', 'thinking', '正在梳理桌面端模型...', {
      content: { durationMs: 3200, redacted: false },
    }),
    message('tool-bash-1', 'tool', 'pnpm --filter mobile test', {
      content: {
        toolName: 'Bash',
        input: { command: 'pnpm --filter mobile test' },
      },
    }),
    message('todo-1', 'tool', 'TodoWrite()', {
      label: 'TodoWrite',
      content: {
        toolName: 'TodoWrite',
        input: {
          todos: [
            { content: '迁移 schedule model', status: 'completed' },
            { content: '抽取 device-link contract', status: 'completed' },
            { content: '补 shared fixture', status: 'in_progress' },
          ],
        },
      },
    }),
    message('assistant-1', 'assistant', '已完成 shared core 迁移，并补上自动化门禁。', {
      content: '已完成 shared core 迁移，并补上自动化门禁。',
    }),
  ],
  pendingInteractions: [
    {
      request: {
        kind: 'permission',
        requestId: 'permission-1',
        toolName: 'Bash',
        input: { command: 'pnpm test && git push' },
      },
    },
    {
      request: {
        kind: 'ask_user_question',
        requestId: 'ask-1',
        questions: [
          {
            question: '下一步优先做什么?',
            options: [{ label: 'UI 重构' }, { label: 'Orca V2' }],
          },
        ],
      },
    },
    {
      request: {
        kind: 'plan_review',
        requestId: 'plan-1',
        plan: '# Plan\n## Shared Core\n- Move models\n## UI\n- Rebuild session detail',
        filePath: '/repo/xdt-maker/apps/mobile/docs/mobile-v1-source-plan.md',
      },
    },
    {
      request: {
        kind: 'issue_confirm',
        requestId: 'issue-1',
        draft: {
          title: 'Mobile controller fixture issue',
          body: 'Fixture issue body',
          type: 'bug',
        },
      },
    },
  ],
  queue: {
    error: null,
    errorRetryText: null,
    pendingQueue: [
      { clientId: 'queue-normal-1', text: '继续整理 UI 信息架构' },
      {
        clientId: 'queue-orca-1',
        text: 'worker sync',
        origin: { kind: 'orca', leadSessionId: 'session-orca-lead' },
      },
    ],
    queueAbortPending: false,
    queueExpanded: false,
    queuePaused: false,
  },
  schedules: [
    {
      id: 'schedule-1',
      name: '每日移动端远控巡检',
      prompt: '检查手机版远程控制回归。',
      kind: 'cron',
      cronExpr: '0 9 * * *',
      timezone: 'Asia/Shanghai',
      recurring: true,
      manual: false,
      agentKind: 'claude-code',
      workspaceKind: 'project',
      workingDir: '/repo/xdt-maker',
      useWorktree: false,
      notify: { desktop: true, feishu: false },
      status: 'active',
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      lastFiredAt: BASE_TS - 3_600_000,
      nextFireAt: BASE_TS + 7_200_000,
    },
  ],
  scheduleRuns: [
    {
      id: 'run-1',
      scheduleId: 'schedule-1',
      sessionId: 'session-primary',
      firedAt: BASE_TS - 3_600_000,
      finishedAt: BASE_TS - 3_500_000,
      status: 'success',
      resultText: 'All checks passed.',
    },
    {
      id: 'run-2',
      scheduleId: 'schedule-1',
      firedAt: BASE_TS - 60_000,
      status: 'running',
    },
  ],
  scheduleTemplate: {
    id: 'template-mobile-regression',
    name: 'Mobile regression',
    description: 'Run mobile remote-control regression checks',
    category: 'quality',
    source: 'builtin',
    prompt: 'Run {{suite}} for {{target}}',
    cronExpr: '0 10 * * *',
    timezone: 'Asia/Shanghai',
    recurring: true,
    agentKind: 'codex',
    model: 'gpt-5.5',
    fastMode: true,
    parameters: [
      { key: 'suite', label: 'Suite', type: 'string', required: true, default: 'full' },
      { key: 'target', label: 'Target', type: 'string', required: true, default: 'mobile' },
    ],
  },
  files: {
    directories: [
      { kind: 'dir', name: 'apps', path: '/repo/xdt-maker/apps' },
      { kind: 'symlink', name: 'current', path: '/repo/xdt-maker/current' },
      { kind: 'file', name: 'README.md', path: '/repo/xdt-maker/README.md' },
    ],
    stats: [
      { kind: 'file', resolvedPath: '/repo/xdt-maker/apps/mobile/docs/mobile-v1-source-plan.md' },
      { kind: 'file', resolvedPath: '/repo/xdt-maker/apps/mobile/docs/fixture.drawio' },
      { kind: 'missing', resolvedPath: '/repo/xdt-maker/missing.txt' },
    ],
  },
  media: [
    {
      url: 'xdt-image://session-primary/chart.png',
      kind: 'image',
      mimeType: 'image/png',
      name: 'chart.png',
    },
    {
      url: 'xdt-video://session-primary/demo.mp4',
      kind: 'video',
      mimeType: 'video/mp4',
      name: 'demo.mp4',
    },
    {
      url: 'xdt-audio://session-primary/voice.m4a',
      kind: 'audio',
      mimeType: 'audio/mp4',
      name: 'voice.m4a',
    },
  ],
  rawMessages: [
    rawMessage('raw-user-1', 'user', JSON.stringify({
      text: '请检查手机版远程控制的 shared core 迁移。',
      images: [
        { url: 'xdt-image://session-primary/input.png', originalName: 'input.png', mimeType: 'image/png' },
      ],
      files: [
        { name: 'mobile-v1-source-plan.md', path: '/repo/xdt-maker/apps/mobile/docs/mobile-v1-source-plan.md' },
      ],
    }), 1),
    rawMessage('raw-thinking-1', 'thinking', {
      kind: 'thinking',
      text: 'checking files',
      durationMs: 1500,
      isRedacted: false,
    }, 2),
    rawMessage('raw-ask-tool', 'tool_use', {
      toolUseId: 'tu_ask',
      toolName: 'AskUserQuestion',
      input: { question: 'Continue?' },
    }, 3, { toolUseId: 'tu_ask' }),
    rawMessage('raw-ask-tool-result', 'tool_result', '{"ok":true}', 4, { toolUseId: 'tu_ask' }),
    rawMessage('raw-bash', 'tool_use', {
      toolUseId: 'tu_bash',
      toolName: 'Bash',
      input: { command: 'pnpm --filter mobile test' },
    }, 5, { toolUseId: 'tu_bash' }),
    rawMessage('raw-bash-result', 'tool_result', '303 tests passed', 6, { toolUseId: 'tu_bash' }),
    rawMessage('raw-edit', 'tool_use', {
      toolUseId: 'tu_edit',
      toolName: 'Edit',
      input: {
        file_path: '/repo/xdt-maker/apps/mobile/src/session/MessageRenderer.tsx',
        old_string: 'rough',
        new_string: 'polished',
      },
    }, 7, { toolUseId: 'tu_edit' }),
    rawMessage('raw-edit-result', 'tool_result', JSON.stringify({
      ok: true,
      xdt_image_urls: ['xdt-image://session-primary/chart.png'],
      xdt_video_urls: ['xdt-video://session-primary/demo.mp4'],
      _xdt_audio_tracks: [
        { title: 'Voice note', xdt_audio_url: 'xdt-audio://session-primary/voice.m4a' },
      ],
    }), 8, { toolUseId: 'tu_edit' }),
    rawMessage('raw-orca-empty', 'tool_use', {
      toolUseId: 'tu_orca_empty',
      toolName: 'mcp__orca_worker_bridge__send_to_lead',
      input: { message: 'status?' },
    }, 9, { toolUseId: 'tu_orca_empty' }),
    rawMessage('raw-orca-empty-result', 'tool_result', JSON.stringify({ ok: true }), 10, {
      toolUseId: 'tu_orca_empty',
    }),
    rawMessage('raw-orca-detail', 'tool_use', {
      toolUseId: 'tu_orca_detail',
      toolName: 'read_lead',
      input: {},
    }, 11, { toolUseId: 'tu_orca_detail' }),
    rawMessage('raw-orca-detail-result', 'tool_result', JSON.stringify({
      ok: true,
      message: 'Lead replied: continue with UI parity.',
    }), 12, { toolUseId: 'tu_orca_detail' }),
    rawMessage('raw-todo-1', 'tool_use', {
      toolUseId: 'tu_todo_1',
      toolName: 'TodoWrite',
      input: {
        todos: [
          { content: '迁移 schedule model', status: 'completed' },
          { content: '抽取 device-link contract', status: 'completed' },
          { content: '补 raw desktop fixture', status: 'in_progress' },
        ],
      },
    }, 13, { toolUseId: 'tu_todo_1' }),
    rawMessage('raw-mid', 'assistant', 'I found the desktop render shape.', 14),
    rawMessage('raw-todo-2', 'tool_use', {
      toolUseId: 'tu_todo_2',
      toolName: 'TodoWrite',
      input: {
        todos: [
          { content: '迁移 schedule model', status: 'completed' },
          { content: '抽取 device-link contract', status: 'completed' },
          { content: '补 raw desktop fixture', status: 'completed' },
        ],
      },
    }, 15, { toolUseId: 'tu_todo_2' }),
    rawMessage('raw-final', 'assistant', '已完成 shared core 迁移，并补上自动化门禁。', 16, {
      agentMeta: { turnCostUsd: 0.042, turnCostIsEstimate: true },
    }),
    rawMessage('raw-ask-pending', 'ask_user', {
      status: 'pending',
      questions: [{ question: 'Should be hidden?' }],
    }, 17),
    rawMessage('raw-ask-answered', 'ask_user', {
      status: 'answered',
      questions: [{ question: 'Deploy?' }, { question: 'Notify?' }],
      answers: { 'Deploy?': 'yes', 'Notify?': '' },
    }, 18),
    rawMessage('raw-plan', 'plan_review', {
      status: 'revised',
      plan: '1. Inspect\n2. Patch\n3. Test\n4. Ship',
      feedback: 'Add rollback plan',
    }, 19),
    rawMessage('raw-system-context', 'system', '', 20, {
      systemCardType: 'context',
      systemCardData: { contextTokens: 2048, contextWindow: 200000 },
    }),
  ],
  rawSchedulePayloads: {
    list: [
      {
        id: 'schedule-bound-session',
        name: '绑定会话巡检',
        prompt: '继续在已有会话里检查移动端远控。',
        kind: 'cron',
        cronExpr: '*/30 * * * *',
        timezone: 'Asia/Shanghai',
        recurring: true,
        manual: false,
        intervalMs: 1_800_000,
        agentKind: 'codex',
        model: '',
        effort: '',
        fastMode: true,
        workspaceKind: 'project',
        workingDir: '/repo/xdt-maker',
        useWorktree: true,
        targetSessionId: 'session-primary',
        persistentSession: false,
        silentWhenIdle: true,
        notify: { desktop: true, feishu: false },
        status: 'active',
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        lastFiredAt: BASE_TS - 900_000,
        nextFireAt: BASE_TS + 900_000,
      },
      {
        id: 'schedule-paused',
        name: '暂停的项目自动化',
        prompt: 'paused',
        kind: 'cron',
        cronExpr: '0 12 * * 1',
        timezone: 'Asia/Shanghai',
        recurring: true,
        manual: false,
        agentKind: 'claude-code',
        workspaceKind: 'project',
        workingDir: '/repo/xdt-maker',
        useWorktree: false,
        notify: { desktop: false, feishu: true },
        status: 'paused',
        updatedAt: BASE_TS - 60_000,
      },
      {
        id: 'schedule-unknown-status',
        name: '',
        status: 'mystery',
        updatedAt: BASE_TS - 120_000,
      },
      { name: 'missing id should drop', status: 'active' },
    ],
    runs: [
      {
        id: 'run-bound-old',
        scheduleId: 'schedule-bound-session',
        sessionId: 'session-primary',
        firedAt: BASE_TS - 1_800_000,
        finishedAt: BASE_TS - 1_700_000,
        status: 'success',
        readAt: BASE_TS - 1_600_000,
        resultText: 'old result',
      },
      {
        id: 'run-bound-new',
        scheduleId: 'schedule-bound-session',
        sessionId: 'session-primary',
        firedAt: BASE_TS - 900_000,
        finishedAt: BASE_TS - 850_000,
        status: 'failed',
        errorMsg: 'mobile parity failed',
      },
      {
        id: 'run-bound-running',
        scheduleId: 'schedule-bound-session',
        firedAt: BASE_TS - 60_000,
        status: 'running',
      },
      {
        id: 'run-bad-status',
        scheduleId: 'schedule-bound-session',
        firedAt: BASE_TS - 30_000,
        status: 'bad',
      },
      { id: 'missing schedule id', status: 'success' },
    ],
    boundSessionSchedule: {
      id: 'schedule-bound-session',
      name: '绑定会话巡检',
      prompt: '继续在已有会话里检查移动端远控。',
      kind: 'cron',
      cronExpr: '*/30 * * * *',
      timezone: 'Asia/Shanghai',
      recurring: true,
      manual: false,
      intervalMs: 1_800_000,
      agentKind: 'codex',
      model: '',
      effort: '',
      fastMode: true,
      workspaceKind: 'project',
      workingDir: '/repo/xdt-maker',
      useWorktree: true,
      targetSessionId: 'session-primary',
      persistentSession: false,
      silentWhenIdle: true,
      notify: { desktop: true, feishu: false },
      status: 'active',
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    },
  },
  rawFilePayloads: {
    listDir: {
      resolvedPath: '/repo/xdt-maker',
      parent: '/repo',
      entries: [
        { kind: 'file', name: 'zeta.log', path: '/repo/xdt-maker/zeta.log' },
        { kind: 'dir', name: 'apps', path: '/repo/xdt-maker/apps' },
        { kind: 'symlink', name: 'current', path: '/repo/xdt-maker/current' },
        { kind: 'file', name: 'demo.mp4', path: '/repo/xdt-maker/demo.mp4' },
      ],
    },
    stats: [
      { kind: 'file', resolvedPath: '/repo/xdt-maker/README.md' },
      { kind: 'file', resolvedPath: '/repo/xdt-maker/spec.pdf' },
      { kind: 'file', resolvedPath: '/repo/xdt-maker/sheet.xlsx' },
      { type: 'directory', relPath: '/repo/xdt-maker/packages' },
      { kind: 'missing', resolvedPath: '/repo/xdt-maker/missing.txt' },
      { kind: 'unknown', resolvedPath: '/repo/xdt-maker/ignored.bin' },
      { kind: 'file' },
    ],
    textPreviewResults: [
      { success: true, data: '# Mobile plan\n', size: 14, limitMb: 5 },
      { success: false, reason: 'oversize', size: 8 * 1024 * 1024, limitMb: 5 },
      { success: false, reason: 'forbidden', size: 0 },
    ],
  },
};

function message(
  clientId: string,
  kind: MessageRenderNormalizedMessage['kind'],
  body: string,
  patch: FixtureMessagePatch = {},
): MessageRenderNormalizedMessage {
  const source: MessageRenderSourceMessageLike = {
    id: clientId,
    clientId,
    content: patch.content ?? body,
    createdAt: CREATED_AT,
    ...patch.source,
  };
  return {
    key: clientId,
    source,
    kind,
    label: patch.label ?? kind,
    body,
    createdAt: patch.createdAt ?? CREATED_AT,
  };
}

function rawMessage(
  id: string,
  role: SharedRawDesktopMessageRole,
  content: unknown,
  seconds: number,
  patch: Partial<SharedRawDesktopMessage> = {},
): SharedRawDesktopMessage {
  return {
    id,
    clientId: id,
    sessionId: 'session-primary',
    role,
    content,
    toolUseId: null,
    agentMeta: null,
    createdAt: `2026-06-17T08:00:${String(seconds).padStart(2, '0')}.000Z`,
    ...patch,
  };
}
