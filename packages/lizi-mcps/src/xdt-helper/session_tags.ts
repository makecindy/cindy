import { z } from 'zod';
import { TASK_TAG_COLORS, type TaskTagRequest, type TaskTagResult } from '@cindy/maker-shared';
import type { LiziMcpSessionContext } from '../types.js';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { okPayload, errorPayload } from './_payload.js';
import { encodeConfirmationToken, decodeConfirmationToken } from './_confirmation_token.js';

export type SessionTagsCallback = (
  callerSessionId: string,
  request: TaskTagRequest,
) => Promise<TaskTagResult>;
export function registerSessionTagTools(
  registry: XdtHelperToolRegistry,
  deps: {
    getSessionContext: () => LiziMcpSessionContext;
    execute: SessionTagsCallback;
  },
) {
  const id = z.string().trim().min(1).max(128);
  const sessionIds = z.array(id).min(1).max(100).optional();
  const tagIds = z.array(id).min(1).max(32);
  const invoke = async (request: TaskTagRequest) => {
    const caller = deps.getSessionContext().sessionId;
    if (!caller) throw new Error('[NO_SESSION_CONTEXT] No current Cindy task');
    return deps.execute(caller, request);
  };
  const register = (
    name: string,
    category: 'history' | 'control',
    description: string,
    inputShape: z.ZodRawShape,
    handler: (args: any) => Promise<object>,
  ) =>
    registry.register({
      name,
      category,
      description:
        description +
        ' Scope: the owner database on the computer hosting the current task. IDs from another computer are not accepted. Only change tags when requested by the user.',
      inputShape,
      handler: async (args) => {
        try {
          if (!deps.getSessionContext().sessionId)
            return errorPayload('NO_SESSION_CONTEXT', 'No current Cindy task');
          return okPayload({ ...(await handler(args)) });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return errorPayload(message.match(/\[([A-Z_]+)\]/)?.[1] ?? 'INTERNAL', message);
        }
      },
    });
  register(
    'list_task_tags',
    'history',
    'list_task_tags(): List label IDs, names, colors, sort positions and revisions in display order. The first seven appear in the task menu.',
    {},
    () => invoke({ action: 'list' }),
  );
  register(
    'get_task_tags',
    'history',
    'get_task_tags(session_ids?: string[]): Read tags for up to 100 task IDs; omitted means current task.',
    { session_ids: sessionIds },
    (a) =>
      invoke({
        action: 'get',
        sessionIds: a.session_ids ?? [deps.getSessionContext().sessionId!],
      }),
  );
  register(
    'find_tasks_by_tag',
    'history',
    'find_tasks_by_tag(tag_id: string, offset?: number, limit?: number): Find tasks with a label; limit 1–100, default 50. Includes archived tasks; follow hasMore.',
    {
      tag_id: id,
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    (a) =>
      invoke({
        action: 'find',
        tagId: a.tag_id,
        offset: a.offset,
        limit: a.limit,
      }),
  );
  register(
    'create_task_tag',
    'control',
    `create_task_tag(name: string, color: ${TASK_TAG_COLORS.join('|')}): Create a named label at the end of the display order.`,
    {
      name: z.string().trim().min(1).max(80),
      color: z.enum(TASK_TAG_COLORS),
    },
    (a) =>
      invoke({
        action: 'create',
        name: a.name,
        color: a.color,
      }),
  );
  register(
    'update_task_tag',
    'control',
    `update_task_tag(tag_id: string, revision: number, name?: string, color?: ${TASK_TAG_COLORS.join('|')}): Rename/recolor globally, preserving display order. Use current revision from list_task_tags; conflicts require rereading.`,
    {
      tag_id: id,
      revision: z.number().int().min(1),
      name: z.string().trim().min(1).max(80).optional(),
      color: z.enum(TASK_TAG_COLORS).optional(),
    },
    (a) =>
      invoke({
        action: 'update',
        tagId: a.tag_id,
        revision: a.revision,
        name: a.name,
        color: a.color,
      }),
  );
  for (const action of ['attach', 'detach'] as const)
    register(
      action === 'attach' ? 'add_task_tags' : 'remove_task_tags',
      'control',
      `${action === 'attach' ? 'add_task_tags' : 'remove_task_tags'}(tag_ids: string[], session_ids?: string[]): ${action === 'attach' ? 'Add' : 'Remove'} labels atomically for up to 100 tasks on this host; omitted IDs mean current task. Preserves all other labels. Returns per-task tags.`,
      { tag_ids: tagIds, session_ids: sessionIds },
      (a) =>
        invoke({
          action,
          tagIds: a.tag_ids,
          sessionIds: a.session_ids ?? [deps.getSessionContext().sessionId!],
        }),
    );
  register(
    'reorder_task_tags',
    'control',
    'reorder_task_tags(tag_ids: string[], expected_order: string[]): Reorder the complete label directory. Both arrays must contain every label ID exactly once. expected_order is the current order from list_task_tags; tag_ids is the requested order. Concurrent changes require rereading. The first seven labels appear in the task menu.',
    {
      tag_ids: z.array(id).min(1).max(256),
      expected_order: z.array(id).min(1).max(256),
    },
    (a) =>
      invoke({
        action: 'reorder',
        tagIds: a.tag_ids,
        expectedOrder: a.expected_order,
      }),
  );
  const confirmation = z.object({
    caller: id,
    tagId: id,
    revision: z.number().int(),
    count: z.number().int(),
    expires: z.number(),
  });
  register(
    'delete_task_tag',
    'control',
    'delete_task_tag(tag_id: string, confirmation_token?: string): First omit token to preview affected task count. After the user explicitly approves deleting this label globally, repeat with returned token. Removes label associations, including archived tasks; keeps tasks/messages. Token expires in 10 minutes; changed data requires a new preview.',
    { tag_id: id, confirmation_token: z.string().max(4096).optional() },
    async (a) => {
      const caller = deps.getSessionContext().sessionId!;
      if (!a.confirmation_token) {
        const r = await invoke({ action: 'previewDelete', tagId: a.tag_id });
        return {
          preview: r.deletion,
          confirmation_token: encodeConfirmationToken('delete_task_tag', {
            caller,
            ...r.deletion,
            expires: Date.now() + 600_000,
          }),
        };
      }
      const payload = decodeConfirmationToken(
        'delete_task_tag',
        a.confirmation_token,
        (v): v is z.infer<typeof confirmation> => confirmation.safeParse(v).success,
      );
      if (
        !payload ||
        payload.caller !== caller ||
        payload.tagId !== a.tag_id ||
        payload.expires < Date.now()
      )
        throw new Error('[INVALID_CONFIRMATION] Repeat the deletion preview');
      return invoke({
        action: 'delete',
        tagId: payload.tagId,
        revision: payload.revision,
        expectedCount: payload.count,
      });
    },
  );
}
