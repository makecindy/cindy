import type { MakeUpstreamItem, MakeUpstreamQuery } from '../../shared/cindyMakeDoctor.js';
import { untilAborted } from './doctor.js';

const REPOSITORY = 'makecindy/cindy';
const MAX_ITEMS = 5;
const TIMEOUT_MS = 25_000;
const FILLER = new Set(
  (
    '我 我们 希望 想要 想 可以 能够 需要 帮我 请 一个 一下 这个 那个 功能 问题 修复 新增 增加 支持 修改 优化 时候 之后 然后 出现 发生 使用 用户 不能 无法 ' +
    'i we you want would like please help can could should need needs have has when after before this that there here are was were does how make a an the to of in on for with and or not is it my fix bug feature add support cindy repo issue pr'
  ).split(' '),
);

export interface UpstreamQueryDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

/** Literal words only: user text cannot inject repository, state or boolean search qualifiers. */
export function upstreamSearchTerms(request: string): string[] {
  const words = [
    ...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(request.slice(0, 4000)),
  ]
    .filter((part) => part.isWordLike)
    .map((part) => part.segment.toLowerCase())
    .filter(
      (word) =>
        /^[\p{L}\p{N}]+$/u.test(word) && word.length >= 2 && word.length <= 48 && !FILLER.has(word),
    );
  return [...new Set(words)].slice(0, 3);
}

class QueryFailure extends Error {
  constructor(readonly reason: NonNullable<MakeUpstreamQuery['failure']>) {
    super(reason);
  }
}

/** Public, bounded keyword search. No account, source checkout, model or credential required. */
export async function searchCindyUpstream(
  request: string,
  signal: AbortSignal,
  deps: UpstreamQueryDeps = { fetch: (url, init) => fetch(url, init) },
): Promise<MakeUpstreamQuery> {
  const terms = upstreamSearchTerms(request);
  if (!terms.length) return { status: 'needsRequest', items: [], terms };
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort('timeout'), TIMEOUT_MS);
  const read = async (url: string): Promise<Record<string, unknown>> => {
    const response = await untilAborted(
      deps.fetch(url, {
        signal: controller.signal,
        redirect: 'error',
        headers: { accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      }),
      controller.signal,
    );
    if (!response.ok)
      throw new QueryFailure(
        response.status === 403 || response.status === 429 ? 'rateLimit' : 'network',
      );
    const body: unknown = await untilAborted(response.json(), controller.signal);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new QueryFailure('invalidResponse');
    return body as Record<string, unknown>;
  };
  try {
    controller.signal.throwIfAborted();
    // Separate literal searches work with REST search grammar without imposing an AND
    // across every word of a natural-language request. Rank repeated hits first.
    const pages = await Promise.all(
      terms.map(async (term) => {
        const url = new URL('https://api.github.com/search/issues');
        url.searchParams.set('q', `repo:${REPOSITORY} is:open in:title,body "${term}"`);
        url.searchParams.set('per_page', String(MAX_ITEMS));
        const body = await read(url.toString());
        if (
          !Array.isArray(body.items) ||
          body.incomplete_results !== false ||
          typeof body.total_count !== 'number' ||
          body.total_count < 0 ||
          (body.total_count > 0 && body.items.length === 0)
        )
          throw new QueryFailure('invalidResponse');
        return body.items.slice(0, MAX_ITEMS).map(parseItem);
      }),
    );
    const hits = new Map<number, { item: MakeUpstreamItem; count: number; rank: number }>();
    for (const page of pages)
      page.forEach((item, rank) => {
        const previous = hits.get(item.number);
        hits.set(item.number, {
          item,
          count: (previous?.count ?? 0) + 1,
          rank: Math.min(previous?.rank ?? rank, rank),
        });
      });
    const items = [...hits.values()]
      .sort((a, b) => b.count - a.count || a.rank - b.rank)
      .slice(0, MAX_ITEMS)
      .map((hit) => hit.item);
    controller.signal.throwIfAborted();
    return { status: items.length ? 'found' : 'notFound', items, terms };
  } catch (error) {
    return {
      status: signal.aborted ? 'cancelled' : 'failed',
      items: [],
      terms,
      failure:
        controller.signal.reason === 'timeout'
          ? 'timeout'
          : error instanceof QueryFailure
            ? error.reason
            : 'network',
    };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    controller.abort();
  }
}

function parseItem(value: unknown): MakeUpstreamItem {
  if (!value || typeof value !== 'object') throw new QueryFailure('invalidResponse');
  const row = value as Record<string, unknown>;
  const number = row.number;
  const kind = row.pull_request && typeof row.pull_request === 'object' ? 'pr' : 'issue';
  const htmlUrl = `https://github.com/${REPOSITORY}/${kind === 'pr' ? 'pull' : 'issues'}/${number}`;
  if (
    !Number.isSafeInteger(number) ||
    (number as number) <= 0 ||
    typeof row.title !== 'string' ||
    !row.title.trim() ||
    row.html_url !== htmlUrl ||
    row.state !== 'open'
  )
    throw new QueryFailure('invalidResponse');
  const author =
    row.user && typeof row.user === 'object'
      ? (row.user as Record<string, unknown>).login
      : undefined;
  return {
    number: number as number,
    title: row.title.slice(0, 300),
    htmlUrl,
    kind,
    state: 'open',
    author: typeof author === 'string' ? author.slice(0, 80) : undefined,
    updatedAt:
      typeof row.updated_at === 'string' && Number.isFinite(Date.parse(row.updated_at))
        ? new Date(row.updated_at).toISOString()
        : undefined,
    summary:
      typeof row.body === 'string'
        ? row.body
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 280)
        : undefined,
  };
}
