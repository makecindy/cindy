/**
 * goal-settings-store —— `/goal` 自主目标的安全护栏**默认值**(main 端持久化)。
 *
 * 文件: <userData>/goal-settings.json(只存 user override,遵守规则 20)
 *
 * 这是「系统默认 + 用户 override + isCustomized + 恢复默认」模型(复用
 * createOverrideSettingsFile,同 collaboration / compaction settings)。三个护栏
 * 都**可空**:null = 不设该上限(允许"无限续跑/无预算")。当前 `/goal` 新建
 * 直接读取这里的默认值;目标编辑器只改当前 goal 行,不写全局默认。
 *
 * 系统默认(创作者推荐的安全体验):
 *  - maxTurns: null      默认不限轮数(让目标自然跑到 complete/blocked/用户停;
 *                        AI 首轮评估若发现任务过大仍可建议用户设个轮次上限)
 *  - budgetTokens: null  默认不设 token 预算(对齐 Codex 可空 tokenBudget)
 *  - noProgressLimit: 3  连续空轮(无 tool_use)上限
 */

import { app } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';
import {
  createOverrideSettingsFile,
  portableOverrideSettings,
  type OverrideSettingsState,
} from './override-settings-file.js';

const log = desktopMakerLogger.child('goal-settings-store');

/** 三个护栏默认值;`null` 表示"不设该上限"。 */
export interface GoalSettings {
  maxTurns: number | null;
  budgetTokens: number | null;
  noProgressLimit: number | null;
}

const DEFAULTS: GoalSettings = {
  maxTurns: null,
  budgetTokens: null,
  noProgressLimit: 3,
};

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'goal-settings.json');
}

/**
 * 归一化一个护栏值:
 *  - 显式 null → 保留 null(用户选了"不设上限",是有意的合法值,不能被 default 顶掉)
 *  - 正整数 → 取整保留(向下取整,>0)
 *  - 其它(缺失 / 非数 / <=0)→ 回落到该项默认值
 */
function normLimit(v: unknown, dflt: number | null): number | null {
  if (v === null) return null;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  return dflt;
}

function normalize(raw: unknown): GoalSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    maxTurns: normLimit(r.maxTurns, DEFAULTS.maxTurns),
    budgetTokens: normLimit(r.budgetTokens, DEFAULTS.budgetTokens),
    noProgressLimit: normLimit(r.noProgressLimit, DEFAULTS.noProgressLimit),
  };
}

const store = createOverrideSettingsFile<GoalSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'goal',
});

export function readGoalSettings(): GoalSettings {
  return store.read();
}

export function readGoalSettingsState(): OverrideSettingsState<GoalSettings> {
  return store.readState();
}

/** 写一组护栏 override(预留给未来 settings UI 更新下次默认)。 */
export function writeGoalSettings(patch: Partial<GoalSettings>): void {
  store.writePatch(patch);
  log.info('goal settings written', { ...patch });
}

export function resetGoalSettings(): GoalSettings {
  return store.reset();
}

export const __testing = { normalize, DEFAULTS };

/** New-computer setup: values the user changed here (docs/product-rules/new-device-setup-migration.md). */
export const goalPortableSettings = portableOverrideSettings(store);
