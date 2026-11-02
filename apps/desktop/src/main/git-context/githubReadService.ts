import { createHash, randomUUID } from 'node:crypto';
import {
  parseGithubPr,
  parseGithubReadArgs,
  type GithubDetailKind,
  type GithubReadMethod,
} from '@cindy/maker-shared';
import type { PrStatusQuery, PrStatusResult } from './prStatusService';
import type { GithubDetails, GithubFact } from './githubPrDetails';

export interface GithubReadContext {
  /** Persistent account + credential identity; never a credential itself. */
  scope: string;
  sourceDevice: string;
  assertCurrent(): Promise<void>;
  status(pr: PrStatusQuery, refresh: boolean): Promise<PrStatusResult>;
  details(
    pr: PrStatusQuery,
    kind: GithubDetailKind,
    head: string,
    base: string,
    refresh: boolean,
  ): Promise<GithubDetails>;
  prepareObservation?(pr: PrStatusQuery, head: string, refresh: boolean): Promise<void>;
  readJournal(key: string): Promise<Journal | null>;
  writeJournal(key: string, value: Journal): Promise<void>;
}
interface Event {
  event_id: string;
  sequence: number;
  kind: string;
  item_id: string;
  observed_at: number;
  fact: GithubFact;
}
export interface Journal {
  generation: string;
  sequence: number;
  signatures: Record<string, Record<string, string>>;
  events: Event[];
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cursor = (scope: string, journal: Journal, sequence = journal.sequence) =>
  Buffer.from(JSON.stringify({ scope, generation: journal.generation, sequence })).toString(
    'base64url',
  );

/** No timers, associations or acknowledgements. Callers own when to read and when to commit a cursor. */
export class GithubReadService {
  private observations = new Map<string, Promise<Journal>>();
  constructor(private readonly capture: () => Promise<GithubReadContext>) {}

  async read(method: GithubReadMethod, raw: unknown): Promise<Record<string, unknown>> {
    const args = parseGithubReadArgs(raw);
    const pr = parseGithubPr(args.pr);
    const ctx = await this.capture();
    const scope = hash([ctx.scope, ctx.sourceDevice, pr.owner, pr.repo, pr.prNumber]);
    const status = await ctx.status(pr, args.freshness === 'refresh');
    await ctx.assertCurrent();
    if (!status.ok) return { ok: false, errorCode: status.reason, source_device: ctx.sourceDevice };
    const snapshot = {
      pr: { repo: `${pr.owner}/${pr.repo}`, number: pr.prNumber, url: pr.url, title: status.title },
      ...(method === 'get_pr_changes' ? { metadata: status.metadata ?? null } : {}),
      head_branch: status.branch,
      state: status.status,
      head_sha: status.headSha ?? null,
      base_branch: status.baseBranch ?? null,
      checks: status.checks ?? null,
      review: {
        unresolved_threads: status.unresolvedCount,
        decision: status.reviewDecision ?? null,
      },
      observed_at: status.observedAt ?? null,
      revision: status.revision ?? null,
      source_device: ctx.sourceDevice,
      freshness: status.observedAt && Date.now() - status.observedAt < 60_000 ? 'fresh' : 'stale',
      partial: status.checks == null || status.unresolvedCount === null,
      errors: [
        ...(status.checks == null ? ['CHECKS_UNAVAILABLE'] : []),
        ...(status.unresolvedCount === null ? ['THREAD_COUNT_UNAVAILABLE'] : []),
      ],
    };
    if (method === 'get_pr_status') return { ok: true, ...snapshot };
    if (method === 'get_pr_details') {
      if (!args.kind) throw new Error('KIND_REQUIRED');
      const details = await ctx.details(
        pr,
        args.kind,
        status.headSha ?? '',
        status.baseBranch ?? '',
        args.freshness === 'refresh',
      );
      await ctx.assertCurrent();
      const items = args.item
        ? details.items.filter(
            (row) => String(row.id ?? row.databaseId ?? row.context) === args.item,
          )
        : details.items;
      const revision = hash(items);
      let offset = 0;
      if (args.after) {
        try {
          const value = JSON.parse(Buffer.from(args.after, 'base64url').toString());
          if (
            value.scope !== scope ||
            value.kind !== args.kind ||
            value.item !== (args.item ?? null) ||
            value.revision !== revision ||
            !Number.isSafeInteger(value.offset) ||
            value.offset < 0 ||
            value.offset > items.length
          )
            throw new Error();
          offset = value.offset;
        } catch {
          return { ok: false, errorCode: 'RESYNC_REQUIRED', snapshot };
        }
      }
      const end = Math.min(items.length, offset + (args.limit ?? 50));
      return {
        ok: true,
        kind: args.kind,
        items: items.slice(offset, end),
        observed_at: details.observed_at,
        source_device: ctx.sourceDevice,
        head_sha: status.headSha,
        partial: details.partial,
        errors: details.errors,
        has_more: end < items.length,
        next_cursor: Buffer.from(
          JSON.stringify({
            scope,
            kind: args.kind,
            item: args.item ?? null,
            revision,
            offset: end,
          }),
        ).toString('base64url'),
      };
    }
    const key = scope;
    let pending = this.observations.get(key);
    if (!pending) {
      pending = this.observe(ctx, pr, status, key, args.freshness === 'refresh');
      this.observations.set(key, pending);
    }
    let journal: Journal;
    try {
      journal = await pending;
    } finally {
      if (this.observations.get(key) === pending) this.observations.delete(key);
    }
    await ctx.assertCurrent();
    if (!args.after)
      return {
        ok: true,
        snapshot,
        events: [],
        baseline: true,
        next_cursor: cursor(scope, journal),
        has_more: false,
        coverage: 'observed_changes',
      };
    let sequence: number;
    try {
      const value = JSON.parse(Buffer.from(args.after, 'base64url').toString());
      sequence = value.sequence;
      if (
        value.scope !== scope ||
        value.generation !== journal.generation ||
        !Number.isSafeInteger(sequence) ||
        sequence > journal.sequence ||
        sequence < (journal.events[0]?.sequence ?? journal.sequence + 1) - 1
      )
        throw new Error();
    } catch {
      return {
        ok: false,
        errorCode: 'RESYNC_REQUIRED',
        snapshot,
        next_cursor: cursor(scope, journal),
      };
    }
    const events = journal.events
      .filter((event) => event.sequence > sequence)
      .slice(0, args.limit ?? 50);
    const through = events.at(-1)?.sequence ?? sequence;
    return {
      ok: true,
      snapshot,
      events,
      next_cursor: cursor(scope, journal, through),
      has_more: through < journal.sequence,
      coverage: 'observed_changes',
    };
  }

  private async observe(
    ctx: GithubReadContext,
    pr: PrStatusQuery,
    status: Extract<PrStatusResult, { ok: true }>,
    key: string,
    refresh: boolean,
  ): Promise<Journal> {
    const previous = await ctx.readJournal(key);
    const journal: Journal = previous ?? {
      generation: randomUUID(),
      sequence: 0,
      signatures: {},
      events: [],
    };
    const kinds: GithubDetailKind[] = ['checks', 'threads', 'comments', 'reviews'];
    await ctx.prepareObservation?.(pr, status.headSha ?? '', refresh);
    const details = await Promise.all(
      kinds.map((kind) =>
        ctx.details(pr, kind, status.headSha ?? '', status.baseBranch ?? '', refresh),
      ),
    );
    await ctx.assertCurrent();
    // Never advance a cursor through a failed or truncated observation.
    if (details.some((detail) => detail.partial)) throw new Error('GITHUB_OBSERVATION_INCOMPLETE');
    const facts: Array<[string, GithubFact[]]> = [
      ['head', [{ id: 'head', head_sha: status.headSha }]],
      ['lifecycle', [{ id: 'lifecycle', state: status.status }]],
      ...kinds.map((kind, index): [string, GithubFact[]] => [kind, details[index].items]),
    ];
    const recordEvent = (kind: string, id: string, fact: GithubFact) => {
      const sequence = ++journal.sequence;
      journal.events.push({
        sequence,
        event_id: hash([key, journal.generation, sequence]),
        kind,
        item_id: id,
        observed_at: Date.now(),
        fact,
      });
    };
    for (const [kind, rows] of facts) {
      const signatures: Record<string, string> = {};
      for (const fact of rows) {
        const id = String(fact.id ?? fact.context ?? hash(fact));
        const signature = hash(fact);
        signatures[id] = signature;
        if (previous && journal.signatures[kind]?.[id] !== signature) recordEvent(kind, id, fact);
      }
      for (const id of Object.keys(journal.signatures[kind] ?? {}))
        if (!Object.hasOwn(signatures, id)) recordEvent(kind, id, { id, deleted: true });
      journal.signatures[kind] = signatures;
    }
    // Bounded durable log; an evicted consumer receives RESYNC_REQUIRED.
    journal.events = journal.events.slice(-1000);
    while (journal.events.length && Buffer.byteLength(JSON.stringify(journal)) > 4 * 1024 * 1024)
      journal.events.shift();
    await ctx.assertCurrent();
    await ctx.writeJournal(key, journal);
    return journal;
  }
}
