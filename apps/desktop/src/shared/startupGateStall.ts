/**
 * 启动门卡住诊断:主窗口停在开屏品牌页超过阈值时,renderer 上报一次各启动门的状态快照,
 * main 用 `renderer-guard` 写一行日志。
 *
 * 为什么要经 main 写:renderer 转发的日志一律带 `r:` 前缀,整类不进「日志与反馈」上传
 * (docs/dev-rules/log-upload-and-redaction.md §1.2)。用户卡在开屏时手里只有上传编号,
 * 只记在 renderer 里等于没记。
 *
 * 隐私边界:快照只有布尔、有限枚举和有界整数(毫秒数)。main 按本文件的白名单逐字段重建后再写,
 * 任何多余字段、非枚举字符串一律整份丢弃——这一行会离开用户机器,不能让 renderer 夹带内容。
 */

export const STARTUP_GATE_STALL_CHANNEL = 'startup-gate:stalled';

/** 开屏停留超过这么久才算卡住:正常冷启动(含数据库迁移)在 10 秒内完成。 */
export const STARTUP_GATE_STALL_AFTER_MS = 20_000;

const ENV_STATUSES = [
  'idle',
  'checking_update',
  'updating',
  'update_done',
  'manifest_failed',
  'download_failed',
  'checking',
  'downloading',
  'passed',
  'failed',
] as const;
const LOCAL_DB_GATE_STATUSES = ['pending', 'ready', 'fatal'] as const;
const AUTH_MODES = ['signed-out', 'local', 'cloud'] as const;
const HANDOFF_PHASES = [
  'boot',
  'settle',
  'shift',
  'awaiting-splash-exit',
  'awaiting-panel',
  'panel',
  'slogan',
  'awaiting-cover-release',
  'brand-exit',
  'done',
] as const;
const HANDOFF_BRANCHES = ['authenticated', 'unauthenticated', 'none'] as const;

export interface StartupGateStallSnapshot {
  /** renderer 启动到上报的毫秒数。 */
  elapsedMs: number;
  /** 这一段连续卡住(开屏在、且不是在等用户登录)到上报的毫秒数。 */
  waitingMs: number;
  /** 上报时窗口是否可见:隐藏窗口里的动画与计时会被节流。 */
  documentVisible: boolean;
  authInitializing: boolean;
  authMode: (typeof AUTH_MODES)[number];
  authenticated: boolean;
  canEnterApp: boolean;
  envStatus: (typeof ENV_STATUSES)[number];
  localDbGate: (typeof LOCAL_DB_GATE_STATUSES)[number];
  coverHeld: boolean;
  handoffPhase: (typeof HANDOFF_PHASES)[number];
  handoffBranch: (typeof HANDOFF_BRANCHES)[number];
  brandStageMounted: boolean;
  /** 品牌交接起播的三个推进锚(另一个是 auth 初始化完成)。 */
  brandAssetsReady: boolean;
  splashExited: boolean;
  splashExitCompleted: boolean;
  loginPanelMounted: boolean;
}

type FieldRule = { kind: 'boolean' } | { kind: 'enum'; values: readonly string[] } | { kind: 'ms' };

const FIELD_RULES: { readonly [K in keyof StartupGateStallSnapshot]: FieldRule } = {
  elapsedMs: { kind: 'ms' },
  waitingMs: { kind: 'ms' },
  documentVisible: { kind: 'boolean' },
  authInitializing: { kind: 'boolean' },
  authMode: { kind: 'enum', values: AUTH_MODES },
  authenticated: { kind: 'boolean' },
  canEnterApp: { kind: 'boolean' },
  envStatus: { kind: 'enum', values: ENV_STATUSES },
  localDbGate: { kind: 'enum', values: LOCAL_DB_GATE_STATUSES },
  coverHeld: { kind: 'boolean' },
  handoffPhase: { kind: 'enum', values: HANDOFF_PHASES },
  handoffBranch: { kind: 'enum', values: HANDOFF_BRANCHES },
  brandStageMounted: { kind: 'boolean' },
  brandAssetsReady: { kind: 'boolean' },
  splashExited: { kind: 'boolean' },
  splashExitCompleted: { kind: 'boolean' },
  loginPanelMounted: { kind: 'boolean' },
};

/** 一天的毫秒数:上限只为拒绝畸形值。 */
const MAX_ELAPSED_MS = 24 * 60 * 60 * 1000;

/**
 * renderer 上报前把时长收进白名单范围:登录页停留或休眠跨过一天、系统时钟回拨时,
 * 原值会被 main 整份拒绝,而每次加载只报一次,诊断就此丢失。
 */
export function clampStartupGateStallMs(ms: number): number {
  return Math.min(MAX_ELAPSED_MS, Math.max(0, Math.round(ms)));
}

/**
 * IPC 入口校验:键集合必须与白名单完全一致,每个值都落在规则内,否则返回 null。
 * 返回值按白名单重建,不复用入参对象。
 */
export function parseStartupGateStallSnapshot(input: unknown): StartupGateStallSnapshot | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const fields = Object.keys(FIELD_RULES) as Array<keyof StartupGateStallSnapshot>;
  const keys = Object.keys(record);
  if (keys.length !== fields.length || !keys.every((key) => key in FIELD_RULES)) return null;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const rule = FIELD_RULES[field];
    const value = record[field];
    if (rule.kind === 'boolean') {
      if (typeof value !== 'boolean') return null;
    } else if (rule.kind === 'enum') {
      if (typeof value !== 'string' || !rule.values.includes(value)) return null;
    } else if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > MAX_ELAPSED_MS
    ) {
      return null;
    }
    out[field] = value;
  }
  return out as unknown as StartupGateStallSnapshot;
}

/** 固定字段顺序的 `key=value` 行,便于日志里横向比对多次上报。 */
export function formatStartupGateStallSnapshot(snapshot: StartupGateStallSnapshot): string {
  const fields = Object.keys(FIELD_RULES) as Array<keyof StartupGateStallSnapshot>;
  return fields.map((field) => `${field}=${String(snapshot[field])}`).join(' ');
}
