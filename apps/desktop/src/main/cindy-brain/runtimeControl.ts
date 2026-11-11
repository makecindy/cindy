import { GHOST_CONTROL_POINTS, type GhostRuntimeControlPointResult, type GhostControlPointData } from '../../shared/ghost.js';
import type { RuntimePluginPoint, RuntimePluginSettings, RuntimePluginTarget } from '../../shared/pluginRuntime.js';
type RuntimeControlPoint = Exclude<RuntimePluginPoint, 'system-prompt'>;

/** Host-only approval guard; never part of the plugin's wire verdict. */
export const RUNTIME_PLUGIN_RESULT_CURRENT = Symbol('runtime-plugin-result-current');
export type RuntimePluginControlResult = GhostRuntimeControlPointResult & { [RUNTIME_PLUGIN_RESULT_CURRENT]?: () => boolean };

/** Parallel provider waits share wall time; host work between waits is excluded. */
function createWaitBudget(limitMs: number, now: () => number) {
  let remaining = limitMs;
  let active = 0;
  let started = 0;
  return {
    remaining: () => Math.max(0, remaining - (active ? now() - started : 0)),
    start: () => {
      if (active++ === 0) started = now();
      return () => { if (--active === 0) remaining = Math.max(0, remaining - (now() - started)); };
    },
  };
}
type WaitBudget = ReturnType<typeof createWaitBudget>;

export class RuntimePluginControlError extends Error {
  constructor(
    readonly action: 'skip' | 'block',
    readonly pluginId: string,
    readonly failure: boolean,
    readonly reason = '',
  ) {
    super(`Runtime plugin ${action}: ${pluginId}`);
    this.name = 'RuntimePluginControlError';
  }
}

/** Selection and effects are host-owned. The gateway owns delivery, approval and timeout. */
export function createRuntimePluginControl(deps: {
  readSettings(sessionId: string): RuntimePluginSettings | undefined;
  captureOwner(): () => boolean;
  screen(point: RuntimeControlPoint, data: GhostControlPointData, target: RuntimePluginTarget, timeoutMs?: number): Promise<RuntimePluginControlResult>;
  now?(): number;
}) {
  const now = deps.now ?? (() => performance.now());
  const turns = new Map<string, { budget: WaitBudget; current: () => boolean }>();
  const beginTurn = (sessionId: string) => {
    const turn = { budget: createWaitBudget(5_000, now), current: deps.captureOwner() };
    turns.set(sessionId, turn);
    return turn.budget;
  };
  return {
    beginTurn,
    forgetSession: (sessionId: string) => { turns.delete(sessionId); },
    requestBudget: () => createWaitBudget(1_000, now),
    /** Undefined is deliberately synchronous: no selection adds no await or data lookup. */
    run<Data extends GhostControlPointData>(
      point: RuntimeControlPoint,
      sessionId: string,
      readData: () => Promise<Data>,
      apply: (
        result: GhostRuntimeControlPointResult,
        data: Data,
        assertCurrent: () => void,
      ) => Promise<Data | void>,
      signal?: AbortSignal,
      inputError?: Error,
      requestBudget?: WaitBudget,
    ): Promise<Data> | undefined {
      const targets = deps.readSettings(sessionId)?.[point];
      if (!targets?.length) return undefined;
      const saved = turns.get(sessionId);
      const turnBudget = point === 'will-search-memory' ? createWaitBudget(GHOST_CONTROL_POINTS[point].timeoutMs, now)
        : saved?.current() ? saved.budget : beginTurn(sessionId);
      const selection = JSON.stringify(targets);
      const ownerCurrent = deps.captureOwner();
      const assertCurrent = () => {
        if (signal?.aborted || !ownerCurrent()
          || JSON.stringify(deps.readSettings(sessionId)?.[point]) !== selection) {
          throw new RuntimePluginControlError('block', '', true, 'selection-changed');
        }
      };
      return (async () => {
        assertCurrent();
        let data = await readData();
        const ask = async (target: RuntimePluginTarget) => {
          assertCurrent();
          if (inputError) throw inputError;
          const budgets = requestBudget ? [turnBudget, requestBudget] : [turnBudget];
          const timeoutMs = Math.min(GHOST_CONTROL_POINTS[point].timeoutMs, ...budgets.map(budget => budget.remaining()));
          if (timeoutMs <= 0) throw new Error('Runtime plugin wait budget exhausted');
          const release = budgets.map(budget => budget.start());
          try {
            return await deps.screen(point, data, target, timeoutMs);
          } finally { for (const finish of release) finish(); }
        };
        const applyResult = async (target: RuntimePluginTarget, answer: { result?: RuntimePluginControlResult; error?: unknown }) => {
          try {
            if ('error' in answer) throw answer.error;
            const result = answer.result!;
            const assertResultCurrent = () => {
              assertCurrent();
              if (result[RUNTIME_PLUGIN_RESULT_CURRENT]?.() === false) throw new Error('Runtime plugin approval changed');
            };
            assertResultCurrent();
            if (result.action === 'skip' || result.action === 'block') {
              throw new RuntimePluginControlError(result.action, target.pluginId, result.failure, result.reason);
            }
            data = await apply(result, data, assertResultCurrent) ?? data;
            assertResultCurrent();
          } catch (error) {
            // An owner/selection/cancellation boundary always wins, including allow-on-failure.
            assertCurrent();
            if (error instanceof RuntimePluginControlError) throw error;
            if (target.onFailure !== 'allow') {
              throw new RuntimePluginControlError(target.onFailure, target.pluginId, true);
            }
          }
        };
        if (point === 'will-compose-context' || point === 'will-search-memory') {
          const answers = await Promise.all(targets.map(async target => {
            try { return { result: await ask(target) }; }
            catch (error) { return { error }; }
          }));
          for (let i = 0; i < targets.length; i++) await applyResult(targets[i], answers[i]);
        } else for (const target of targets) {
          let answer;
          try { answer = { result: await ask(target) }; }
          catch (error) { answer = { error }; }
          await applyResult(target, answer);
        }
        return data;
      })();
    },
  };
}
