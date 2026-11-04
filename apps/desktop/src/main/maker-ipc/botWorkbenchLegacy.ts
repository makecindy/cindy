/**
 * 旧版工作台(2026-10-17 之前「项目 + 判断」形态)留在伙伴 Home `workbench.json` 里的数据。
 *
 * 新版工作台不再按项目认领任务。directories 由伙伴关联项目设置读写，旧判断保留，
 * 并继续用于以下兼容路径:
 * - 伙伴 Todo 把旧 PR / issue / 建议判断按稳定 id 兼容导入(`botTodoStore.ts`);
 * - 云端伙伴搬家时把旧文件原样随身带走(`botWorkbenchService.ts` 的 companion 读写),
 *   不让新版本把另一台还在旧版本上的电脑的数据清空。
 */
import path from 'node:path';

export type LegacyWorkbenchVerdict = 'unfinished' | 'idea' | 'done';

/** 伙伴对一件候选任务写下的旧判断。 */
export interface LegacyWorkbenchJudgment {
  title: string;
  verdict: LegacyWorkbenchVerdict;
  next: string | null;
  project: string;
  ref?: string | null;
  updatedAt: string;
}

export const LEGACY_JUDGMENT_TITLE_MAX = 40;
export const LEGACY_JUDGMENT_NEXT_MAX = 120;
export const LEGACY_JUDGMENT_REF_MAX = 2_000;
export const LEGACY_MAX_JUDGMENTS = 200;
/** 旧文件里目录条数的防护上限(与旧存储层同源)。 */
export const LEGACY_MAX_DIRECTORIES = 50;

export type LegacyWorkbenchTaskRef =
  | { kind: 'github'; type: 'pr' | 'issue'; owner: string; repo: string; number: number }
  | { kind: 'idea'; slug: string }
  | { kind: 'other' };

const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;

/** 旧条目 id:`pr:<owner>/<repo>#<n>`、`issue:…`、`idea:<slug>`;其余(会话 id 等)归为 other。 */
export function parseLegacyWorkbenchTaskId(taskId: string): LegacyWorkbenchTaskRef | null {
  const id = taskId.trim();
  if (!id || id.length > 256) return null;
  const github = /^(pr|issue):([^/\s]+)\/([^#\s]+)#(\d{1,9})$/.exec(id);
  if (github) {
    if (!GITHUB_NAME.test(github[2]) || !GITHUB_NAME.test(github[3])) return null;
    return { kind: 'github', type: github[1] as 'pr' | 'issue', owner: github[2], repo: github[3], number: Number(github[4]) };
  }
  if (/^(pr|issue):/.test(id)) return null;
  const idea = /^idea:(.*)$/.exec(id);
  if (idea) return /^[a-z0-9-]{3,40}$/.test(idea[1]) ? { kind: 'idea', slug: idea[1] } : null;
  return { kind: 'other' };
}

const VERDICTS = new Set(['unfinished', 'idea', 'done']);

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

export function normalizeLegacyJudgment(raw: unknown): LegacyWorkbenchJudgment | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  const title = boundedText(entry.title, LEGACY_JUDGMENT_TITLE_MAX);
  if (!title || typeof entry.verdict !== 'string' || !VERDICTS.has(entry.verdict)) return null;
  if (typeof entry.project !== 'string' || !path.isAbsolute(entry.project)) return null;
  return {
    title,
    verdict: entry.verdict as LegacyWorkbenchVerdict,
    next: boundedText(entry.next, LEGACY_JUDGMENT_NEXT_MAX),
    project: entry.project,
    ...(typeof entry.ref === 'string' && entry.ref.trim() ? { ref: entry.ref.trim().slice(0, LEGACY_JUDGMENT_REF_MAX) } : {}),
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date(0).toISOString(),
  };
}

/** 判断上限 200 条:超出时先淘汰最旧的 done,再淘汰最旧的其它判断。 */
export function boundLegacyJudgments(
  tasks: Record<string, LegacyWorkbenchJudgment>,
  max = LEGACY_MAX_JUDGMENTS,
): Record<string, LegacyWorkbenchJudgment> {
  const entries = Object.entries(tasks);
  if (entries.length <= max) return tasks;
  const byAge = (a: [string, LegacyWorkbenchJudgment], b: [string, LegacyWorkbenchJudgment]) =>
    Date.parse(a[1].updatedAt) - Date.parse(b[1].updatedAt) || a[0].localeCompare(b[0]);
  const evictOrder = [
    ...entries.filter(([, value]) => value.verdict === 'done').sort(byAge),
    ...entries.filter(([, value]) => value.verdict !== 'done').sort(byAge),
  ];
  const drop = new Set(evictOrder.slice(0, entries.length - max).map(([key]) => key));
  return Object.fromEntries(entries.filter(([key]) => !drop.has(key)));
}

export function normalizeLegacyJudgments(raw: unknown): Record<string, LegacyWorkbenchJudgment> {
  const out: Record<string, LegacyWorkbenchJudgment> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || key.length > 256) continue;
    const judgment = normalizeLegacyJudgment(value);
    if (judgment) out[key] = judgment;
  }
  return boundLegacyJudgments(out);
}
