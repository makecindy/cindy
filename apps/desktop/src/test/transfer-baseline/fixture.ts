/**
 * Deterministic synthetic tasks for the transfer baseline. No user data: every string
 * is generated from fixed vocabularies with a seeded PRNG, so two runs produce
 * byte-identical rows (ids, timestamps and text all have stable lengths).
 *
 * Shapes follow what Desktop actually persists (`packages/maker-shared/src/uiMock.ts`
 * `taskMessageRows`, `messagePersistBroadcaster.ts`): user `{ text, images, files }`,
 * assistant string, thinking `{ kind, text, durationMs, isRedacted }`, tool_use
 * `{ toolUseId, toolName, input }`, tool_result string capped by the real persist cap.
 */
import { capToolResultTextForPersist } from '../../shared/toolResultPersistCap';

export const FIXTURE_EPOCH = Date.UTC(2026, 9, 1, 8, 0, 0);

export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ZH = [
  '先看一下', '当前实现', '这个模块', '的入口', '在启动时', '会读取配置', '然后', '把结果', '写回缓存', '需要注意',
  '边界情况', '如果为空', '直接返回', '否则', '继续处理', '下一步', '我会', '修改', '对应的', '测试',
  '运行之后', '全部通过', '还剩', '一个问题', '日志里', '可以看到', '请求', '超时了', '原因是', '重试次数',
  '设置得', '太小', '调整为', '更合理的值', '另外', '界面上', '列表', '刷新', '比较慢', '已经',
  '定位到', '查询', '没有走索引', '补上之后', '耗时', '明显下降', '最后', '整理一下', '改动', '如下',
];
const EN = [
  'const', 'result', 'await', 'export', 'function', 'return', 'session', 'history', 'controller', 'payload',
  'buffer', 'stream', 'index', 'update', 'config', 'cache', 'value', 'error', 'string', 'number',
  'import', 'from', 'interface', 'options', 'request', 'response', 'timeout', 'retry', 'items', 'length',
];
const PATHS = [
  'src/app/main.ts', 'src/app/config.ts', 'src/lib/cache.ts', 'src/lib/http.ts', 'src/ui/List.tsx',
  'src/ui/Detail.tsx', 'test/cache.test.ts', 'test/http.test.ts', 'docs/notes.md', 'scripts/build.mjs',
];

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)];
}

/** Chinese prose of roughly `chars` characters. */
export function zhProse(random: () => number, chars: number): string {
  let text = '';
  while (text.length < chars) {
    text += pick(random, ZH);
    const r = random();
    text += r < 0.12 ? '。' : r < 0.25 ? '，' : '';
    if (r > 0.97) text += '\n\n';
  }
  return text.slice(0, chars);
}

/** Code-like / log-like output of roughly `bytes` bytes (ASCII). */
export function codeText(random: () => number, bytes: number): string {
  const lines: string[] = [];
  let size = 0;
  let line = 1;
  while (size < bytes) {
    const words = 3 + Math.floor(random() * 8);
    let text = `${String(line).padStart(4, ' ')}  `;
    for (let i = 0; i < words; i++) text += `${pick(random, EN)}${random() < 0.3 ? `_${Math.floor(random() * 1000)}` : ''} `;
    text += random() < 0.2 ? `// ${pick(random, PATHS)}` : ';';
    lines.push(text);
    size += text.length + 1;
    line++;
  }
  return lines.join('\n').slice(0, bytes);
}

/** Fixed-length ids (cuid-sized) so byte counts never drift between runs. */
export function fixtureId(prefix: string, n: number): string {
  return `${prefix}${String(n).padStart(25 - prefix.length, '0')}`;
}

export interface FixtureMessageRow {
  id: string;
  clientId: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'thinking' | 'tool_use' | 'tool_result';
  content: unknown;
  toolUseId: string | null;
  agentMeta?: Record<string, unknown>;
  createdAt: number;
}

export interface FixtureSessionRow {
  id: string;
  title: string;
  preview: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  /** Extra `sessions` columns (drizzle field names); realistic-row mode only. */
  columns?: Record<string, unknown>;
  tagIds?: string[];
}

export interface FixtureTag {
  id: string;
  name: string;
  nameCustomized: boolean;
  color: string;
  favoriteOrder: number | null;
  sortOrder: number;
  revision: number;
}

export interface FixtureTool {
  toolName: string;
  input: Record<string, unknown>;
  /** Raw output as the agent produced it (the live path sees this). */
  result: string;
}

export interface TurnShape {
  userChars: number;
  thinkingChars: number;
  /** Ordinary tool calls per turn. */
  tools: number;
  toolResultBytes: number;
  /** One large MCP-style result per turn (raw bytes, before the persist cap). */
  largeResultBytes: number;
  answerChars: number;
}

/** Ten turns × five commands + one ~879 KiB MCP result per turn (T3's fixed transcript shape). */
export const LONG_TURN: TurnShape = {
  userChars: 160,
  thinkingChars: 600,
  tools: 5,
  toolResultBytes: 3 * 1024,
  largeResultBytes: 879 * 1024,
  answerChars: 900,
};

export const SHORT_TURN: TurnShape = {
  userChars: 80,
  thinkingChars: 200,
  tools: 2,
  toolResultBytes: 1024,
  largeResultBytes: 0,
  answerChars: 300,
};

export function turnTools(random: () => number, shape: TurnShape): FixtureTool[] {
  const tools: FixtureTool[] = [];
  for (let i = 0; i < shape.tools; i++) {
    const file = pick(random, PATHS);
    switch (i % 4) {
      case 0: tools.push({ toolName: 'Bash', input: { command: `pnpm vitest run ${file}`, description: zhProse(random, 12) }, result: codeText(random, shape.toolResultBytes) }); break;
      case 1: tools.push({ toolName: 'Read', input: { file_path: `/workspace/demo/${file}` }, result: codeText(random, shape.toolResultBytes) }); break;
      case 2: tools.push({ toolName: 'Grep', input: { pattern: pick(random, EN), path: '/workspace/demo/src' }, result: codeText(random, shape.toolResultBytes) }); break;
      default: tools.push({ toolName: 'Edit', input: { file_path: `/workspace/demo/${file}`, old_string: codeText(random, 200), new_string: codeText(random, 240) }, result: 'The file has been updated.' }); break;
    }
  }
  if (shape.largeResultBytes > 0) {
    tools.push({ toolName: 'mcp__docs__search', input: { query: zhProse(random, 16), limit: 50 }, result: codeText(random, shape.largeResultBytes) });
  }
  return tools;
}

/** Build persisted rows for `turns` completed turns, exactly as Desktop would store them. */
export function buildSessionRows(sessionId: string, tag: string, seed: number, turns: number, shape: TurnShape, startAt: number): FixtureMessageRow[] {
  const random = createRandom(seed);
  const rows: FixtureMessageRow[] = [];
  let at = startAt;
  let n = 0;
  const id = () => fixtureId(`m${tag}_`, ++n);
  const push = (role: FixtureMessageRow['role'], content: unknown, toolUseId: string | null = null, agentMeta?: Record<string, unknown>) => {
    const rowId = id();
    rows.push({ id: rowId, clientId: rowId, sessionId, role, content, toolUseId, ...(agentMeta ? { agentMeta } : {}), createdAt: at });
    at += 1_000;
  };
  for (let turn = 0; turn < turns; turn++) {
    push('user', { text: zhProse(random, shape.userChars), images: [], files: [] });
    push('thinking', { kind: 'thinking', text: zhProse(random, shape.thinkingChars), durationMs: 1_500, isRedacted: false });
    for (const tool of turnTools(random, shape)) {
      const toolUseId = fixtureId(`toolu_${tag}_`, rows.length + 1);
      push('tool_use', { toolUseId, toolName: tool.toolName, input: tool.input }, toolUseId);
      push('tool_result', capToolResultTextForPersist(tool.result), toolUseId);
    }
    push('assistant', zhProse(random, shape.answerChars), null, { turnCompleted: true });
  }
  return rows;
}

export interface SidebarFixture {
  sessions: FixtureSessionRow[];
  messages: FixtureMessageRow[];
  tags?: FixtureTag[];
}

const MODELS: Array<[string, 'cc' | 'codex' | 'pi', string]> = [
  ['claude-sonnet-5', 'cc', 'anthropic'], ['claude-opus-5', 'cc', 'anthropic'], ['gpt-5.5', 'codex', 'openai'],
  ['gpt-5.5-codex', 'codex', 'openai'], ['kimi-k3', 'pi', 'kimi'], ['deepseek-v4', 'pi', 'deepseek'],
];
const TAG_COLORS = ['red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'];
const PROJECT_WORDS = ['orbit', 'garden', 'ledger', 'atlas', 'harbor', 'signal', 'canvas', 'relay', 'summit', 'meadow'];

function hex(random: () => number, length: number): string {
  let text = '';
  while (text.length < length) text += Math.floor(random() * 16).toString(16);
  return text;
}

function uuid(random: () => number): string {
  return `${hex(random, 8)}-${hex(random, 4)}-4${hex(random, 3)}-${(8 + Math.floor(random() * 4)).toString(16)}${hex(random, 3)}-${hex(random, 12)}`;
}

/** Tags for realistic rows: a sidebar tag set like a heavy user's. */
export function buildFixtureTags(): FixtureTag[] {
  const random = createRandom(11);
  return TAG_COLORS.map((color, index) => ({
    id: fixtureId('tag', index + 1), name: zhProse(random, 2 + (index % 3)) + index, nameCustomized: index % 2 === 0,
    color, favoriteOrder: index < 3 ? index : null, sortOrder: index, revision: 1 + (index % 4),
  }));
}

/**
 * Every remaining `sessions` column (apps/desktop/src/main/localDb/schema.ts `sessions`) with a
 * per-row value: SDK session ids, usage and cost, paths, model / provider, plan JSON, timestamps.
 * Fields that change which tasks are listed or read ahead (status, source, hidden, activity
 * time) or what a history page holds (clear boundary) keep their default meaning. A few rows
 * are pinned: that reorders the list, while read-ahead ranks by activity time
 * (historyViewPrefetch.ts selectHistoryPrefetchSessions) and so picks the same tasks.
 */
function realisticColumns(random: () => number, index: number, createdAt: number, updatedAt: number): Record<string, unknown> {
  const drawn = MODELS[Math.floor(random() * MODELS.length)];
  // The long task stays a Claude Code task, so its history projection is the default one.
  const [model, agentKind, providerId] = index === 0 ? MODELS[0] : drawn;
  const project = `${PROJECT_WORDS[Math.floor(random() * PROJECT_WORDS.length)]}-${PROJECT_WORDS[index % PROJECT_WORDS.length]}`;
  const workingDir = `/Users/dev${1 + (index % 3)}/Code/${project}${index % 4 === 0 ? '' : `/packages/${pick(random, EN)}`}`;
  const cost = Math.round(random() * 40 * 1e6) / 1e6;
  const window = [200_000, 400_000, 1_000_000][Math.floor(random() * 3)];
  const later = index >= 6;
  const currency = random() < 0.3 ? 'CNY' : 'USD';
  return {
    workingDir,
    projectDir: workingDir.split('/packages/')[0],
    workspaceKind: index % 5 === 4 ? 'dialogue' : 'project',
    model,
    scheduledModelBaseline: index % 7 === 3 ? model : null,
    sdkSessionId: uuid(random),
    totalTokenUsage: Math.floor(random() * 5_000_000),
    totalCostUsd: cost,
    totalCostAmount: currency === 'CNY' ? Math.round(cost * 7.2 * 1e6) / 1e6 : cost,
    totalCostCurrency: currency,
    contextTokens: Math.floor(random() * window * 0.8),
    contextWindow: window,
    contextWindowRuntime: random() < 0.5 ? window : null,
    planModeEnabled: random() < 0.2,
    // Before the first message, so no history range is hidden.
    clearedAt: random() < 0.2 ? createdAt - 60_000 : null,
    pinnedAt: index % 9 === 4 ? updatedAt - 86_400_000 : null,
    notificationsMuted: random() < 0.1,
    summary: index % 3 === 0 ? zhProse(random, 60 + Math.floor(random() * 60)) : null,
    providerId: random() < 0.2 ? `custom-${hex(random, 10)}` : providerId,
    userSendAt: updatedAt - Math.floor(random() * 600_000),
    lastActivityAt: updatedAt,
    agentKind,
    orcaRole: later && index % 11 === 0 ? 'lead' : null,
    worktreePath: random() < 0.3 ? `${workingDir}/.cindy-worktrees/${pick(random, PROJECT_WORDS)}-${pick(random, PROJECT_WORDS)}` : null,
    usedProjectContext: random() < 0.6,
    codexHistoryHasProductPrompt: agentKind === 'codex' ? true : null,
    codexPlanJson: agentKind === 'codex'
      ? JSON.stringify({ explanation: zhProse(random, 30), plan: Array.from({ length: 3 + Math.floor(random() * 3) }, (_, i) => ({ step: zhProse(random, 20 + Math.floor(random() * 20)), status: i === 0 ? 'completed' : i === 1 ? 'in_progress' : 'pending' })) })
      : null,
    extraDirs: JSON.stringify(random() < 0.3 ? [`/Users/dev${1 + (index % 3)}/Code/${pick(random, PROJECT_WORDS)}-shared`] : []),
    writableDirs: JSON.stringify(random() < 0.2 ? [`/tmp/${hex(random, 8)}`] : []),
    remoteHostId: later && index % 13 === 0 ? `ssh-${hex(random, 12)}` : null,
    // Never after updatedAt: activity order (read-ahead ranking) stays the default one.
    lastTurnEndedAt: updatedAt - Math.floor(random() * 5_000),
  };
}

export const LONG_SESSION_ID = fixtureId('tblong', 1);
export const LONG_SESSION_TURNS = 10;
export const SIDEBAR_SESSIONS = 30;
/** Scenario v3 list-scale variant: the Mobile/Desktop list read limit (sessions:list [200, …]). */
export const LARGE_SIDEBAR_SESSIONS = 200;
/** Sessions after the long one carry a short history so the list prefetch has real pages to read. */
export const SHORT_SESSION_TURNS = 3;

export function buildFixture(sidebarSessions = SIDEBAR_SESSIONS, options: { realisticRows?: boolean } = {}): SidebarFixture {
  const sessions: FixtureSessionRow[] = [];
  const messages: FixtureMessageRow[] = [];
  const random = createRandom(7);
  // A separate stream, so the default rows stay byte-identical whether or not this mode is on.
  const realistic = createRandom(13);
  const tags = options.realisticRows ? buildFixtureTags() : undefined;
  for (let index = 0; index < sidebarSessions; index++) {
    const id = index === 0 ? LONG_SESSION_ID : fixtureId('tbside', index);
    const turns = index === 0 ? LONG_SESSION_TURNS : SHORT_SESSION_TURNS;
    const shape = index === 0 ? LONG_TURN : SHORT_TURN;
    // Most recent first: the long task is the newest, then older sidebar tasks.
    const updatedAt = FIXTURE_EPOCH - index * 3_600_000;
    const rows = buildSessionRows(id, String(index).padStart(3, '0'), 100 + index, turns, shape, updatedAt - turns * 200_000);
    messages.push(...rows);
    const createdAt = updatedAt - turns * 200_000;
    sessions.push({
      id,
      title: zhProse(random, 14 + (index % 7)),
      preview: zhProse(random, 60),
      messageCount: rows.length,
      createdAt,
      updatedAt,
      ...(tags ? {
        columns: realisticColumns(realistic, index, createdAt, updatedAt),
        tagIds: tags.filter(() => realistic() < 0.25).slice(0, 3).map((tag) => tag.id),
      } : {}),
    });
  }
  return { sessions, messages, ...(tags ? { tags } : {}) };
}
