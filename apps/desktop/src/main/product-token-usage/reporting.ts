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
import { contribution, newGrant, readLedger, type Grant } from './ledger.js';

const log = createLogger('product-token-usage');
const day = (time: number) => new Date(time).toISOString().slice(0, 10);
const file = () => path.join(app.getPath('userData'), 'product-token-grants-v1.json');
const load = (): Record<string, Grant> => JSON.parse(readAtomicFileSync(file()) ?? '{}');
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
export function interruptTokenReporting() {
  revision++;
  active?.abort();
}
export function revokeAllTokenReporting() {
  interruptTokenReporting();
  if (readAtomicFileSync(file()) !== null) atomicWriteFileSync(file(), '{}');
}
export function tokenReportingEnabled() {
  const owner = identity();
  if (!owner) return false;
  try {
    return !!load()[owner];
  } catch {
    log.warn('Cannot read model usage participation setting');
    return false;
  }
}
export async function setTokenReporting(enabled: boolean) {
  const owner = identity();
  if (!owner) throw new Error('Signed-in profile required');
  interruptTokenReporting();
  const version = revision;
  if (!enabled) {
    const grants = load();
    delete grants[owner];
    atomicWriteFileSync(file(), JSON.stringify(grants));
    return;
  }
  const snapshot = getCurrentDbClientSnapshot();
  if (!isAnalyticsAllowed() || !snapshot || snapshot.userId !== getCurrentUserId())
    throw new Error('Profile unavailable');
  if (load()[owner]) return;
  const start = day(Date.now());
  const rows = await readLedger(snapshot.client, start);
  if (
    owner !== identity() ||
    snapshot !== getCurrentDbClientSnapshot() ||
    version !== revision ||
    !isAnalyticsAllowed()
  )
    throw new Error('Profile changed');
  const grants = load();
  grants[owner] = newGrant(randomBytes(32).toString('hex'), start, rows);
  atomicWriteFileSync(file(), JSON.stringify(grants));
}

export async function reportTokenUsage() {
  if (sending) return;
  sending = true;
  const cancel = new AbortController();
  active = cancel;
  try {
    const owner = identity();
    if (!owner || !isAnalyticsAllowed()) return;
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
    const dirty = rows.flatMap((row) => {
      if (row.day > today) return [];
      const c = contribution(grant, row);
      return c && grant.acknowledged[c.day + ':' + c.cell] !== c.counts.join(',') ? [c] : [];
    });
    for (let i = 0; i < dirty.length; i += 64) {
      const cells = dirty.slice(i, i + 64);
      const response = await serverApiFetch<{ accepted: boolean }>(
        '/api/model-access/product-token-usage',
        {
          method: 'POST',
          body: { version: 1, cells },
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
      const grants = load();
      if (grants[owner]?.secret !== grant.secret) return;
      for (const key of Object.keys(grants[owner].acknowledged)) {
        if (key.slice(0, 10) < oldest) delete grants[owner].acknowledged[key];
      }
      if (grants[owner].day < oldest) grants[owner].baseline = {};
      for (const c of cells) grants[owner].acknowledged[c.day + ':' + c.cell] = c.counts.join(',');
      atomicWriteFileSync(file(), JSON.stringify(grants));
    }
  } catch {
    if (!cancel.signal.aborted) log.warn('daily aggregates deferred to next report');
  } finally {
    active = undefined;
    sending = false;
  }
}
