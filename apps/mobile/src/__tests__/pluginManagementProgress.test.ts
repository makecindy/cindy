import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceLinkError } from '@cindy/device-link';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { createPluginManagementClient, type PluginManagementInvoke } from '@/plugins/pluginManagementClient';
import { createPluginManagementController, nextDetachedStep } from '@/plugins/pluginManagementController';
import type { PluginManagementReceipt } from '@/plugins/pluginManagementTypes';
import { createPluginManagementSlot, pluginOperationHold } from '@/plugins/pluginManagementSlot';
import { SLOT_WHO, capability, confirmation, controller, controllers, deferred, detail, eventually, host, manifest, plugin, receipt, shownCancel, snapshot, uiConfirmation, type Envelope } from './pluginManagementFixtures';

vi.mock('expo-crypto', () => ({ randomUUID: () => 'operation-1' }));
// The model check of pluginManagement.test.ts, moved unchanged into its own file: it alone takes about 3 s, which put
// that file over the per-file budget (engineering-conventions §3.2). Same fixtures, same tier (unit, in-memory Host).
beforeEach(() => { setMobileAuthOwner('owner'); });
afterEach(() => { controllers.forEach((value) => value.dispose()); controllers.length = 0; vi.useRealTimers(); });

// Maintainer review 13:02 (liveness): a late write receipt and a reconnect lookup overwrote each other and verification
// stopped (A: late begin consent after Allow already ran → unknown with no next poll; B: late begin `running` while a
// lookup held busy, then the lookup's `succeeded` dropped → stuck in progress); an answer written with its reply lost,
// after a later lookup still found the same consent, left both buttons disabled with nothing to tap or poll.
// Model check from begin in flight, against a stand-in Host that moves on by itself (accepted → consent → after an
// answer running → final). Events: going offline or online; each request's check before the write (in queue order,
// as on one link), its delivery or lost reply (any order); the Host moving on; a poll timer firing; Allow, Reject or
// Check result whenever tappable. States already seen are pruned, so deeper orders (about ten steps) are reached.
// After every step: ①–⑤ as above, plus ⑥ a non-final operation with nothing in flight on an online computer has a
// poll scheduled or a tappable consent; ⑦ the phase shown never goes back behind one the Host has reached and the
// phone has shown. At every leaf, ⑧ after releasing everything in flight and letting polls run (no taps), the phone
// shows the Host's real result. Minimal failing inputs: the two orders above and the stuck consent (ea3874b2).
// Tier: unit (in-memory Host, fake timers).
describe('progress only moves forward and never stops', () => {
  type Kind = 'begin' | 'answer' | 'operation' | 'cancel';
  type Item = { kind: Kind; seq: number; confirmed?: boolean; stage: 'queued' | 'written'; epoch: number; arrived: boolean;
    dequeue(): void; arrive(): void; deliver(): void; lose(): void; refuse(): void };
  const lostError = () => { const error = new DeviceLinkError('INVOKE_TIMEOUT', 'no reply after first socket write'); error.inFlight = true; return error; };
  const notFound = () => Object.assign(new Error('[NOT_FOUND] gone'), { code: 'NOT_FOUND' });
  const POLL = 1000;
  // `promptOnAccept`: the Host shows the consent before answering begin; `consent: false`: an operation without one.
  function rig(hostOptions: { promptOnAccept?: boolean; consent?: boolean; lookupInvalid?: boolean } = {}) {
    const host = { phase: 'none' as 'none' | 'accepted' | 'confirmation' | 'running' | 'succeeded' | 'cancelled', allowed: false, answersWritten: 0 };
    const hostReceipt = (): PluginManagementReceipt | null => host.phase === 'none' ? null
      : host.phase === 'confirmation' ? confirmation() : receipt(host.phase === 'accepted' ? 'running' : host.phase);
    const pending: Item[] = [], transit: Item[] = [];
    let connection = 0, seq = 0;
    // This replay's own timers (the controller's scheduler), so liveness never counts another path's poll.
    const timers: Array<{ run: () => void; delayMs: number }> = [];
    const scheduler = { set: (run: () => void, delayMs: number) => { const timer = { run, delayMs }; timers.push(timer); return timer; },
      clear: (handle: unknown) => { const index = timers.indexOf(handle as typeof timers[number]); if (index >= 0) timers.splice(index, 1); } };
    const sent = { lookups: 0, snapshots: 0 };
    // Every management request written, in order, and every request asked for (written or not).
    const writes: string[] = [], asked: string[] = [];
    // Consents the view put on screen, and the consent each cancel was asked for (⑫).
    const shown = new Set<string>(), cancelledConsents: Array<string | undefined> = [];
    const settle = (item: Item) => { const index = pending.indexOf(item); if (index >= 0) pending.splice(index, 1); };
    const invoke = (async (_id: string, channel: string, args?: unknown[], options?: { preSend?: () => void; onRequestWritten?: () => void; onNotSent?: () => void }) => {
      options?.preSend?.();
      const request = args?.[0] as Envelope | undefined;
      const action = request?.actionId?.replace('management:', '');
      if (!['begin', 'answer', 'operation', 'cancel'].includes(action ?? '')) {
        options?.preSend?.(); options?.onRequestWritten?.();
        if (channel.endsWith(':manifest')) return capability;
        if (action === 'snapshot') { sent.snapshots += 1; return { effects: [], result: snapshot() }; }
        if (action === 'market-detail') return { effects: [], result: detail };
        throw new Error('unexpected ' + action);
      }
      if (action === 'operation') sent.lookups += 1;
      if (action === 'cancel') cancelledConsents.push(c.getState().receipt?.consent?.requestId);
      asked.push(action!);
      return new Promise((resolve, reject) => {
        let reply: (() => void) | undefined;
        const item: Item = { kind: action as Kind, seq: ++seq, stage: 'queued', epoch: connection, arrived: false,
          confirmed: (request!.input as { confirmed?: boolean }).confirmed,
          dequeue: () => {
            try { options?.preSend?.(); } catch (error) { settle(item); reject(error); return; }
            options?.onRequestWritten?.();
            item.stage = 'written';
            writes.push(item.kind);
            if (item.kind === 'answer') host.answersWritten += 1;
            // Written; it reaches the Host later (it may still arrive after its reply was given up on).
            transit.push(item);
          },
          // The Host takes the request now and answers with its state at that moment.
          arrive: () => {
            transit.splice(transit.indexOf(item), 1);
            item.arrived = true;
            if (item.kind === 'begin' && host.phase === 'none') host.phase = hostOptions.promptOnAccept ? 'confirmation' : 'accepted';
            if (item.kind === 'answer' && host.phase === 'confirmation') { host.phase = 'running'; host.allowed = !!item.confirmed; }
            if (item.kind === 'cancel' && ['accepted', 'confirmation', 'running'].includes(host.phase)) host.phase = 'cancelled';
            const captured = hostReceipt();
            reply = () => {
              if (item.kind === 'operation' && hostOptions.lookupInvalid) resolve({ effects: [], result: { phase: 'nonsense' } });
              else if (captured) resolve({ effects: [], result: captured }); else reject(notFound());
            };
          },
          deliver: () => { settle(item); reply!(); },
          lose: () => { settle(item); reject(lostError()); },
          // Refused before its first write (the link said no): never written.
          refuse: () => { settle(item); options?.onNotSent?.(); reject(new Error('refused before the first write')); },
        };
        pending.push(item);
      });
    }) as unknown as PluginManagementInvoke;
    const c = createPluginManagementController(createPluginManagementClient({ deviceId: 'host-1', invoke }),
      { createOperationId: () => 'operation-1', pollIntervalMs: POLL, scheduler });
    controllers.push(c);
    // The page slot held for this operation, and its view: shown, or gone (driven as usePluginManagement does).
    const slot = createPluginManagementSlot();
    const token = slot.tryAcquire('update', SLOT_WHO)!;
    const hold = pluginOperationHold(slot, token);
    const view = { detached: false, gone: false, steps: [] as string[], lostCheck: false };
    let stopReview: (() => void) | undefined;
    const review = () => {
      if (!view.detached || view.gone) return;
      const next = nextDetachedStep(c);
      if (next === 'letGo') {
        view.gone = true; view.steps.push('letGo');
        // ⑪ evidence: what the controller still had when it was let go (a written, unsettled operation must not be).
        view.lostCheck = !!c.pendingCheck();
        stopReview?.(); c.dispose();
      }
      else if (next === 'cancel') { view.steps.push('cancel'); void c.cancel(); }
    };
    return { c, host, pending, transit, timers, sent, writes, asked, slot, token, hold, view, shown, cancelledConsents,
      consentless: hostOptions.consent === false, toggle: () => { connection += 1; }, connection: () => connection,
      leave: () => { view.detached = true; stopReview = c.subscribe(review); review(); },
      back: () => { view.detached = false; stopReview?.(); stopReview = undefined; },
      // Done with this replay: its controller and timers go before the next path starts.
      dispose: () => { stopReview?.(); c.dispose(); controllers.splice(controllers.indexOf(c), 1); timers.length = 0; } };
  }
  // 40 microtask turns settle every step: the explored state set is identical to 100 turns (same fingerprint hash, 2026-11-26).
  const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  type R = ReturnType<typeof rig>;
  const finalOutcome = (o: string) => o === 'succeeded' || o === 'cancelled' || o === 'failed';
  const tappable = (r: R) => { const st = r.c.getState(); return st.outcome === 'confirmation' && st.online && !st.busy && !st.answerHeld; };
  async function step(r: R, event: string, counts: Record<string, number>) {
    const [name, at] = event.split('#');
    const item = at !== undefined ? [...r.pending, ...r.transit].find((entry) => entry.seq === Number(at)) : undefined;
    counts[name] = (counts[name] ?? 0) + 1;
    if (name === 'offline') { r.toggle(); r.c.setOnline(false); }
    else if (name === 'online') { r.toggle(); r.c.setOnline(true); }
    else if (name === 'allow' || name === 'reject') void r.c.answer(name === 'allow');
    else if (name === 'check' || name === 'recordCheck') void r.c.reconcile();
    else if (name === 'host') {
      if (r.host.phase === 'accepted') r.host.phase = r.consentless ? 'succeeded' : 'confirmation';
      else if (r.host.phase === 'running') r.host.phase = r.host.allowed ? 'succeeded' : 'cancelled';
    } else if (name === 'tick') r.timers.shift()?.run();
    else if (name === 'leave') r.leave();
    else if (name === 'return') r.back();
    else if (name === 'refuse') item!.refuse();
    else if (name === 'dequeue') item!.dequeue();
    else if (name === 'arrive') item!.arrive();
    else if (name === 'deliver') item!.deliver();
    else item!.lose();
    await flush();
    // A view on screen shows the consent it has (the sheet marks it); a view gone shows nothing.
    const consent = r.c.getState().receipt?.consent?.requestId;
    if (!r.view.detached && !r.view.gone && r.c.getState().outcome === 'confirmation' && consent) { r.c.markConsentShown(consent); r.shown.add(consent); }
  }
  function enabled(r: R, counts: Record<string, number>): string[] {
    const st = r.c.getState(), list: string[] = [];
    if (st.online && !counts.offline) list.push('offline');
    if (!st.online && !counts.online) list.push('online');
    // Taps need the view on screen.
    if (!r.view.detached && tappable(r) && (counts.allow ?? 0) + (counts.reject ?? 0) < 2) list.push('allow', 'reject');
    if (!r.view.detached && st.outcome === 'unknown' && st.online && !st.busy && !counts.check) list.push('check');
    // Maintainer review 20:45: "Check result" from the list of pending checks, the view gone (it may find a consent nobody
    // saw, for example after begin's reply was lost and the lookups stopped).
    if (r.view.detached && !r.view.gone && st.outcome === 'unknown' && st.online && !st.busy && !counts.recordCheck) list.push('recordCheck');
    if ((r.host.phase === 'accepted' || r.host.phase === 'running') && (counts.host ?? 0) < 3) list.push('host');
    if (r.timers.length > 0 && (counts.tick ?? 0) < 3) list.push('tick');
    const firstQueued = r.pending.find((entry) => entry.stage === 'queued');
    if (firstQueued) list.push(`dequeue#${firstQueued.seq}`);
    // Maintainer review 17:43: the view going away and coming back, and a cancel refused before its first write.
    // (Leaving once, between requests; coming back once, while nothing is in flight: the orders that matter, without
    // multiplying every interleaving.)
    if (!r.view.detached && !r.view.gone && !counts.leave && !firstQueued) list.push('leave');
    if (r.view.detached && !r.view.gone && !counts.return && r.pending.length === 0) list.push('return');
    if (firstQueued?.kind === 'cancel') list.push(`refuse#${firstQueued.seq}`);
    // Requests reach the Host in the order they were written; a reply comes only after that, a lost one any time.
    if (r.transit.length) list.push(`arrive#${r.transit[0].seq}`);
    for (const entry of r.pending) if (entry.stage === 'written') {
      if (entry.arrived) list.push(`deliver#${entry.seq}`);
      list.push(`lose#${entry.seq}`);
    }
    return list;
  }
  function check(r: R, shown: { rank: number }, path: string): string | null {
    const st = r.c.getState();
    // ⑩ One cancel at most, asked for and written; never after an answer was written; the slot never goes while a write
    // of this operation is still on its way, and is never left held by a controller that was let go.
    if (r.asked.filter((kind) => kind === 'cancel').length > 1) return `⑩ cancel asked for twice (${path})`;
    const firstAnswer = r.writes.indexOf('answer'), cancelAt = r.writes.indexOf('cancel');
    if (firstAnswer >= 0 && cancelAt > firstAnswer) return `⑩ cancel written after an answer (${path})`;
    // The computer's slot is this operation's alone here (its first token, or one it took back after waiting for a check).
    const slotHeld = !!r.slot.holder('host-1');
    if (!slotHeld && r.pending.some((entry) => entry.kind !== 'operation'))
      return `⑩ slot released with a ${r.pending.find((entry) => entry.kind !== 'operation')!.kind} in flight (${path})`;
    if (r.view.gone && slotHeld) return `⑩ slot held by a controller that was let go (${path})`;
    // ⑫ (maintainer review 20:45, dispatcher L-2) Nothing the list of pending checks or a gone view drives writes: a
    // cancel is only ever asked for a consent the view showed; an answer only comes from a tap on a view on screen.
    const unseen = r.cancelledConsents.find((id) => !id || !r.shown.has(id));
    if (r.cancelledConsents.length && unseen !== undefined) return `⑫ cancel of a consent never shown (${path})`;
    // ⑪ (maintainer review 18:45) An operation whose begin was written keeps a pending check until its final result,
    // whatever happens to its view or the connection (offline, leaving, lookups stopped, the receipt gone): it is never
    // let go before that. While the check waits for the person, the computer's slot is free; while the operation moves
    // on by itself, it holds the slot.
    if (r.view.lostCheck) return `⑪ a written operation was let go before its final result (${path})`;
    if (r.view.gone) return null;
    const check = r.c.pendingCheck();
    if (r.writes.includes('begin') && !finalOutcome(st.outcome) && !check) return `⑪ written and unsettled, but no pending check (${path})`;
    if (check?.waiting && slotHeld) return `⑪ slot kept by a result waiting to be checked (${path})`;
    if (check && !check.waiting && r.pending.length === 0 && !st.busy && !slotHeld)
      return `⑪ moving on by itself without its computer's slot (${path})`;
    if (tappable(r) && r.pending.some((entry) => entry.kind === 'answer')) return `① tappable while an answer is in flight (${path})`;
    if (r.host.answersWritten > 1) return `② ${r.host.answersWritten} answers written (${path})`;
    if (r.pending.filter((entry) => entry.kind === 'operation' && entry.epoch === r.connection()).length > 1) return `③ two lookups in flight (${path})`;
    if (st.busy && r.pending.length === 0) return `⑤ busy with nothing in flight (${path})`;
    const open = !!st.operationId && ['running', 'confirmation', 'unknown'].includes(st.outcome);
    if (open && st.online && r.pending.length === 0 && !st.busy && !tappable(r) && r.timers.length === 0
      && !(st.outcome === 'unknown' && st.missingReceiptFacts !== undefined && st.missingReceiptFacts !== null))
      return `⑥ stuck: ${st.outcome}${st.answerHeld ? ' (answer held)' : ''} with nothing in flight and no poll (${path})`;
    const rank = st.outcome === 'confirmation' ? 1 : st.outcome === 'running' ? (r.host.answersWritten > 0 && r.host.phase !== 'confirmation' ? 2 : 0)
      : finalOutcome(st.outcome) ? 3 : -1;
    if (rank >= 0 && rank < shown.rank) return `⑦ went back to ${st.outcome} (${path})`;
    shown.rank = Math.max(shown.rank, rank);
    return null;
  }
  async function drain(r: R) {
    const counts: Record<string, number> = {};
    for (let i = 0; i < 60; i++) {
      if (!r.c.getState().online) { await step(r, 'online', counts); continue; }
      const queued = r.pending.find((entry) => entry.stage === 'queued');
      if (queued) { await step(r, `dequeue#${queued.seq}`, counts); continue; }
      if (r.transit.length) { await step(r, `arrive#${r.transit[0].seq}`, counts); continue; }
      const written = r.pending.find((entry) => entry.stage === 'written' && entry.arrived);
      if (written) { await step(r, `deliver#${written.seq}`, counts); continue; }
      if (r.host.phase === 'accepted' || r.host.phase === 'running') { await step(r, 'host', counts); continue; }
      if (r.timers.length > 0) { await step(r, 'tick', counts); continue; }
      break;
    }
    // A result waiting for the person (lookups stopped, the receipt gone) is settled by their "Check result", once.
    if (!r.view.gone && r.c.pendingCheck()?.waiting) {
      await step(r, 'check', counts);
      for (let i = 0; i < 20; i++) {
        const next = r.pending.find((entry) => entry.stage === 'queued') ?? r.transit[0] ?? r.pending.find((entry) => entry.stage === 'written' && entry.arrived);
        if (!next) break;
        await step(r, `${next.stage === 'queued' ? 'dequeue' : r.transit.includes(next) ? 'arrive' : 'deliver'}#${next.seq}`, counts);
      }
    }
    const st = r.c.getState();
    // Let go: this phone stopped following it (nothing written for that); it must not hold the slot.
    if (r.view.gone) return r.slot.holder('host-1') ? '⑩ slot held after letting go' : r.view.lostCheck ? '⑪ written operation let go' : null;
    if (r.host.phase === 'none') return st.outcome === 'failed' ? null : `⑧ Host never took the begin, phone shows ${st.outcome}`;
    if (r.host.phase === 'confirmation') return tappable(r) ? null : `⑧ Host waits for an answer, phone shows ${st.outcome}${st.answerHeld ? ' (held)' : ''}`;
    return st.outcome === r.host.phase ? null : `⑧ Host ${r.host.phase}, phone shows ${st.outcome}`;
  }
  async function replay(events: string[]) {
    const r = rig();
    await r.c.refresh();
    void r.c.install(detail, plugin, r.hold);
    await flush();
    const counts: Record<string, number> = {}, shown = { rank: -1 };
    // ⑨ pace: within lookups that bring nothing new from the Host, the delay never shrinks (see the controller's pace).
    const sig = () => { const st = r.c.getState(); return JSON.stringify([st.receipt?.phase, st.receipt?.consent?.requestId]); };
    let pace: { delay: number; sig: string } | null = null;
    for (let i = 0; i < events.length; i++) {
      const lostLookup = events[i].startsWith('lose#')
        && r.pending.some((entry) => entry.kind === 'operation' && `lose#${entry.seq}` === events[i]);
      const snapshotsBefore = r.sent.snapshots;
      if (['online', 'offline', 'check', 'allow', 'reject'].includes(events[i])) pace = null;
      if (events[i] === 'tick' && r.timers.length) {
        const delay = r.timers[0].delayMs, now = sig();
        if (pace && pace.sig === now && delay < pace.delay)
          return { violation: `⑨ lookup delay shrank ${pace.delay} → ${delay} without progress (${events.slice(0, i + 1).join(' → ')})`, r, counts, next: [] as string[] };
        pace = { delay, sig: now };
      }
      await step(r, events[i], counts);
      const path = events.slice(0, i + 1).join(' → ');
      // ⑨ Automatic lookups are bounded by the timer firings (plus reconnects and taps); a failed lookup reads no snapshot.
      if (r.sent.lookups > (counts.tick ?? 0) + (counts.online ?? 0) + (counts.check ?? 0) + 1)
        return { violation: `⑨ ${r.sent.lookups} lookups for ${counts.tick ?? 0} timer firings (${path})`, r, counts, next: [] as string[] };
      if (lostLookup && r.sent.snapshots > snapshotsBefore)
        return { violation: `⑨ snapshot read after a failed lookup (${path})`, r, counts, next: [] as string[] };
      const violation = check(r, shown, path);
      if (violation) return { violation, r, counts, next: [] as string[] };
    }
    return { violation: null, r, counts, next: enabled(r, counts) };
  }
  const fingerprint = (r: R, counts: Record<string, number>) => JSON.stringify([r.host, r.c.getState().outcome, r.c.getState().busy,
    r.c.getState().answerHeld, r.c.getState().online, r.c.getState().receipt?.phase, r.timers.length,
    r.pending.map((entry) => [entry.kind, entry.stage, entry.arrived, entry.confirmed, entry.epoch === r.connection()]),
    r.transit.map((entry) => [entry.kind, entry.confirmed]), r.view.detached, r.view.gone, r.c.cancelPhase(), r.writes, counts, [...r.shown]]);
  // The maintainer's orders, as plain regressions (each fails on ea3874b2 and e46ff0aa).
  const run = async (r: R, events: string[]) => { const counts = {}; for (const event of events) await step(r, event, counts); };
  it('A: a late begin consent after Allow already ran neither goes back nor stops the polling', async () => {
    {
      const r = rig({ promptOnAccept: true });
      await r.c.refresh(); void r.c.install(detail, plugin); await flush();
      await run(r, ['dequeue#1', 'arrive#1', 'offline', 'online', 'dequeue#2', 'arrive#2', 'deliver#2']);
      expect(r.c.getState().outcome).toBe('confirmation');
      await run(r, ['allow', 'dequeue#3', 'arrive#3', 'deliver#3']);
      expect(r.c.getState().outcome).toBe('running');
      await run(r, ['deliver#1']);                                 // the begin's consent arrives late
      expect(r.c.getState().outcome).toBe('running');
      await run(r, ['host', 'tick']);                              // the Host finishes; the next poll shows it
      const lookup = r.pending.find((entry) => entry.kind === 'operation')!;
      await run(r, [`dequeue#${lookup.seq}`, `arrive#${lookup.seq}`, `deliver#${lookup.seq}`]);
      expect(r.c.getState()).toMatchObject({ outcome: 'succeeded', busy: false });
    }
  });
  it('B: a final outcome from the reconnect lookup lands after a late begin running', async () => {
    {
      const r = rig({ consent: false });
      await r.c.refresh(); void r.c.uninstall(plugin); await flush();
      await run(r, ['dequeue#1', 'arrive#1', 'offline', 'online', 'host', 'dequeue#2', 'arrive#2', 'deliver#1', 'deliver#2']);
      expect(r.c.getState()).toMatchObject({ outcome: 'succeeded', busy: false });
    }
  });
  it('a written answer whose reply is lost after a later lookup still found its consent becomes checkable, then settles', async () => {
    {
      const r = rig();
      await r.c.refresh(); void r.c.install(detail, plugin); await flush();
      await run(r, ['dequeue#1', 'arrive#1', 'deliver#1', 'host', 'tick', 'dequeue#2', 'arrive#2', 'deliver#2']);
      expect(r.c.getState().outcome).toBe('confirmation');
      await run(r, ['allow', 'dequeue#3', 'offline', 'online', 'dequeue#4', 'arrive#4', 'deliver#4']);
      expect(r.c.getState()).toMatchObject({ outcome: 'confirmation', answerHeld: 'consent-1' });
      await run(r, ['lose#3']);                                    // the answer's reply is lost
      // Not a dead end: a checkable unknown result whose answer stays locked, looked up by itself.
      expect(r.c.getState()).toMatchObject({ outcome: 'unknown', answerHeld: 'consent-1', busy: false });
      expect(r.timers.length).toBeGreaterThan(0);
      await run(r, ['arrive#3', 'host', 'tick']);                  // the answer reached the Host after all; it finishes
      const lookup = r.pending.find((entry) => entry.kind === 'operation')!;
      await run(r, [`dequeue#${lookup.seq}`, `arrive#${lookup.seq}`, `deliver#${lookup.seq}`]);
      expect(r.c.getState()).toMatchObject({ outcome: 'succeeded' });
      expect(r.host.answersWritten).toBe(1);
    }
  });
  it('keeps every invariant after every step, and reaches the Host result without taps', async () => {
    const violations = new Set<string>(), seen = new Set<string>();
    let leaves = 0;
    const explore = async (events: string[]): Promise<void> => {
      const { violation, r, counts, next } = await replay(events);
      if (violation) { violations.add(violation); r.dispose(); return; }
      const key = fingerprint(r, counts);
      if (seen.has(key)) { r.dispose(); return; }
      seen.add(key);
      if (!next.length || events.length >= 10) {
        leaves += 1;
        const end = await drain(r);
        if (end) violations.add(`${end} (${events.join(' → ')})`);
        r.dispose();
        return;
      }
      r.dispose();
      for (const event of next) await explore([...events, event]);
    };
    await explore([]);
    expect([...violations].slice(0, 8)).toEqual([]);
    expect(leaves).toBeGreaterThan(200);
  }, 30_000);
  // Maintainer review 14:18 #1: a lookup that keeps failing while the computer stays online made one lookup and one
  // extra snapshot read per second, for as long as the failure lasted. Now: no snapshot on a failed lookup, lookups
  // back off and stop after a few failures (a protocol error stops them at once); "Check result" stays available, and
  // coming back online starts over. Minimal failing input: a written begin whose reply is lost, then lookups that time out.
  it('backs off and stops automatic lookups that keep failing, without reading a snapshot each time', async () => {
    const r = rig();
    await r.c.refresh(); void r.c.install(detail, plugin); await flush();
    await run(r, ['dequeue#1', 'arrive#1', 'lose#1']);          // the begin's reply is lost: unknown
    expect(r.c.getState().outcome).toBe('unknown');
    const snapshots = r.sent.snapshots, delays: number[] = [];
    for (let i = 0; i < 10 && r.timers.length; i++) {
      delays.push(r.timers[0].delayMs);
      await run(r, ['tick']);
      const lookup = r.pending.find((entry) => entry.kind === 'operation')!;
      await run(r, [`dequeue#${lookup.seq}`, `arrive#${lookup.seq}`, `lose#${lookup.seq}`]);
    }
    expect(r.sent.lookups).toBe(4);
    expect(delays).toEqual([POLL, 2 * POLL, 4 * POLL, 8 * POLL]);
    expect(r.sent.snapshots).toBe(snapshots);
    // Stopped, not stuck: "Check result" can be tapped, and it looks up once.
    expect(r.c.getState()).toMatchObject({ outcome: 'unknown', busy: false, online: true });
    expect(r.timers).toHaveLength(0);
    void r.c.reconcile(); await flush();
    expect(r.sent.lookups).toBe(5);
    const manual = r.pending.find((entry) => entry.kind === 'operation')!;
    await run(r, [`dequeue#${manual.seq}`, `arrive#${manual.seq}`, `lose#${manual.seq}`]);
    expect(r.timers).toHaveLength(0);
    // Back online after going away: automatic lookups start over.
    await run(r, ['offline', 'online']);
    expect(r.sent.lookups).toBe(6);
  });
  /* 测试价值（维护者 15:37 复审第 3 条；调度要求的统一节奏）
   * - 生产入口与可观察结果：真实 controller + client 接隔离传输；观察自动查询的间隔、答复写出次数。
   * - 依据：只有观察到的进展（回执的秩上升）重置节奏；同一个已答复的确认、同一个进行中状态都算没有进展，按同一规则
   *   翻倍、封顶（进行中 5 秒，其余 30 秒），同一段里间隔不减；成功但没有进展的查询不停，速率由封顶限制。
   * - 缺口：写出 Allow 后回包丢失，Host 一直返回同一个确认时，每秒查一次、无界。
   * - 最小失败输入：Allow 写出、回包丢失，十次查询都返回原 requestId。tier: unit。
   */
  it('backs off while the Host keeps showing the consent this phone already answered', async () => {
    const r = rig({ promptOnAccept: true });
    await r.c.refresh(); void r.c.install(detail, plugin); await flush();
    await run(r, ['dequeue#1', 'arrive#1', 'deliver#1']);       // the Host shows the consent
    expect(r.c.getState().outcome).toBe('confirmation');
    void r.c.answer(true); await flush();
    const answer = r.pending.find((entry) => entry.kind === 'answer')!;
    // Written, but it never reaches the Host and its reply is lost: the Host keeps showing the same consent.
    await run(r, [`dequeue#${answer.seq}`, `lose#${answer.seq}`]);
    expect(r.c.getState()).toMatchObject({ outcome: 'unknown', answerHeld: 'consent-1' });
    const delays: number[] = [];
    for (let i = 0; i < 10; i++) {
      delays.push(r.timers[0].delayMs);
      await run(r, ['tick']);
      const lookup = r.pending.find((entry) => entry.kind === 'operation')!;
      await run(r, [`dequeue#${lookup.seq}`, `arrive#${lookup.seq}`, `deliver#${lookup.seq}`]);
      expect(r.c.getState()).toMatchObject({ outcome: 'unknown', answerHeld: 'consent-1' });
    }
    expect(r.host.answersWritten).toBe(1);
    expect(delays).toEqual([POLL, 2 * POLL, 4 * POLL, 8 * POLL, 16 * POLL, 30_000, 30_000, 30_000, 30_000, 30_000]);
    // Still looked up (bounded rate), and "Check result" stays available without a second answer.
    expect(r.timers.map((timer) => timer.delayMs)).toEqual([30_000]);
    void r.c.reconcile(); await flush();
    expect(r.pending.filter((entry) => entry.kind === 'answer')).toHaveLength(0);
  });
  it('backs off while the Host keeps reporting the same running state, and starts over on progress', async () => {
    const r = rig();
    await r.c.refresh(); void r.c.install(detail, plugin); await flush();
    await run(r, ['dequeue#1', 'arrive#1', 'deliver#1']);       // running; the Host stays there (slow download)
    expect(r.c.getState().outcome).toBe('running');
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      delays.push(r.timers[0].delayMs);
      await run(r, ['tick']);
      const lookup = r.pending.find((entry) => entry.kind === 'operation')!;
      await run(r, [`dequeue#${lookup.seq}`, `arrive#${lookup.seq}`, `deliver#${lookup.seq}`]);
    }
    expect(delays).toEqual([POLL, 2 * POLL, 4 * POLL, 5_000, 5_000, 5_000]);
    // Progress (the Host now shows its consent): the pace starts over once the person answered.
    await run(r, ['host', 'tick']);
    const lookup = r.pending.find((entry) => entry.kind === 'operation')!;
    await run(r, [`dequeue#${lookup.seq}`, `arrive#${lookup.seq}`, `deliver#${lookup.seq}`]);
    expect(r.c.getState().outcome).toBe('confirmation');
    void r.c.answer(true); await flush();
    const answer = r.pending.find((entry) => entry.kind === 'answer')!;
    await run(r, [`dequeue#${answer.seq}`, `arrive#${answer.seq}`, `deliver#${answer.seq}`]);
    expect(r.c.getState().outcome).toBe('running');
    expect(r.timers.map((timer) => timer.delayMs)).toEqual([POLL]);
  });
  /* 测试价值（维护者 17:43 复审第 1 条；调度要求 F）
   * - 生产入口与可观察结果：真实 controller + client 接隔离传输，视图走开后按 usePluginManagement 同一个决策函数
   *   `nextDetachedStep` 推进；观察写出的 management:* 顺序与页面占用的持有、释放时刻。
   * - 依据：每项操作最多一次取消，只在确认已出现、本机从未写出答复时；取消在途时持有占用；写出前失败不重试、只放开本机；
   *   写出后结果不明只核实原操作；已写出答复的操作任何路径都不取消；放弃跟踪不写任何东西。
   * - 缺口：watcher 在取消收尾前反复进入；丢回包后再次取消；已允许的操作在离开时被取消。
   * - 最小失败输入：下面三种各一次。tier: unit。
   */
  it('cancels a consent left unanswered once; refused before writing, it stays a pending check that waits for the person, with nothing written', async () => {
    const r = rig({ promptOnAccept: true });
    await r.c.refresh(); void r.c.install(detail, plugin, r.hold); await flush();
    await run(r, ['dequeue#1', 'arrive#1', 'deliver#1']);
    expect(r.c.getState().outcome).toBe('confirmation');
    await run(r, ['leave']);
    const cancel = r.pending.find((entry) => entry.kind === 'cancel')!;
    expect(r.slot.holds(r.token)).toBe(true);                     // held while the cancel is on its way
    await run(r, [`refuse#${cancel.seq}`]);
    expect(r.asked).toEqual(['begin', 'cancel']);
    expect(r.writes).toEqual(['begin']);
    // Maintainer review 18:45: the begin was written, so it is kept (its "Check result" and "Stop tracking" stay); the
    // computer's slot goes, as nothing moves it on by itself.
    expect(r.view.steps).toEqual(['cancel']);
    expect(r.c.pendingCheck()).toMatchObject({ operationId: 'operation-1', entry: 'update', waiting: true });
    expect(r.slot.holder('host-1')).toBeNull();
    expect(r.pending).toEqual([]);
  });
  it('after a written cancel whose reply is lost, only looks up the operation, never cancels again', async () => {
    const r = rig({ promptOnAccept: true, lookupInvalid: true });
    await r.c.refresh(); void r.c.install(detail, plugin, r.hold); await flush();
    await run(r, ['dequeue#1', 'arrive#1', 'deliver#1', 'leave']);
    const cancel = r.pending.find((entry) => entry.kind === 'cancel')!;
    await run(r, [`dequeue#${cancel.seq}`, `lose#${cancel.seq}`]);
    expect(r.c.getState().outcome).toBe('unknown');
    expect(r.slot.holds(r.token)).toBe(true);
    await run(r, ['tick']);
    const lookup = r.pending.find((entry) => entry.kind === 'operation')!;
    expect(r.slot.holds(r.token)).toBe(true);                     // the lookup is still on its way
    await run(r, [`dequeue#${lookup.seq}`, `arrive#${lookup.seq}`, `deliver#${lookup.seq}`]);
    // INVALID_RESPONSE stops the lookups; it waits for the person's "Check result" (kept, the slot free), no second cancel.
    expect(r.asked).toEqual(['begin', 'cancel', 'operation']);
    expect(r.writes).toEqual(['begin', 'cancel', 'operation']);
    expect(r.view.steps).toEqual(['cancel']);
    expect(r.c.pendingCheck()?.waiting).toBe(true);
    expect(r.slot.holder('host-1')).toBeNull();
  });
  it('never cancels an operation whose Allow was written, even when it is left after lookups stopped', async () => {
    const r = rig({ promptOnAccept: true, lookupInvalid: true });
    await r.c.refresh(); void r.c.install(detail, plugin, r.hold); await flush();
    await run(r, ['dequeue#1', 'arrive#1', 'deliver#1']);
    void r.c.answer(true); await flush();
    const answer = r.pending.find((entry) => entry.kind === 'answer')!;
    await run(r, [`dequeue#${answer.seq}`, `arrive#${answer.seq}`, `lose#${answer.seq}`, 'tick']);
    const lookup = r.pending.find((entry) => entry.kind === 'operation')!;
    await run(r, [`dequeue#${lookup.seq}`, `arrive#${lookup.seq}`, `deliver#${lookup.seq}`]);
    expect(r.c.lookupsStopped()).toBe(true);
    await run(r, ['leave']);
    expect(r.asked).toEqual(['begin', 'answer', 'operation']);
    expect(r.writes).toEqual(['begin', 'answer', 'operation']);
    expect(r.view.steps).toEqual([]);                             // kept as a pending check, never cancelled
    expect(r.c.pendingCheck()?.waiting).toBe(true);
    expect(r.host.phase).toBe('running');                         // the computer goes on with it
    expect(r.slot.holder('host-1')).toBeNull();
  });
  // The rule is about the operation, not one consent: once this phone wrote an answer to it, nothing cancels it, even
  // when the computer then shows a second consent and the view goes away.
  it('does not cancel a second consent of an operation whose first consent was answered', async () => {
    const second: PluginManagementReceipt = { ...confirmation(), consent: { ...confirmation().consent!, requestId: 'consent-2' } };
    const h = host((request) => request.actionId === 'management:begin' ? confirmation()
      : request.actionId === 'management:answer' ? second : receipt('running'));
    const c = controller(h.client); await c.refresh();
    await c.install(detail, plugin);
    await c.answer(true);
    expect(c.getState()).toMatchObject({ outcome: 'confirmation', answerHeld: null });
    expect(nextDetachedStep(c)).toBe('letGo');
    expect(c.mayCancel()).toBe(false);
    await shownCancel(c);
    expect(h.requests.map((request) => request.actionId).filter((id) => id !== 'management:snapshot' && id !== 'management:market-detail'))
      .toEqual(['management:begin', 'management:answer']);
  });
  it('stops automatic lookups at once on a protocol error and keeps "Check result"', async () => {
    const r = rig({ lookupInvalid: true });
    await r.c.refresh(); void r.c.install(detail, plugin); await flush();
    await run(r, ['dequeue#1', 'arrive#1', 'lose#1', 'tick']);
    const lookup = r.pending.find((entry) => entry.kind === 'operation')!;
    await run(r, [`dequeue#${lookup.seq}`, `arrive#${lookup.seq}`, `deliver#${lookup.seq}`]);
    expect(r.c.getState()).toMatchObject({ outcome: 'unknown', errorCode: 'INVALID_RESPONSE', busy: false });
    expect(r.timers).toHaveLength(0);
    expect(r.sent.lookups).toBe(1);
  });
});
