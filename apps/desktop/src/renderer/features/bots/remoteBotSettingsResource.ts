import { z } from 'zod';
import { REMOTE_RESOURCE_PROTOCOL_VERSION, type RemoteResourceRef } from '@cindy/device-link';

const id = z.string().min(1).max(256);
const text = z.union([
  z.string().max(20_000),
  z.object({
    fallback: z.string().max(20_000),
    translations: z.record(z.string(), z.string().max(20_000)).optional(),
  }),
]);
const field = z
  .object({
    id,
    label: text,
    kind: z.enum(['text', 'multiline', 'toggle', 'select']),
    required: z.boolean().optional(),
    options: z
      .array(z.object({ value: z.string().max(256), label: text }))
      .max(2000)
      .optional(),
  })
  .refine((value) => value.kind !== 'select' || !!value.options?.length);
const action = z.object({
  id,
  label: text,
  disabled: z.boolean().optional(),
  tone: z.string().optional(),
  fields: z.array(field).max(20).optional(),
  confirmation: z
    .object({ title: text, body: text.optional(), confirmLabel: text.optional() })
    .optional(),
});
const block = z.object({
  id,
  primitive: z.string(),
  title: text.optional(),
  fallbackMarkdown: z.string().max(100_000),
  data: z
    .object({
      actionId: id.optional(),
      values: z.record(z.string(), z.unknown()).optional(),
      entries: z
        .array(z.object({ id, title: text, resourceId: id }))
        .max(2000)
        .optional(),
    })
    .passthrough()
    .optional(),
});
const resource = z.object({
  ref: z.object({ collectionId: id, kind: id, id }),
  revision: z.string().max(1024),
  display: z.object({ title: text }),
  blocks: z.array(z.unknown()).max(512).optional().default([]),
  actions: z.array(z.unknown()).max(512).optional().default([]),
});
export type RemoteBotSettingsAction = z.infer<typeof action>;
export type RemoteBotSettingsValues = Record<string, string | boolean>;
export type RemoteBotSettingsPanel = z.infer<typeof block> & {
  action?: RemoteBotSettingsAction;
  values: RemoteBotSettingsValues;
};
export interface RemoteBotSettingsResource {
  ref: RemoteResourceRef;
  revision: string;
  title: z.infer<typeof text>;
  panels: RemoteBotSettingsPanel[];
}

export function remoteBotSettingsClient(locale: string) {
  return {
    protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION,
    primitives: ['form', 'action', 'list', 'markdown'],
    locale,
  };
}

/** Unknown controls stay read-only; incomplete forms must never overwrite host values. */
export function parseRemoteBotSettings(
  raw: unknown,
  expected: RemoteResourceRef,
): RemoteBotSettingsResource {
  const parsed = resource.parse(raw);
  if (
    parsed.ref.collectionId !== expected.collectionId ||
    parsed.ref.kind !== expected.kind ||
    parsed.ref.id !== expected.id
  )
    throw new Error('Unexpected teammate settings');
  const actions = new Map(
    parsed.actions.flatMap((value) => {
      const result = action.safeParse(value);
      return result.success ? [[result.data.id, result.data] as const] : [];
    }),
  );
  const panels = parsed.blocks.flatMap((value) => {
    const result = block.safeParse(value);
    if (!result.success) return [];
    const item = result.data;
    let bound = ['form', 'action'].includes(item.primitive)
      ? actions.get(item.data?.actionId ?? '')
      : undefined;
    const values: RemoteBotSettingsValues = {};
    for (const field of bound?.fields ?? []) {
      const value = item.data?.values?.[field.id];
      if (item.primitive === 'action' && value === undefined && field.kind !== 'toggle') {
        values[field.id] = '';
      } else if (
        field.kind === 'toggle'
          ? typeof value === 'boolean'
          : typeof value === 'string' && value.length <= 65_536
      ) {
        values[field.id] = value as string | boolean;
      } else bound = undefined;
    }
    return [{ ...item, action: bound, values }];
  });
  return { ref: parsed.ref, revision: parsed.revision, title: parsed.display.title, panels };
}
