import { z } from 'zod';
import { settingsSnapshotReportV2Schema, validateSettingsSnapshotBudget } from './settingsSnapshotV2.js';
export * from './settingsSnapshotV2.js';

/** CIS 设置快照的客户端本地契约；与服务端 settings-snapshot.ts 及 fixture 成对维护。 */
export const SETTINGS_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const SETTINGS_SNAPSHOT_MAX_BYTES = 8 * 1024;
export const SETTINGS_SNAPSHOT_PUBLISH_INTERVAL_MS = 60_000;
export const SETTINGS_SNAPSHOT_MIN_WRITE_INTERVAL_MS = 10_000;
export const SETTINGS_SNAPSHOT_FRESHNESS_MS = 180_000;
export const settingsSnapshotSourceSchema = z.enum(['default', 'override']);
const field = <T extends z.core.$ZodType>(value: T) => z.strictObject({
  value, source: settingsSnapshotSourceSchema,
});
/** 只接收结构化目录标识，不安全或自定义原始值由投影端省略。 */
export const settingsSnapshotIdentifierSchema = z.string().min(1).max(96)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
  .refine(value => !/^(?:sk-|Bearer|cpca_|cpcr_|eyJ|https?|localhost$)/iu.test(value));
const number = (min: number, max: number) => z.number().finite().min(min).max(max);
const domain = <T extends z.ZodRawShape, S extends string, B extends string>(
  scope: S, boundary: B, shape: T,
) => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('supported'), scope: z.literal(scope), boundary: z.literal(boundary),
    fields: z.strictObject(shape) }),
  z.strictObject({ status: z.literal('unsupported'), scope: z.literal(scope), boundary: z.literal(boundary) }),
  z.strictObject({ status: z.literal('unavailable'), scope: z.literal(scope), boundary: z.literal(boundary) }),
]);

export const settingsSnapshotDomainsSchema = z.strictObject({
  newTaskDefaults: domain('owner', 'nextTask', {
    harness: field(z.enum(['claude-code', 'codex', 'pi'])).optional(),
    modelId: field(settingsSnapshotIdentifierSchema).optional(),
    providerId: field(settingsSnapshotIdentifierSchema).optional(),
    effort: field(z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])).optional(),
    fast: field(z.boolean()).optional(),
    thinking: field(z.boolean()).optional(),
    worktree: field(z.boolean()).optional(),
    plan: field(z.boolean()).optional(),
  }),
  personalization: domain('owner', 'nextAgentStart', {
    customized: field(z.boolean()),
  }),
  databaseWarning: domain('profile', 'immediate', {
    thresholdGiB: field(number(0.1, 1024)),
    disabled: field(z.boolean()),
  }),
  appearance: domain('cloudDesktop', 'immediate', {
    uiFontSize: field(number(8, 48)),
    codeFontSize: field(number(8, 48)),
    zoomFactor: field(number(0.5, 3)),
    uiFontCustomized: field(z.boolean()),
    codeFontCustomized: field(z.boolean()),
  }),
});

export const settingsSnapshotReportSchema = z.strictObject({
  schemaVersion: z.literal(SETTINGS_SNAPSHOT_SCHEMA_VERSION),
  reportId: z.string().uuid(),
  baseRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  capturedAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  domains: settingsSnapshotDomainsSchema,
});
export type SettingsSnapshotReport = z.infer<typeof settingsSnapshotReportSchema>;
/** 整份替换的双版本入口；不改变原 v1 parser/export 的语义。 */
export const settingsSnapshotAnyReportSchema = z.union([settingsSnapshotReportSchema, settingsSnapshotReportV2Schema])
  .superRefine((report, ctx) => {
    if (!validateSettingsSnapshotBudget(report).ok) ctx.addIssue({ code: 'custom', message: 'SNAPSHOT_BUDGET_EXCEEDED' });
  });
export type SettingsSnapshotAnyReport = z.infer<typeof settingsSnapshotAnyReportSchema>;
export type SettingsSnapshotDomains = z.infer<typeof settingsSnapshotDomainsSchema>;
/** 接收回执只含服务端水位和时间，不回传配置或身份。 */
export interface SettingsSnapshotReceipt {
  revision: number;
  receivedAtMs: number;
  expiresAtMs: number;
}

/** 两仓共同的非秘密 fixture，不加入身份、路径、指令正文或原始错误。 */
export const SETTINGS_SNAPSHOT_COMPATIBILITY_FIXTURE: SettingsSnapshotReport = {
  schemaVersion: 1,
  reportId: '00000000-0000-4000-8000-000000000001',
  baseRevision: 0,
  capturedAtMs: 1_800_000_000_000,
  domains: {
    newTaskDefaults: { status: 'supported', scope: 'owner', boundary: 'nextTask', fields: {
      harness: { value: 'codex', source: 'override' },
      modelId: { value: 'model-example', source: 'override' },
      providerId: { value: 'provider-example', source: 'default' },
      effort: { value: 'high', source: 'default' },
      fast: { value: false, source: 'default' },
      thinking: { value: true, source: 'default' },
      worktree: { value: false, source: 'override' },
      plan: { value: false, source: 'default' },
    } },
    personalization: { status: 'supported', scope: 'owner', boundary: 'nextAgentStart',
      fields: { customized: { value: true, source: 'override' } } },
    databaseWarning: { status: 'supported', scope: 'profile', boundary: 'immediate', fields: {
      thresholdGiB: { value: 10, source: 'default' }, disabled: { value: false, source: 'default' },
    } },
    appearance: { status: 'supported', scope: 'cloudDesktop', boundary: 'immediate', fields: {
      uiFontSize: { value: 14, source: 'default' }, codeFontSize: { value: 13, source: 'override' },
      zoomFactor: { value: 1, source: 'default' }, uiFontCustomized: { value: false, source: 'default' },
      codeFontCustomized: { value: true, source: 'override' },
    } },
  },
};
