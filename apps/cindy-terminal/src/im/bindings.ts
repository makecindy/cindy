import type { IdentityKey } from '@cindy/im';
import type { Logger } from '@cindy/maker-core';
import { PersistentImBindingStore } from '@cindy/im-runtime/binding';
import { createImBindingStorage } from '@cindy/app-runtime/imBindingStorage';
import type { NodeDatabase } from '../database.js';

/** Original SQLite binding store, scoped to the server's active owner. */
export class TerminalImBindings {
  readonly store: PersistentImBindingStore;
  readonly ready: Promise<void>;
  private database?: NodeDatabase;
  private closed = false;
  constructor(private readonly options: {
    database: Promise<NodeDatabase>;
    assertCurrent(): void;
    logger: Logger;
    beforeOpen?: Promise<void>;
  }) {
    this.store = new PersistentImBindingStore({
      log: options.logger,
      captureStorage: () => {
        this.guard();
        if (!this.database) throw new Error('IM_BINDINGS_NOT_READY');
        return createImBindingStorage(this.database.db);
      },
    });
    this.ready = this.open();
  }
  private guard() {
    if (this.closed) throw new Error('IM_BINDINGS_CLOSED');
    this.options.assertCurrent();
  }
  private async open() {
    await this.options.beforeOpen;
    this.database = await this.options.database;
    this.guard();
    await this.store.preload();
  }
  async commitTaskRotation<T>(
    detach: { identity: IdentityKey; targetSessionId: string } | null,
    commit: (detached: boolean) => Promise<T>,
  ): Promise<T> {
    await this.ready;
    this.guard();
    return this.store.commitAndDetach(detach, detached => {
      this.guard();
      return commit(detached);
    });
  }
  async close() {
    await this.ready.catch(() => {});
    await this.store.flush();
    this.closed = true;
    this.store.resetRuntime();
  }
}
