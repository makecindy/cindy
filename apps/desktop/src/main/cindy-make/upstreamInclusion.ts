import type {
  MakeRuntimeVersion,
  MakeUpstreamInclusion,
  MakeUpstreamItem,
} from '../../shared/cindyMakeDoctor';
import { untilAborted } from './doctor';

const REPOSITORY = 'makecindy/cindy';
const MAX_ITEMS = 5;
const MAX_CANDIDATES = 20;

export interface UpstreamRuntimeDeps {
  runtime?: MakeRuntimeVersion;
  containsCommit?: (commit: string, signal: AbortSignal) => Promise<MakeUpstreamInclusion>;
  isCurrent?: () => Promise<boolean>;
}

export async function filterUpstreamCandidates(
  candidates: MakeUpstreamItem[],
  read: (url: string) => Promise<Record<string, unknown>>,
  signal: AbortSignal,
  deps: UpstreamRuntimeDeps,
) {
  const runtime = deps.runtime ? { ...deps.runtime } : undefined;
  const inspected: MakeUpstreamItem[] = [];
  const comparisons = new Map<string, Promise<MakeUpstreamInclusion>>();
  const current = async () => {
    if (!deps.isCurrent) return true;
    try {
      return await untilAborted(deps.isCurrent(), signal);
    } catch {
      return false;
    }
  };
  const contains = async (commit: string): Promise<MakeUpstreamInclusion> => {
    if (runtime?.confidence !== 'exact' || !validCommit(runtime.commit) || !(await current()))
      return 'unknown';
    if (commit === runtime.commit) return 'included';
    try {
      const local = deps.containsCommit
        ? await untilAborted(deps.containsCommit(commit, signal), signal)
        : 'unknown';
      if (local !== 'unknown') return local;
      const comparison = await read(
        `https://api.github.com/repos/${REPOSITORY}/compare/${commit}...${runtime.commit}`,
      );
      const base = record(comparison.base_commit)?.sha;
      const common = record(comparison.merge_base_commit)?.sha;
      if (base !== commit) return 'unknown';
      if (
        (comparison.status === 'ahead' || comparison.status === 'identical') &&
        common === commit &&
        comparison.behind_by === 0 &&
        Array.isArray(comparison.commits) &&
        comparison.total_commits === comparison.commits.length &&
        !comparison.commits.some((entry) => {
          const message = record(record(entry)?.commit)?.message;
          return (
            typeof message !== 'string' || (/revert/i.test(message) && message.includes(commit))
          );
        })
      )
        return 'included';
      if (
        comparison.status === 'behind' &&
        common === runtime.commit &&
        comparison.ahead_by === 0 &&
        typeof comparison.behind_by === 'number' &&
        comparison.behind_by > 0
      )
        return 'notIncluded';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  };
  const inspect = async (item: MakeUpstreamItem): Promise<MakeUpstreamItem | null> => {
    let detail: Record<string, unknown>;
    try {
      detail = await read(`https://api.github.com/repos/${REPOSITORY}/pulls/${item.number}`);
      if (
        detail.number !== item.number ||
        detail.html_url !== item.htmlUrl ||
        record(record(detail.base)?.repo)?.full_name !== REPOSITORY ||
        typeof detail.merged !== 'boolean' ||
        !['open', 'closed'].includes(String(detail.state)) ||
        (detail.merged && detail.state !== 'closed')
      )
        throw new Error('Invalid pull request');
    } catch {
      return { ...item, inclusion: 'unknown' };
    }
    if (!detail.merged && detail.state === 'closed') return null;
    const commit = detail.merged ? detail.merge_commit_sha : record(detail.head)?.sha;
    let inclusion: MakeUpstreamInclusion = 'unknown';
    if (validCommit(commit)) {
      if (!comparisons.has(commit)) comparisons.set(commit, contains(commit));
      inclusion = await comparisons.get(commit)!;
    }
    return {
      ...item,
      state: detail.merged ? 'merged' : 'open',
      draft: detail.draft === true,
      inclusion,
    };
  };
  let inspectedCount = 0;
  for (let offset = 0; offset < Math.min(candidates.length, MAX_CANDIDATES); offset += 2) {
    signal.throwIfAborted();
    const batch = candidates.slice(offset, Math.min(offset + 2, MAX_CANDIDATES));
    inspectedCount += batch.length;
    const results = await Promise.all(batch.map(inspect));
    inspected.push(...results.filter((item): item is MakeUpstreamItem => item !== null));
    if (inspected.filter((item) => item.inclusion !== 'included').length >= MAX_ITEMS) break;
  }
  if (!(await current())) {
    if (runtime) runtime.confidence = 'unknown';
    for (const item of inspected) item.inclusion = 'unknown';
  }
  signal.throwIfAborted();
  const available = inspected.filter((item) => item.inclusion !== 'included');
  return {
    items: available.slice(0, MAX_ITEMS),
    ...(runtime ? { runtime } : {}),
    excludedIncluded: inspected.filter((item) => item.inclusion === 'included').length,
    hasMore: candidates.length > inspectedCount || available.length > MAX_ITEMS,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function validCommit(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
}
