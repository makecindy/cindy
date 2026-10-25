import { prependHandoffToUserMessage } from '@cindy/im-runtime/agentHandoff';
import { createAgentHandoffRuntime } from '@cindy/app-runtime/agentHandoffRuntime';
import type { DbLogger } from '@cindy/runtime-db/logging';
import type { TerminalConversations } from './conversations.js';
import type { UserMessage } from '@cindy/maker-core';

/** Context belongs to the persistent task, including when no UI is connected.
 * Accepted dispatches consume exactly the handoff read by that dispatch. */
export class TerminalTaskContext {
  readonly handoff;
  private writes: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(private readonly host: {
    conversations: Promise<TerminalConversations>;
    logger: DbLogger;
    assertCurrent(): void;
  }) {
    this.handoff = createAgentHandoffRuntime({
      createLogger: () => host.logger,
      findPendingAgentHandoffSnapshot: async id => { host.assertCurrent(); return (await host.conversations).messages.findPendingAgentHandoffSnapshot(id); },
      findForkParentSessionId: async id => { host.assertCurrent(); return (await host.conversations).messages.findForkParentSessionId(id); },
      findPendingForkOrigin: async id => { host.assertCurrent(); return (await host.conversations).messages.findPendingForkOrigin(id); },
      markLatestAgentHandoffConsumed: (...args) => this.enqueueAdmitted(async () => {
        await (await host.conversations).messages.markLatestAgentHandoffConsumed(...args);
      }),
    }).agentHandoffPending;
  }
  /** Call after committing a new handoff with the model change. */
  refresh(id: string) { this.handoff.clear(id); }
  async prepareHandoff(id: string, message: UserMessage) {
    const pending = await this.handoff.peek(id);
    this.host.assertCurrent();
    return { message: pending ? prependHandoffToUserMessage(message, pending) as UserMessage : message,
      accepted: () => { if (pending) this.handoff.consume(id); } };
  }
  async enqueue<T>(_label: string, write: () => T | Promise<T>): Promise<T> {
    this.host.assertCurrent();
    if (this.closed) throw new Error('TASK_CONTEXT_CLOSED');
    return this.enqueueAdmitted(write);
  }
  private enqueueAdmitted<T>(write: () => T | Promise<T>): Promise<T> {
    // Already admitted writes target this owner's fixed storage. Let them drain
    // at shutdown, especially the post-acceptance consumption marker.
    const operation = this.writes.then(write);
    this.writes = operation.then(() => {}, () => {});
    return operation;
  }
  async peekGoalInactiveNote(id: string): Promise<string | null> {
    this.host.assertCurrent();
    return (await this.host.conversations).goalInactive.peekGoalInactiveNote(id);
  }
  async close() { this.closed = true; await this.writes; }
}
