import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { and, eq, isNotNull } from 'drizzle-orm';

import type {
  CreateScheduleInput,
  Logger,
  Schedule,
  ScheduleNotifyConfig,
  Scheduler,
  UpdateScheduleInput,
} from '@cindy/maker-scheduler';

import { projectAutomationConsents, schedules, sessions } from '../localDb/schema';
import { projectAutomationConsentToRow } from '../localDb/mapper';
import { PROJECT_AUTOMATION_REL_SEGMENTS } from '../../shared/projectAutomationPaths';
import { migrateLegacyXdmakerDir } from '../utils/legacyXdmakerMigration';
import type { DrizzleScheduleStorage, SchedulerDrizzleDb } from './storage';

/**
 * ProjectAutomationLoader reads .cindy/automations/schedules.json and syncs it
 * into the scheduler DB.
 *
 * Project schedules are mandatory project-lead configuration, similar to lint
 * rules. Users cannot reject them; opt-out is deleting the file or pausing a
 * single schedule. The project_automation_consents table now only records the
 * last successfully reconciled hash so renderer toasts can be deduped. The old
 * consent meaning is deprecated.
 */
const AUTOMATIONS_REL_PATH = path.join(...PROJECT_AUTOMATION_REL_SEGMENTS);
const CACHE_TTL_MS = 5_000;
const PROJECT_SCHEDULE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface ProjectAutomationsFile {
  version: 1;
  schedules: ProjectScheduleConfig[];
}

export interface ProjectScheduleConfig {
  id: string;
  name: string;
  prompt: string;
  cronExpr: string;
  timezone?: string;
  recurring?: boolean;
  manual?: boolean;
  intervalMs?: number;
  agentKind?: 'claude-code' | 'codex';
  model?: string;
  /** 可选：显式来源(供应商)id。省略 → 走原生默认来源（与旧配置字节级一致）。详见 Schedule.providerId。 */
  providerId?: string;
  effort?: string;
  /** Codex Fast 模式开关，仅 Codex 有意义。详见 Schedule.fastMode。 */
  fastMode?: boolean;
  useWorktree?: boolean;
  persistentSession?: boolean;
  silentWhenIdle?: boolean;
  /**
   * 前置检查脚本(Pre-run Hook)。省略 = 未启用;reconcile 恒带 key,配置文件里
   * 删掉即清空 DB 里的 hook。与 renderer projectAutomationConfig.ts 同形。
   */
  preRunHook?: { command: string; timeoutMs?: number };
  notify?: { desktop?: boolean; feishu?: boolean; wecomGroup?: boolean };
}

export interface ReconcileResult {
  workingDir: string;
  inserted: number;
  updated: number;
  deleted: number;
  skipped: 'no-file' | 'parse-error' | 'migration-incomplete' | null;
}

export type ProjectAutomationEvent = {
  type: 'reconciled';
  workingDir: string;
  inserted: number;
  updated: number;
  deleted: number;
  isFirstTime: boolean;
  hashChanged: boolean;
};

type CachedRead =
  | { kind: 'loaded'; content: string; configHash: string; schedules: ProjectScheduleConfig[] }
  | { kind: 'missing' }
  | { kind: 'parse-error' }
  | { kind: 'migration-incomplete' };

type Listener = (event: ProjectAutomationEvent) => void;

export class ProjectAutomationLoader {
  private readonly cache = new Map<string, { value: CachedRead; ts: number }>();
  private readonly inflight = new Map<string, Promise<CachedRead>>();
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly deps: {
      scheduler: Scheduler;
      storage: DrizzleScheduleStorage;
      getDb: () => SchedulerDrizzleDb;
      logger: Logger;
    },
  ) {}

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async loadProjectSchedules(workingDir: string): Promise<ProjectScheduleConfig[] | null> {
    const result = await this.readProjectAutomations(workingDir);
    return result.kind === 'loaded' ? result.schedules : null;
  }

  computeHash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  async hasConsent(workingDir: string, configHash: string): Promise<boolean> {
    return (await this.getLastHash(workingDir)) === configHash;
  }

  async saveConsent(workingDir: string, configHash: string): Promise<void> {
    const now = Date.now();
    const row = projectAutomationConsentToRow({
      workingDir,
      consentedAt: now,
      configHash,
    });
    await this.deps.getDb()
      .insert(projectAutomationConsents)
      .values(row)
      .onConflictDoUpdate({
        target: projectAutomationConsents.workingDir,
        set: { consentedAt: now, configHash },
      });
  }

  async reconcile(workingDir: string): Promise<ReconcileResult> {
    const read = await this.readProjectAutomations(workingDir);
    if (read.kind === 'migration-incomplete') {
      return { workingDir, inserted: 0, updated: 0, deleted: 0, skipped: 'migration-incomplete' };
    }
    if (read.kind !== 'loaded') {
      const lastReconciledHash = await this.getLastHash(workingDir);
      const deleted = await this.deleteProjectSchedules(workingDir);
      if (lastReconciledHash !== null) {
        await this.deleteLastHash(workingDir);
      }
      if (deleted > 0) {
        this.emit({
          type: 'reconciled',
          workingDir,
          inserted: 0,
          updated: 0,
          deleted,
          isFirstTime: false,
          hashChanged: true,
        });
      }
      return {
        workingDir,
        inserted: 0,
        updated: 0,
        deleted,
        skipped: read.kind === 'missing' ? 'no-file' : 'parse-error',
      };
    }

    const lastReconciledHash = await this.getLastHash(workingDir);
    const hashChanged = lastReconciledHash !== read.configHash;

    const existing = (await this.deps.storage.list()).filter(
      (schedule) => schedule.source === 'project' && sameWorkingDir(schedule.workingDir, workingDir),
    );
    const byConfigId = new Map(
      existing
        .filter((schedule) => typeof schedule.projectConfigId === 'string')
        .map((schedule) => [schedule.projectConfigId as string, schedule]),
    );
    const configIds = new Set(read.schedules.map((config) => config.id));

    let inserted = 0;
    let updated = 0;
    let deleted = 0;

    for (const config of read.schedules) {
      const current = byConfigId.get(config.id);
      if (!current) {
        await this.deps.scheduler.create(
          scheduleConfigToCreateInput(config, workingDir) as ProjectCreateScheduleInput,
        );
        inserted += 1;
        continue;
      }
      if (schedulesDiffer(current, config, workingDir)) {
        await this.deps.scheduler.update(
          current.id,
          scheduleConfigToUpdateInput(config, workingDir) as ProjectUpdateScheduleInput,
        );
        updated += 1;
      }
    }

    for (const schedule of existing) {
      if (!schedule.projectConfigId || !configIds.has(schedule.projectConfigId)) {
        await this.deps.scheduler.delete(schedule.id);
        deleted += 1;
      }
    }

    const result: ReconcileResult = {
      workingDir,
      inserted,
      updated,
      deleted,
      skipped: null,
    };
    await this.saveConsent(workingDir, read.configHash);
    this.emit({
      type: 'reconciled',
      workingDir,
      inserted,
      updated,
      deleted,
      isFirstTime: lastReconciledHash === null,
      hashChanged,
    });
    return result;
  }

  async upsertSchedule(
    workingDir: string,
    config: ProjectScheduleConfig,
  ): Promise<ReconcileResult> {
    if (!isProjectScheduleConfig(config)) {
      throwInvalidParams('invalid project schedule config');
    }
    if (!PROJECT_SCHEDULE_ID_RE.test(config.id)) {
      throwInvalidParams('project schedule id must be kebab-case ascii');
    }
    const read = await this.readProjectAutomationsFromDisk(workingDir);
    const schedules = read.kind === 'loaded' ? read.schedules : [];
    const next: ProjectAutomationsFile = {
      version: 1,
      schedules: [
        ...schedules.filter((item) => item.id !== config.id),
        config,
      ],
    };
    await this.writeProjectAutomationsFile(workingDir, next);
    return this.reconcileAfterWrite(workingDir);
  }

  async removeSchedule(workingDir: string, id: string): Promise<ReconcileResult> {
    if (!id.trim()) {
      throwInvalidParams('project schedule id is required');
    }
    const read = await this.readProjectAutomationsFromDisk(workingDir);
    if (read.kind !== 'loaded') {
      return this.reconcileAfterWrite(workingDir);
    }
    const next: ProjectAutomationsFile = {
      version: 1,
      schedules: read.schedules.filter((item) => item.id !== id),
    };
    await this.writeProjectAutomationsFile(workingDir, next);
    return this.reconcileAfterWrite(workingDir);
  }

  async reconcileAll(): Promise<void> {
    for (const workingDir of await this.listKnownWorkingDirs()) {
      try {
        await this.reconcile(workingDir);
      } catch (err) {
        this.deps.logger.warn?.('[project-automation] reconcile failed', {
          workingDir,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  async deleteProjectSchedules(workingDir: string): Promise<number> {
    const existing = (await this.deps.storage.list()).filter(
      (schedule) => schedule.source === 'project' && sameWorkingDir(schedule.workingDir, workingDir),
    );
    for (const schedule of existing) {
      await this.deps.scheduler.delete(schedule.id);
    }
    return existing.length;
  }

  private async readProjectAutomations(
    workingDir: string,
    options: { force?: boolean } = {},
  ): Promise<CachedRead> {
    if (!workingDir) return { kind: 'missing' };
    const key = path.resolve(workingDir);
    const now = Date.now();
    const cached = this.cache.get(key);
    if (!options.force && cached && now - cached.ts < CACHE_TTL_MS) {
      this.deps.logger.debug?.('[project-automation] cache hit', { workingDir });
      return cached.value;
    }

    let pending = this.inflight.get(key);
    if (!pending || options.force) {
      pending = this.readProjectAutomationsFromDisk(workingDir);
      this.inflight.set(key, pending);
      pending.finally(() => this.inflight.delete(key));
    }
    const value = await pending;
    this.cache.set(key, { value, ts: Date.now() });
    return value;
  }

  private async reconcileAfterWrite(workingDir: string): Promise<ReconcileResult> {
    await this.readProjectAutomations(workingDir, { force: true });
    return this.reconcile(workingDir);
  }

  private async readProjectAutomationsFromDisk(workingDir: string): Promise<CachedRead> {
    const migration = await migrateLegacyXdmakerDir(workingDir);
    if (!migration.complete) return { kind: 'migration-incomplete' };
    const filePath = path.join(workingDir, AUTOMATIONS_REL_PATH);
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') return { kind: 'missing' };
      this.deps.logger.warn?.('[project-automation] read failed', {
        workingDir,
        error: err instanceof Error ? err.message : String(err),
      });
      return { kind: 'parse-error' };
    }

    try {
      const parsed = JSON.parse(content) as unknown;
      if (!isProjectAutomationsFile(parsed)) {
        this.deps.logger.warn?.('[project-automation] invalid schedules.json schema', {
          workingDir,
        });
        return { kind: 'parse-error' };
      }
      return {
        kind: 'loaded',
        content,
        configHash: this.computeHash(content),
        schedules: parsed.schedules,
      };
    } catch (err) {
      this.deps.logger.warn?.('[project-automation] parse failed', {
        workingDir,
        error: err instanceof Error ? err.message : String(err),
      });
      return { kind: 'parse-error' };
    }
  }

  private async writeProjectAutomationsFile(
    workingDir: string,
    file: ProjectAutomationsFile,
  ): Promise<void> {
    const filePath = path.join(workingDir, AUTOMATIONS_REL_PATH);
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = path.join(dir, `schedules.json.tmp.${randomUUID()}`);
    const content = `${JSON.stringify(file, null, 2)}\n`;
    await fs.writeFile(tmpPath, content, 'utf8');
    await fs.rename(tmpPath, filePath);
  }

  private async listKnownWorkingDirs(): Promise<string[]> {
    const found = new Map<string, string>();
    const add = (workingDir: string | null | undefined) => {
      if (!workingDir) return;
      found.set(path.resolve(workingDir), workingDir);
    };

    const projectSchedules = await this.deps.getDb()
      .select({ workingDir: schedules.workingDir })
      .from(schedules)
      .where(and(eq(schedules.source, 'project'), isNotNull(schedules.workingDir)));
    for (const row of projectSchedules) add(row.workingDir);

    const projectSessions = await this.deps.getDb()
      .select({ workingDir: sessions.workingDir })
      .from(sessions)
      .where(isNotNull(sessions.workingDir));
    for (const row of projectSessions) add(row.workingDir);

    return [...found.values()];
  }

  private async getLastHash(workingDir: string): Promise<string | null> {
    const [row] = await this.deps.getDb()
      .select({ configHash: projectAutomationConsents.configHash })
      .from(projectAutomationConsents)
      .where(eq(projectAutomationConsents.workingDir, workingDir))
      .limit(1);
    return row?.configHash ?? null;
  }

  private async deleteLastHash(workingDir: string): Promise<void> {
    await this.deps.getDb()
      .delete(projectAutomationConsents)
      .where(eq(projectAutomationConsents.workingDir, workingDir));
  }

  private emit(event: ProjectAutomationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.deps.logger.warn?.('[project-automation] event listener failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

type ProjectCreateScheduleInput = CreateScheduleInput & {
  source: 'project';
  projectConfigId: string;
};

type ProjectUpdateScheduleInput = UpdateScheduleInput & {
  source: 'project';
  projectConfigId: string;
};

function scheduleConfigToCreateInput(
  config: ProjectScheduleConfig,
  workingDir: string,
): ProjectCreateScheduleInput {
  return {
    name: config.name,
    prompt: config.prompt,
    source: 'project',
    projectConfigId: config.id,
    kind: 'cron',
    cronExpr: config.cronExpr,
    timezone: config.timezone ?? 'Asia/Shanghai',
    recurring: config.recurring ?? true,
    manual: config.manual ?? false,
    intervalMs: config.intervalMs,
    agentKind: config.agentKind ?? 'claude-code',
    model: config.model,
    providerId: config.providerId,
    effort: config.effort,
    fastMode: config.fastMode,
    workspaceKind: 'project',
    workingDir,
    useWorktree: config.useWorktree ?? false,
    persistentSession: config.persistentSession ?? false,
    silentWhenIdle: config.silentWhenIdle ?? false,
    // 恒带 key:配置省略 → undefined → update patch 双列写 NULL(清空既有 hook),
    // 与表单 buildScheduleInput 的「关闭前置检查」落库通道同一契约。
    preRunHook: config.preRunHook?.command?.trim()
      ? { command: config.preRunHook.command, timeoutMs: config.preRunHook.timeoutMs }
      : undefined,
    notify: normalizeNotify(config.notify),
  };
}

function scheduleConfigToUpdateInput(
  config: ProjectScheduleConfig,
  workingDir: string,
): ProjectUpdateScheduleInput {
  return scheduleConfigToCreateInput(config, workingDir);
}

export function schedulesDiffer(
  schedule: Schedule,
  config: ProjectScheduleConfig,
  workingDir: string,
): boolean {
  const expected = scheduleConfigToUpdateInput(config, workingDir);
  return (
    schedule.name !== expected.name ||
    schedule.prompt !== expected.prompt ||
    schedule.cronExpr !== expected.cronExpr ||
    schedule.timezone !== expected.timezone ||
    schedule.recurring !== expected.recurring ||
    schedule.manual !== expected.manual ||
    schedule.intervalMs !== expected.intervalMs ||
    schedule.agentKind !== expected.agentKind ||
    schedule.model !== expected.model ||
    (schedule.providerId ?? undefined) !== (expected.providerId ?? undefined) ||
    schedule.effort !== expected.effort ||
    !!schedule.fastMode !== !!expected.fastMode ||
    schedule.workspaceKind !== expected.workspaceKind ||
    !sameWorkingDir(schedule.workingDir, workingDir) ||
    schedule.useWorktree !== expected.useWorktree ||
    schedule.persistentSession !== expected.persistentSession ||
    schedule.silentWhenIdle !== expected.silentWhenIdle ||
    (schedule.preRunHook?.command ?? '') !== (expected.preRunHook?.command ?? '') ||
    (schedule.preRunHook?.timeoutMs ?? undefined) !== (expected.preRunHook?.timeoutMs ?? undefined) ||
    schedule.notify.desktop !== expected.notify?.desktop ||
    schedule.notify.feishu !== expected.notify?.feishu ||
    !!schedule.notify.wecomGroup !== !!expected.notify?.wecomGroup
  );
}

function normalizeNotify(
  notify: ProjectScheduleConfig['notify'] | undefined,
): ScheduleNotifyConfig {
  return {
    desktop: notify?.desktop ?? true,
    feishu: notify?.feishu ?? false,
    wecomGroup: notify?.wecomGroup ?? false,
  };
}

export const __testing = {
  scheduleConfigToUpdateInput,
};

function sameWorkingDir(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isProjectAutomationsFile(value: unknown): value is ProjectAutomationsFile {
  if (!value || typeof value !== 'object') return false;
  const file = value as { version?: unknown; schedules?: unknown };
  if (file.version !== 1 || !Array.isArray(file.schedules)) return false;
  const ids = new Set<string>();
  for (const schedule of file.schedules) {
    if (!isProjectScheduleConfig(schedule) || ids.has(schedule.id)) return false;
    ids.add(schedule.id);
  }
  return true;
}

function isProjectScheduleConfig(value: unknown): value is ProjectScheduleConfig {
  if (!value || typeof value !== 'object') return false;
  const config = value as ProjectScheduleConfig;
  return (
    typeof config.id === 'string' &&
    config.id.trim() !== '' &&
    typeof config.name === 'string' &&
    config.name.trim() !== '' &&
    typeof config.prompt === 'string' &&
    typeof config.cronExpr === 'string' &&
    config.cronExpr.trim() !== '' &&
    optionalString(config.timezone) &&
    optionalBoolean(config.recurring) &&
    optionalBoolean(config.manual) &&
    optionalNumber(config.intervalMs) &&
    optionalAgentKind(config.agentKind) &&
    optionalString(config.model) &&
    optionalString(config.providerId) &&
    optionalString(config.effort) &&
    optionalBoolean(config.fastMode) &&
    optionalBoolean(config.useWorktree) &&
    optionalBoolean(config.persistentSession) &&
    optionalBoolean(config.silentWhenIdle) &&
    optionalPreRunHook(config.preRunHook) &&
    optionalNotify(config.notify)
  );
}

function optionalPreRunHook(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const hook = value as { command?: unknown; timeoutMs?: unknown };
  return (
    typeof hook.command === 'string' &&
    hook.command.trim() !== '' &&
    optionalNumber(hook.timeoutMs)
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function optionalAgentKind(value: unknown): boolean {
  return value === undefined || value === 'claude-code' || value === 'codex';
}

function optionalNotify(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const notify = value as { desktop?: unknown; feishu?: unknown; wecomGroup?: unknown };
  return (
    optionalBoolean(notify.desktop) &&
    optionalBoolean(notify.feishu) &&
    optionalBoolean(notify.wecomGroup)
  );
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function throwInvalidParams(message: string): never {
  const err = new Error(message);
  (err as { code?: string }).code = 'INVALID_PARAMS';
  throw err;
}
