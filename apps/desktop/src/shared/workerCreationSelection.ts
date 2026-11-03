/** Worker 面板按账号和任务所在电脑提交过的完整路线。 */
export interface WorkerCreationSelection {
  agent: 'claude-code' | 'codex' | 'pi';
  model: string;
  providerId: string | null;
  agentDeviceId: string | null;
  effort: string;
  fast: boolean | 'ultrafast';
}

export function normalizeWorkerCreationSelection(raw: unknown): WorkerCreationSelection | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Partial<WorkerCreationSelection>;
  const text = (v: unknown, limit: number) =>
    typeof v === 'string' &&
    v.trim().length > 0 &&
    v.length <= limit &&
    Array.from(v).every((character) => character.charCodeAt(0) >= 32);
  if (
    !['claude-code', 'codex', 'pi'].includes(p.agent ?? '') ||
    !text(p.model, 1024) ||
    typeof p.effort !== 'string' ||
    p.effort.length > 32 ||
    Array.from(p.effort).some((character) => character.charCodeAt(0) < 32) ||
    !(p.fast === true || p.fast === false || p.fast === 'ultrafast') ||
    !(p.providerId === null || text(p.providerId, 128)) ||
    !(p.agentDeviceId === null || text(p.agentDeviceId, 128))
  )
    return null;
  return {
    agent: p.agent!,
    model: p.model!,
    effort: p.effort!,
    fast: p.fast!,
    providerId: p.providerId!,
    agentDeviceId: p.agentDeviceId!,
  };
}
