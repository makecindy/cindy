import type { DbClient } from '@cindy/runtime-db';
import { createPluginTaskStore } from '@cindy/app-runtime/pluginTaskStore';
import { createPluginTargetStore } from '@cindy/plugin-runtime/pluginTargetStore';
import type { PluginTaskStore } from '@cindy/plugin-runtime/pluginTaskService';
import type { PluginTargetStore } from '@cindy/plugin-runtime/pluginTargetSlot';

/** Receipts use the same owner database as tasks and authorization projections. */
export class TerminalPluginTaskStore {
  readonly ready: Promise<void>;
  private store?: PluginTaskStore;
  private targetStore?: PluginTargetStore;
  private closed = false;
  constructor(private readonly options: { database: Promise<DbClient>; guard(): void }) {
    this.ready = this.open();
  }
  private guard() {
    if (this.closed) throw new Error('PLUGIN_TASK_STORE_CLOSED');
    this.options.guard();
  }
  private async open() {
    const database = await this.options.database;
    this.guard();
    this.store = createPluginTaskStore(database);
    this.targetStore = createPluginTargetStore(database, () => this.guard());
  }
  async get(): Promise<PluginTaskStore> {
    await this.ready; this.guard(); return this.store!;
  }
  async targets(): Promise<PluginTargetStore> {
    await this.ready; this.guard(); return this.targetStore!;
  }
  /** The TaskHost owns and closes the database after accepted writes drain. */
  async close() { this.closed = true; await this.ready.catch(() => {}); }
}
