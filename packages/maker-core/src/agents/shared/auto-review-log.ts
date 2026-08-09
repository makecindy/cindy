/**
 * Auto-review 判定日志 —— 让「为什么又弹了」可归因。
 *
 * 此前这条链路是黑盒:用户报「Auto 档狂弹」时,无从判断弹窗来自
 * 静态红线、AI 判 `ask`、审阅器超时,还是记忆没命中 —— 只能事后翻 agent 的
 * session 记录去猜。每次判定落一行结构化日志后,归因变成一次 grep。
 *
 * 隐私:**不落命令原文**。命令可能带路径、token、查询串,而日志会进上报链路
 * (log-upload-and-redaction.md 的白名单方向:deny-by-default)。这里只落
 * 「动作种类 + 固定命令标签 + 长度 + 判定结果」——足够定位是哪一类命令被卡,
 * 又不泄漏内容。需要原文时用户可在本机的 agent session 记录里对照。
 */

import type { AgentKind } from '../../types/common.js';
import type { Logger } from '../../interfaces/logger.js';

import type { LocalAutoReviewTier } from './auto-review-decision.js';
import type { ReviewableAction } from './auto-review.js';

/** 这次放行/拒绝是谁决定的。归因投诉时最关键的一列。 */
export type AutoReviewDecisionSource =
  /** 记忆命中(用户批准过 / 审阅器判过 allow),没有再问也没有再审。 */
  | 'memory'
  /** 静态分类器独立裁决(白名单放行,或确定性红线)。 */
  | 'static'
  /** 灰区,交轻量审阅器判定。 */
  | 'reviewer';

export interface AutoReviewDecisionLogEntry {
  agentKind: AgentKind;
  action: ReviewableAction;
  source: AutoReviewDecisionSource;
  localTier?: LocalAutoReviewTier;
  verdict: 'allow' | 'block' | 'ask';
  /** 审阅器没跑起来(缺失/超时/抛错)导致的 block,与模型判危险区分。 */
  unavailable?: boolean;
  elapsedMs: number;
}

/**
 * 允许写入日志的固定低基数命令标签。未知首词一律收口为 `other`，不能把未经脱敏的
 * basename 原样带进本地日志或上报链路。
 */
const SAFE_COMMAND_LABELS: ReadonlySet<string> = new Set([
  'sh', 'bash', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh',
  'git', 'gh', 'glab', 'npm', 'npx', 'pnpm', 'pnpx', 'yarn',
  'node', 'nodejs', 'python', 'python3', 'py', 'ruby', 'perl', 'php', 'lua',
  'go', 'cargo', 'make', 'gmake', 'just', 'task', 'gradle', 'gradlew', 'mvn', 'mvnw',
  'cmake', 'ctest', 'ninja', 'docker', 'podman', 'kubectl', 'helm',
  'terraform', 'tofu', 'ansible-playbook', 'curl', 'wget', 'ssh', 'scp', 'rsync',
  'rm', 'mv', 'cp', 'mkdir', 'chmod', 'chown', 'sed', 'awk', 'find', 'xargs',
  'cat', 'ls', 'printf', 'echo', 'env', 'timeout',
]);

function commandLabel(command: string): string {
  const first = command.trim().split(/\s+/, 1)[0] ?? '';
  const base = first.split(/[/\\]/).pop()?.toLowerCase().replace(/\.(?:exe|cmd|bat)$/i, '') ?? '';
  return SAFE_COMMAND_LABELS.has(base) ? base : 'other';
}

export function logAutoReviewDecision(
  logger: Logger | undefined,
  entry: AutoReviewDecisionLogEntry,
): void {
  if (!logger) return;
  const { action } = entry;
  logger.debug('auto-review decision', {
    agentKind: entry.agentKind,
    actionKind: action.kind,
    ...(action.kind === 'exec'
      ? { bin: commandLabel(action.command ?? ''), commandChars: (action.command ?? '').length }
      : {}),
    source: entry.source,
    ...(entry.localTier ? { localTier: entry.localTier } : {}),
    verdict: entry.verdict,
    ...(entry.unavailable ? { unavailable: true } : {}),
    elapsedMs: entry.elapsedMs,
  });
}
