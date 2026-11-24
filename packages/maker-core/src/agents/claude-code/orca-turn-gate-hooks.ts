import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';

type GateEvaluator = (
  sessionId: string,
  finalText: string | undefined,
) => Promise<string | undefined>;

/**
 * Claude Code 的 Stop hook：让收口闸门和用户自己的 Stop hook 在**同一次** stop 评估里跑，
 * 任一 block 只让引擎续跑一次。
 *
 * 这里绑定 Cindy 的 session id，而不是 `input.session_id`——后者是引擎自己生成的
 * SDK 会话 id，与宿主记录 worker/派发的键不是同一套。
 *
 * 失败一律放行：卡住会话的代价高于放过一句假话。
 */
export function buildClaudeOrcaTurnGateHooks(
  sessionId: string,
  evaluate: GateEvaluator | undefined,
): { Stop: HookCallbackMatcher[] } | undefined {
  if (!evaluate) return undefined;
  return {
    Stop: [
      {
        // 判定含一次小模型调用（≤10s 预算），matcher 超时留出余量。
        timeout: 15,
        hooks: [
          async (input) => {
            if (input.hook_event_name !== 'Stop') return { continue: true } as const;
            // 引擎已经因为 Stop hook 续跑过一次：不再叠加第二次，避免死循环。
            if (input.stop_hook_active) return { continue: true } as const;
            const reason = await evaluate(sessionId, input.last_assistant_message ?? undefined)
              .catch(() => undefined);
            if (!reason) return { continue: true } as const;
            return { decision: 'block', reason } as const;
          },
        ],
      },
    ],
  };
}
