import type { Schedule } from '@cindy/maker-scheduler';

/** 图标与提示需要的绑定信息；远程镜像不保留 prompt 等执行配置。 */
export type ScheduleBinding = Pick<
  Schedule,
  'id' | 'name' | 'status' | 'targetSessionId' | 'cronExpr' | 'manual' | 'intervalMs'
> &
  Partial<Pick<Schedule, 'recurring'>>;

let lastInput: readonly ScheduleBinding[] | null = null;
let lastMap: ReadonlyMap<string, ScheduleBinding[]> = new Map();

/** 只依据当前绑定，不把历史运行记录当作仍然有效的绑定。 */
export function buildBindingMap(
  schedules: readonly ScheduleBinding[] | null,
): ReadonlyMap<string, ScheduleBinding[]> {
  if (schedules === lastInput) return lastMap;
  const map = new Map<string, ScheduleBinding[]>();
  for (const schedule of schedules ?? []) {
    if (!schedule.targetSessionId || schedule.status === 'expired') continue;
    const list = map.get(schedule.targetSessionId);
    if (list) list.push(schedule);
    else map.set(schedule.targetSessionId, [schedule]);
  }
  lastInput = schedules;
  lastMap = map;
  return map;
}

export function __resetBindingMemoForTest(): void {
  lastInput = null;
  lastMap = new Map();
}

/** maker:schedule:list 的既有 wire，校验并投影出当前绑定。 */
export function parseScheduleBindings(raw: unknown): ScheduleBinding[] {
  if (!Array.isArray(raw)) throw new Error('Invalid remote schedule list');
  const result: ScheduleBinding[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') throw new Error('Invalid remote schedule');
    const s = value as Record<string, unknown>;
    if (s.targetSessionId == null || s.targetSessionId === '' || s.status === 'expired') continue;
    if (
      typeof s.targetSessionId !== 'string' ||
      typeof s.id !== 'string' ||
      typeof s.name !== 'string' ||
      typeof s.cronExpr !== 'string' ||
      (s.status !== 'active' && s.status !== 'paused') ||
      (s.manual !== undefined && typeof s.manual !== 'boolean') ||
      (s.recurring !== undefined && typeof s.recurring !== 'boolean') ||
      (s.intervalMs !== undefined &&
        (typeof s.intervalMs !== 'number' || !Number.isFinite(s.intervalMs) || s.intervalMs <= 0))
    )
      throw new Error('Invalid remote schedule binding');
    result.push({
      id: s.id,
      name: s.name,
      status: s.status,
      targetSessionId: s.targetSessionId,
      cronExpr: s.cronExpr,
      manual: s.manual === true,
      recurring: s.recurring as boolean | undefined,
      intervalMs: s.intervalMs as number | undefined,
    });
  }
  return result;
}
