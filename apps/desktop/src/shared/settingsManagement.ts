import { z } from 'zod';

/** Optional cloud web capability; independent of the frozen v3 settings DTOs. */
export const managementSectionSchema = z.enum(['bots', 'providers', 'mcp', 'contacts', 'memory']);
const id = z.string().uuid();
const text = z.string().max(512);
const name = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u);
const values = z.record(name, z.string().max(16_384)).refine((v) => Object.keys(v).length <= 24);
export const managementCommandSchema = z.discriminatedUnion('operation', [
  z
    .strictObject({
      operation: z.literal('list'),
      section: managementSectionSchema,
      offset: z.number().int().min(0).max(1_000_000).optional(),
    }),
  z.strictObject({ operation: z.literal('run'), actionId: id, operationId: id, values }),
  z.strictObject({ operation: z.literal('status'), operationId: id }),
  z.strictObject({ operation: z.literal('cancel'), operationId: id }),
  z
    .strictObject({ operation: z.literal('respond'), operationId: id, value: z.string().max(16_384) }),
]);
const option = z.strictObject({ value: z.string().max(512), label: text });
export const managementFieldSchema = z
  .strictObject({
    name,
    label: text,
    kind: z.enum(['text', 'password', 'textarea', 'select']),
    required: z.boolean(),
    maxLength: z.number().int().min(1).max(16_384),
    value: z.string().max(16_384).optional(),
    options: z.array(option).max(256).optional(),
  })
  .superRefine((v, ctx) => {
    if (
      (v.kind === 'password' && v.value !== undefined) ||
      (v.kind === 'select' && !v.options?.length) ||
      (v.kind !== 'select' && v.options !== undefined) ||
      (v.value && v.value.length > v.maxLength)
    )
      ctx.addIssue({ code: 'custom', message: 'invalid management field' });
  });
const action = z
  .strictObject({
    id,
    label: text,
    intent: z.enum([
      'connect',
      'authorize',
      'disconnect',
      'reconnect',
      'cancel',
      'create',
      'edit',
      'delete',
      'sync',
      'reset',
    ]),
    confirmation: text.optional(),
    fields: z.array(managementFieldSchema).max(24),
    expiresAt: z.number().int().safe(),
  });
const item = z
  .strictObject({
    id: z.string().min(1).max(256),
    label: text,
    labelKey: z
      .string()
      .regex(/^management\.[a-zA-Z.]+$/u)
      .optional(),
    description: text.optional(),
    status: z.enum([
      'connected',
      'disconnected',
      'connecting',
      'error',
      'conflict',
      'offline',
      'available',
      'unavailable',
    ]),
    detail: text.optional(),
    group: text.optional(),
    actions: z.array(action).max(12),
  });
const externalUrl = z
  .string()
  .max(8192)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  });
export const managementPromptSchema = z
  .strictObject({
    kind: z.enum(['browser', 'device', 'callback', 'qr']),
    url: externalUrl,
    userCode: z.string().max(128).optional(),
    expiresAt: z.number().int().safe(),
  });
export const managementResultSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('page'),
      section: managementSectionSchema,
      items: z.array(item).max(256),
      offset: z.number().int().min(0).optional(),
      nextOffset: z.number().int().min(1).optional(),
    }),
  z
    .strictObject({
      kind: z.literal('operation'),
      operationId: id,
      phase: z.enum([
        'running',
        'waiting',
        'succeeded',
        'failed',
        'cancelled',
        'expired',
        'unknown',
      ]),
      prompt: managementPromptSchema.optional(),
      code: z
        .string()
        .regex(/^[A-Z_]{1,64}$/u)
        .optional(),
    }),
]);
export type ManagementSection = z.infer<typeof managementSectionSchema>;
export type ManagementCommand = z.infer<typeof managementCommandSchema>;
export type ManagementResult = z.infer<typeof managementResultSchema>;
export type ManagementField = z.infer<typeof managementFieldSchema>;
export type ManagementPrompt = z.infer<typeof managementPromptSchema>;
export type ManagementItem = Extract<ManagementResult, { kind: 'page' }>['items'][number];
