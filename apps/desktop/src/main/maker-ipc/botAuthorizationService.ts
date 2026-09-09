import { randomUUID } from 'node:crypto';
import { UI_ACTION_TRIGGER_PREFIX } from '../../shared/interruptedTurn.js';
import type {
  GhostSetupAllowedAction,
  GhostSetupAssessment,
  GhostSetupPlan,
} from '../../shared/ghost.js';
import type { GhostSetupActionResult } from '../cindy-brain/ghostSetupCoordinator.js';
import { defaultPlan, toSnapshot, validatePlan } from '../cindy-brain/ghostSetupCoordinator.js';
import type { GhostSetupInteractionResponseTarget } from '../cindy-brain/ghostSetupInteractionBridge.js';
import {
  parseGhostSetupInteractionCommand,
  parseGhostSetupInlineSubmit,
} from '../cindy-brain/ghostSetupInteractionBridge.js';
import type {
  BotAuthorizationCard,
  BotAuthorizationTarget,
} from '../../shared/botAuthorization.js';

/** Display names are untrusted plugin text and must never become model instructions. */
export function buildBotAuthorizationContinuation(card: BotAuthorizationCard) {
  const message =
    'An account connection requested in this conversation has completed authorization. Tell the user it is connected, then continue the work paused for this connection. Do not assume any other account or model was changed.';
  return {
    targetSessionId: card.sessionId,
    message,
    persistedContent: `${UI_ACTION_TRIGGER_PREFIX}${message}`,
    clientId: `bot-authorization-resume:${card.snapshot.requestId}`,
  };
}

/** Rewound/cleared deliveries do not acknowledge a still-visible card. A new
 * deterministic id avoids both the message unique key and the queue's old id. */
export async function resolveBotAuthorizationDelivery(
  baseId: string,
  read: (clientId: string) => Promise<{ id: string; createdAt: number; rewindAt: number | null; clearedAt: number | null } | null>,
): Promise<{ clientId: string; delivered: boolean }> {
  let clientId = baseId;
  while (true) {
    const row = await read(clientId);
    if (!row) return { clientId, delivered: false };
    if (row.rewindAt === null && (row.clearedAt === null || row.createdAt > row.clearedAt))
      return { clientId, delivered: true };
    clientId = `${baseId}:retry:${row.id}`;
  }
}

export interface BotAuthorizationInputGuard {
  validate(): Promise<void>;
  assertCurrent(): void;
}

/** Called while the existing session send lock is held. No await may separate
 * the synchronous clear-generation check from enqueue. */
export async function commitBotAuthorizationInput(
  guard: BotAuthorizationInputGuard,
  enqueue: () => void,
) {
  await guard.validate();
  guard.assertCurrent();
  enqueue();
}

export interface BotAuthorizationAdapter {
  identity: { id: string; name: string; iconDataUrl?: string };
  assess(): Promise<GhostSetupAssessment>;
  subscribe(wake: () => void): () => void;
  execute(
    action: GhostSetupAllowedAction,
    sender?: GhostSetupInteractionResponseTarget,
    value?: string,
    onAuthorizationUrl?: (url: string) => void,
    assertCurrent?: () => void,
    beforeCommit?: () => Promise<void>,
  ): Promise<GhostSetupActionResult>;
}
export interface BotAuthorizationDeps {
  adapter(sessionId: string, target: BotAuthorizationTarget): Promise<BotAuthorizationAdapter>;
  captureRequestGuard?(sessionId: string): () => void;
  save(card: BotAuthorizationCard, assertCurrent?: () => void): Promise<void>;
  load(requestId: string): Promise<BotAuthorizationCard | null>;
  findPending(
    sessionId: string,
    target: BotAuthorizationTarget,
  ): Promise<BotAuthorizationCard | null>;
  resume(card: BotAuthorizationCard, assertCurrent: () => void): Promise<void>;
  warn(error: unknown): void;
  openExternal(url: string): Promise<void>;
  onDisposing?(): void;
  onDispose?(): void;
}
interface Entry {
  card: BotAuthorizationCard;
  adapter: BotAuthorizationAdapter;
  unsubscribe: () => void;
  poll?: ReturnType<typeof setInterval>;
  expiry?: ReturnType<typeof setTimeout>;
  action?: Promise<void>;
  checking?: Promise<void>;
  writes: Promise<void>;
  closed: boolean;
  cancelled?: boolean;
  authorizationUrl?: string;
  assessmentFingerprint?: string;
}

/** Transcript cards outlive the agent turn. Mirrors Grok's card/action boundary,
 * 15-minute auth watch and one-hour completion fallback; credentials stay in adapters.
 * Source: grok-bot-0.18-reconstructed mcp-auth-watch-lifecycle / host-mcp-auth-completion.
 */
export class BotAuthorizationService {
  private entries = new Map<string, Entry>();
  private epoch = 0;
  private oauthFlights = new Map<
    string,
    {
      promise: Promise<GhostSetupActionResult>;
      url?: string;
      listeners: Set<(url: string) => void>;
      participants: Map<(url: string) => void, { assertCurrent: () => void; validate: () => Promise<void> }>;
    }
  >();
  private restoring = new Map<string, Promise<Entry | null>>();
  constructor(private readonly deps: BotAuthorizationDeps) {}

  private requests = new Map<string, ReturnType<BotAuthorizationService['requestCard']>>();
  request(sessionId: string, target: BotAuthorizationTarget, plan?: GhostSetupPlan) {
    const key = `${this.epoch}:${sessionId}:${target.kind}:${target.id}:${!!target.reauthorize}`;
    const existing = this.requests.get(key);
    if (existing) return existing;
    const pending = this.requestCard(sessionId, target, plan).finally(() =>
      this.requests.delete(key),
    );
    this.requests.set(key, pending);
    return pending;
  }

  private async requestCard(
    sessionId: string,
    target: BotAuthorizationTarget,
    plan?: GhostSetupPlan,
  ) {
    const epoch = this.epoch;
    const assertCurrent = this.deps.captureRequestGuard?.(sessionId);
    const adapter = await this.deps.adapter(sessionId, target);
    const assessment = await adapter.assess();
    if (epoch !== this.epoch) throw new Error('Authorization context changed');
    if (assessment.state === 'ready')
      return { ok: true as const, status: 'already-connected' as const };
    const existing = [...this.entries.values()].find(
      (e) =>
        !e.closed &&
        e.card.sessionId === sessionId &&
        e.card.target.kind === target.kind &&
        e.card.target.id === target.id &&
        !!e.card.target.reauthorize === !!target.reauthorize,
    );
    if (existing) {
      await existing.writes;
      const visible = await this.deps.load(existing.card.snapshot.requestId);
      if (epoch !== this.epoch) throw new Error('Authorization context changed');
      if (visible && !visible.snapshot.terminal) return this.waitingResult(existing.card);
      this.close(existing);
    }
    // Watcher expiry is not card expiry: reuse the durable visible request.
    const retained = await this.deps.findPending(sessionId, target);
    if (epoch !== this.epoch) throw new Error('Authorization context changed');
    if (retained) {
      const restored = await this.get(retained.snapshot.requestId);
      if (restored) return this.waitingResult(restored.card);
    }
    if (epoch !== this.epoch) throw new Error('Authorization context changed');
    const requestId = randomUUID();
    const snapshot = toSnapshot(
      requestId,
      adapter.identity,
      assessment,
      validatePlan(plan, assessment) ?? defaultPlan(assessment),
    );
    if (!snapshot.steps.length) throw new Error('No supported authorization action');
    const card: BotAuthorizationCard = { v: 1, sessionId, target, snapshot, createdAt: Date.now() };
    const entry = this.attach(card, adapter);
    entry.assessmentFingerprint = JSON.stringify(assessment);
    try {
      await this.save(entry, assertCurrent);
    } catch (error) {
      this.close(entry);
      throw error;
    }
    // subscribe() does not replay changes between the first read and attachment.
    await this.check(entry).catch(this.deps.warn);
    return this.waitingResult(card);
  }

  private waitingResult(card: BotAuthorizationCard) {
    return {
      ok: false as const,
      errorCode: 'SETUP_REQUIRED' as const,
      requestId: card.snapshot.requestId,
      message:
        'Authorization card sent. Finish unrelated work and end this turn. The Host will notify you after connection succeeds; then confirm it and continue the original work. Do not poll or repeat this request.',
    };
  }

  private attach(card: BotAuthorizationCard, adapter: BotAuthorizationAdapter): Entry {
    const entry: Entry = {
      card,
      adapter,
      unsubscribe: () => {},
      writes: Promise.resolve(),
      closed: false,
    };
    this.entries.set(card.snapshot.requestId, entry);
    this.watch(entry);
    return entry;
  }
  private watch(entry: Entry) {
    entry.unsubscribe();
    if (entry.expiry) clearTimeout(entry.expiry);
    entry.unsubscribe = entry.adapter.subscribe(() => void this.check(entry).catch(this.deps.warn));
    // Grok's waiter fallback is independent of its shorter polling deadline.
    entry.expiry = setTimeout(
      () => {
        entry.unsubscribe();
        entry.unsubscribe = () => {};
        if (!entry.action) this.close(entry);
      },
      60 * 60 * 1000,
    );
    entry.expiry.unref?.();
  }
  private save(entry: Entry, assertCurrent?: () => void): Promise<void> {
    const card = structuredClone(entry.card);
    const write = entry.writes
      .then(() => {
        if (!entry.closed) return this.deps.save(card, assertCurrent);
      })
      .catch((error: unknown) => {
        if ((error as { code?: string } | null)?.code === 'REMOTE_OPTIMISTIC_INPUT_CLEARED')
          this.close(entry);
        throw error;
      });
    entry.writes = write.catch(this.deps.warn);
    return write;
  }
  private async isVisible(entry: Entry): Promise<boolean> {
    await entry.writes;
    if (entry.closed) return false;
    const card = await this.deps.load(entry.card.snapshot.requestId);
    if (entry.closed) return false;
    if (!card || card.snapshot.terminal) {
      this.close(entry);
      return false;
    }
    return true;
  }
  private async get(requestId: string): Promise<Entry | null> {
    const live = this.entries.get(requestId);
    if (live) return (await this.isVisible(live)) ? live : null;
    let flight = this.restoring.get(requestId);
    if (!flight) {
      const epoch = this.epoch;
      flight = (async () => {
        const card = await this.deps.load(requestId);
        if (!card || card.snapshot.terminal) return null;
        const adapter = await this.deps.adapter(
          card.sessionId,
          card.completionPending ? { ...card.target, reauthorize: false } : card.target,
        );
        // A retained card can start a fresh flow; an old browser URL is never persisted.
        const hadReopenAction = !!card.snapshot.reopenActionId;
        card.snapshot = {
          ...card.snapshot,
          reopenActionId: undefined,
          revision: card.snapshot.revision + (hadReopenAction ? 1 : 0),
        };
        const assessment = await adapter.assess();
        if (epoch !== this.epoch) return null;
        const entry = this.attach(card, adapter);
        entry.assessmentFingerprint = JSON.stringify(assessment);
        if (!(await this.isVisible(entry))) return null;
        // Broadcast a newer revision before accepting a stale reopen click. The
        // retained card can then start a new flow without a generic action error.
        if (hadReopenAction) await this.save(entry);
        return entry.closed ? null : entry;
      })().finally(() => this.restoring.delete(requestId));
      this.restoring.set(requestId, flight);
    }
    return flight;
  }

  async resolve(
    requestId: string,
    raw: unknown,
    sender?: GhostSetupInteractionResponseTarget,
  ): Promise<boolean> {
    const command = parseGhostSetupInteractionCommand(raw);
    if (!command) return false;
    const entry = await this.get(requestId);
    if (!entry || entry.closed) return false;
    if (command.expectedRevision !== entry.card.snapshot.revision) {
      await this.save(entry);
      return true;
    }
    if (command.action === 'cancel') {
      entry.cancelled = true;
      entry.card.snapshot = {
        ...entry.card.snapshot,
        revision: entry.card.snapshot.revision + 1,
        terminal: true,
        steps: entry.card.snapshot.steps.map((s) => ({
          ...s,
          phase: 'cancelled',
          action: undefined,
        })),
      };
      try {
        await this.save(entry);
      } finally {
        this.close(entry);
      }
      return true;
    }
    if (!sender) return false;
    if (command.actionId === 'reopen-authorization') {
      if (!entry.authorizationUrl) return false;
      await entry.adapter.assess();
      if (entry.cancelled || !(await this.isVisible(entry))) return false;
      await this.deps.openExternal(entry.authorizationUrl);
      return true;
    }
    this.start(entry, command.actionId, sender);
    return true;
  }

  async submit(requestId: string, raw: unknown): Promise<boolean> {
    const submit = parseGhostSetupInlineSubmit(raw);
    if (!submit) return false;
    const entry = await this.get(requestId);
    if (!entry || entry.closed) return false;
    if (submit.expectedRevision !== entry.card.snapshot.revision) {
      await this.save(entry);
      return true;
    }
    this.start(entry, submit.actionId, undefined, submit.value);
    return true;
  }

  private start(
    entry: Entry,
    actionId: string,
    sender?: GhostSetupInteractionResponseTarget,
    value?: string,
  ) {
    if (entry.action) return;
    const assertBoundary = this.deps.captureRequestGuard?.(entry.card.sessionId);
    const assertCurrent = () => {
      if (entry.closed || entry.cancelled) throw new Error('Authorization action is no longer active');
      assertBoundary?.();
    };
    entry.action = (async () => {
      // Re-resolve the adapter at the action boundary: current owner, bot and plugin policy win.
      await this.deps.adapter(entry.card.sessionId, entry.card.target);
      const assessment = await entry.adapter.assess();
      if (entry.cancelled || !(await this.isVisible(entry))) return;
      entry.assessmentFingerprint = JSON.stringify(assessment);
      if (assessment.state === 'ready') {
        await this.check(entry);
        return;
      }
      const action = assessment.groups
        .flatMap((g) =>
          g.items.some((i) => i.state === 'satisfied') ? [] : g.items.flatMap((i) => i.actions),
        )
        .find((a) => a.id === actionId);
      if (!action || (action.kind === 'inline_form') !== (value !== undefined)) {
        await this.refresh(entry, assessment);
        return;
      }
      this.watch(entry);
      await this.phase(entry, 'action_running', actionId);
      if (entry.cancelled || !(await this.isVisible(entry))) return;
      this.startPoll(entry);
      const result = await this.execute(entry, action, sender, value, (url) => {
        if (entry.closed || entry.cancelled) return;
        entry.authorizationUrl = url;
        entry.card.snapshot.reopenActionId = 'reopen-authorization';
        void this.phase(entry, 'waiting_external', actionId).catch(this.deps.warn);
      }, assertCurrent);
      if (entry.closed) return;
      if (!result.ok) {
        this.stopPoll(entry);
        await this.phase(entry, 'failed', actionId, result.errorCode);
        return;
      }
      await this.check(entry);
      if (!entry.closed) await this.phase(entry, 'waiting_external', actionId);
    })()
      .catch(async (error) => {
        this.deps.warn(error);
        if (!entry.closed) {
          this.stopPoll(entry);
          try {
            await this.phase(entry, 'failed', actionId, 'ACTION_FAILED');
          } catch (recoveryError) {
            // Owner/profile validation can reject the recovery write too. This
            // detached action must settle without leaving a live invalid watcher.
            this.close(entry);
            this.deps.warn(recoveryError);
          }
        }
      })
      .finally(() => {
        entry.action = undefined;
      });
  }
  private async execute(
    entry: Entry,
    action: GhostSetupAllowedAction,
    sender: GhostSetupInteractionResponseTarget | undefined,
    value: string | undefined,
    onUrl: (url: string) => void,
    assertCurrent: () => void,
  ): Promise<GhostSetupActionResult> {
    assertCurrent();
    if (action.kind !== 'oauth_connect') return entry.adapter.execute(action, sender, value, onUrl, assertCurrent);
    const participant = {
      assertCurrent,
      validate: async () => {
        await this.deps.adapter(entry.card.sessionId, entry.card.target);
        if (!(await this.isVisible(entry))) throw new Error('Authorization card is no longer visible');
        assertCurrent();
      },
    };
    const key = `${entry.card.target.kind}:${entry.card.target.id}:${action.id}`;
    let flight = this.oauthFlights.get(key);
    if (!flight) {
      const listeners = new Set<(url: string) => void>([onUrl]);
      const next = {
        promise: Promise.resolve({ ok: true } as GhostSetupActionResult),
        listeners,
        participants: new Map([[onUrl, participant]]),
        url: undefined as string | undefined,
      };
      // Install the flight before execute() can report its browser handoff.
      this.oauthFlights.set(key, next);
      let validated: Set<typeof participant> | null = null;
      const assertAnyCurrent = () => {
        for (const candidate of validated ?? next.participants.values()) {
          if (![...next.participants.values()].includes(candidate)) continue;
          try { candidate.assertCurrent(); return; } catch { /* another card may still own the flow */ }
        }
        throw new Error('No active authorization card remains');
      };
      const beforeCommit = async () => {
        validated = new Set();
        for (const candidate of next.participants.values()) {
          try { await candidate.validate(); validated.add(candidate); } catch { /* validate every remaining owner */ }
        }
        assertAnyCurrent();
      };
      next.promise = entry.adapter
        .execute(action, sender, value, (url) => {
          next.url = url;
          for (const listener of next.listeners) listener(url);
        }, assertAnyCurrent, beforeCommit)
        .finally(() => this.oauthFlights.delete(key));
      flight = next;
    } else {
      flight.listeners.add(onUrl);
      flight.participants.set(onUrl, participant);
      if (flight.url) onUrl(flight.url);
    }
    try {
      return await flight.promise;
    } finally {
      flight.listeners.delete(onUrl);
      flight.participants.delete(onUrl);
    }
  }

  private startPoll(entry: Entry) {
    this.stopPoll(entry);
    const expires = Date.now() + 15 * 60 * 1000;
    entry.poll = setInterval(() => {
      if (Date.now() >= expires) {
        this.stopPoll(entry);
        void this.phase(entry, 'failed', undefined, 'TIMEOUT').catch(this.deps.warn);
        return;
      }
      void this.check(entry).catch(this.deps.warn);
    }, 5000);
    entry.poll.unref?.();
  }
  private stopPoll(entry: Entry) {
    if (entry.poll) clearInterval(entry.poll);
    entry.poll = undefined;
  }
  private async phase(
    entry: Entry,
    phase: 'action_running' | 'waiting_external' | 'failed',
    actionId?: string,
    errorCode?: 'TIMEOUT' | 'ACTION_FAILED' | import('../../shared/ghost.js').GhostSetupErrorCode,
  ) {
    if (entry.closed || entry.cancelled) return;
    if (phase === 'failed') {
      entry.authorizationUrl = undefined;
      delete entry.card.snapshot.reopenActionId;
    }
    entry.card.snapshot = {
      ...entry.card.snapshot,
      revision: entry.card.snapshot.revision + 1,
      steps: entry.card.snapshot.steps.map((s) =>
        s.phase === 'satisfied' || (actionId && s.action?.id !== actionId)
          ? s
          : { ...s, phase, errorCode },
      ),
    };
    await this.save(entry);
  }
  private async refresh(entry: Entry, assessment: GhostSetupAssessment) {
    if (entry.closed || entry.cancelled) return;
    entry.assessmentFingerprint = JSON.stringify(assessment);
    const satisfiedGroups = new Set(
      assessment.groups
        .filter((g) => g.items.some((i) => i.state === 'satisfied'))
        .map((g) => g.id),
    );
    const completed = entry.card.snapshot.steps
      .filter((s) => satisfiedGroups.has(s.groupId))
      .map((s) => ({ ...s, phase: 'satisfied' as const, action: undefined, errorCode: undefined }));
    entry.card.snapshot = toSnapshot(
      entry.card.snapshot.requestId,
      entry.adapter.identity,
      assessment,
      defaultPlan(assessment),
      { revision: entry.card.snapshot.revision + 1 },
    );
    entry.card.snapshot.steps = [...completed, ...entry.card.snapshot.steps];
    await this.save(entry);
  }
  private check(entry: Entry): Promise<void> {
    if (entry.closed) return Promise.resolve();
    if (entry.checking) return entry.checking;
    entry.checking = (async () => {
      const assessment = await withAssessmentDeadline(entry.adapter.assess());
      if (entry.closed || entry.cancelled) return;
      if (assessment.state !== 'ready') {
        if (entry.assessmentFingerprint !== JSON.stringify(assessment))
          await this.refresh(entry, assessment);
        return;
      }
      // Retire the watcher before dispatch: concurrent callback/poll cannot resume twice.
      this.stopPoll(entry);
      entry.unsubscribe();
      const beforeCompletion = entry.card.snapshot;
      const completedSnapshot: BotAuthorizationCard['snapshot'] = {
        ...entry.card.snapshot,
        revision: entry.card.snapshot.revision + 1,
        terminal: true,
        steps: entry.card.snapshot.steps.map((s) => ({
          ...s,
          phase: 'satisfied',
          action: undefined,
          errorCode: undefined,
        })),
      };
      try {
        // Commit the idempotent continuation durably before retiring the card.
        // A crash before that boundary leaves the existing nonterminal card recoverable;
        // a crash after it can safely retry the same continuation clientId.
        entry.card.completionPending = true;
        await this.save(entry);
        if (entry.closed || entry.cancelled) return;
        // Rewind can hide the card while its OAuth action or persistence is awaiting.
        if (!(await this.deps.load(entry.card.snapshot.requestId))) {
          this.close(entry);
          return;
        }
        if (entry.closed || entry.cancelled) return;
        await this.deps.resume(entry.card, () => {
          if (entry.closed || entry.cancelled) throw new Error('Authorization was cancelled');
        });
        if (entry.closed || entry.cancelled) return;
        entry.card.snapshot = completedSnapshot;
        delete entry.card.completionPending;
        await this.save(entry);
      } catch (error) {
        if (entry.closed || entry.cancelled) throw error;
        entry.card.completionPending = true;
        entry.card.snapshot = {
          ...beforeCompletion,
          revision: entry.card.snapshot.revision,
          terminal: undefined,
        };
        await this.phase(entry, 'failed', undefined, 'ACTION_FAILED');
        this.watch(entry);
        throw error;
      }
      this.close(entry);
    })().finally(() => {
      entry.checking = undefined;
    });
    return entry.checking;
  }
  private close(entry: Entry) {
    entry.closed = true;
    entry.unsubscribe();
    this.stopPoll(entry);
    if (entry.expiry) clearTimeout(entry.expiry);
    this.entries.delete(entry.card.snapshot.requestId);
  }
  async dispose() {
    this.epoch += 1;
    this.deps.onDisposing?.();
    const entries = [...this.entries.values()];
    for (const entry of entries) this.close(entry);
    await Promise.allSettled(
      entries.flatMap((e) => [
        e.writes,
        ...(e.action ? [e.action] : []),
        ...(e.checking ? [e.checking] : []),
      ]),
    );
    this.deps.onDispose?.();
  }
}
let service: BotAuthorizationService | null = null;
export function initBotAuthorizationService(deps: BotAuthorizationDeps) {
  service = new BotAuthorizationService(deps);
  return service;
}
export function getBotAuthorizationService() {
  return service;
}

/** Grok gives each watch probe a 30-second deadline, separately from the flow TTL. */
async function withAssessmentDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Authorization assessment timed out')), 30_000);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
