/** Native Make results share the task's existing dots without faking Agent turns. */
export interface CindyMakeAttention {
  kind: 'done' | 'error' | 'running' | 'none';
  key: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Accepts both persisted JSON columns and decoded message broadcasts. */
export function getCindyMakeMessageAttention(message: {
  role?: string;
  agentMeta?: unknown;
  content?: unknown;
}): CindyMakeAttention | undefined {
  if (message.role !== 'assistant') return;
  const completion = object(object(message.agentMeta)?.cindyMakeCompletion);
  if (
    completion &&
    typeof completion.reportedAt === 'number' &&
    Number.isFinite(completion.reportedAt)
  ) {
    if (completion.continuedAt) return { kind: 'none', key: 'editing' };
    const test = object(completion.test);
    const personal = object(completion.personal);
    const action = completion.lastAction ?? (personal ? 'build' : test ? 'test' : 'complete');
    const state = action === 'build' ? personal : action === 'test' ? test : undefined;
    const key = [completion.reportedAt, action, state?.buildId ?? '', state?.status ?? ''].join(
      ':',
    );
    if (!state) return { kind: 'done', key };
    if (state.error === 'cancelled') return { kind: 'none', key };
    if (state.status === 'failed' || state.error === 'interrupted') return { kind: 'error', key };
    if (state.status === 'ready') return { kind: 'done', key };
    if (state.status === 'stopped') return { kind: 'none', key };
    if (
      ['starting', 'waiting', 'syncing', 'merging', 'checking', 'packaging', 'publishing'].includes(
        String(state.status),
      )
    )
      return { kind: 'running', key };
    return;
  }
  const card = object(object(message.content)?.__cindyMakeCard);
  if (card?.type !== 'cindy-make' && card?.type !== 'cindy-make-doctor') return;
  const data = object(card.data);
  if (data?.modalOnly === true) return;
  const report = object(data?.report);
  if (!report || typeof report.runId !== 'string') return;
  const task = object(report.task);
  const key = String(report.runId) + ':' + report.status;
  if (task?.finished) return { kind: 'none', key };
  if (task?.cleanupPending || report.status === 'failed') return { kind: 'error', key };
  if (report.status === 'completed') {
    const checks = Array.isArray(report.checks) ? report.checks : [];
    const failedCheck = checks.some((check) =>
      ['missing', 'incompatible', 'failed'].includes(String(object(check)?.status)),
    );
    return { kind: failedCheck ? 'error' : 'done', key };
  }
  if (report.status === 'cancelled') return { kind: 'none', key };
  if (report.status === 'running') return { kind: 'running', key };
}
