/**
 * UI mock data shared by Desktop and Mobile dev builds.
 *
 * One catalog of demo projects and tasks, written in the raw Desktop row shape
 * (the same rows Mobile receives over device-link). Desktop seeds them into an
 * isolated sandbox database; Mobile's visual mock serves them without login.
 * Dev tooling only: production code must not import this module.
 * See docs/dev-rules/ui-mock-data.md.
 */
/** Every seeded id starts with this prefix, except the Mobile state ids below. */
export const UI_MOCK_ID_PREFIX = 'ui-mock-';

export interface UiMockProject {
  /** Directory name; Desktop creates it under the sandbox, Mobile shows it as a remote path. */
  name: string;
  /** Small text files so file browsers and previews have something to open. */
  files: Record<string, string>;
}

export type UiMockMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string }
  | { role: 'thinking'; text: string }
  | { role: 'tool'; name: string; input: Record<string, unknown>; result: string };

export interface UiMockTask {
  id: string;
  title: string;
  /** Project directory name, or null for a dialogue task. */
  project: string | null;
  agentKind: 'cc' | 'codex' | 'pi';
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh';
  status: 'active' | 'archived';
  source: 'desktop' | 'scheduler';
  pinned?: boolean;
  fastMode?: boolean;
  /** Last activity, relative to the time the data is built. */
  minutesAgo: number;
  messages: UiMockMessage[];
}

export const UI_MOCK_PROJECTS: readonly UiMockProject[] = [
  {
    name: 'cindy-demo',
    files: {
      'README.md': '# Cindy Demo\n\nA small demo project used by the UI mock data.\n',
      'src/login.tsx': 'export function Login() {\n  return <form className="login" />;\n}\n',
      'src/settings.tsx': 'export function Settings() {\n  return <section className="settings" />;\n}\n',
      'package.json': '{\n  "name": "cindy-demo",\n  "private": true\n}\n',
    },
  },
  {
    name: 'design-system',
    files: {
      'README.md': '# Design System\n\nTokens and components for the demo.\n',
      'tokens.json': '{\n  "space": [4, 8, 12, 16, 24]\n}\n',
    },
  },
];

const RICH_ANSWER = [
  '## 结论',
  '',
  '登录页在窄窗口下的错位来自**固定宽度的表单容器**，改为随窗口收缩即可。',
  '',
  '| 窗口宽度 | 修改前 | 修改后 |',
  '| --- | --- | --- |',
  '| 320 | 横向溢出 | 正常 |',
  '| 768 | 正常 | 正常 |',
  '',
  '```tsx',
  'export function Login() {',
  '  return <form className="login w-full max-w-sm" />;',
  '}',
  '```',
  '',
  '1. 去掉 `width: 420px`',
  '2. 加上 `max-width`，保留居中',
  '3. 补一张深色模式截图',
  '',
  '> 只改样式，不影响登录流程。',
].join('\n');

/**
 * Task ids starting with `visual-` keep Mobile's runtime state overlays
 * (running, waiting for permission, queued) working; Desktop shows them as
 * ordinary tasks because those states live in the agent runtime, not the database.
 */
export const UI_MOCK_TASKS: readonly UiMockTask[] = [
  {
    id: 'visual-running',
    title: '重构登录页布局',
    project: 'cindy-demo',
    agentKind: 'codex',
    model: 'gpt-5.5',
    effort: 'medium',
    status: 'active',
    source: 'desktop',
    minutesAgo: 1,
    messages: [
      { role: 'user', text: '登录页在窄窗口下会错位，帮我看看。' },
      { role: 'thinking', text: '先读登录页组件和样式。' },
      { role: 'tool', name: 'Read', input: { file_path: 'src/login.tsx' }, result: 'export function Login() { … }' },
      { role: 'assistant', text: '正在调整表单容器的宽度，稍后给出改前／改后对比。' },
    ],
  },
  {
    id: 'visual-pending',
    title: '清理旧的构建缓存',
    project: 'cindy-demo',
    agentKind: 'cc',
    model: 'claude-sonnet-5',
    effort: 'medium',
    status: 'active',
    source: 'desktop',
    minutesAgo: 3,
    messages: [
      { role: 'user', text: '构建目录太大了，清理一下旧缓存。' },
      { role: 'assistant', text: '需要删除 `.cache/build`，等你确认后继续。' },
    ],
  },
  {
    id: 'visual-queue',
    title: '补充设置页的深色模式截图',
    project: 'cindy-demo',
    agentKind: 'cc',
    model: 'claude-opus-5',
    effort: 'high',
    status: 'active',
    source: 'desktop',
    minutesAgo: 6,
    messages: [
      { role: 'user', text: '给设置页补一组深色模式截图。' },
      { role: 'assistant', text: '浅色模式已经截好，深色模式排在下一条消息之后处理。' },
    ],
  },
  {
    id: 'visual-prompt-recommendation',
    title: '整理本周发布说明',
    project: null,
    agentKind: 'cc',
    model: 'claude-sonnet-5',
    effort: 'medium',
    status: 'active',
    source: 'desktop',
    minutesAgo: 12,
    messages: [
      { role: 'user', text: '把这周合并的改动整理成发布说明。' },
      { role: 'assistant', text: '已按「新功能／修复／体验改进」分组，共 12 条。需要我再写一段英文版吗？' },
    ],
  },
  {
    id: `${UI_MOCK_ID_PREFIX}rich-answer`,
    title: '登录页窄窗口错位排查',
    project: 'cindy-demo',
    agentKind: 'cc',
    model: 'claude-opus-5',
    effort: 'high',
    status: 'active',
    source: 'desktop',
    pinned: true,
    minutesAgo: 25,
    messages: [
      { role: 'user', text: '为什么登录页在 320 宽度下会横向滚动？给我结论和改法。' },
      { role: 'thinking', text: '检查容器宽度、媒体查询和全局样式。' },
      {
        role: 'tool',
        name: 'Bash',
        input: { command: 'rg -n "width: 420px" src' },
        result: 'src/login.tsx:2:  width: 420px;',
      },
      {
        role: 'tool',
        name: 'Edit',
        input: { file_path: 'src/login.tsx', old_string: 'width: 420px', new_string: 'max-width: 24rem' },
        result: 'The file src/login.tsx has been updated.',
      },
      { role: 'assistant', text: RICH_ANSWER },
    ],
  },
  {
    id: `${UI_MOCK_ID_PREFIX}long-title`,
    title: '一个特别长的任务标题，用来检查列表、标题栏和通知里的截断与换行是否正常显示，并确认悬停时能看到完整内容',
    project: 'design-system',
    agentKind: 'cc',
    model: 'claude-sonnet-5',
    effort: 'medium',
    status: 'active',
    source: 'desktop',
    minutesAgo: 60,
    messages: [
      { role: 'user', text: '检查超长标题的显示。' },
      { role: 'assistant', text: '列表里截断为一行，标题栏显示完整内容的前半部分。' },
    ],
  },
  {
    id: `${UI_MOCK_ID_PREFIX}english`,
    title: 'Investigate flaky upload test',
    project: 'design-system',
    agentKind: 'codex',
    model: 'gpt-5.5',
    effort: 'xhigh',
    status: 'active',
    source: 'desktop',
    fastMode: true,
    minutesAgo: 180,
    messages: [
      { role: 'user', text: 'The upload test fails about once every twenty runs. Find out why.' },
      {
        role: 'tool',
        name: 'Bash',
        input: { command: 'pnpm vitest run upload --repeat 20' },
        result: '19 passed, 1 failed: timeout waiting for progress event',
      },
      {
        role: 'assistant',
        text: 'The progress listener is attached after the request starts, so a fast upload can finish before it subscribes. Attaching it first fixes the race.',
      },
    ],
  },
  {
    id: `${UI_MOCK_ID_PREFIX}dialogue`,
    title: '帮我写一封请假邮件',
    project: null,
    agentKind: 'cc',
    model: 'claude-sonnet-5',
    effort: 'low',
    status: 'active',
    source: 'desktop',
    minutesAgo: 60 * 26,
    messages: [
      { role: 'user', text: '下周三想请一天假，帮我写封邮件给经理。' },
      {
        role: 'assistant',
        text: '主题：下周三请假一天\n\n王经理您好：\n\n我想在下周三（10 月 29 日）请假一天处理个人事务，手头的工作会在周二前交接好。\n\n谢谢！',
      },
    ],
  },
  {
    id: 'visual-automation-running',
    title: '[Schedule] 每日依赖检查',
    project: 'cindy-demo',
    agentKind: 'cc',
    model: 'claude-sonnet-5',
    effort: 'medium',
    status: 'active',
    source: 'scheduler',
    minutesAgo: 2,
    messages: [
      { role: 'user', text: '检查依赖是否有安全更新。' },
      { role: 'assistant', text: '正在检查 128 个依赖。' },
    ],
  },
  {
    id: 'visual-automation-unread',
    title: '[Schedule] 每周用量报告',
    project: null,
    agentKind: 'cc',
    model: 'claude-sonnet-5',
    effort: 'medium',
    status: 'active',
    source: 'scheduler',
    minutesAgo: 60 * 30,
    messages: [
      { role: 'user', text: '汇总本周的模型用量。' },
      { role: 'assistant', text: '本周共 42 个任务，用量比上周少 8%。' },
    ],
  },
  {
    id: `${UI_MOCK_ID_PREFIX}archived`,
    title: '已归档：迁移旧的图标资源',
    project: 'design-system',
    agentKind: 'cc',
    model: 'claude-sonnet-5',
    effort: 'medium',
    status: 'archived',
    source: 'desktop',
    minutesAgo: 60 * 24 * 9,
    messages: [
      { role: 'user', text: '把旧图标换成新的图标库。' },
      { role: 'assistant', text: '已替换 36 个图标，旧资源已删除。' },
    ],
  },
];

export interface UiMockSessionRow {
  id: string;
  title: string;
  /** Absolute project path, or null for dialogue tasks (each platform assigns its own). */
  workingDir: string | null;
  workspaceKind: 'project' | 'dialogue';
  agentKind: UiMockTask['agentKind'];
  model: string;
  effort: UiMockTask['effort'];
  permissionMode: 'ask';
  fastMode: boolean;
  status: UiMockTask['status'];
  source: UiMockTask['source'];
  /** Unix ms. */
  pinnedAt: number | null;
  userSendAt: number;
  createdAt: number;
  updatedAt: number;
  preview: string;
  messageCount: number;
}

export type UiMockMessageRole = 'user' | 'assistant' | 'thinking' | 'tool_use' | 'tool_result';

export interface UiMockMessageRow {
  id: string;
  clientId: string;
  sessionId: string;
  role: UiMockMessageRole;
  /** Decoded content; Desktop stores `JSON.stringify(content)`. */
  content: unknown;
  toolUseId: string | null;
  /** Unix ms. */
  createdAt: number;
}

export interface UiMockRows {
  sessions: UiMockSessionRow[];
  messages: UiMockMessageRow[];
}

const MINUTE_MS = 60_000;

/**
 * Build session and message rows. `projectRoot` is the parent directory of the
 * demo projects; times are relative to `now` so lists always look recent.
 */
export function buildUiMockRows({ now, projectRoot }: { now: number; projectRoot: string }): UiMockRows {
  let end = projectRoot.length;
  while (end > 0 && (projectRoot[end - 1] === '/' || projectRoot[end - 1] === '\\')) end -= 1;
  const root = projectRoot.slice(0, end);
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const sessions: UiMockSessionRow[] = [];
  const messages: UiMockMessageRow[] = [];
  for (const task of UI_MOCK_TASKS) {
    const updatedAt = now - task.minutesAgo * MINUTE_MS;
    const rows = taskMessageRows(task, updatedAt);
    messages.push(...rows);
    sessions.push({
      id: task.id,
      title: task.title,
      workingDir: task.project ? `${root}${separator}${task.project}` : null,
      workspaceKind: task.project ? 'project' : 'dialogue',
      agentKind: task.agentKind,
      model: task.model,
      effort: task.effort,
      permissionMode: 'ask',
      fastMode: task.fastMode ?? false,
      status: task.status,
      source: task.source,
      pinnedAt: task.pinned ? updatedAt : null,
      userSendAt: rows[0]?.createdAt ?? updatedAt,
      createdAt: (rows[0]?.createdAt ?? updatedAt) - MINUTE_MS,
      updatedAt,
      preview: previewOf(task),
      messageCount: rows.length,
    });
  }
  return { sessions, messages };
}

function taskMessageRows(task: UiMockTask, endsAt: number): UiMockMessageRow[] {
  const rows: UiMockMessageRow[] = [];
  const count = task.messages.reduce((total, message) => total + (message.role === 'tool' ? 2 : 1), 0);
  let at = endsAt - (count - 1) * 1_000;
  const push = (role: UiMockMessageRole, content: unknown, toolUseId: string | null = null) => {
    const id = `${UI_MOCK_ID_PREFIX}${task.id}-${rows.length + 1}`;
    rows.push({ id, clientId: id, sessionId: task.id, role, content, toolUseId, createdAt: at });
    at += 1_000;
  };
  task.messages.forEach((message, index) => {
    switch (message.role) {
      case 'user':
        push('user', { text: message.text, images: [], files: [] });
        break;
      case 'assistant':
        push('assistant', message.text);
        break;
      case 'thinking':
        push('thinking', { kind: 'thinking', text: message.text, durationMs: 1_500, isRedacted: false });
        break;
      case 'tool': {
        const toolUseId = `${UI_MOCK_ID_PREFIX}${task.id}-tool-${index + 1}`;
        push('tool_use', { toolUseId, toolName: message.name, input: message.input }, toolUseId);
        push('tool_result', message.result, toolUseId);
        break;
      }
    }
  });
  return rows;
}

function previewOf(task: UiMockTask): string {
  const last = [...task.messages].reverse().find((message) => message.role === 'assistant' || message.role === 'user');
  const text = last && 'text' in last ? last.text : task.title;
  return text.replace(/[#>*`|\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
}
