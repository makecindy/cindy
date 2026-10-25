import type { RemoteActionDescriptor, RemoteActionField, RemoteLocalizedText } from '@cindy/device-link';
import type { CreateScheduleInput, Schedule, UpdateScheduleInput } from '@cindy/maker-scheduler';

const labels = {
  schedules: ['Schedules', '自动任务', '自動任務', '自動タスク', '자동 작업'],
  create: ['Create schedule', '创建自动任务', '建立自動任務', '自動タスクを作成', '자동 작업 만들기'],
  edit: ['Edit', '编辑', '編輯', '編集', '편집'],
  delete: ['Delete', '删除', '刪除', '削除', '삭제'],
  deleteTitle: ['Delete this schedule?', '删除此自动任务？', '刪除此自動任務？', 'この自動タスクを削除しますか？', '이 자동 작업을 삭제할까요?'],
  run: ['Run now', '立即运行', '立即執行', '今すぐ実行', '지금 실행'],
  pause: ['Pause', '暂停', '暫停', '一時停止', '일시 정지'],
  resume: ['Resume', '恢复', '恢復', '再開', '재개'],
  active: ['Active', '已开启', '已開啟', '有効', '활성'],
  paused: ['Paused', '已暂停', '已暫停', '一時停止中', '일시 정지됨'],
  name: ['Name', '名称', '名稱', '名前', '이름'],
  engine: ['Engine', '内核', '核心', 'エンジン', '엔진'],
  provider: ['Provider', '供应商', '供應商', 'プロバイダー', '공급자'],
  model: ['Model', '模型', '模型', 'モデル', '모델'],
  directory: ['Working folder', '工作目录', '工作目錄', '作業フォルダー', '작업 폴더'],
  prompt: ['Instructions', '指令', '指令', '指示', '지시'],
  timing: ['Timing', '运行时间', '執行時間', '実行タイミング', '실행 시점'],
  cron: ['Cron expression', 'Cron 表达式', 'Cron 表達式', 'Cron 式', 'Cron 표현식'],
  interval: ['Interval (seconds)', '间隔（秒）', '間隔（秒）', '間隔（秒）', '간격(초)'],
  timezone: ['Time zone', '时区', '時區', 'タイムゾーン', '시간대'],
  persistent: ['Continue in the same task', '持续使用同一任务', '持續使用同一任務', '同じタスクを継続', '같은 작업에서 계속'],
  notify: ['Notify when finished', '完成时通知', '完成時通知', '完了時に通知', '완료 시 알림'],
  worktree: ['Use worktree', '使用 worktree', '使用 worktree', 'worktree を使用', 'worktree 사용'],
  cronKind: ['Calendar (cron)', '日历时间（cron）', '日曆時間（cron）', 'カレンダー（cron）', '달력(cron)'],
  intervalKind: ['Fixed interval', '固定间隔', '固定間隔', '一定間隔', '고정 간격'],
} as const;
export function scheduleText(key: keyof typeof labels): RemoteLocalizedText {
  const [fallback, cn, tw, ja, ko] = labels[key];
  return { fallback, translations: { en: fallback, 'zh-CN': cn, 'zh-TW': tw, ja, ko } };
}
export function scheduleForm(row?: Schedule): RemoteActionDescriptor {
  const field = (id: string, key: keyof typeof labels, required = false, placeholder?: string): RemoteActionField => ({
    id, label: scheduleText(key), kind: id === 'prompt' ? 'multiline' : 'text', required,
    ...(placeholder ? { placeholder } : {}),
  });
  return {
    id: row ? 'edit' : 'create', label: scheduleText(row ? 'edit' : 'create'),
    fields: [field('name', 'name', !row, row?.name),
      { id: 'agentKind', label: scheduleText('engine'), kind: 'select', required: true,
        options: [...(row ? [{ value: '__keep', label: row.agentKind }] : []), ...['claude-code', 'codex', 'pi'].map(value => ({ value, label: value }))] },
      field('providerId', 'provider', false, row?.providerId), field('model', 'model', false, row?.model),
      field('workingDir', 'directory', !row, row?.workingDir), field('prompt', 'prompt', !row, row?.prompt),
      { id: 'useWorktree', label: scheduleText('worktree'), kind: 'toggle' },
      { id: 'kind', label: scheduleText('timing'), kind: 'select', required: true, options: [
        ...(row ? [{ value: '__keep', label: scheduleText(!!row.intervalMs ? 'intervalKind' : 'cronKind') }] : []),
        { value: 'cron', label: scheduleText('cronKind') }, { value: 'interval', label: scheduleText('intervalKind') },
      ] },
      field('cronExpr', 'cron', false, row?.cronExpr ?? '0 9 * * *'),
      field('intervalSeconds', 'interval', false, row?.intervalMs ? String(row.intervalMs / 1000) : '3600'),
      field('timezone', 'timezone', false, row?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone),
      ...(!row ? [{ id: 'persistentSession', label: scheduleText('persistent'), kind: 'toggle' }, { id: 'notify', label: scheduleText('notify'), kind: 'toggle' }] : []),
    ],
  };
}

/** Resource form input is converted to the same scheduler contract as GUI IPC.
 * Empty edit fields preserve the saved value, including its original time zone. */
export function scheduleFormInput(input: Record<string, unknown>, row?: Schedule): CreateScheduleInput | UpdateScheduleInput {
  const read = (key: string, fallback?: string) => {
    const value = input[key];
    if (value === undefined || value === '' || value === '__keep') return fallback;
    if (typeof value !== 'string') throw new Error('INVALID_SCHEDULE_INPUT');
    return value;
  };
  const kind = read('kind', row ? (row.intervalMs ? 'interval' : 'cron') : undefined);
  const name = read('name', row?.name), prompt = read('prompt', row?.prompt), workingDir = read('workingDir', row?.workingDir);
  const agentKind = read('agentKind', row?.agentKind);
  if (!name || !prompt || !workingDir || !['claude-code', 'codex', 'pi'].includes(agentKind ?? '') || !['cron', 'interval'].includes(kind ?? '')) throw new Error('INVALID_SCHEDULE_INPUT');
  const timezone = read('timezone', row?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)!;
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new Error('INVALID_TIMEZONE'); }
  const interval = read('intervalSeconds');
  const intervalMs = interval ? Number(interval) * 1000 : row?.intervalMs;
  const cronExpr = read('cronExpr', row?.cronExpr) ?? '';
  if (kind === 'interval' && (!Number.isSafeInteger(intervalMs) || intervalMs! <= 0)) throw new Error('INVALID_INTERVAL');
  if (kind === 'cron' && !cronExpr.trim()) throw new Error('INVALID_CRON');
  for (const key of ['persistentSession', 'notify', 'useWorktree']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error('INVALID_SCHEDULE_INPUT');
  return { name, prompt, workingDir, kind: 'cron', cronExpr: cronExpr || '0 9 * * *', timezone,
    agentKind: agentKind as CreateScheduleInput['agentKind'], modelAgentKind: agentKind as CreateScheduleInput['agentKind'],
    providerId: read('providerId', row?.providerId), model: read('model', row?.model),
    intervalMs: kind === 'interval' ? intervalMs : undefined,
    useWorktree: typeof input.useWorktree === 'boolean' ? input.useWorktree : row?.useWorktree ?? false,
    ...(!row ? { recurring: true, workspaceKind: 'project' as const, persistentSession: input.persistentSession === true, notify: { desktop: input.notify === true, feishu: false } } : {}),
  };
}
