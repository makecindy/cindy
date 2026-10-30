import { z } from 'zod';
import { REMOTE_RESOURCE_PROTOCOL_VERSION, type RemoteResourceRef } from '@cindy/device-link';

const id = z.string().min(1).max(160);
const text = z.union([
  z.string().max(20_000),
  z.object({
    fallback: z.string().max(20_000),
    translations: z.record(z.string().max(64), z.string().max(20_000)).optional(),
  }),
]);
const ref = z.object({ collectionId: id, kind: id, id });
const collection = z.object({ id, resourceKind: id, placement: z.string().max(256).optional() });
const manifest = z.object({
  protocolVersion: z.number().int().positive(),
  collections: z.array(z.unknown()).max(256),
});
const action = z.object({
  id,
  label: text,
  disabled: z.boolean().optional(),
  tone: z.string().max(64).optional(),
  confirmation: z
    .object({ title: text, body: text.optional(), confirmLabel: text.optional() })
    .optional(),
  // This surface does not advertise forms. Never submit an action with omitted fields.
  fields: z.array(z.unknown()).max(0).optional(),
});
const block = z
  .object({
    id,
    primitive: id,
    fallbackMarkdown: z.string().max(100_000),
    data: z.unknown().optional(),
  })
  .transform((value) => {
    const controls = z
      .object({ input: z.string(), busy: z.boolean().optional() })
      .safeParse(value.data);
    return {
      ...value,
      data: value.primitive === 'session-controls' && controls.success ? controls.data : undefined,
    };
  });
const resource = z.object({
  ref,
  revision: z.string().max(1024),
  display: z.object({
    title: text,
    subtitle: text.optional(),
    status: z.object({ label: text, tone: z.string().max(64).optional() }).optional(),
  }),
  blocks: z.array(block).max(256).optional().default([]),
  actions: z.array(z.unknown()).max(256).optional().default([]),
});

export type SessionResource = Omit<z.infer<typeof resource>, 'actions'> & {
  actions: z.infer<typeof action>[];
};
export type SessionResourceCollection = z.infer<typeof collection>;

export function sessionResourceClient(locale: string) {
  return {
    protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION,
    primitives: ['session-controls'],
    locale,
  };
}

export function sessionResourceCollections(
  raw: unknown,
  source: string,
): SessionResourceCollection[] {
  return manifest
    .parse(raw)
    .collections.flatMap((item) => {
      const parsed = collection.safeParse(item);
      return parsed.success && parsed.data.placement === 'session:' + source ? [parsed.data] : [];
    })
    .filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index)
    .slice(0, 4);
}

export function parseSessionResource(raw: unknown, expected: RemoteResourceRef): SessionResource {
  const parsed = resource.parse(raw);
  if (
    parsed.ref.collectionId !== expected.collectionId ||
    parsed.ref.kind !== expected.kind ||
    parsed.ref.id !== expected.id
  )
    throw new Error('Unexpected session resource');
  return {
    ...parsed,
    actions: parsed.actions.flatMap((item) => {
      const parsedAction = action.safeParse(item);
      return parsedAction.success ? [parsedAction.data] : [];
    }),
  };
}

export function sessionResourceInputBlocked(resources: readonly SessionResource[]): boolean {
  return resources.some((item) =>
    item.blocks.some(
      (block) => block.primitive === 'session-controls' && block.data?.input !== 'available',
    ),
  );
}
