import { createHash } from 'node:crypto';
import { existsSync, readdirSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { meResponseSchema } from '@cindy/auth-client';
import { dailyUploadSlot, latestUploadableDay } from './enterpriseDailyUpload.js';
import { CompanyTokenQueue, projectUsage, type CompanyPolicy } from './companyTokenQueue.js';
import type { CaptureCompanyUsage, CompanyExecutionReporting, CompanyModelTokens, CompanyTurnBoundary } from './companyTokenFacts.js';

const POLICY_CHECK_INTERVAL_MS = 12 * 60 * 60_000;
const RETRY_INTERVAL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface ReportingIdentity {
  orgId: string;
  member: string;
  owner: string;
  generation: number;
  base: string;
  device: string;
  token: string;
}

export interface ReportingRuntime {
  dir: string;
  identity(): ReportingIdentity | null;
  recovering(): boolean;
  isAnalyticsAllowed(): boolean;
  subscribeAuth(listener: () => void): () => void;
  subscribeSettings(listener: (allowed: boolean, explicitEnabled?: boolean) => void): () => void;
  direct(provider: string, kind: 'claude-code' | 'codex' | 'pi'): boolean;
  fetch(url: string, init: RequestInit): Promise<Response>;
}
type Policy = CompanyPolicy & {
  participating: boolean;
  models: Set<string>;
  generation: number;
  until: number;
};

class CompanyAuthorizationError extends Error {}

function projectTurn(models: ReadonlySet<string>, day: string, samples: readonly CompanyModelTokens[]) {
  return samples.flatMap(sample => {
    const row = projectUsage(models, day, sample.model, sample);
    return row ? [row] : [];
  });
}

export function createCompanyTokenReportingCore(ports: ReportingRuntime) {
  const { identity, isAnalyticsAllowed } = ports;
  const current = (id: ReportingIdentity) => {
    const active = identity();
    return (
      active?.owner === id.owner && active.generation === id.generation && active.base === id.base
    );
  };

  async function sendRequest(signal: AbortSignal, id: ReportingIdentity, route: string, method = 'GET', body?: object) {
    if (!current(id)) throw new Error('Company identity changed');
    const response = await ports.fetch(id.base + route, {
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
  let requests = new AbortController();
  let uploads = new AbortController();
  const request = (id: ReportingIdentity, route: string, method?: string, body?: object) => {
    // Finish an in-flight withdrawal before sending a subsequent enable for the same member.
    const signal = route.endsWith('/participation')
      ? requests.signal
      : AbortSignal.any([requests.signal, uploads.signal]);
    return sendRequest(signal, id, route, method, body);
  };
  const { dir } = ports;
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
  let ownerPhase: 'initial' | 'active' | 'recovering' | 'inactive' = 'initial';
  let syncing = false;
  let rerun = false;
  let disposed = false;
  const visible = (checkedIdentity?: ReportingIdentity | null) => {
    if (!policy || disposed || !isAnalyticsAllowed()) return null;
    const who = checkedIdentity === undefined ? identity() : checkedIdentity;
    return who?.owner === policy.owner &&
      who.generation === policy.generation &&
      Date.now() < policy.until
      ? policy
      : null;
  };
  const endpoint = (id: ReportingIdentity) =>
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
        if (!ports.recovering()) purge();
        return;
      }
      const offFile = optOutFile(who.owner);
      const onFile = offFile + '.enable';
      const localOff = existsSync(offFile);
      const allowed = isAnalyticsAllowed();
      const localOn = allowed && existsSync(onFile);
      if (!allowed && !localOff) {
        purge();
        policy = null;
        return;
      }
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
          if (!existsSync(file) || (target && !isAnalyticsAllowed())) continue;
          if (participating !== target) {
            await request(who, endpoint(who) + '/participation', 'PUT', { participating: target });
            if (!current(who) || invalidation !== version) return;
            participating = target;
          }
          rmSync(file, { force: true });
        }
        rerun = participating && isAnalyticsAllowed();
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
      // The outboxes can outlive the process that last read their owner. Check scope on disk
      // before disclosing even a receipt identifier to another organization's endpoint.
      const owned = new Map<string, ReturnType<CompanyTokenQueue['scope']>>();
      for (const file of files) {
        const outbox = delegated(file);
        try {
          const stored = outbox.scope();
          if (stored.owner === who.owner) owned.set(file, stored);
          else outbox.clear();
        } catch {
          // Leave unreadable data in place without blocking other receipts or the local batch.
        }
      }
      const ids = [...new Set([...liveReceipts.keys(), ...owned.keys()])];
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
          const previousScope = owned.get(id) ?? outbox.scope();
          if (previousScope.owner !== who.owner) continue;
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
  function capture(): CaptureCompanyUsage | undefined {
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
  }
  function captureBoundary(): CompanyTurnBoundary | undefined {
    const who = identity();
    const initial = visible(who);
    if (!who || !initial?.participating) return;
    const { device, base } = who;
    const version = invalidation;
    const day = new Date().toISOString().slice(0, 10);
    return model => {
      const executor = identity();
      const active = visible(executor);
      return version === invalidation && active?.participating === true &&
        executor?.device === device && executor.base === base &&
        active.owner === initial.owner && active.generation === initial.generation &&
        active.orgRevision === initial.orgRevision && active.memberRevision === initial.memberRevision &&
        new Date().toISOString().slice(0, 10) === day &&
        (model === undefined || active.models.has(model));
    };
  }
  const execution: CompanyExecutionReporting = {
    direct: ports.direct,
    captureBoundary,
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
      const boundary = captureBoundary();
      const who = identity();
      if (!boundary || !who) return;
      const data = await (
        await request(who, endpoint(who) + '/redeem', 'POST', { nonce, grant })
      ).json();
      if (
        !current(who) ||
        !boundary() ||
        !receiptId.test(data.receipt) ||
        !Number.isSafeInteger(data.expires) ||
        data.expires <= Date.now() ||
        data.day !== new Date().toISOString().slice(0, 10) ||
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
      const usable = () => boundary() && liveReceipts.has(data.receipt) && Date.now() < data.expires;
      return {
        receipt: data.receipt,
        current: usable,
        record(samples) {
          const active = visible();
          if (!active || !usable()) return;
          const rows = projectTurn(active.models, data.day, samples);
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
  };
  let lastAllowed = isAnalyticsAllowed();
  const onOwner = (force: boolean) => {
    const id = identity();
    const phase = id ? 'active' : ports.recovering() ? 'recovering' : 'inactive';
    const owner = id?.owner ?? (phase === 'recovering' ? activeOwner : null);
    if (phase !== ownerPhase || owner !== activeOwner || (id?.generation ?? -1) !== activeGeneration) {
      invalidation++;
      requests.abort();
      requests = new AbortController();
      policy = null;
      liveReceipts.clear();
      // A cloud identity can be temporarily unavailable during cold start. Only resume the
      // same member's scoped data after the membership and both switches are revalidated.
      if (phase === 'inactive' || (id && activeOwner && (activeOwner !== id.owner || ownerPhase === 'active'))) purge();
      activeOwner = owner;
      lastAllowed = isAnalyticsAllowed();
      activeGeneration = id?.generation ?? -1;
      ownerPhase = phase;
    } else if (!force) {
      return;
    }
    if (id || phase !== 'recovering') void refresh();
  };
  let timer = setTimeout(() => {
    if (identity()) void refresh();
  }, POLICY_CHECK_INTERVAL_MS);
  timer.unref();
  const unsubscribe = ports.subscribeAuth(() => onOwner(false));
  const unsubscribeSettings = ports.subscribeSettings((allowed, explicitEnabled) => {
    if (allowed === lastAllowed && explicitEnabled === undefined) return;
    lastAllowed = allowed;
    uploads.abort();
    uploads = new AbortController();
    invalidation++;
    policy = null;
    purge();
    const who = identity();
    if (who && explicitEnabled !== undefined) {
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
    capture,
    execution,
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
