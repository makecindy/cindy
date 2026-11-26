import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ContributionChanges, AuthorHistoryEvent, MyPluginSummary, SubmissionView } from '../../shared/pluginContributionContract.js';
import type { PluginReviewUpdate } from '../../shared/pluginContributions.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { isPassiveSharedUserDataInstance } from '../authManager.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { ORGANIZATION_REVIEW_ID_PREFIX, type OrganizationReviewSnapshot } from '../../shared/pluginAuthor.js';
import { createPluginAuthorApi, pluginAuthorOwnerKey } from '../plugin-author/host.js';
import { createOrganizationReviewUpdates } from '../plugin-author/reviewUpdates.js';
import { ContributionApi } from './api.js';
import { assertContributionOwner, contributionAccountKey, contributionOwnerKey } from './prepared.js';

type Decision = Omit<PluginReviewUpdate, 'unread'>;
type ReviewCache = { owner: string; token: Pick<ContributionChanges, 'changedAt' | 'eventCount'>; entries: Map<string, Decision | null> };
let cache: ReviewCache | null = null;
let inFlight: { owner: string; task: Promise<PluginReviewUpdate[]> } | null = null;
const readSchema = z.object({ version: z.literal(1), read: z.record(z.string(), z.string()) });
// Organization plugins (#1541) join the same list and read markers under the `org:` prefix.
const organization = createOrganizationReviewUpdates({ api: createPluginAuthorApi, ownerKey: pluginAuthorOwnerKey });

function readFile(): string {
  const account = crypto.createHash('sha256').update(contributionAccountKey()).digest('hex');
  return ownerScopedUserDataPath('plugin-contributions', `review-read-${account}.v1.json`);
}
function readMarkers(file: string): Record<string, string> {
  try { return readSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8'))).read; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError || error instanceof z.ZodError) return {};
    throw error;
  }
}
function decision(pluginId: string, value: SubmissionView | AuthorHistoryEvent): Decision | null {
  const status = 'reviewStatus' in value ? value.reviewStatus : value.type;
  const at = 'decidedAt' in value ? value.decidedAt : value.at;
  const revision = value.revision;
  if (!('reviewStatus' in value) && (status === 'disabled' || status === 'revoked' || status === 'enabled') && at) {
    const marketStatus = value.pluginStatus === 'archived' ? 'archived' : status as 'disabled' | 'revoked' | 'enabled';
    return { pluginId, key: JSON.stringify([value.eventId, marketStatus, at]), status: marketStatus, decidedAt: at,
      releaseId: value.releaseId, version: value.version, sha256: revision?.sha256 ?? null,
      revision: revision?.displayUpdatedAt ?? null };
  }
  if ((status !== 'approved' && status !== 'rejected') || !at || !revision || !value.version) return null;
  const key = JSON.stringify([revision.releaseId, revision.sha256, revision.displayUpdatedAt, status, at]);
  return { pluginId, key, releaseId: revision.releaseId, version: value.version, sha256: revision.sha256,
    revision: revision.displayUpdatedAt, status, decidedAt: at };
}
async function latestDecision(api: ContributionApi, plugin: MyPluginSummary): Promise<Decision | null> {
  const current = plugin.latestSubmission && decision(plugin.pluginId, plugin.latestSubmission);
  // Compare server events with the latest review: either can be the newest result.
  // A pending/cancelled version must not hide an older unread decision.
  const detail = await api.detail(plugin.pluginId);
  let history = detail.history;
  const cursors = new Set<string>();
  for (;;) {
    for (const event of history.events) {
      const result = decision(plugin.pluginId, event);
      if (result) return !current || Date.parse(result.decidedAt) >= Date.parse(current.decidedAt) ? result : current;
    }
    if (!history.nextCursor) return current || null;
    if (cursors.has(history.nextCursor)) throwIpcError('PRECONDITION_FAILED', 'Review history pagination did not advance');
    cursors.add(history.nextCursor);
    history = await api.history(plugin.pluginId, history.nextCursor);
  }
}
/** Public-market results; rereads only when the public change token moves. */
async function refreshPublic(api: ContributionApi): Promise<ReviewCache> {
  const owner = api.owner;
  const token = await api.changes();
  assertContributionOwner(owner);
  const previous = cache?.owner === owner ? cache : null;
  if (previous && previous.token.changedAt === token.changedAt && previous.token.eventCount === token.eventCount) {
    return previous;
  }
  const held: ReviewCache = { owner, token: { changedAt: token.changedAt, eventCount: token.eventCount }, entries: new Map() };
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await api.list({ query: '', filter: 'all', ...(cursor ? { cursor } : {}) });
    assertContributionOwner(owner);
    for (const plugin of page.plugins) {
      const result = await latestDecision(api, plugin);
      assertContributionOwner(owner);
      held.entries.set(plugin.pluginId, result);
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor) {
      if (cursors.has(cursor)) throwIpcError('PRECONDITION_FAILED', 'Plugin pagination did not advance');
      cursors.add(cursor);
    }
  } while (cursor);
  assertContributionOwner(owner);
  cache = held;
  return held;
}

function toUpdates(owner: string, decisions: Decision[]): PluginReviewUpdate[] {
  const markers = readMarkers(readFile());
  assertContributionOwner(owner);
  return decisions.map(value => ({ ...value, unread: markers[value.pluginId] !== value.key }));
}

/** Public-market review results. Organization results are a separate call (see below). */
export async function reviewUpdates(): Promise<PluginReviewUpdate[]> {
  const api = new ContributionApi();
  if (inFlight?.owner === api.owner) return inFlight.task;
  const owner = api.owner;
  const task = refreshPublic(api).then(held =>
    toUpdates(owner, [...held.entries.values()].flatMap(value => value ? [value] : [])));
  inFlight = { owner, task };
  try { return await task; }
  finally { if (inFlight?.task === task) inFlight = null; }
}

/**
 * Organization ("团队共享") review results, read independently of the public ones so a slow or
 * failing side never holds back or drops the other (#1541). Shares the public read markers.
 */
export async function organizationReviewUpdates(): Promise<OrganizationReviewSnapshot> {
  const owner = contributionOwnerKey();
  const decisions = await organization.read();
  return { updates: toUpdates(owner, decisions), changeToken: organization.changeToken() };
}

export function markReviewRead(pluginId: string, key: string): void {
  const api = new ContributionApi();
  assertContributionOwner(api.owner);
  if (isPassiveSharedUserDataInstance()) throwIpcError('PRECONDITION_FAILED', 'Use the active Cindy instance');
  const current = pluginId.startsWith(ORGANIZATION_REVIEW_ID_PREFIX)
    ? organization.isCurrent(pluginId, key)
    : cache?.owner === api.owner && cache.entries.get(pluginId)?.key === key;
  if (!current) throwIpcError('PRECONDITION_FAILED', 'Refresh the review result before marking it read');
  const file = readFile();
  const read = readMarkers(file);
  read[pluginId] = key;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, read }), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
