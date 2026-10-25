import path from "node:path";
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from "../overrideSettingsFile.js";
import type { DbLogger } from "@cindy/runtime-db/logging";

/** 三个护栏默认值;`null` 表示"不设该上限"。 */
export interface GoalSettings {
  maxTurns: number | null;
  budgetTokens: number | null;
  noProgressLimit: number | null;
}
export function createGoalSettingsStore(host: {
  userDataDirectory(): string;
  logger: DbLogger;
}) {
  const log = host.logger;

  const DEFAULTS: GoalSettings = {
    maxTurns: null,
    budgetTokens: null,
    noProgressLimit: 3,
  };

  function settingsFilePath(): string {
    return path.join(host.userDataDirectory(), "goal-settings.json");
  }

  /**
   * 归一化一个护栏值:
   *  - 显式 null → 保留 null(用户选了"不设上限",是有意的合法值,不能被 default 顶掉)
   *  - 正整数 → 取整保留(向下取整,>0)
   *  - 其它(缺失 / 非数 / <=0)→ 回落到该项默认值
   */
  function normLimit(v: unknown, dflt: number | null): number | null {
    if (v === null) return null;
    if (typeof v === "number" && Number.isFinite(v) && v > 0)
      return Math.floor(v);
    return dflt;
  }

  function normalize(raw: unknown): GoalSettings {
    if (!raw || typeof raw !== "object") return { ...DEFAULTS };
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
    label: "goal",
  });

  function readGoalSettings(): GoalSettings {
    return store.read();
  }

  function readGoalSettingsState(): OverrideSettingsState<GoalSettings> {
    return store.readState();
  }

  /** 写一组护栏 override(预留给未来 settings UI 更新下次默认)。 */
  function writeGoalSettings(patch: Partial<GoalSettings>): void {
    store.writePatch(patch);
    log.info("goal settings written", { ...patch });
  }

  function resetGoalSettings(): GoalSettings {
    return store.reset();
  }

  const __testing = { normalize, DEFAULTS };
  return {
    readGoalSettings,
    readGoalSettingsState,
    writeGoalSettings,
    resetGoalSettings,
    __testing,
  };
}
