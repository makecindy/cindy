import { readCompanyTokenReportingPreference } from '../analytics-settings-store.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { effectiveXdGatewayBaseUrl } from '../model-access/effectiveEndpoint.js';
import { directCompanyTokenRoute } from './companyTokenRoute.js';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync, rmSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { app, net } from 'electron';
import { meResponseSchema } from '@cindy/auth-client';
import * as auth from '../authManager.js';
import { getClientEndpointForRealm } from '../clientEndpointsService.js';
import { dailyUploadSlot, latestUploadableDay } from './enterpriseDailyUpload.js';
import { CompanyTokenQueue, projectUsage, type CompanyPolicy } from './companyTokenQueue.js';
import { installCompanyUsageCapture, installExecutionReporting, type CompanyModelTokens } from './companyTokenFacts.js';

const POLICY_CHECK_INTERVAL_MS = 12 * 60 * 60_000;
const RETRY_INTERVAL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

function identity() {
  const state = auth.getAuthState();
  const user = state.user;
  const token = auth.getAccessToken();
  if (
    state.mode !== 'cloud' ||
    !state.isAuthenticated ||
    !state.canEnterApp ||
    !user?.orgId ||
    user.membershipKind !== 'org' ||
    !token
  )
    return null;
  const realm = auth.getActiveAuthRealm();
  return {
    owner: JSON.stringify([realm, user.orgId, user.id]),
    orgId: user.orgId,
    member: user.id,
    token,
    generation: state.ownerGeneration,
    base: getClientEndpointForRealm(realm, 'authApiBaseUrl'),
    device: state.deviceId,
  };
}
type Identity = NonNullable<ReturnType<typeof identity>>;
type Policy = CompanyPolicy & {
  participating: boolean;
  models: Set<string>;
  generation: number;
  until: number;
};
const current = (id: Identity) => {
  const active = identity();
  return (
    active?.owner === id.owner && active.generation === id.generation && active.base === id.base
  );
};

class CompanyAuthorizationError extends Error {}
async function sendRequest(signal: AbortSignal, id: Identity, route: string, method = 'GET', body?: object) {
  if (!current(id)) throw new Error('Company identity changed');
  const response = await net.fetch(id.base + route, {
    method,
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    headers: {
      Authorization: 'Bearer ' + id.token,
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
  });
  if ([401, 403, 404, 409].includes(response.status)) throw new CompanyAuthorizationError();
  if (!response.ok) throw new Error('Company request failed');
  return response;
}

function projectTurn(models: ReadonlySet<string>, day: string, samples: readonly CompanyModelTokens[]) {
  return samples.flatMap(sample => {
    const row = projectUsage(models, day, sample.model, sample);
    return row ? [row] : [];
  });
}

export function createCompanyTokenReporting(
  subscribe: (listener: (personalAnalyticsAllowed: boolean, explicitEnabled?: boolean) => void) => () => void,
) {
  let requests = new AbortController();
  let uploads = new AbortController();
  const request = (id: Identity, route: string, method?: string, body?: object) => {
    // Finish an in-flight withdrawal before sending a subsequent enable for the same member.
    const signal = route.endsWith('/participation')
      ? requests.signal
      : AbortSignal.any([requests.signal, uploads.signal]);
    return sendRequest(signal, id, route, method, body);
  };
  const dir = app.getPath('userData');
  const queue = new CompanyTokenQueue(path.join(dir, 'company-token-outbox.json'));
  const delegatedDir = path.join(dir, 'company-token-executor');
  const receiptId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const delegated = (id: string) => new CompanyTokenQueue(path.join(delegatedDir, id));
  const liveReceipts = new Map<string, number>();
  const purge = () => {
    liveReceipts.clear();
    queue.clear();
    rmSync(delegatedDir, { recursive: true, force: true });
  };
  // This local preference also suppresses reporting while a disconnected opt-out is waiting to sync.
  const optOutFile = (owner: string) =>
    path.join(dir, 'company-token-opt-out-' + createHash('sha256').update(owner).digest('hex'));
  let policy: Policy | null = null;
  let invalidation = 0;
  let activeOwner: string | null = null;
  let activeGeneration = -1;
  let syncing = false;
  let rerun = false;
  let disposed = false;
  // Re-read on policy or preference changes; model turns only consult this in-memory decision.
  let localPreference: boolean | null = null;
  const visible = () => {
    if (localPreference !== true || !policy || Date.now() >= policy.until) return null;
    const who = identity();
    return who?.owner === policy.owner && who.generation === policy.generation ? policy : null;
  };
  const endpoint = (id: Identity) =>
    '/api/orgs/' + encodeURIComponent(id.orgId) + '/company-token-reporting';
  const refresh = async () => {
    if (disposed) return;
    if (syncing) {
      rerun = true;
      return;
    }
    syncing = true;
    clearTimeout(timer);
    const version = invalidation;
    let policyLoaded = false;
    let nextRefreshAt = Date.now() + POLICY_CHECK_INTERVAL_MS;
    try {
      const who = identity();
      if (!who) {
        policy = null;
        purge();
        return;
      }
      const offFile = optOutFile(who.owner);
      const onFile = offFile + '.enable';
      const localOff = existsSync(offFile);
      localPreference = readCompanyTokenReportingPreference();
      if (localPreference === null || (!localPreference && !localOff)) {
        if (policy) invalidation++;
        policy = null;
        if (localPreference === null) {
          liveReceipts.clear();
          nextRefreshAt = Date.now() + RETRY_INTERVAL_MS;
        } else {
          purge();
        }
        return;
      }
      const localOn = localPreference && existsSync(onFile);
      const me = meResponseSchema.parse(await (await request(who, '/api/me')).json());
      if (!current(who) || invalidation !== version) return;
      const rule = me.membership.companyTokenReporting;
      if (
        me.membership.kind !== 'org' ||
        me.membership.id !== who.member ||
        me.membership.orgId !== who.orgId
      ) {
        policy = null;
        purge();
        return;
      }
      if (!rule) {
        policy = null;
        purge();
        // An enable for this login cannot enroll the member into a future company policy.
        rmSync(onFile, { force: true });
        return;
      }
      // Apply withdrawals before re-enrollment, including after a lost response or restart.
      // Only an explicit action on the unified switch may undo a previous member opt-out.
      if (localOff || localOn) {
        policy = null;
        purge();
        let participating = rule.participating;
        for (const [file, target] of [[offFile, false], [onFile, true]] as const) {
          if (!existsSync(file) || (target && !localPreference)) continue;
          if (participating !== target) {
            await request(who, endpoint(who) + '/participation', 'PUT', { participating: target });
            if (!current(who) || invalidation !== version) return;
            participating = target;
          }
          rmSync(file, { force: true });
        }
        rerun = participating && localPreference;
        return;
      }
      const previous = policy;
      const same =
        previous?.owner === who.owner &&
        previous.orgRevision === rule.orgRevision &&
        previous.memberRevision === rule.memberRevision &&
        previous.generation === who.generation;
      if (previous && !same) purge();
      policy = {
        owner: who.owner,
        generation: who.generation,
        orgRevision: rule.orgRevision,
        memberRevision: rule.memberRevision,
        participating: rule.participating,
        models: new Set(rule.models),
        until: Date.now() + POLICY_CHECK_INTERVAL_MS + REQUEST_TIMEOUT_MS,
      };
      policyLoaded = true;
      if (!policy.participating) {
        purge();
        return;
      }
      const scope = {
        owner: who.owner,
        orgRevision: rule.orgRevision,
        memberRevision: rule.memberRevision,
      };
      const cutoff = latestUploadableDay(Date.now(), dailyUploadSlot(who.device));
      const sameOwner = () => visible()?.participating && current(who) && invalidation === version;
      for (const [id, exp] of liveReceipts) if (exp <= Date.now()) liveReceipts.delete(id);
      const files = existsSync(delegatedDir)
        ? readdirSync(delegatedDir).filter((id) => receiptId.test(id))
        : [];
      const ids = [...new Set([...liveReceipts.keys(), ...files])];
      for (let i = 0; i < ids.length && sameOwner(); i += 256) {
        const receipts = ids.slice(i, i + 256);
        const checked = await (
          await request(who, endpoint(who) + '/receipts/check', 'POST', { receipts })
        ).json();
        if (!Array.isArray(checked?.receipts) || !sameOwner()) return;
        for (const id of receipts) {
          if (!sameOwner()) return;
          const outbox = delegated(id);
          if (!checked.receipts.includes(id)) {
            liveReceipts.delete(id);
            outbox.clear();
            continue;
          }
          if (!existsSync(path.join(delegatedDir, id))) continue;
          const previousScope = outbox.scope();
          if (previousScope.owner !== who.owner) {
            outbox.clear();
            continue;
          }
          while (sameOwner()) {
            const batch = outbox.next(previousScope, cutoff);
            if (!batch) break;
            await request(who, endpoint(who) + '/receipts/' + id + '/batches', 'POST', batch);
            if (!sameOwner()) return;
            outbox.acknowledge(previousScope, batch.batchId);
          }
        }
      }
      while (visible()?.participating && current(who) && invalidation === version) {
        const batch = queue.next(scope, cutoff);
        if (!batch) break;
        await request(who, endpoint(who) + '/batches', 'POST', batch);
        if (!current(who) || invalidation !== version) break;
        queue.acknowledge(scope, batch.batchId);
      }
    } catch (error) {
      if (version === invalidation) {
        if (!policyLoaded || error instanceof CompanyAuthorizationError) policy = null;
        // Temporary failures must not postpone policy discovery or a durable withdrawal for 12 hours.
        if (!(error instanceof CompanyAuthorizationError)) nextRefreshAt = Date.now() + RETRY_INTERVAL_MS;
      }
    } finally {
      syncing = false;
      if (rerun) {
        rerun = false;
        void refresh();
      } else if (!disposed) {
        timer = setTimeout(() => void refresh(), Math.max(0, nextRefreshAt - Date.now()));
        timer.unref();
      }
    }
  };
  installCompanyUsageCapture(() => {
    const initial = visible();
    if (!initial?.participating) return;
    const version = invalidation;
    return (samples) => {
      const p = visible();
      if (
        version !== invalidation ||
        !p?.participating ||
        p.owner !== initial.owner ||
        p.orgRevision !== initial.orgRevision ||
        p.memberRevision !== initial.memberRevision
      )
        return;
      const rows = projectTurn(p.models, new Date().toISOString().slice(0, 10), samples);
      if (rows.length) {
        try {
          queue.add(
            { owner: p.owner, orgRevision: p.orgRevision, memberRevision: p.memberRevision },
            rows,
          );
        } catch {
          /* Model execution is independent of the reporting store. */
        }
      }
    };
  });
  installExecutionReporting({
    direct(id, kind) {
      try {
        const route = getActiveCatalog().providers.find((entry) => entry.id === id)?.routing[kind];
        return directCompanyTokenRoute(id, route, effectiveXdGatewayBaseUrl());
      } catch {
        return false;
      }
    },
    available() {
      return visible()?.participating === true;
    },
    challenge(nonce) {
      const p = visible(),
        who = identity();
      if (!p?.participating || !who) return null;
      return {
        nonce,
        recipient: createHash('sha256')
          .update(JSON.stringify([who.member, who.device, nonce]))
          .digest('hex'),
      };
    },
    async issue(challenge) {
      const p = visible(),
        who = identity();
      if (!p?.participating || !who) return null;
      const version = invalidation;
      const data = await (
        await request(who, endpoint(who) + '/grants', 'POST', {
          ...challenge,
          orgRevision: p.orgRevision,
          memberRevision: p.memberRevision,
        })
      ).json();
      return current(who) &&
        invalidation === version &&
        visible()?.participating &&
        typeof data.grant === 'string'
        ? data.grant
        : null;
    },
    async redeem(nonce, grant) {
      const p = visible(),
        who = identity();
      if (!p?.participating || !who) return;
      const version = invalidation;
      const data = await (
        await request(who, endpoint(who) + '/redeem', 'POST', { nonce, grant })
      ).json();
      if (
        !current(who) ||
        invalidation !== version ||
        !receiptId.test(data.receipt) ||
        !Number.isSafeInteger(data.expires) ||
        !Number.isSafeInteger(data.orgRevision) ||
        !Number.isSafeInteger(data.memberRevision)
      )
        return;
      const scope = {
        owner: who.owner,
        orgRevision: data.orgRevision,
        memberRevision: data.memberRevision,
      };
      liveReceipts.set(data.receipt, data.expires);
      return {
        receipt: data.receipt,
        record(samples) {
          const active = visible();
          if (
            !active?.participating ||
            active.generation !== who.generation ||
            active.owner !== who.owner ||
            invalidation !== version ||
            !liveReceipts.has(data.receipt) ||
            Date.now() >= data.expires
          )
            return;
          const day = new Date().toISOString().slice(0, 10);
          if (day !== data.day) return;
          const rows = projectTurn(active.models, day, samples);
          if (!rows.length) return;
          try {
            mkdirSync(delegatedDir, { recursive: true, mode: 0o700 });
            delegated(data.receipt).add(scope, rows);
          } catch {
            /* A recording failure must never interrupt a remote run. */
          }
        },
      };
    },
  });
  const onOwner = (force: boolean) => {
    const id = identity();
    if ((id?.owner ?? null) !== activeOwner || (id?.generation ?? -1) !== activeGeneration) {
      invalidation++;
      requests.abort();
      requests = new AbortController();
      if (activeOwner || !id) purge();
      activeOwner = id?.owner ?? null;
      activeGeneration = id?.generation ?? -1;
      policy = null;
    } else if (!force) {
      return;
    }
    void refresh();
  };
  let timer = setTimeout(() => {
    if (identity()) void refresh();
  }, POLICY_CHECK_INTERVAL_MS);
  timer.unref();
  const unsubscribe = auth.onAuthStateChange(() => onOwner(false));
  const unsubscribeSettings = subscribe((_personalAnalyticsAllowed, explicitEnabled) => {
    const who = identity();
    if (!who || (explicitEnabled === undefined &&
        (who.owner !== activeOwner || who.generation !== activeGeneration))) return;
    const allowed = readCompanyTokenReportingPreference();
    if (allowed === localPreference && explicitEnabled === undefined) return;
    localPreference = allowed;
    uploads.abort();
    uploads = new AbortController();
    invalidation++;
    policy = null;
    if (allowed === false || explicitEnabled === false) purge();
    else liveReceipts.clear();
    if (explicitEnabled !== undefined) {
      const offFile = optOutFile(who.owner);
      if (!explicitEnabled) {
        rmSync(offFile + '.enable', { force: true });
        writeFileSync(offFile, '', { mode: 0o600 });
      } else if (allowed) {
        writeFileSync(offFile + '.enable', '', { mode: 0o600 });
      }
    }
    // Serialize preference requests; uploads use a separately cancellable signal.
    void refresh();
  });
  return {
    refresh: () => onOwner(true),
    dispose() {
      disposed = true;
      clearTimeout(timer);
      unsubscribe();
      unsubscribeSettings();
      requests.abort();
      invalidation++;
      policy = null;
    },
  };
}
