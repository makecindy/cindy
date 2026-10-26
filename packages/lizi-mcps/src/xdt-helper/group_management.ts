import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

const id = z.string().uuid();
const revision = z.number().int().positive();
/** No caller-supplied group or acting identity: the Host binds both to the live turn. */
export const currentGroupAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('update'), expectedRevision: revision, name: z.string().trim().min(1).max(40).optional(), topic: z.string().max(250).optional(), description: z.string().max(2000).optional(), responseMode: z.enum(['all', 'mentioned']).optional(), speakingMode: z.enum(['auto', 'sequential']).optional() }).strict(),
  z.object({ type: z.literal('member'), actorId: id, action: z.enum(['invite', 'remove', 'ban', 'unban', 'role']), role: z.enum(['admin', 'member']).optional() }).strict(),
  z.object({ type: z.literal('createInvite') }).strict(),
  z.object({ type: z.literal('revokeInvite'), link: z.string().min(1).max(2048) }).strict(),
  z.object({ type: z.literal('archive'), archived: z.boolean(), expectedRevision: revision }).strict(),
  z.object({ type: z.literal('execution'), executionId: id, action: z.literal('stop') }).strict(),
  z.object({ type: z.literal('plan'), planId: id, expectedRevision: revision, action: z.enum(['start', 'continue', 'retry', 'stop', 'dismiss', 'remove', 'reassign']), position: z.number().int().min(0).max(11).optional(), botId: id.optional() }).strict(),
]);
export const currentGroupMutation = z.object({ operationId: id, action: currentGroupAction }).strict();
export type CurrentGroupMutation = z.infer<typeof currentGroupMutation>;
export type CurrentGroupRequest = { type: 'inspect' } | { type: 'manage'; mutation: CurrentGroupMutation };
export const archivedGroupRestore = z.object({ groupId: id, operationId: id, expectedRevision: revision }).strict();
export type ArchivedGroupRequest = { type: 'list-archived' } | { type: 'restore-archived'; mutation: z.infer<typeof archivedGroupRestore> };
export type CurrentGroupResult = { ok: true; [key: string]: unknown } | { ok: false; errorCode: string; message: string };
export type CurrentGroupCallback = (sessionId: string, request: CurrentGroupRequest | ArchivedGroupRequest) => Promise<CurrentGroupResult>;

export function registerCurrentGroupTools(registry: XdtHelperToolRegistry, deps: { getSessionContext(): LiziMcpSessionContext; execute: CurrentGroupCallback }) {
  const execute = async (request: CurrentGroupRequest | ArchivedGroupRequest) => {
    const sessionId = deps.getSessionContext().sessionId;
    if (!sessionId) return errorPayload('NO_GROUP_EXECUTION', 'A bound teammate task is required; current-group tools need a live group execution and recovery tools need the owner’s private Bot Chat.');
    const result = await deps.execute(sessionId, request);
    return result.ok ? okPayload(result) : errorPayload(result.errorCode, result.message);
  };
  registry.register({ name: 'get_archived_groups', category: 'bots',
    description: 'From your owner’s private Bot Chat only, list archived groups this same teammate currently has permission to restore. Returns public group IDs and revisions; never borrows another teammate or owner role. Also reconciles uncertain restore results. Scope: hosting computer’s Chat Server.',
    inputShape: {}, handler: async () => execute({ type: 'list-archived' }) });
  registry.register({ name: 'restore_archived_group', category: 'bots',
    description: 'Restore one archived group from your owner’s private Bot Chat, using this teammate’s own current admin/owner role. Read get_archived_groups first for IDs and revisions. Uses normal task permission review. Group execution grants cannot authorize recovery. Keep the same operationId and revision for an identical retry; after GROUP_RESULT_UNKNOWN query before retrying. Scope: hosting computer’s Chat Server; no other group management or private teammate access.',
    inputShape: archivedGroupRestore.shape, handler: async (input: z.infer<typeof archivedGroupRestore>) => execute({ type: 'restore-archived', mutation: archivedGroupRestore.parse(input) }) });
  registry.register({ name: 'get_current_group', category: 'bots',
    description: 'Read this group’s live name, topic, description, members, your own role, requester role, effective management permissions and current queue with the bound currentExecution and source/plan linkage. When stopping all runs, stop currentExecution last. Bound to the current executing teammate and group; never borrows your owner’s or another teammate’s role. Group roles do not grant private data or tools. Only available in an authorized live group execution on the hosting computer.',
    inputShape: {}, handler: async () => execute({ type: 'inspect' }) });
  registry.register({ name: 'manage_current_group', category: 'bots',
    description: 'Manage the current group as this executing teammate, when your current role allows it and the requester is your human owner. Guest management is unavailable until Chat Server can atomically authorize the requester; an admin guest cannot borrow your role. Read get_current_group first for actor IDs and revisions. Supports group information, members, invitation links, archive, execution stop, plan/queue controls. Ownership transfer and group dissolution are unavailable to teammate tools; use the human group settings. Never changes another teammate’s private access or tools. Use a unique operationId for a new operation; keep it for the same operation. GROUP_RESULT_UNKNOWN means it may have succeeded: query current state before deciding whether to retry; never blindly repeat a removal. Scope: this live group only, through the hosting computer’s Chat Server.',
    inputShape: currentGroupMutation.shape, handler: async (input: CurrentGroupMutation) => execute({ type: 'manage', mutation: currentGroupMutation.parse(input) }) });
}
