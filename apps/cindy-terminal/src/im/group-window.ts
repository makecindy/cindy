import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, chmod } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, sql } from 'drizzle-orm';
import type { Logger } from '@cindy/maker-core';
import { createGroupWindowCore, DEFAULT_GROUP_WINDOW_RETENTION } from '@cindy/im-runtime/groupWindowCore';
import { createGroupWindowMaintenance } from '@cindy/im-runtime/groupWindowMaintenance';
import { createChannelGroupWindow, type ChannelGroupWindow } from '@cindy/im-runtime/channelGroupWindow';
import { createGroupHistorySearch } from '@cindy/im-runtime/groupHistorySearch';
import type { FeishuNotificationStore } from '@cindy/im-runtime/channels/feishu/notificationOrigin';
import * as schema from '@cindy/im-runtime/groupWindowSchema';
import { privateDirectory } from '../platform.js';
import { GROUP_WINDOW_SCHEMA_SQL } from './group-window-schema.js';

export class TerminalGroupWindows {
  readonly ready: Promise<void>;
  private native?: Database.Database;
  private db?: ReturnType<typeof drizzle<typeof schema>>;
  private closed = false;
  private closing?: Promise<void>;
  private readonly operations = new Set<Promise<unknown>>();
  private readonly operation = new AsyncLocalStorage<boolean>();
  private readonly windows = new Map<string, ChannelGroupWindow>();
  readonly core: ReturnType<typeof createGroupWindowCore>;
  readonly search: ReturnType<typeof createGroupHistorySearch>;

  constructor(private readonly root: string, private readonly guardOwner: () => void, private readonly logger: Logger) {
    // Admitted writes and cursor compensation may finish against this owner's
    // database while shutdown drains them. New calls still require admission.
    const getDbClient = () => { if (!this.operation.getStore()) this.guard(); if (!this.db) throw new Error('IM_HISTORY_NOT_READY'); return { drizzle: this.db }; };
    const maintenance = createGroupWindowMaintenance({ getDbClient, log: logger });
    const core = createGroupWindowCore({ getDbClient, tryGetDbClient: () => this.closed || !this.db ? null : getDbClient(), maintenance });
    this.core = {
      recordGroupWindowEntry: (...args) => this.track(() => core.recordGroupWindowEntry(...args)),
      assembleGroupWindowContext: (...args) => this.track(async () => {
        const assembly = await core.assembleGroupWindowContext(...args);
        return { ...assembly, commit: guard => this.track(async () => {
          const receipt = await assembly.commit(guard);
          return receipt ? { rollback: () => this.track(() => receipt.rollback()) } : undefined;
        }) };
      }),
      resetGroupWindowCursors: (...args) => this.track(() => core.resetGroupWindowCursors(...args)),
    };
    const search = createGroupHistorySearch({ log: logger, query: async <T>(sql: string, values: unknown[]) => {
      if (!this.operation.getStore() || !this.native) throw new Error('IM_HISTORY_NOT_READY');
      return this.native.prepare(sql).all(...values) as T[];
    } });
    this.search = args => this.track(() => search(args));
    this.ready = this.open();
  }
  private guard() { if (this.closed) throw new Error('IM_HISTORY_CLOSED'); this.guardOwner(); }
  private async open() {
    const directory = path.join(this.root, 'im');
    await privateDirectory(directory); this.guard();
    const file = path.join(directory, 'history.sqlite');
    for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
      const info = await lstat(candidate).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
      if (info && (!info.isFile() || info.isSymbolicLink() || process.platform !== 'win32' && typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('UNSAFE_IM_HISTORY_DATABASE');
    }
    this.guard();
    const database = this.native = new Database(file);
    try {
      database.pragma('journal_mode = WAL');
      let version = database.pragma('user_version', { simple: true });
      if (version === 0) {
        database.transaction(() => { database.exec(GROUP_WINDOW_SCHEMA_SQL); database.pragma('user_version = 1'); })();
        version = 1;
      }
      if (version === 1) database.transaction(() => {
        database.exec(`CREATE TABLE im_notification_origins (
          channel TEXT NOT NULL, bot_context_id TEXT NOT NULL, user_id TEXT NOT NULL,
          message_id TEXT NOT NULL, chat_id TEXT NOT NULL, session_id TEXT NOT NULL, created_at INTEGER NOT NULL,
          PRIMARY KEY (channel, bot_context_id, user_id, message_id)
        )`);
        database.pragma('user_version = 2');
      })();
      else if (version !== 2) throw new Error('IM_HISTORY_VERSION_UNSUPPORTED');
      if (process.platform !== 'win32') await chmod(file, 0o600);
      this.guard(); this.db = drizzle(database, { schema });
    } catch (error) { database.close(); this.native = undefined; throw error; }
  }
  notificationStore(session: FeishuNotificationStore['session']): FeishuNotificationStore {
    this.guard();
    return {
      insert: origin => this.track(async () => {
        this.native!.prepare(`INSERT INTO im_notification_origins
          (channel,bot_context_id,user_id,message_id,chat_id,session_id,created_at) VALUES (?,?,?,?,?,?,?)`)
          .run(origin.channel,origin.botContextId,origin.userId,origin.messageId,origin.chatId,origin.sessionId,origin.createdAt);
      }),
      find: key => this.track(async () => this.native!.prepare(`SELECT session_id AS sessionId FROM im_notification_origins
        WHERE channel=? AND bot_context_id=? AND user_id=? AND message_id=? AND chat_id=? LIMIT 1`)
        .get(key.channel,key.botContextId,key.userId,key.messageId,key.chatId) as { sessionId: string } | undefined ?? null),
      session: id => this.track(() => session(id)),
    };
  }

  private track<T>(action: () => Promise<T>): Promise<T> {
    const work = (async () => {
      this.guard(); await this.ready; this.guard();
      return this.operation.run(true, action);
    })();
    this.operations.add(work);
    void work.then(() => this.operations.delete(work), () => this.operations.delete(work));
    return work;
  }
  channel(prefix: string): ChannelGroupWindow {
    this.guard();
    const cached = this.windows.get(prefix); if (cached) return cached;
    const window = createChannelGroupWindow({ providerPrefix: prefix, retention: { ...DEFAULT_GROUP_WINDOW_RETENTION }, log: this.logger }, {
      core: this.core,
      listKnownGroups: provider => this.track(async () => this.db!.select({ chatId: schema.hookGroupMessages.chatId, chatName: sql<string | null>`max(${schema.hookGroupMessages.chatName})` })
        .from(schema.hookGroupMessages).where(eq(schema.hookGroupMessages.provider, provider)).groupBy(schema.hookGroupMessages.chatId)
        .orderBy(sql`max(${schema.hookGroupMessages.sentAt}) desc`).limit(50).all()),
    });
    this.windows.set(prefix, window);
    return window;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    return this.closing = (async () => {
      await this.ready.catch(() => {});
      await Promise.allSettled([...this.operations]);
      this.windows.clear(); this.db = undefined; this.native?.close(); this.native = undefined;
    })();
  }
}
