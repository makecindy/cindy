import { app } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { getActiveAuthRealm, getCurrentUserId, isLocalMode } from '../authManager.js';
import { isAnalyticsAllowed } from '../analytics-settings-store.js';
import { getClientEndpointForRealm } from '../clientEndpointsService.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { serverApiFetch } from '../serverApiClient.desktop.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import { createLogger } from '../logger.js';
import {
  contribution,
  newGrant,
  normalizeHarness,
  publicModel,
  readAccountFirstDay,
  readLedger,
  type Grant,
  type Harness,
} from './ledger.js';

const log = createLogger('product-token-usage');
const day = (time: number) => new Date(time).toISOString().slice(0, 10);
const windowId = (secret: string) => createHash('sha256').update(secret).digest('hex');
const file = () => path.join(app.getPath('userData'), 'product-token-grants-v1.json');
interface AccountGrant extends Grant {
  startsAt: number;
  choices: Record<string, string[]>;
}
type Participation = Grant & { account?: AccountGrant };
const load = (): Record<string, Participation> => JSON.parse(readAtomicFileSync(file()) ?? '{}');
function identity() {
  const user = getCurrentUserId();
  return user && !isLocalMode()
    ? createHash('sha256')
        .update(JSON.stringify([getActiveAuthRealm(), user]))
        .digest('hex')
    : null;
}
let revision = 0;
let active: AbortController | undefined;
let sending = false;
// Frequent turns using the same model should not re-read the grants file.
let seenChoices: { owner: string; day: string; models: Set<string> } | undefined;
export function interruptTokenReporting() {
  revision++;
  seenChoices = undefined;
  active?.abort();
}
export function revokeAllTokenReporting() {
  interruptTokenReporting();
  if (readAtomicFileSync(file()) !== null) atomicWriteFileSync(file(), '{}');
  const snapshot = getCurrentDbClientSnapshot();
  if (snapshot)
    void snapshot.client
      .exec('DELETE FROM token_reporting_window WHERE id=1')
      .then(() =>
        snapshot.client.exec(`DELETE FROM token_reporting_first_day WHERE generation NOT IN
        (SELECT generation FROM token_reporting_window)`),
      )
      .catch(() => log.warn('Local first-day window cleanup deferred'));
}
// Share enrollment across startup, selection and the periodic reporter. Otherwise two
// first visits to the same profile could install different generations in its SQLite worker.
let enrollment:
  | {
      owner: string;
      revision: number;
      snapshot: ReturnType<typeof getCurrentDbClientSnapshot>;
      promise: Promise<void>;
    }
  | undefined;
async function ensureBaseline() {
  const owner = identity();
  const snapshot = getCurrentDbClientSnapshot();
  if (!owner || !isAnalyticsAllowed() || !snapshot || snapshot.userId !== getCurrentUserId())
    return;
  if (load()[owner]?.account?.startsAt) return;
  if (
    enrollment?.owner === owner &&
    enrollment.revision === revision &&
    enrollment.snapshot === snapshot
  )
    return enrollment.promise;
  const version = revision;
  const startsAt = Date.now();
  const start = day(startsAt);
  const generation = randomBytes(32).toString('hex');
  const promise = (async () => {
    const window = windowId(generation);
    await snapshot.client.exec(
      `INSERT INTO token_reporting_window(id,generation,day,starts_at) VALUES(1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,day=excluded.day,starts_at=excluded.starts_at`,
      [window, start, startsAt],
    );
    await snapshot.client.exec(
      `DELETE FROM token_reporting_first_day WHERE generation<>? AND
      EXISTS (SELECT 1 FROM token_reporting_window WHERE id=1 AND generation=?)`,
      [window, window],
    );
    const rows = await readLedger(snapshot.client, start);
    if (
      version !== revision ||
      owner !== identity() ||
      snapshot !== getCurrentDbClientSnapshot() ||
      !isAnalyticsAllowed()
    )
      return;
    const grants = load();
    grants[owner] ??= newGrant(randomBytes(32).toString('hex'), start, rows);
    grants[owner].account = { ...newGrant(generation, start, []), startsAt, choices: {} };
    atomicWriteFileSync(file(), JSON.stringify(grants));
  })();
  enrollment = { owner, revision: version, snapshot, promise };
  try {
    await promise;
  } finally {
    if (enrollment?.promise === promise) enrollment = undefined;
  }
}

export function prepareTokenReporting() {
  void ensureBaseline().catch(() => log.warn('Model usage baseline deferred'));
}

function encodeChoiceEntry(model: string, harness: Harness) {
  return harness === 'unknown' ? model : `h:${harness}:${model}`;
}
function decodeChoiceEntry(entry: string): { model: string; harness: Harness } {
  const match = /^h:(claude-code|codex|pi|auxiliary):(.+)$/.exec(entry);
  return match
    ? { harness: match[1] as Harness, model: match[2]! }
    : { harness: 'unknown', model: entry };
}

// Capture permission and owner at dispatch. Keep just one public choice per UTC day and harness.
export function captureModelChoice(rawModel: string, rawHarness?: string) {
  const owner = identity();
  const version = revision;
  const snapshot = getCurrentDbClientSnapshot();
  if (!owner || !snapshot || snapshot.userId !== getCurrentUserId() || !isAnalyticsAllowed())
    return;
  const usageDay = day(Date.now());
  const harness = normalizeHarness(rawHarness);
  const choice = rawModel?.trim() || 'unknown';
  const dispatchModel = ['auto', 'automatic', 'default'].includes(choice.toLowerCase())
    ? 'auto'
    : publicModel(choice);
  return async (automatic = false) => {
    const model = automatic ? 'auto' : dispatchModel;
    const entry = encodeChoiceEntry(model, harness);
    if (version !== revision || !isAnalyticsAllowed() || owner !== identity()) return;
    if (
      seenChoices?.owner === owner &&
      seenChoices.day === usageDay &&
      seenChoices.models.has(entry)
    )
      return;
    await ensureBaseline();
    if (
      revision !== version ||
      owner !== identity() ||
      snapshot !== getCurrentDbClientSnapshot() ||
      !isAnalyticsAllowed()
    )
      return;
    const grants = load();
    const account = grants[owner]?.account;
    if (!account || usageDay < account.day) return;
    const oldest = day(Date.now() - 89 * 86400000);
    for (const d of Object.keys(account.choices)) if (d < oldest) delete account.choices[d];
    const choices = (account.choices[usageDay] ??= []);
    if (!choices.includes(entry)) {
      choices.push(entry);
      atomicWriteFileSync(file(), JSON.stringify(grants));
    }
    seenChoices = { owner, day: usageDay, models: new Set(choices) };
  };
}

export async function reportTokenUsage() {
  if (sending) return;
  sending = true;
  const cancel = new AbortController();
  active = cancel;
  try {
    const owner = identity();
    if (!owner || !isAnalyticsAllowed()) return;
    await ensureBaseline();
    if (cancel.signal.aborted || identity() !== owner) return;
    const grant = load()[owner];
    const snapshot = getCurrentDbClientSnapshot();
    if (!grant || !snapshot || snapshot.userId !== getCurrentUserId()) return;
    const realm = getActiveAuthRealm();
    const baseUrl = getClientEndpointForRealm(realm, 'modelAccessApiBaseUrl');
    const guard = () => {
      if (
        cancel.signal.aborted ||
        identity() !== owner ||
        snapshot !== getCurrentDbClientSnapshot() ||
        !isAnalyticsAllowed() ||
        getClientEndpointForRealm(realm, 'modelAccessApiBaseUrl') !== baseUrl
      )
        throw new Error('Profile changed');
    };
    const oldest = day(Date.now() - 89 * 86400000);
    const rows = await readLedger(snapshot.client, grant.day > oldest ? grant.day : oldest);
    const today = day(Date.now());
    async function sendBatch(body: object) {
      const response = await serverApiFetch<{ accepted: boolean }>(
        '/api/model-access/product-token-usage',
        {
          method: 'POST',
          body,
          baseUrl: () => baseUrl,
          beforeHop: guard,
          signal: cancel.signal,
          timeoutMs: 15000,
          redactErrorDetails: true,
          skipAutoRefresh: true,
          skipSessionInvalidation: true,
        },
      );
      guard();
      if (response?.accepted !== true) throw new Error('Unacknowledged batch');
    }
    const partialDay =
      grant.account && grant.account.day >= oldest
        ? await readAccountFirstDay(
            snapshot.client,
            grant.account.day,
            grant.account.startsAt,
            windowId(grant.account.secret),
          )
        : [];
    for (const version of [1, 2] as const) {
      const stream = version === 1 ? grant : grant.account;
      if (!stream) continue;
      const streamRows =
        version === 1 ? rows : [...partialDay, ...rows.filter((row) => row.day > stream.day)];
      const dirty = streamRows.flatMap((row) => {
        if (row.day < stream.day || row.day > today) return [];
        const c = contribution(stream, row);
        return c && stream.acknowledged[c.day + ':' + c.cell] !== c.counts.join(',') ? [c] : [];
      });
      const choices =
        version === 2
          ? Object.entries(grant.account!.choices).flatMap(([day, entries]) =>
              day >= oldest && day <= today
                ? entries
                    .filter((entry) => !stream.acknowledged[day + ':choice:' + entry])
                    .map((entry) => ({ entry, payload: { day, ...decodeChoiceEntry(entry) } }))
                : [],
            )
          : [];
      for (
        let cellOffset = 0, choiceOffset = 0;
        cellOffset < dirty.length || choiceOffset < choices.length;
      ) {
        const cells = dirty.slice(cellOffset, cellOffset + 64);
        const selected = choices.slice(choiceOffset, choiceOffset + 64 - cells.length);
        await sendBatch(
          version === 1
            ? { version, cells }
            : { version, cells, choices: selected.map((item) => item.payload) },
        );
        const grants = load();
        const stored = version === 1 ? grants[owner] : grants[owner]?.account;
        if (!stored || stored.secret !== stream.secret) return;
        for (const key of Object.keys(stored.acknowledged)) {
          if (key.slice(0, 10) < oldest) delete stored.acknowledged[key];
        }
        if (stored.day < oldest) stored.baseline = {};
        if (version === 2) {
          const history = grants[owner].account!.choices;
          for (const d of Object.keys(history)) if (d < oldest) delete history[d];
        }
        for (const c of cells) stored.acknowledged[c.day + ':' + c.cell] = c.counts.join(',');
        for (const c of selected) stored.acknowledged[c.payload.day + ':choice:' + c.entry] = '1';
        atomicWriteFileSync(file(), JSON.stringify(grants));
        cellOffset += cells.length;
        choiceOffset += selected.length;
      }
    }
  } catch {
    if (!cancel.signal.aborted) log.warn('daily aggregates deferred to next report');
  } finally {
    active = undefined;
    sending = false;
  }
}
