import type { GhostRuntimeControlPointResult, GhostControlPointData } from '../../shared/ghost.js';
import type { RuntimePluginPoint, RuntimePluginSettings, RuntimePluginTarget } from '../../shared/pluginRuntime.js';
type RuntimeControlPoint = Exclude<RuntimePluginPoint, 'system-prompt'>;

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
  screen(point: RuntimeControlPoint, data: GhostControlPointData, target: RuntimePluginTarget): Promise<GhostRuntimeControlPointResult>;
}) {
  return {
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
    ): Promise<Data> | undefined {
      const targets = deps.readSettings(sessionId)?.[point];
      if (!targets?.length) return undefined;
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
        for (const target of targets) {
          assertCurrent();
          try {
            const result = await deps.screen(point, data, target);
            assertCurrent();
            if (result.action === 'skip' || result.action === 'block') {
              throw new RuntimePluginControlError(result.action, target.pluginId, result.failure, result.reason);
            }
            data = await apply(result, data, assertCurrent) ?? data;
            assertCurrent();
          } catch (error) {
            // An owner/selection/cancellation boundary always wins, including allow-on-failure.
            assertCurrent();
            if (error instanceof RuntimePluginControlError) throw error;
            if (target.onFailure !== 'allow') {
              throw new RuntimePluginControlError(target.onFailure, target.pluginId, true);
            }
          }
        }
        return data;
      })();
    },
  };
}
