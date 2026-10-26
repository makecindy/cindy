/**
 * Mission handoff: lets another Claude account pick up an unfinished task with full
 * understanding and the fewest tokens.
 *
 * Everything here is built from the local transcript JSONL only. No model call, no network,
 * zero tokens. Prompt caches are per account, so a full `resume` on a new account re-reads
 * the whole context uncached once. The `brief` option seeds a fresh session with a compact
 * Mission Brief instead. The user always chooses; this module only measures and recommends.
 * Design: docs/dev-rules/claude-multi-account.md §4.6.
 */

export const RESUME_CHEAP_THRESHOLD_TOKENS = 40_000;

const GOAL_MAX = 1_500;
const INSTRUCTION_MAX = 600;
const PROGRESS_MAX = 1_500;
const SUMMARY_MAX = 2_500;
const ERROR_MAX = 300;
const DETAIL_MAX = 200;
const MAX_FILES = 40;
const MAX_INSTRUCTIONS = 3;
const MAX_ERRORS = 3;

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const NOT_A_PROMPT = [/^<command-/, /^<local-command/, /^Caveat:/];

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface MissionSnapshot {
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  /** First real user prompt. */
  goal?: string;
  /** Real user prompts after the goal, newest last (max 3). */
  recentInstructions: string[];
  /** Last TodoWrite plan. */
  todos: Array<{ content: string; status: TodoStatus }>;
  /** Last assistant text. */
  lastProgress?: string;
  /** Latest compaction summary, if the session was compacted. */
  compactSummary?: string;
  /** Files written or edited, most recent last (max 40). */
  filesTouched: string[];
  /** Tool errors since the latest user instruction, newest three, as `Tool: message`. */
  recentErrors: string[];
  /** A tool call with no result at the end of the transcript. */
  interrupted?: { tool: string; detail: string };
  /** input + cache creation + cache read of the last assistant turn; null if unknown. */
  contextTokens: number | null;
  /** Number of real user prompts. */
  userTurns: number;
}

type Json = Record<string, unknown>;

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function asObject(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const b = asObject(block);
      return b && b.type === 'text' && typeof b.text === 'string' ? b.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function toolDetail(name: string, input: unknown): string {
  const i = asObject(input) ?? {};
  for (const key of ['command', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'description']) {
    if (typeof i[key] === 'string' && i[key]) return clip(i[key] as string, DETAIL_MAX);
  }
  try {
    return clip(JSON.stringify(i), DETAIL_MAX);
  } catch {
    return name;
  }
}

function parseTodos(input: unknown): MissionSnapshot['todos'] | null {
  const todos = asObject(input)?.todos;
  if (!Array.isArray(todos)) return null;
  const out: MissionSnapshot['todos'] = [];
  for (const raw of todos) {
    const t = asObject(raw);
    if (!t || typeof t.content !== 'string') continue;
    const status: TodoStatus =
      t.status === 'completed' || t.status === 'in_progress' ? t.status : 'pending';
    out.push({ content: clip(t.content, INSTRUCTION_MAX), status });
  }
  return out;
}

function usageTokens(usage: unknown): number | null {
  const u = asObject(usage);
  if (!u) return null;
  const parts = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].map((k) =>
    typeof u[k] === 'number' ? (u[k] as number) : 0,
  );
  return parts.reduce((a, b) => a + b, 0);
}

export function buildMissionSnapshot(lines: Iterable<string>): MissionSnapshot {
  const prompts: string[] = [];
  const todosRef: { value: MissionSnapshot['todos'] } = { value: [] };
  const files: string[] = [];
  let errorsSinceInstruction: string[] = [];
  const pending = new Map<string, { tool: string; detail: string }>();
  const toolNames = new Map<string, string>();
  const snap: Omit<MissionSnapshot, 'recentInstructions' | 'todos' | 'filesTouched' | 'recentErrors' | 'userTurns'> = {
    contextTokens: null,
  };

  for (const line of lines) {
    if (!line || !line.trim()) continue;
    let entry: Json | null;
    try {
      entry = asObject(JSON.parse(line));
    } catch {
      continue;
    }
    if (!entry || entry.isSidechain === true) continue;

    if (typeof entry.sessionId === 'string') snap.sessionId = entry.sessionId;
    if (typeof entry.cwd === 'string') snap.cwd = entry.cwd;
    if (typeof entry.gitBranch === 'string' && entry.gitBranch) snap.gitBranch = entry.gitBranch;

    if (entry.type === 'summary' && typeof entry.summary === 'string') {
      snap.compactSummary = clip(entry.summary, SUMMARY_MAX);
      continue;
    }
    const message = asObject(entry.message);
    if (!message) continue;

    if (entry.type === 'user') {
      if (entry.isCompactSummary === true) {
        const text = textOf(message.content);
        if (text) snap.compactSummary = clip(text, SUMMARY_MAX);
        continue;
      }
      const blocks = Array.isArray(message.content) ? message.content : [];
      let hadToolResult = false;
      for (const raw of blocks) {
        const b = asObject(raw);
        if (!b || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
        hadToolResult = true;
        pending.delete(b.tool_use_id);
        if (b.is_error === true) {
          const tool = toolNames.get(b.tool_use_id) ?? 'Tool';
          const text = clip(typeof b.content === 'string' ? b.content : textOf(b.content), ERROR_MAX);
          errorsSinceInstruction.push(`${tool}: ${text || 'error'}`);
        }
      }
      if (hadToolResult || entry.isMeta === true) continue;
      const text = textOf(message.content).trim();
      if (!text || NOT_A_PROMPT.some((re) => re.test(text))) continue;
      prompts.push(text);
      errorsSinceInstruction = [];
      continue;
    }

    if (entry.type === 'assistant') {
      const tokens = usageTokens(message.usage);
      if (tokens !== null) snap.contextTokens = tokens;
      const blocks = Array.isArray(message.content) ? message.content : [];
      for (const raw of blocks) {
        const b = asObject(raw);
        if (!b) continue;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          snap.lastProgress = clip(b.text, PROGRESS_MAX);
        } else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
          toolNames.set(b.id, b.name);
          pending.set(b.id, { tool: b.name, detail: toolDetail(b.name, b.input) });
          if (b.name === 'TodoWrite') {
            const todos = parseTodos(b.input);
            if (todos) todosRef.value = todos;
          }
          if (FILE_TOOLS.has(b.name)) {
            const input = asObject(b.input) ?? {};
            const file = typeof input.file_path === 'string' ? input.file_path : input.notebook_path;
            if (typeof file === 'string' && file) {
              const at = files.indexOf(file);
              if (at >= 0) files.splice(at, 1);
              files.push(file);
            }
          }
        }
      }
    }
  }

  const interrupted = [...pending.values()].at(-1);
  return {
    ...snap,
    ...(prompts[0] !== undefined ? { goal: clip(prompts[0], GOAL_MAX) } : {}),
    recentInstructions: prompts.slice(1).slice(-MAX_INSTRUCTIONS).map((p) => clip(p, INSTRUCTION_MAX)),
    todos: todosRef.value,
    filesTouched: files.slice(-MAX_FILES),
    recentErrors: errorsSinceInstruction.slice(-MAX_ERRORS),
    ...(interrupted ? { interrupted } : {}),
    userTurns: prompts.length,
  };
}

/** Rough token estimate (≈4 characters per token). Used only to compare options. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const TODO_MARK: Record<TodoStatus, string> = { completed: '[x]', in_progress: '[~]', pending: '[ ]' };

export function renderMissionBrief(s: MissionSnapshot): string {
  const out: string[] = [
    '# Continuing an unfinished task',
    '',
    'Another session started this task and stopped before finishing. Before changing anything, ' +
      'check the current state of the files listed below. Do not redo steps marked [x]. ' +
      'Continue from the first unfinished step, then finish the goal.',
  ];
  const section = (title: string, body: string[]) => {
    if (body.length === 0) return;
    out.push('', `## ${title}`, ...body);
  };
  section('Goal', s.goal ? [s.goal] : []);
  section('Latest instructions', s.recentInstructions.map((i) => `- ${i}`));
  section('Plan', s.todos.map((t) => `- ${TODO_MARK[t.status]} ${t.content}`));
  section('Summary of earlier work', s.compactSummary ? [s.compactSummary] : []);
  section('Last progress update', s.lastProgress ? [s.lastProgress] : []);
  section('Files touched', s.filesTouched.map((f) => `- ${f}`));
  section('Open problems', s.recentErrors.map((e) => `- ${e}`));
  const where: string[] = [];
  if (s.interrupted) where.push(`Interrupted: ${s.interrupted.tool} (${s.interrupted.detail}). Check whether it ran before retrying.`);
  if (s.cwd) where.push(`Working directory: ${s.cwd}${s.gitBranch ? ` (branch ${s.gitBranch})` : ''}`);
  section('Where things stand', where);
  return `${out.join('\n')}\n`;
}

export interface HandoffPlan {
  recommended: 'resume' | 'brief';
  /** Same session, full fidelity; first turn re-reads the whole context uncached. */
  resume: { estimatedTokens: number | null };
  /** Fresh session seeded with the Mission Brief. */
  brief: { text: string; estimatedTokens: number };
}

export function planHandoff(
  s: MissionSnapshot,
  options: { resumeThresholdTokens?: number } = {},
): HandoffPlan {
  const threshold = options.resumeThresholdTokens ?? RESUME_CHEAP_THRESHOLD_TOKENS;
  const text = renderMissionBrief(s);
  const briefTokens = estimateTokens(text);
  const resumeTokens = s.contextTokens;
  const recommended = resumeTokens !== null && resumeTokens > threshold && briefTokens < resumeTokens ? 'brief' : 'resume';
  return { recommended, resume: { estimatedTokens: resumeTokens }, brief: { text, estimatedTokens: briefTokens } };
}
