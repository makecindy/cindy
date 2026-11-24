import { createLogger } from '../../logger.js';

const log = createLogger('orca-turn-gate-hook');

type OrcaTurnGateEvaluator = (
  sessionId: string,
  finalText: string | undefined,
) => Promise<string | undefined>;

let evaluator: OrcaTurnGateEvaluator | null = null;

export function setOrcaTurnGateEvaluator(next: OrcaTurnGateEvaluator | null): void {
  evaluator = next;
}

/**
 * 判定入口的转发。引擎侧的 Stop hook 由 maker-core 在**每个会话**构造时注册，
 * 并把 Cindy 的 session id 一起绑进去；它调用这里，而不是直接用 SDK 的
 * `input.session_id`（那是引擎自己生成的会话 id，与宿主记录 worker 的键不同）。
 *
 * 失败一律放行：Hook 抛错时引擎按默认 continue 收口，卡住会话的代价高于放过一句假话。
 */
export async function evaluateOrcaTurnGate(
  sessionId: string,
  finalText: string | undefined,
): Promise<string | undefined> {
  if (!evaluator) return undefined;
  return evaluator(sessionId, finalText).catch((error: unknown) => {
    log.warn('orca turn gate evaluation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  });
}
