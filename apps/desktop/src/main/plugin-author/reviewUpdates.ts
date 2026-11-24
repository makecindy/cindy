/**
 * Review results of organization plugins for the unread dots (#1541).
 *
 * Driven by the author change signal (`GET /api/personal/plugins/changes`): the author list is
 * re-read only when `changedAt` or `eventCount` moves; the list is never polled on its own. Results share the public read
 * markers under the `org:` prefix, so reading state stays per account on this computer.
 */
import {
  ORGANIZATION_REVIEW_ID_PREFIX,
  organizationReviewDecision,
  type PersonalPluginChanges,
  type PersonalPluginSummary,
} from '../../shared/pluginAuthor.js';
import type { PluginReviewUpdate } from '../../shared/pluginContributions.js';
import type { PluginAuthorApi } from './api.js';

/** Bounds a runaway list; each batch is already up to 20 pages of 100. */
const MAX_LIST_BATCHES = 5;

export type OrganizationDecision = Omit<PluginReviewUpdate, 'unread'>;

interface Cache {
  owner: string;
  token: PersonalPluginChanges;
  entries: Map<string, OrganizationDecision>;
}

/**
 * The latest review event of one plugin as the server reports it (#1593): an approval, a return
 * or an administrator delisting. Pending, cancelled and author actions are not events and leave
 * no dot.
 */
export function organizationDecision(plugin: PersonalPluginSummary): OrganizationDecision | null {
  const decision = organizationReviewDecision(plugin);
  if (!decision) return null;
  return {
    pluginId: `${ORGANIZATION_REVIEW_ID_PREFIX}${plugin.id}`,
    key: decision.key,
    status: decision.status,
    decidedAt: decision.at,
    releaseId: decision.releaseId,
    version: decision.version,
    sha256: null,
    revision: null,
  };
}

export function createOrganizationReviewUpdates(deps: {
  api: () => Pick<PluginAuthorApi, 'changes' | 'listPages'>;
  ownerKey: () => string | null;
}) {
  let cache: Cache | null = null;
  // Several windows check at once; like the public results, one account shares one read
  // (Greptile review on #12469).
  let inFlight: { owner: string; task: Promise<OrganizationDecision[]> } | null = null;

  async function read(): Promise<OrganizationDecision[]> {
    const owner = deps.ownerKey();
    if (!owner) return [];
    if (inFlight?.owner === owner) return inFlight.task;
    const task = load(owner);
    inFlight = { owner, task };
    try { return await task; }
    finally { if (inFlight?.task === task) inFlight = null; }
  }

  async function load(owner: string): Promise<OrganizationDecision[]> {
    const api = deps.api();
    const token: PersonalPluginChanges = await api.changes();
    if (deps.ownerKey() !== owner) return [];
    if (cache?.owner === owner && cache.token.changedAt === token.changedAt && cache.token.eventCount === token.eventCount) {
      return [...cache.entries.values()];
    }
    const entries = new Map<string, OrganizationDecision>();
    let cursor: string | null = null;
    for (let batch = 0; batch < MAX_LIST_BATCHES; batch += 1) {
      const page = await api.listPages(cursor);
      if (deps.ownerKey() !== owner) return [];
      for (const plugin of page.plugins) {
        const decision = organizationDecision(plugin);
        if (decision) entries.set(decision.pluginId, decision);
      }
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    cache = { owner, token, entries };
    return [...entries.values()];
  }

  return {
    read,
    /** Whether `key` is the current result of this organization plugin (guards read markers). */
    isCurrent(pluginId: string, key: string): boolean {
      return cache?.owner === deps.ownerKey() && cache?.entries.get(pluginId)?.key === key;
    },
    /**
     * The last change signal read for the current owner. It moves on any author-visible change
     * (a new plugin, becoming a maintainer, a submission), not only on review results, so the team
     * list can follow it without polling the list itself.
     */
    changeToken(): string | null {
      return cache && cache.owner === deps.ownerKey()
        ? JSON.stringify([cache.token.changedAt, cache.token.eventCount]) : null;
    },
  };
}
