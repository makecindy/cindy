import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { effectiveXdGatewayBaseUrl } from '../model-access/effectiveEndpoint.js';
import { directCompanyTokenRoute } from './companyTokenRoute.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { app, net } from 'electron';
import { meResponseSchema } from '@cindy/auth-client';
import * as auth from '../authManager.js';
import { getClientEndpointForRealm } from '../clientEndpointsService.js';
import { dailyUploadSlot, latestUploadableDay } from './enterpriseDailyUpload.js';
import { CompanyTokenQueue, projectUsage, type CompanyPolicy } from './companyTokenQueue.js';
import { installCompanyUsageCapture, installExecutionReporting } from './companyTokenFacts.js';

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

async function request(id: Identity, route: string, method = 'GET', body?: object) {
  if (!current(id)) throw new Error('Company identity changed');
  const response = await net.fetch(id.base + route, {
    method,
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
    headers: {
      Authorization: 'Bearer ' + id.token,
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
  });
  if (!response.ok) throw new Error('Company request failed');
  return response;
}

export function createCompanyTokenReporting() {
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
  const noticeFile = (p: Policy) =>
    path.join(dir, 'company-token-notice-' + createHash('sha256').update(p.owner).digest('hex'));
  const hasNotice = (p: Policy) => {
    try {
      return readFileSync(noticeFile(p), 'utf8') === String(p.orgRevision);
    } catch {
      return false;
    }
  };
  let policy: Policy | null = null;
  let invalidation = 0;
  let activeOwner: string | null = null;
  let activeGeneration = -1;
  let syncing = false;
  let rerun = false;
  const visible = () => {
    const who = identity();
    return policy &&
      who?.owner === policy.owner &&
      who.generation === policy.generation &&
      Date.now() < policy.until
      ? policy
      : null;
  };
  const endpoint = (id: Identity) =>
    '/api/orgs/' + encodeURIComponent(id.orgId) + '/company-token-reporting';
  const refresh = async () => {
    if (syncing) {
      rerun = true;
      return;
    }
    syncing = true;
    const version = invalidation;
    try {
      const who = identity();
      if (!who) {
        policy = null;
        purge();
        return;
      }
      const me = meResponseSchema.parse(await (await request(who, '/api/me')).json());
      if (!current(who) || invalidation !== version) return;
      const rule = me.membership.companyTokenReporting;
      if (
        !rule ||
        me.membership.kind !== 'org' ||
        me.membership.id !== who.member ||
        me.membership.orgId !== who.orgId
      ) {
        policy = null;
        purge();
        return;
      }
      const localOff = existsSync(optOutFile(who.owner));
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
        participating: rule.participating && !localOff,
        models: new Set(rule.models),
        until: Date.now() + 6 * 60_000,
      };
      if (!policy.participating) {
        purge();
        if (localOff) {
          if (rule.participating)
            await request(who, endpoint(who) + '/participation', 'PUT', { participating: false });
          if (current(who) && invalidation === version)
            rmSync(optOutFile(who.owner), { force: true });
        }
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
    } catch {
      if (version === invalidation) policy = null;
    } finally {
      syncing = false;
      if (rerun) {
        rerun = false;
        void refresh();
      }
    }
  };
  installCompanyUsageCapture(() => {
    const initial = visible();
    if (!initial?.participating || !hasNotice(initial)) return;
    const version = invalidation;
    return (model, counts) => {
      const p = visible();
      if (
        version !== invalidation ||
        !p?.participating ||
        p.owner !== initial.owner ||
        p.orgRevision !== initial.orgRevision ||
        p.memberRevision !== initial.memberRevision
      )
        return;
      const row = projectUsage(p.models, new Date().toISOString().slice(0, 10), model, counts);
      if (row) {
        try {
          queue.add(
            { owner: p.owner, orgRevision: p.orgRevision, memberRevision: p.memberRevision },
            row,
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
      const p = visible();
      return !!p?.participating && hasNotice(p);
    },
    challenge(nonce) {
      const p = visible(),
        who = identity();
      if (!p?.participating || !who || !hasNotice(p)) return null;
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
      if (!p?.participating || !who || !hasNotice(p)) return null;
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
      if (!p?.participating || !who || !hasNotice(p)) return;
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
        record(model, counts) {
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
          const row = projectUsage(active.models, day, model, counts);
          if (!row) return;
          try {
            mkdirSync(delegatedDir, { recursive: true, mode: 0o700 });
            delegated(data.receipt).add(scope, row);
          } catch {
            /* A recording failure must never interrupt a remote run. */
          }
        },
      };
    },
  });
  const onOwner = () => {
    const id = identity();
    if ((id?.owner ?? null) !== activeOwner || (id?.generation ?? -1) !== activeGeneration) {
      invalidation++;
      if (activeOwner || !id) purge();
      activeOwner = id?.owner ?? null;
      activeGeneration = id?.generation ?? -1;
      policy = null;
    }
    void refresh();
  };
  const unsubscribe = auth.onAuthStateChange(onOwner);
  const timer = setInterval(() => {
    if (identity()) void refresh();
  }, 5 * 60_000);
  timer.unref();
  return {
    refresh: onOwner,
    dispose() {
      clearInterval(timer);
      unsubscribe();
      invalidation++;
      policy = null;
    },
    view() {
      const p = visible();
      return p
        ? { participating: p.participating, generation: p.generation, needsNotice: !hasNotice(p) }
        : null;
    },
    noted(generation: number) {
      const p = visible();
      if (p && p.generation === generation)
        writeFileSync(noticeFile(p), String(p.orgRevision), { mode: 0o600 });
    },
    async set(participating: boolean, generation: number) {
      const p = visible(),
        who = identity();
      if (!p || p.generation !== generation || !who || typeof participating !== 'boolean')
        throw new Error('Company statistics unavailable');
      invalidation++;
      const file = optOutFile(who.owner);
      if (!participating) {
        p.participating = false;
        purge();
        writeFileSync(file, '', { mode: 0o600 });
      }
      await request(who, endpoint(who) + '/participation', 'PUT', { participating });
      if (!current(who)) return;
      rmSync(file, { force: true });
      await refresh();
    },
  };
}
