import { createHash } from 'node:crypto';
import { eq, lt, sql } from 'drizzle-orm';
import { getDeviceId } from '../authManager';
import { getCurrentDbClientSnapshot } from '../localDb/client/current';
import { githubObservations } from '../localDb/schema';
import { outboundFetch } from '../maker-host/outbound-fetch.desktop';
import { readGithubTokenDetailed } from './githubToken.desktop.js';
import { GithubReadService, type Journal } from './githubReadService';
import { GithubReadTransport } from './githubReadTransport';
import { readGithubDetails, readGithubFirstPages, type Connection } from './githubPrDetails';
import type { PrStatusService } from './prStatusService';

export const githubTransport = new GithubReadTransport(outboundFetch);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export async function githubReadScope(): Promise<string> {
  const account = getCurrentDbClientSnapshot();
  const read = await readGithubTokenDetailed();
  if (account !== getCurrentDbClientSnapshot()) throw new Error('ACCOUNT_CHANGED');
  return `${account?.userId ?? 'none'}:${account?.clientEpoch ?? 0}:${read.ok ? digest(read.token) : 'no-token'}`;
}

/** 自动化「指定 PR 或 Issue」的识别结果；只含识别所需的公开信息。 */
export type GithubItemResolution =
  | { ok: true; kind: 'pr' | 'issue'; title: string; state: 'open' | 'closed' }
  | { ok: false; reason: 'not-connected' | 'not-found' | 'unavailable' };

/**
 * GitHub 的 PR 与 Issue 共用编号；Issues 接口对两者都返回，PR 带 pull_request 字段。
 * 复用账号级的条件读取与限速，不缓存失败。
 */
export async function resolveGithubItem(repository: string, number: number): Promise<GithubItemResolution> {
  if (!/^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/i.test(repository) || !Number.isSafeInteger(number) || number < 1) {
    return { ok: false, reason: 'not-found' };
  }
  const read = await readGithubTokenDetailed();
  if (!read.ok) return { ok: false, reason: 'not-connected' };
  try {
    const scope = await githubReadScope();
    const data = await githubTransport.read(scope, read.token, `/repos/${repository.toLowerCase()}/issues/${number}`, { ttl: 60_000 }) as {
      title?: unknown; state?: unknown; pull_request?: unknown;
    };
    return {
      ok: true,
      kind: data.pull_request ? 'pr' : 'issue',
      title: typeof data.title === 'string' ? data.title.slice(0, 300) : '',
      state: data.state === 'closed' ? 'closed' : 'open',
    };
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (status === 404 || status === 410) return { ok: false, reason: 'not-found' };
    if (status === 401) return { ok: false, reason: 'not-connected' };
    return { ok: false, reason: 'unavailable' };
  }
}

/** Give GithubClient the same conditional transport and identity-wide rate-limit budget. */
export function githubStatusFetch(token: string): typeof fetch {
  return async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.origin !== 'https://api.github.com') throw new Error('INVALID_GITHUB_ORIGIN');
    const account = getCurrentDbClientSnapshot();
    const scope = `${account?.userId ?? 'none'}:${account?.clientEpoch ?? 0}:${digest(token)}`;
    const data = await githubTransport.read(scope, token, url.pathname + url.search, {
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
      ttl: 0,
    });
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

export function createGithubReadService(statusService: PrStatusService): GithubReadService {
  const seeds = new Map<string, { at: number; pages: Record<string, Connection> }>();
  return new GithubReadService(async () => {
    const account = getCurrentDbClientSnapshot();
    if (!account) throw new Error('HOST_NOT_READY');
    const read = await readGithubTokenDetailed();
    if (!read.ok) throw new Error(read.reason);
    const scope = digest(`${account.userId}:${read.token}`);
    const transportScope = await githubReadScope();
    const assertCurrent = async () => {
      if (account !== getCurrentDbClientSnapshot() || transportScope !== (await githubReadScope()))
        throw new Error('ACCOUNT_CHANGED');
    };
    await assertCurrent();
    const db = account.client.drizzle;
    // Only first pages prepared by this read may bypass an explicit refresh below.
    let prepared: { key: string; at: number; pages: Record<string, Connection> } | undefined;
    return {
      scope,
      sourceDevice: getDeviceId(),
      assertCurrent,
      status: async (pr, refresh) =>
        (await statusService.getStatuses([pr], { refresh, waitForFresh: true }))[0],
      prepareObservation: async (pr, head, refresh) => {
        const { pages, observedAt } = await readGithubFirstPages(
          githubTransport,
          transportScope,
          read.token,
          pr,
          head,
          refresh,
        );
        await assertCurrent();
        if (seeds.size >= 200) seeds.delete(seeds.keys().next().value!);
        const key = `${transportScope}:${pr.owner}/${pr.repo}#${pr.prNumber}:${head}`;
        prepared = { key, at: observedAt, pages };
        seeds.set(key, prepared);
      },
      details: (pr, kind, head, base, refresh) => {
        const key = `${transportScope}:${pr.owner}/${pr.repo}#${pr.prNumber}:${head}`;
        const cached = prepared?.key === key ? prepared : !refresh ? seeds.get(key) : undefined;
        const seed =
          cached && cached.at + 60_000 > Date.now()
            ? structuredClone(cached.pages[kind])
            : undefined;
        return readGithubDetails({
          transport: githubTransport,
          scope: transportScope,
          token: read.token,
          pr,
          kind,
          head,
          base,
          refresh,
          seed,
          seedObservedAt: seed ? cached?.at : undefined,
        });
      },
      readJournal: async (key) => {
        await assertCurrent();
        const [row] = await db
          .select()
          .from(githubObservations)
          .where(eq(githubObservations.key, key))
          .limit(1);
        return row ? (JSON.parse(row.state) as Journal) : null;
      },
      writeJournal: async (key, value) => {
        await assertCurrent();
        const now = Date.now();
        await db
          .insert(githubObservations)
          .values({ key, state: JSON.stringify(value), updatedAt: now })
          .onConflictDoUpdate({
            target: githubObservations.key,
            set: { state: JSON.stringify(value), updatedAt: now },
          });
        await db
          .delete(githubObservations)
          .where(lt(githubObservations.updatedAt, now - 30 * 86400_000));
        await db
          .delete(githubObservations)
          .where(
            sql`${githubObservations.key} in (select key from github_observations order by updated_at desc limit -1 offset 200)`,
          );
        await assertCurrent();
      },
    };
  });
}
