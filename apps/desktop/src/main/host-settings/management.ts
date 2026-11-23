import { runCloudManagementExecution } from './managementCalls.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  managementCommandSchema,
  managementResultSchema,
  managementPromptSchema,
  type ManagementCommand,
  type ManagementField,
  type ManagementItem,
  type ManagementPrompt,
  type ManagementResult,
  type ManagementSection,
} from '../../shared/settingsManagement.js';

export interface ManagementCaller {
  key: string;
  assertCurrent(): void;
}
export interface ManagementExecution {
  signal: AbortSignal;
  assertCurrent(): void;
  prompt(value: ManagementPrompt, respond?: (value: string) => Promise<void>): void;
  onCancel(cancel: () => void): void;
}
export interface ManagementAction {
  label: string;
  intent: ManagementItem['actions'][number]['intent'];
  fields?: ManagementField[];
  confirmation?: string;
  /** Shared resource identity, independent of the browser session. */
  resource: string;
  run(values: Record<string, string>, execution: ManagementExecution): Promise<void>;
}
export interface ManagementEntry extends Omit<ManagementItem, 'actions'> {
  actions: ManagementAction[];
}
export interface ManagementProvider {
  list(
    section: ManagementSection,
    caller: ManagementCaller,
    offset: number,
  ): Promise<ManagementEntry[] | { entries: ManagementEntry[]; hasMore: boolean }>;
}
type Ticket = { key: string; expiresAt: number; action: ManagementAction; used?: string };
type Operation = {
  key: string;
  fingerprint: string;
  expiresAt: number;
  touchedAt: number;
  assertOwner(): void;
  view: Extract<ManagementResult, { kind: 'operation' }>;
  abort: AbortController;
  cancel: Array<() => void>;
  respond?: (value: string) => Promise<void>;
};
const TTL = 5 * 60_000;
const RETENTION = 10 * 60_000;
const error = (code: string): never => {
  throw new Error(code);
};
const terminal = (phase: Operation['view']['phase']) => !['running', 'waiting'].includes(phase);

/** Private cloud web operations: session-bound action tickets and at-most-once execution.
 * Restarts return unknown; neither a lost response nor a new request replays a mutation.
 * No password, callback value, raw domain result or raw error appears in a view.
 */
export function createSettingsManagement(provider: ManagementProvider, now = Date.now) {
  const tickets = new Map<string, Ticket>();
  const operations = new Map<string, Operation>();
  const busy = new Set<string>();
  const prune = () => {
    for (const [id, ticket] of tickets) if (ticket.expiresAt <= now()) tickets.delete(id);
    for (const [id, op] of operations) {
      let ownerCurrent = true;
      try {
        op.assertOwner();
      } catch {
        ownerCurrent = false;
      }
      if (
        !terminal(op.view.phase) &&
        (op.expiresAt <= now() ||
          (op.view.prompt && op.view.prompt.expiresAt <= now()) ||
          !ownerCurrent)
      ) {
        op.abort.abort();
        for (const cancel of op.cancel.splice(0)) {
          try {
            cancel();
          } catch {
            /* no raw errors */
          }
        }
        op.view = {
          kind: 'operation',
          operationId: id,
          phase: ownerCurrent ? 'expired' : 'unknown',
        };
        op.respond = undefined;
      }
      if (op.expiresAt + RETENTION <= now()) operations.delete(id);
    }
  };
  function get(caller: ManagementCaller, operationId: string): Operation | undefined {
    const op = operations.get(operationId);
    if (op && op.key !== caller.key) error('MANAGEMENT_NOT_FOUND');
    if (op) op.touchedAt = now();
    return op;
  }
  async function execute(
    caller: ManagementCaller,
    raw: ManagementCommand,
  ): Promise<ManagementResult> {
    caller.assertCurrent();
    prune();
    const command = managementCommandSchema.parse(raw);
    if (command.operation === 'list') {
      const offset = command.offset ?? 0;
      const listed = await provider.list(command.section, caller, offset);
      const entries = Array.isArray(listed) ? listed.slice(offset, offset + 8) : listed.entries;
      const hasMore = Array.isArray(listed) ? listed.length > offset + 8 : listed.hasMore;
      caller.assertCurrent();
      if (tickets.size > 4096 || entries.length > 256) error('MANAGEMENT_BUSY');
      const items = entries.map(({ actions, ...item }) => ({
        ...item,
        actions: actions.map((action) => {
          const id = randomUUID(),
            expiresAt = now() + TTL;
          tickets.set(id, { key: caller.key, expiresAt, action });
          return {
            id,
            expiresAt,
            label: action.label,
            intent: action.intent,
            fields: action.fields ?? [],
            ...(action.confirmation ? { confirmation: action.confirmation } : {}),
          };
        }),
      }));
      return managementResultSchema.parse({
        kind: 'page',
        section: command.section,
        items,
        offset,
        ...(hasMore ? { nextOffset: offset + 8 } : {}),
      });
    }
    const op = get(caller, command.operationId);
    if (command.operation !== 'run') {
      if (!op) return { kind: 'operation', operationId: command.operationId, phase: 'unknown' };
      if (command.operation === 'cancel' && !terminal(op.view.phase)) {
        op.abort.abort();
        for (const cancel of op.cancel.splice(0)) {
          try {
            cancel();
          } catch {
            /* no raw errors */
          }
        }
        // Cancellation is a request, not proof that a dispatched write was undone.
        op.view = { kind: 'operation', operationId: command.operationId, phase: 'unknown' };
        op.respond = undefined;
      }
      if (command.operation === 'respond') {
        if (op.view.phase !== 'waiting' || !op.respond) error('MANAGEMENT_RESPONSE_UNAVAILABLE');
        const respond = op.respond!;
        // Consume before awaiting so duplicate callbacks cannot race each other.
        op.respond = undefined;
        try {
          caller.assertCurrent();
          await respond(command.value);
          caller.assertCurrent();
        } catch (failure) {
          if (op.view.phase === 'waiting') op.respond = respond;
          throw failure;
        }
        if (op.view.phase === 'waiting')
          op.view = { kind: 'operation', operationId: command.operationId, phase: 'running' };
      }
      return structuredClone(op.view);
    }
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          command.actionId,
          Object.entries(command.values).sort(([a], [b]) => a.localeCompare(b)),
        ]),
      )
      .digest('hex');
    if (op) {
      if (op.fingerprint !== fingerprint) error('MANAGEMENT_OPERATION_REUSED');
      return structuredClone(op.view);
    }
    const ticket = tickets.get(command.actionId);
    if (!ticket || ticket.key !== caller.key || ticket.expiresAt <= now() || ticket.used)
      error('MANAGEMENT_ACTION_EXPIRED');
    const action = ticket!.action,
      fields = action.fields ?? [];
    if (
      Object.keys(command.values).some((key) => !fields.some((field) => field.name === key)) ||
      fields.some((field) => {
        const value = command.values[field.name] ?? '';
        return (
          (field.required && !value.trim()) ||
          value.length > field.maxLength ||
          (field.kind === 'select' &&
            value !== '' &&
            !field.options?.some((option) => option.value === value))
        );
      })
    )
      error('MANAGEMENT_INVALID_INPUT');
    if (busy.has(action.resource) || operations.size >= 512) error('MANAGEMENT_BUSY');
    caller.assertCurrent();
    ticket!.used = command.operationId;
    busy.add(action.resource);
    const created: Operation = {
      key: caller.key,
      fingerprint,
      assertOwner: caller.assertCurrent,
      expiresAt: now() + 20 * 60_000,
      touchedAt: now(),
      view: { kind: 'operation', operationId: command.operationId, phase: 'running' },
      abort: new AbortController(),
      cancel: [],
    };
    operations.set(command.operationId, created);
    const assertCurrent = () => {
      caller.assertCurrent();
      if (created.abort.signal.aborted || created.expiresAt <= now()) error('MANAGEMENT_EXPIRED');
    };
    const execution: ManagementExecution = {
      signal: created.abort.signal,
      assertCurrent,
      prompt(value, respond) {
        assertCurrent();
        created.view = {
          kind: 'operation',
          operationId: command.operationId,
          phase: 'waiting',
          prompt: managementPromptSchema.parse(value),
        };
        created.respond = respond;
      },
      onCancel(cancel) {
        assertCurrent();
        created.cancel.push(cancel);
      },
    };
    void Promise.resolve()
      .then(async () => {
        assertCurrent();
        await runCloudManagementExecution(execution, () => action.run(command.values, execution));
        assertCurrent();
        created.view = { kind: 'operation', operationId: command.operationId, phase: 'succeeded' };
      })
      .catch(() => {
        if (!terminal(created.view.phase))
          created.view = {
            kind: 'operation',
            operationId: command.operationId,
            phase: created.abort.signal.aborted ? 'unknown' : 'failed',
            code: 'MANAGEMENT_OPERATION_FAILED',
          };
      })
      .finally(() => {
        created.respond = undefined;
        created.cancel = [];
        busy.delete(action.resource);
      });
    return structuredClone(created.view);
  }
  return {
    execute,
    prune,
    stop() {
      for (const op of operations.values()) {
        op.abort.abort();
        for (const cancel of op.cancel) {
          try {
            cancel();
          } catch {
            /* no raw errors */
          }
        }
      }
      tickets.clear();
      operations.clear();
    },
  };
}
