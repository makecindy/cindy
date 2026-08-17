import { stripTrailingPathSeparators } from './pathText.js';

export type ComposerTrigger =
  | { kind: 'none' }
  | { kind: 'slash'; query: string; from: number }
  | { kind: 'at'; query: string; from: number };

export type ComposerSlashCommand =
  | { kind: 'agent-builtin'; name: string; description: string }
  | {
      kind: 'agent-skill';
      name: string;
      description?: string;
      source: 'user' | 'skill';
      path?: string;
      scope?: string;
      enabled?: boolean;
    }
  // desktop 自有命令(main 进程 DesktopCommandRegistry,如 /learn):由控制端/宿主
  // 执行,绝不转发给 agent。移动端只放行自己能执行的子集(见 mobile 侧过滤)。
  | { kind: 'desktop'; name: string; description: string };

export interface ComposerAtResourceItem {
  type: 'file' | 'dir' | 'agent';
  name: string;
  relPath: string;
  description?: string;
}

export function detectComposerTrigger(text: string): ComposerTrigger {
  const slash = detectSlashTrigger(text);
  if (slash.kind !== 'none') return slash;
  return detectAtTrigger(text);
}

export function mergeSlashCommands(
  agentBuiltin: readonly ComposerSlashCommand[],
  agentSkills: readonly ComposerSlashCommand[],
  desktopCommands: readonly ComposerSlashCommand[] = [],
): ComposerSlashCommand[] {
  const out: ComposerSlashCommand[] = [];
  const seen = new Set<string>();
  // 重名优先级对齐桌面 slashCommands.ts 的 mergeCommands:agent-skill > desktop > agent-builtin。
  const tiers = [
    [...agentSkills].sort(commandNameCompare),
    [...desktopCommands].sort(commandNameCompare),
    [...agentBuiltin].sort(commandNameCompare),
  ];
  for (const tier of tiers) {
    for (const command of tier) {
      const key = command.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(command);
    }
  }
  return out;
}

export function filterSlashCommands(
  commands: readonly ComposerSlashCommand[],
  query: string,
  limit = 8,
): ComposerSlashCommand[] {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? commands.filter((command) => command.name.toLowerCase().startsWith(q))
    : [...commands];
  return filtered.slice(0, Math.max(0, limit));
}

export function filterAtResources(
  items: readonly ComposerAtResourceItem[],
  query: string,
  limit = 8,
): ComposerAtResourceItem[] {
  const q = query.trim().toLowerCase();
  const scored: Array<{ item: ComposerAtResourceItem; score: number }> = [];
  for (const item of items) {
    const score = scoreAtResource(item, q);
    if (score >= 0) scored.push({ item, score });
  }
  scored.sort((a, b) =>
    b.score - a.score
    || a.item.name.localeCompare(b.item.name)
    || a.item.relPath.localeCompare(b.item.relPath),
  );
  return scored.slice(0, Math.max(0, limit)).map((entry) => entry.item);
}

export function insertSlashCommand(
  text: string,
  trigger: ComposerTrigger,
  command: Pick<ComposerSlashCommand, 'name'>,
): string {
  if (trigger.kind !== 'slash') return text;
  return `${text.slice(0, trigger.from)}/${command.name} `;
}

/** Pi runtime invocation is `/skill:name`. Display layer always shows `/name`. */
const PI_SKILL_RUNTIME_TOKEN_RE = /^\/skill:(\S+)$/i;
const PI_SKILL_RUNTIME_PREFIX = 'skill:';

/** Project a stored slash token (`/skill:git` or `/git`) to the human label. */
export function slashCommandDisplayLabel(commandText: string): string {
  const match = commandText.match(PI_SKILL_RUNTIME_TOKEN_RE);
  return match ? `/${match[1]}` : commandText;
}

/**
 * Project confirmed slash runs in a message body to the human label.
 * Without ranges, leave the text untouched — ordinary `/skill:foo` prose
 * must not be rewritten.
 */
export function projectSlashCommandsInText(
  text: string,
  ranges?: readonly { start: number; end: number }[],
): string {
  if (!ranges || ranges.length === 0) return text;
  let result = text;
  const ordered = [...ranges].sort((a, b) => b.start - a.start);
  for (const range of ordered) {
    if (range.start < 0 || range.end > result.length || range.end <= range.start) continue;
    const token = result.slice(range.start, range.end);
    const display = slashCommandDisplayLabel(token);
    if (display === token) continue;
    result = `${result.slice(0, range.start)}${display}${result.slice(range.end)}`;
  }
  return result;
}

/**
 * Put a displayed `/git ...` back to the stored `/skill:git ...` when the
 * user is resending an edited Pi skill message. Leave other commands alone.
 */
export function restoreSlashCommandRuntimeAlias(
  originalText: string,
  editedText: string,
): string {
  const originalCommand = originalText.match(/^\/(\S+)/)?.[1];
  const editedCommand = editedText.match(/^\/(\S+)/)?.[1];
  if (!originalCommand || !editedCommand) return editedText;
  if (!originalCommand.toLowerCase().startsWith(PI_SKILL_RUNTIME_PREFIX)) return editedText;
  const humanName = originalCommand.slice(PI_SKILL_RUNTIME_PREFIX.length);
  if (!humanName || editedCommand.toLowerCase() !== humanName.toLowerCase()) return editedText;
  return `/${originalCommand}${editedText.slice(editedCommand.length + 1)}`;
}

/**
 * Length of the hidden `skill:` run after `/` when the visible token is a Pi
 * runtime alias. Zero when the document already uses the human name.
 */
export function slashCommandRuntimePrefixLength(
  commandText: string,
  command: { name?: string; runtimeCommandName?: string },
): number {
  const runtime = command.runtimeCommandName?.trim();
  if (!runtime || !runtime.toLowerCase().startsWith(PI_SKILL_RUNTIME_PREFIX)) return 0;
  const body = commandText.startsWith('/') ? commandText.slice(1) : commandText;
  if (body.toLowerCase() !== runtime.toLowerCase()) return 0;
  return PI_SKILL_RUNTIME_PREFIX.length;
}

export function insertAtResource(
  text: string,
  trigger: ComposerTrigger,
  item: ComposerAtResourceItem,
): string {
  if (trigger.kind !== 'at') return text;
  return `${text.slice(0, trigger.from)}${serializeAtResource(item)} `;
}

export function serializeAtResource(item: Pick<ComposerAtResourceItem, 'type' | 'relPath'>): string {
  const relPath = item.type === 'dir'
    ? `${stripTrailingPathSeparators(item.relPath)}/`
    : item.relPath;
  return `@${formatMentionRef(relPath)}`;
}

function detectSlashTrigger(text: string): ComposerTrigger {
  if (!text.startsWith('/')) return { kind: 'none' };
  const run = text.slice(1);
  if (/\s/.test(run)) return { kind: 'none' };
  return { kind: 'slash', query: run, from: 0 };
}

function detectAtTrigger(text: string): ComposerTrigger {
  const at = text.lastIndexOf('@');
  if (at < 0) return { kind: 'none' };
  const before = at === 0 ? '' : text[at - 1];
  if (before && !/\s/.test(before)) return { kind: 'none' };
  const run = text.slice(at + 1);
  if (/\s/.test(run)) return { kind: 'none' };
  return { kind: 'at', query: run, from: at };
}

function commandNameCompare(a: ComposerSlashCommand, b: ComposerSlashCommand): number {
  return a.name.localeCompare(b.name);
}

function scoreAtResource(item: ComposerAtResourceItem, query: string): number {
  if (!query) return item.type === 'agent' ? 10 : 1;
  const name = item.name.toLowerCase();
  const relPath = item.relPath.toLowerCase();
  if (name.startsWith(query)) return 1000 - name.length;
  if (name.includes(query)) return 500 - name.length;
  if (fuzzyInOrder(name, query)) return 100 - name.length;
  if (fuzzyInOrder(relPath, query)) return 50 - relPath.length / 10;
  return -1;
}

function fuzzyInOrder(value: string, query: string): boolean {
  let index = 0;
  for (const ch of value) {
    if (ch === query[index]) index += 1;
    if (index === query.length) return true;
  }
  return index === query.length;
}

function formatMentionRef(path: string): string {
  return /\s/.test(path) || path.includes('"')
    ? `"${path.replace(/"/g, '\\"')}"`
    : path;
}
