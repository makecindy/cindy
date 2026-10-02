import { z } from 'zod';

const id = z.string().min(1).max(256);
const execution = z.object({ instanceId: id, generation: z.number().int().nonnegative() }).strict();
const queueOptions = z.object({ expectedClearBoundaryMs: z.number().nonnegative().nullable().optional(), durableDelivery: z.boolean().optional() }).strict();
const files = z.array(z.object({ owningDeviceId: id, remoteHostId: id.nullable(), kind: z.enum(['file', 'attachment']),
  locator: z.string().min(1), version: id.optional() }).strict()).optional();
const command = <K extends string, S extends z.ZodRawShape>(operation: K, shape: S) =>
  z.object({ operation: z.literal(operation), args: z.object(shape).strict() }).strict();
export const sessionControlRequestSchema = z.object({
  version: z.literal(1), requestId: id, deviceId: id,
  target: z.object({ deviceId: id, sessionId: id }).strict().optional(),
  command: z.discriminatedUnion('operation', [
    command('listRecords', { limit: z.number().int().min(1).max(100).optional(), cursor: z.object({ createdAt: z.number(), id }).strict().optional() }),
    command('compact', { instructions: z.string().optional() }),
    command('ensureRuntime', {}),
    command('inspectInteractions', {}), command('listBackgroundTasks', {}),
    command('resolveInteraction', { requestId: id, decision: z.record(z.string(), z.json()) }),
    command('deleteMessage', { clientId: id }),
    command('updateMetadata', { title: z.string().min(1).max(500) }),
    command('setRecordStatus', { status: z.enum(['active', 'archived', 'deleted']) }),
    command('pauseQueue', { options: queueOptions.extend({ keepQueue: z.boolean().optional(), pauseQueue: z.boolean().optional() }).optional() }),
    command('resumeQueue', { options: queueOptions.optional() }),
    command('retryInput', { options: queueOptions.optional() }),
    command('clearInputError', { options: queueOptions.optional() }),
    command('moveInput', { inputId: id, targetIndex: z.number().int().nonnegative(), options: queueOptions.optional() }),
    command('updateInputPresentation', { expanded: z.boolean(), options: queueOptions.optional() }),
    command('setInputLock', { kind: z.enum(['interaction', 'edit']), inputId: id, locked: z.boolean(), options: queueOptions.optional() }),
    command('clearInputs', { clearedAt: z.iso.datetime().optional() }),
    command('changePermission', { setting: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('permission'), mode: z.enum(['ask', 'default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']) }).strict(),
      z.object({ kind: z.literal('plan'), enabled: z.boolean() }).strict(),
    ]) }),
    command('inspectHistory', { mode: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('tree') }).strict(),
      z.object({ kind: z.literal('rewind-preview'), inputId: id }).strict(),
    ]) }),
    command('rewind', { mode: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('tree'), entryId: id, options: z.object({ summarize: z.boolean().optional(), customInstructions: z.string().optional() }).strict().optional() }).strict(),
      z.object({ kind: z.literal('message'), inputId: id, options: z.object({ requireLatestUser: z.boolean().optional(), stopIfRunning: z.boolean().optional(), allowFileRestore: z.boolean().optional() }).strict().optional() }).strict(),
    ]) }),
    command('fork', { messageClientId: id }),
    command('listActive', {}), command('inspect', {}), command('diagnose', {}), command('capabilities', {}),
    command('inspectQueue', {}), command('inspectRuntime', {}),
    command('createRecord', { businessKey: id, title: z.string().max(500).optional(), model: id.optional(),
      providerId: id.nullable().optional(), agentKind: z.enum(['claude-code', 'codex', 'pi']).optional(),
      directory: z.object({ owningDeviceId: id, remoteHostId: id.nullable(), kind: z.literal('directory'),
        locator: z.string().min(1), version: id.optional() }).strict() }),
    command('send', { businessKey: id, message: z.string().min(1), files }),
    command('enqueue', { businessKey: id, message: z.string().min(1), files }),
    command('editOwnedInput', { inputId: id, message: z.string().min(1) }),
    command('withdrawOwnedInput', { inputId: id }), command('steer', { message: z.string().min(1) }),
    command('requestStop', { expectedExecution: execution.optional() }),
    command('abortTurn', { expectedExecution: execution }), command('closeRuntime', { expectedExecution: execution }),
    command('stopBackgroundTask', { taskId: id }),
    command('selectRuntime', { expectedGeneration: z.number().int().nonnegative(), patch: z.object({
      model: id.optional(), providerId: id.nullable().optional(), harness: z.enum(['claude-code', 'codex', 'pi']).optional(),
      effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(), fastMode: z.boolean().optional(),
    }).strict() }),
  ]),
}).strict();
