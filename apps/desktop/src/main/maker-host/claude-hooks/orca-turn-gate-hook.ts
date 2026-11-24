import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from '../../logger.js';

const log = createLogger('orca-turn-gate-hook');

/** 判定入口由宿主注入：判定逻辑与宿主 settle 共用同一份，不在这里重复实现。 */
type OrcaTurnGateEvaluator = (
  sessionId: string,
  finalText: string | undefined,
) => Promise<string | undefined>;

let evaluator: OrcaTurnGateEvaluator | null = null;

export function setOrcaTurnGateEvaluator(next: OrcaTurnGateEvaluator | null): void {
  evaluator = next;
}

/**
 * Claude Code 的 Stop hook：让闸门和用户自己的 Stop hook 在**同一次** stop 评估里跑，
 * 任一 block 只让引擎续跑一次。宿主 settle 那侧看到「这一轮已判过」就跳过，
 * 因此一个会话始终只有一个否决点。
 *
 * 失败一律放行：hook 抛错时引擎按 onFailure 默认 continue 继续收口，
 * 卡住会话的代价高于放过一句假话。
 */
export function createOrcaTurnGateStopHooks(): Partial<Record<'Stop', HookCallbackMatcher[]>> {
  return {
    Stop: [
      {
        // 判定含一次小模型调用（≤10s 预算），matcher 超时留出余量。
        timeout: 15,
        hooks: [
          async (input) => {
            if (input.hook_event_name !== 'Stop') return { continue: true } as const;
            // 引擎已经因为 Stop hook 续跑过一次：不再叠加第二次，避免死循环。
            if (input.stop_hook_active || !evaluator) return { continue: true } as const;
            const reason = await evaluator(
              input.session_id,
              input.last_assistant_message ?? undefined,
            ).catch((error: unknown) => {
              log.warn('orca turn gate hook failed', {
                error: error instanceof Error ? error.message : String(error),
              });
              return undefined;
            });
            if (!reason) return { continue: true } as const;
            log.info('orca turn gate veto', { sessionId: input.session_id });
            return { decision: 'block', reason } as const;
          },
        ],
      },
    ],
  };
}
