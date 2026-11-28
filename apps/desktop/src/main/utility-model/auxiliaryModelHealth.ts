/**
 * Tracks whether the auxiliary-model chain can run, for the Settings card and the
 * one-time notification (docs/product-rules/auxiliary-model-health.md).
 *
 * - A configuration problem (every candidate skipped before reaching a model) is
 *   reported as soon as a request observes it, with each candidate's reason.
 * - Request failures only count after AUXILIARY_RUNTIME_FAILURE_THRESHOLD
 *   consecutive chain failures, so a single network blip stays silent.
 * - Any success clears the state. An account switch starts over.
 *
 * Only real state changes call `notify`; repeated failures with the same cause do
 * not re-notify. State is in memory: it describes this run of the app.
 */

import type { AuxiliaryModelHealth } from '../../shared/auxiliaryModelHealth.js';
import type { AuxiliaryChainCandidateStatus } from './auxiliaryChainAvailability.js';
import type { AuxiliaryChainOutcome } from './auxiliaryChainOutcomeSink.js';

export const AUXILIARY_RUNTIME_FAILURE_THRESHOLD = 3;


export interface AuxiliaryModelHealthDeps {
  /** Current chain, judged with the same predicates the request path uses. */
  evaluate(): AuxiliaryChainCandidateStatus[];
  notify(): void;
  now(): number;
  /** Account the state belongs to; a change resets it. */
  ownerKey(): string | null;
}

export function createAuxiliaryModelHealthTracker(deps: AuxiliaryModelHealthDeps) {
  // Read on first use, not at creation: the Desktop instance is created while main
  // modules are still loading, where the owner state may not be initialized yet.
  let owner: string | null | undefined;
  let health: AuxiliaryModelHealth = { status: 'ok' };
  let failures = 0;
  let fallbackModel: string | undefined;

  const syncOwner = (): void => {
    const key = deps.ownerKey();
    if (key === owner) return;
    const first = owner === undefined;
    owner = key;
    if (first) return;
    failures = 0;
    fallbackModel = undefined;
    // The previous account's problem is not this account's; let the UI re-read.
    if (health.status !== 'ok') {
      health = { status: 'ok' };
      deps.notify();
    }
  };

  const set = (next: AuxiliaryModelHealth): void => {
    if (JSON.stringify(next) === JSON.stringify(health)) return;
    health = next;
    deps.notify();
  };

  const sinceFor = (kind: 'config' | 'runtime'): number =>
    health.status === 'unavailable' && health.kind === kind ? health.since : deps.now();

  /** Config state when no candidate is usable now, otherwise null. */
  const configState = (): AuxiliaryModelHealth | null => {
    const statuses = deps.evaluate();
    if (statuses.some((status) => status.issue === null)) return null;
    return {
      status: 'unavailable',
      kind: 'config',
      candidates: statuses.map(({ ref, label, issue }) => ({ ref, label, issue: issue ?? 'unavailable' })),
      ...(fallbackModel ? { fallbackModel } : {}),
      since: sinceFor('config'),
    };
  };

  const recordFailure = (): void => {
    failures += 1;
    if (failures < AUXILIARY_RUNTIME_FAILURE_THRESHOLD) return;
    if (health.status === 'unavailable' && health.kind === 'config') return;
    set({
      status: 'unavailable',
      kind: 'runtime',
      ...(fallbackModel ? { fallbackModel } : {}),
      since: sinceFor('runtime'),
    });
  };

  return {
    /**
     * Current state. A configuration problem already observed by a request is
     * re-judged, so a fix (or a changed cause) shows at once. Reading never
     * raises a new problem: at startup the catalog may still be loading, and
     * only a real request proves the chain cannot run.
     */
    get(): AuxiliaryModelHealth {
      syncOwner();
      if (health.status === 'unavailable' && health.kind === 'config') {
        const config = configState();
        if (config) set(config);
        else {
          fallbackModel = undefined;
          set({ status: 'ok' });
        }
      }
      return health;
    },

    reportChainOutcome(outcome: AuxiliaryChainOutcome): void {
      syncOwner();
      if (outcome === 'success') {
        failures = 0;
        fallbackModel = undefined;
        set({ status: 'ok' });
        return;
      }
      if (outcome === 'no_candidate') {
        const config = configState();
        if (config) {
          set(config);
          return;
        }
      }
      recordFailure();
    },

    /**
     * A plugin task could not use any auxiliary candidate and runs on `model`
     * instead; null once plugin tasks use an auxiliary candidate again.
     */
    reportPluginFallback(model: string | null): void {
      syncOwner();
      fallbackModel = model ?? undefined;
      if (model) {
        const config = configState();
        if (config) {
          set(config);
          return;
        }
      }
      if (health.status === 'unavailable') {
        const { fallbackModel: _previous, ...rest } = health;
        set(model ? { ...rest, fallbackModel: model } : rest);
      }
    },
  };
}

export type AuxiliaryModelHealthTracker = ReturnType<typeof createAuxiliaryModelHealthTracker>;
