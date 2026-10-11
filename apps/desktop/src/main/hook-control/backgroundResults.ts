import { randomUUID } from 'node:crypto';
import { makeTurnEnd, type HookMessage } from '@cindy/slack-hook-protocol';
import type { HookSessionRunner } from './dispatcher';
import type { HookBindingStore } from './bindings';
import { providerForExternalKey } from './providerRouting.js';
import { isSilencedSchedulerTurn } from '../scheduler-host/silent-output.js';
import type { ChannelTurnSource } from '../maker-ipc/channelTurnSignal.js';

/** Shares the normal observer/final attachment collector; no task replay or outbox. */
export function createBackgroundResults(deps: {
  bindings: HookBindingStore;
  runner: HookSessionRunner;
  owned(sessionId: string): boolean;
  allowed(connectionId: string, workingDir: string): boolean;
  sender(connectionId: string): ((message: HookMessage) => boolean) | undefined;
  generation(): number;
  log: { warn(message: string): void };
}) {
  const watches = new Map<string, { cancel(): void; active: boolean }>();
  return {
    start(sessionId: string, workingDir: string, source?: ChannelTurnSource) {
      if (deps.owned(sessionId) || watches.has(sessionId) || !deps.runner.watchContinuation) return;
      const targets = (deps.bindings.findBySession?.(sessionId) ?? []).filter(({ connectionId, externalKey }) => {
        const provider = providerForExternalKey(externalKey);
        return (provider === 'telegram' || provider === 'slack') && deps.allowed(connectionId, workingDir);
      });
      if (!targets.length) return;
      const senders = targets.map((target) => ({ ...target, send: deps.sender(target.connectionId) })).filter((t) => t.send);
      if (!senders.length) return;
      const generation = deps.generation();
      const state = { cancel: () => {}, active: true };
      watches.set(sessionId, state);
      const detach = () => { if (watches.get(sessionId) === state) watches.delete(sessionId); };
      // Desktop input stays in the app. Scheduler turns are only known at terminal (turnOrigin);
      // a silenced run then sends only its failure.
      let relay: 'all' | 'failure' | 'none' | null = null;
      state.cancel = deps.runner.watchContinuation({
        sessionId, workingDir,
        isDirAuthorized: (dir) => senders.some((t) => deps.allowed(t.connectionId, dir)),
        onClaim() {}, onProgress() {},
        onSettling(origin) {
          relay ??= origin?.kind === 'scheduler'
            ? (isSilencedSchedulerTurn(origin) ? 'failure' : 'all')
            : source === 'other-task' ? 'all' : 'none';
          detach();
        },
        onAbandon: () => { state.active = false; detach(); },
        onEnd(outcome) {
          detach();
          if (!state.active || generation !== deps.generation() ||
              (relay !== 'all' && !(relay === 'failure' && outcome.status === 'error')) ||
              (!outcome.finalText.trim() && !outcome.errorMessage && !outcome.attachments?.length)) return;
          state.active = false;
          for (const target of senders) {
            if (deps.sender(target.connectionId) !== target.send ||
                !deps.allowed(target.connectionId, workingDir) ||
                deps.bindings.get(target.connectionId, target.externalKey) !== sessionId) continue;
            try { target.send?.(makeTurnEnd({
              background: true, requestId: randomUUID(), externalKey: target.externalKey, sessionId,
              status: outcome.status, finalText: outcome.finalText, errorMessage: outcome.errorMessage,
              usage: { durationMs: outcome.durationMs },
              ...(outcome.attachments ? { attachments: outcome.attachments } : {}),
            })); } catch { deps.log.warn('background session result could not be sent'); }
          }
        },
      });
    },
    cancel(sessionId: string) {
      const state = watches.get(sessionId);
      if (!state) return;
      state.active = false;
      watches.delete(sessionId);
      state.cancel();
    },
    clear() {
      for (const state of watches.values()) { state.active = false; state.cancel(); }
      watches.clear();
    },
  };
}
