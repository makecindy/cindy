import { managementCommandSchema, managementResultSchema } from './settingsManagement.js';
import { z } from 'zod';
import { ADDITIONAL_SETTINGS_DOMAINS, additionalSettingsSchema, normalizeAdditionalSettingsChange, settingsEditableValueSchema } from './settingsEditableCatalog.js';

/** Separate from the public read-only snapshot. These values belong to the signed-in owner. */
export const settingsWebDomainSchema = z.enum(['newTaskDefaults', 'personalization', 'databaseWarning', 'appearance', ...ADDITIONAL_SETTINGS_DOMAINS]);
export const SETTINGS_WEB_MAX_BYTES = 64 * 1024;
/** Catalog routes include every supported engine; saved override limits remain separate. */
export const SETTINGS_WEB_MAX_CHOICES = 512;
const id = z.string().uuid();
const revision = z.string().min(1).max(128);
// eslint-disable-next-line no-control-regex
const routeId = z.string().trim().min(1).max(256).regex(/^[^\x00-\x1f]+$/u);
const effort = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const newTask = z.strictObject({ harness: z.enum(['claude-code', 'codex', 'pi']), providerId: routeId.nullable(), modelId: routeId.nullable(), effort: effort.nullable(), fast: z.boolean(), thinking: z.boolean(), worktree: z.boolean(), planMode: z.boolean() });
const appearance = z.strictObject({ uiFamily: z.string().trim().max(256), codeFamily: z.string().trim().max(256), uiSize: z.number().int().min(12).max(24), codeSize: z.number().int().min(10).max(24), windowZoom: z.number().min(0.5).max(3).refine(v => Math.abs(v * 10 - Math.round(v * 10)) < 1e-8) });
const database = z.strictObject({ thresholdGiB: z.number().min(1).max(1024), disabled: z.boolean() });
const personalization = z.strictObject({ userPrompt: z.string().max(8000) });
const fields = {
  newTaskDefaults: newTask.keyof().options,
  personalization: personalization.keyof().options,
  databaseWarning: database.keyof().options,
  appearance: appearance.keyof().options,
};
const updateBase = { expectedRevision: revision, operationId: id, clear: z.array(z.string()).max(8).optional() };
const nativeSettingsWebUpdateSchema = z.discriminatedUnion('domain', [
  z.strictObject({ ...updateBase, domain: z.literal('newTaskDefaults'), set: newTask.extend({ providerId: routeId, modelId: routeId }).partial().optional() }),
  z.strictObject({ ...updateBase, domain: z.literal('personalization'), set: personalization.partial().optional() }),
  z.strictObject({ ...updateBase, domain: z.literal('databaseWarning'), set: database.partial().optional() }),
  z.strictObject({ ...updateBase, domain: z.literal('appearance'), set: appearance.partial().optional() }),
]).superRefine((value, ctx) => {
  const set = Object.keys(value.set ?? {});
  const clear = value.clear ?? [];
  if (!set.length && !clear.length || clear.some(key => !(fields[value.domain] as string[]).includes(key) || set.includes(key))
    || new Set(clear).size !== clear.length) ctx.addIssue({ code: 'custom', message: 'invalid settings change' });
});
const additionalDomain = z.enum(ADDITIONAL_SETTINGS_DOMAINS as [typeof ADDITIONAL_SETTINGS_DOMAINS[number], ...typeof ADDITIONAL_SETTINGS_DOMAINS[number][]]);
const workspaceId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const additionalUpdate = z.strictObject({ ...updateBase, domain: additionalDomain, workspaceId: workspaceId.optional(), set: z.record(z.string(), z.unknown()).optional(), clear: z.array(z.string()).max(16).optional() })
  .superRefine((value, ctx) => { try { normalizeAdditionalSettingsChange(value.domain, value.set, value.clear); }
    catch { ctx.addIssue({ code: 'custom', message: 'invalid settings change' }); }
    if ((value.domain === 'workspaceTools') !== (value.workspaceId !== undefined)) ctx.addIssue({ code: 'custom', message: 'invalid workspace scope' }); });
export const settingsWebUpdateSchema = z.union([nativeSettingsWebUpdateSchema, additionalUpdate]);
const batchDomains = z.array(settingsWebDomainSchema).min(1).max(64).refine(domains => new Set(domains).size === domains.length);
/**
 * Owner-only Host calls the cloud instance service's browser pages make in place of
 * DeviceLink invokes. A closed list: CIS relays only these names, and only to a Host
 * that declared them. The Host applies the same handlers and owner checks as DeviceLink.
 * The personal instructions are not here: their text travels over DeviceLink only.
 */
export const SETTINGS_WEB_CHANNELS = [
  'cloud:provider-settings:v1',
  'cloud:im-settings:v1',
  'cloud:storage-usage:v1',
  'maker:get-capabilities',
  'maker:model-catalog:read',
  'maker:provider:list',
  // Account quota, model favorites and the owner's provider management.
  'maker:usage:account',
  'maker:usage:codex-rate-limits',
  'maker:model-favorites:get',
  'maker:model-favorites:apply',
  'provider-group:remote',
] as const;
/** The largest Host channel reply (the provider catalog) plus envelope headroom. */
export const SETTINGS_WEB_LARGE_RESULT_MAX_BYTES = 2 * 1024 * 1024 + 64 * 1024;
const channelName = z.enum(SETTINGS_WEB_CHANNELS);
const iceUrl = z.string().max(512).regex(/^(stun|turn|turns):[^\s]+$/u);
const iceServer = z.strictObject({ urls: z.union([iceUrl, z.array(iceUrl).min(1).max(8)]),
  username: z.string().max(512).optional(), credential: z.string().max(512).optional() });
export const settingsWebCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('manage'), command: managementCommandSchema }),
  z.strictObject({ kind: z.literal('readBatch'), domains: batchDomains }),
  z.strictObject({ kind: z.literal('read'), domain: settingsWebDomainSchema, workspaceId: workspaceId.optional() }),
  z.strictObject({ kind: z.literal('update'), change: settingsWebUpdateSchema }),
  z.strictObject({ kind: z.literal('receipt'), operationId: id }),
  // Opaque to CIS: the Host parses arguments and requests with its own schemas.
  z.strictObject({ kind: z.literal('channel'), channel: channelName, args: z.array(z.unknown()).max(8) }),
  z.strictObject({ kind: z.literal('desktop'), request: z.record(z.string(), z.unknown()) }),
  z.strictObject({ kind: z.literal('desktopIce') }),
]).refine(value => value.kind !== 'read' || value.workspaceId === undefined || value.domain === 'workspaceTools', 'invalid workspace scope');
export type SettingsWebCommand = z.infer<typeof settingsWebCommandSchema>;
/** Commands only a signed-in browser may send; the native client already has DeviceLink. */
export const settingsWebConnectSchema = z.strictObject({ runtimeId: id, domains: batchDomains, readBatch: z.literal(true).optional(), managementV1: z.literal(true).optional(),
  channels: z.array(channelName).min(1).max(SETTINGS_WEB_CHANNELS.length).refine(names => new Set(names).size === names.length).optional(),
  desktopV1: z.literal(true).optional() });
const modelOption = z.strictObject({ harness: newTask.shape.harness, providerId: routeId, providerName: z.string().min(1).max(256), modelId: routeId, modelName: z.string().min(1).max(256), efforts: z.array(effort).max(7), supportsFast: z.boolean(), supportsThinkingToggle: z.boolean() });
const readyBase = { status: z.literal('ready'), revision, operationId: id, customizedKeys: z.array(z.string().max(32)).max(8), isCustomized: z.boolean() };
const promptState = z.strictObject({ isCustomized: z.boolean() });
const nativeReady = z.discriminatedUnion('domain', [
  z.strictObject({ ...readyBase, domain: z.literal('newTaskDefaults'), value: newTask, defaults: newTask, models: z.array(modelOption).max(256) }),
  z.strictObject({ ...readyBase, domain: z.literal('personalization'), value: promptState, defaults: promptState }),
  z.strictObject({ ...readyBase, domain: z.literal('databaseWarning'), value: database, defaults: database }),
  z.strictObject({ ...readyBase, domain: z.literal('appearance'), value: appearance, defaults: appearance }),
]).refine(value => new Set(value.customizedKeys).size === value.customizedKeys.length
  && value.customizedKeys.every(key => (fields[value.domain] as string[]).includes(key))
  && value.isCustomized === (value.customizedKeys.length > 0), 'invalid override state');
const additionalReady = z.strictObject({ ...readyBase, domain: additionalDomain,
  workspaceId: workspaceId.optional(), workspaceLabel: z.string().min(1).max(512).optional(),
  value: z.record(z.string(), settingsEditableValueSchema),
  defaults: z.record(z.string(), settingsEditableValueSchema),
  customizedKeys: z.array(z.string().max(64)).max(16),
  choices: z.record(z.string(), z.array(z.strictObject({ value: settingsEditableValueSchema, label: z.string().min(1).max(512), efforts: z.array(z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])).max(7).optional(), supportsFast: z.boolean().optional() })).max(SETTINGS_WEB_MAX_CHOICES)).optional(),
}).superRefine((value, ctx) => {
  const schema = additionalSettingsSchema(value.domain);
  if ((value.domain === 'workspaceTools') !== (value.workspaceId !== undefined && value.workspaceLabel !== undefined)
    || value.domain !== 'workspaceTools' && (value.workspaceId !== undefined || value.workspaceLabel !== undefined)
    || !schema.safeParse(value.value).success || !schema.safeParse(value.defaults).success
    || new Set(value.customizedKeys).size !== value.customizedKeys.length
    || value.customizedKeys.some(key => !Object.hasOwn(schema.shape, key))
    || value.isCustomized !== (value.customizedKeys.length > 0)) ctx.addIssue({ code: 'custom', message: 'invalid settings state' });
});
const ready = z.union([nativeReady, additionalReady]);
const receipt = z.union([
  z.strictObject({ status: z.enum(['pending', 'unknown']) }),
  z.strictObject({ status: z.enum(['saved', 'rejected', 'unknown']), operationId: id, domain: settingsWebDomainSchema, saved: z.boolean(), application: z.enum(['next_task', 'next_agent_start', 'applied', 'failed', 'not_applied']), revision: revision.optional(), code: z.string().regex(/^[A-Z_]{1,64}$/u).optional() })
    .refine(value => value.saved === (value.status === 'saved') && value.saved === (value.application !== 'not_applied'), 'inconsistent receipt'),
]);
const failed = z.strictObject({ ok: z.literal(false), code: z.string().regex(/^[A-Z_]{1,64}$/u) });
export const settingsWebReadResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), settings: ready }),
  z.strictObject({ ok: z.literal(true), settings: z.strictObject({ domain: settingsWebDomainSchema, status: z.enum(['unavailable', 'unreadable']), revision: z.null() }) }),
  failed,
]);
export type SettingsWebReadResult = z.infer<typeof settingsWebReadResultSchema>;
export const settingsWebBatchResultSchema = z.strictObject({
  ok: z.literal(true),
  entries: z.array(z.strictObject({ domain: settingsWebDomainSchema, result: settingsWebReadResultSchema })).min(1).max(64),
  remainingDomains: z.array(settingsWebDomainSchema).max(63),
}).superRefine((value, ctx) => {
  const domains = [...value.entries.map(entry => entry.domain), ...value.remainingDomains];
  if (domains.length > 64 || new Set(domains).size !== domains.length
    || value.entries.some(entry => entry.result.ok && entry.result.settings.domain !== entry.domain)) {
    ctx.addIssue({ code: 'custom', message: 'invalid settings batch' });
  }
});
const largeResult = (value: object) => 'channel' in value || 'desktop' in value;
export const settingsWebResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), management: managementResultSchema }),
  settingsWebReadResultSchema,
  settingsWebBatchResultSchema,
  z.strictObject({ ok: z.literal(true), receipt }),
  z.strictObject({ ok: z.literal(true), channel: z.unknown().refine(value => value !== undefined) }),
  z.strictObject({ ok: z.literal(true), desktop: z.unknown().refine(value => value !== undefined) }),
  z.strictObject({ ok: z.literal(true), ice: z.array(iceServer).max(16) }),
]).refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength
  <= (largeResult(value) ? SETTINGS_WEB_LARGE_RESULT_MAX_BYTES : SETTINGS_WEB_MAX_BYTES) - 512, 'settings response exceeds its budget');
export type SettingsWebResult = z.infer<typeof settingsWebResultSchema>;
export type SettingsWebEnvelope = { requestId: string; runtimeId: string; sessionKey: string; expiresAtMs: number; command: SettingsWebCommand };
