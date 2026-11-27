import { z } from 'zod';

// Client projection of CIS's existing maintenance contract, not a Host protocol.
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);
const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
export const cloudMaintenanceCalendarSchema = z
  .strictObject({
    timezone: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => {
        if (value !== value.trim() || (!value.includes('/') && value !== 'UTC')) return false;
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }),
    windows: z
      .array(
        z
          .strictObject({
            id: z
              .string()
              .min(1)
              .max(48)
              .regex(/^[a-zA-Z0-9_-]+$/u),
            weekdays: z
              .array(z.number().int().min(1).max(7))
              .min(1)
              .max(7)
              .refine((days) => new Set(days).size === days.length),
            startLocal: time,
            endLocal: time,
          }),
      )
      .min(1)
      .max(7),
  })
  .superRefine((calendar, ctx) => {
    const ids = new Set<string>(),
      occupied = new Set<number>();
    for (const rule of calendar.windows) {
      const start = minutes(rule.startLocal),
        duration = (minutes(rule.endLocal) - start + 1440) % 1440;
      if (ids.has(rule.id) || duration < 60 || duration > 360)
        ctx.addIssue({ code: 'custom', message: 'invalid maintenance window' });
      ids.add(rule.id);
      for (const day of rule.weekdays)
        for (let n = 0; n < duration; n++) {
          const slot = ((day - 1) * 1440 + start + n) % (7 * 1440);
          if (occupied.has(slot)) {
            ctx.addIssue({ code: 'custom', message: 'overlapping windows' });
            return;
          }
          occupied.add(slot);
        }
    }
  });
export type CloudMaintenanceCalendar = z.infer<typeof cloudMaintenanceCalendarSchema>;
const revision = z.string().regex(/^[a-f0-9]{64}$/u);
const patch = {
  revision,
  defaultsRevision: z.number().int().nonnegative(),
  autoUpdate: z.boolean(),
};
export const cloudMaintenanceEditSchema = z.discriminatedUnion('policyMode', [
  z.strictObject({ ...patch, policyMode: z.literal('inherit') }),
  z
    .strictObject({ ...patch, policyMode: z.literal('custom'), calendar: cloudMaintenanceCalendarSchema }),
]);
export type CloudMaintenanceEdit = z.infer<typeof cloudMaintenanceEditSchema>;
export const cloudMaintenanceViewSchema = z.object({
  instanceId: z.string().min(1).max(128),
  revision,
  defaultsRevision: z.number().int().nonnegative(),
  autoUpdate: z.boolean(),
  raw: z.object({
    policyMode: z.enum(['inherit', 'custom']),
    calendar: cloudMaintenanceCalendarSchema.nullable(),
    scheduledTaskPolicy: z.enum(['protect', 'defer']),
    pausedUntilMs: z.number().nullable(),
  }),
  effective: z.object({
    calendar: cloudMaintenanceCalendarSchema,
    source: z.enum(['inherit', 'custom']),
  }),
  executionMode: z.enum(['scheduled', 'preview-only']),
  nextEligibleAtMs: z.number().nullable(),
  serverTimeMs: z.number(),
  windows: z
    .array(
      z.object({
        startAtMs: z.number(),
        endAtMs: z.number(),
        timezone: z.string(),
        skipped: z.boolean(),
      }),
    )
    .max(32),
});
export type CloudMaintenanceView = z.infer<typeof cloudMaintenanceViewSchema>;
// CIS owner upgrade projection. Image references and backup details stay in Main/CIS.
export const cloudUpgradeOperationSchema = z.object({
  operationId: z.string().min(1).max(128),
  phase: z.string().min(1).max(64),
  active: z.boolean(),
  updatedAtMs: z.number().finite(),
});
export type CloudUpgradeOperation = z.infer<typeof cloudUpgradeOperationSchema>;
export const cloudUpgradeStatusSchema = z.object({
  instanceId: z.string().min(1).max(128),
  latestReleaseTag: z.string().max(256).nullable(),
  updateAvailable: z.boolean(),
  manualUpgrade: z.boolean(),
  operation: cloudUpgradeOperationSchema.nullable(),
});
export const cloudUpgradeReceiptSchema = z.object({ operation: cloudUpgradeOperationSchema });
export const cloudInstanceViewSchema = z
  .strictObject({
    instanceId: z.string().min(1).max(128),
    deviceId: z.string().min(1).max(160),
    name: z.string().max(512).nullable(),
    nameSequence: z.number().int().nonnegative(),
    // Place among the owner's current instances for the default name; null for a sole one.
    ordinal: z.number().int().positive().nullable(),
    desiredState: z.enum(['running', 'stopped', 'deleted']),
    runtimeState: z.string().max(64),
    ready: z.boolean(),
    loginRequired: z.boolean().optional(),
    loginWakeSupported: z.boolean().optional(),
    version: z.string().max(256).nullable(),
    imageId: z.string().max(64).nullable(),
    updateAvailable: z.boolean(),
    latestVersion: z.string().max(256).nullable(),
    upgradeState: z.enum(['idle', 'verifying', 'rolled-back']),
    observedAtMs: z.number().nullable(),
    maintenance: cloudMaintenanceViewSchema.nullable(),
    // Absent on older CIS: do not infer permission from a registry tag.
    manualUpgrade: z.boolean().optional(),
    upgradeOperation: cloudUpgradeOperationSchema.nullable().optional(),
    resourceChanging: z.boolean().optional(),
  });
export type CloudInstanceView = z.infer<typeof cloudInstanceViewSchema>;
export const cloudInstanceTargetSchema = z.strictObject({ deviceId: z.string().min(1).max(160) });
export const cloudInstancePowerSchema = cloudInstanceTargetSchema
  .extend({ action: z.enum(['wake', 'sleep']) })
  .strict();
export const cloudInstancePolicySchema = cloudInstanceTargetSchema
  .extend({ change: cloudMaintenanceEditSchema })
  .strict();

export const cloudInstanceUpgradeSchema = cloudInstanceTargetSchema
  .extend({ requestId: z.string().uuid() })
  .strict();
