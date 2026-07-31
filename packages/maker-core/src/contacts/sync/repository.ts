/**
 * 同步状态的 SQLite 持久层。
 *
 * 同步未激活时表里没有 singleton 行，现有通讯录零额外写放大。首次激活会把
 * 当前库捕获为本设备状态；之后即使用户暂时关闭传输，下次读取也会从上次投影
 * 补记全部离线变化，重新开启时可以完整补发。
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import type { Logger } from "../../interfaces/logger.js";
import { ContactsError } from "../types.js";
import { captureContactsSnapshot } from "./capture.js";
import { materializeContactsSyncState } from "./materialize.js";
import { mergeContactsSyncStates } from "./merge.js";
import { readContactsSnapshot, writeContactsSnapshot } from "./snapshot.js";
import {
  createEmptyContactsSnapshot,
  createEmptyContactsSyncState,
  type ContactsDataSnapshot,
  type ContactsSyncState,
} from "./types.js";
import {
  CONTACTS_SYNC_MAX_ROWS_PER_TABLE,
  isValidContactsSyncState,
} from "./validation.js";

interface PersistedSyncRow {
  node_id: string;
  state_json: string;
  projection_json: string;
}

function isSnapshotShape(value: unknown): value is ContactsDataSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ContactsDataSnapshot>;
  const isBoundedArray = (entries: unknown): entries is unknown[] =>
    Array.isArray(entries) &&
    entries.length <= CONTACTS_SYNC_MAX_ROWS_PER_TABLE;
  return (
    isBoundedArray(candidate.contacts) &&
    isBoundedArray(candidate.identities) &&
    isBoundedArray(candidate.events) &&
    isBoundedArray(candidate.groups) &&
    isBoundedArray(candidate.memberships) &&
    isBoundedArray(candidate.relations)
  );
}

export class ContactsSyncRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly logger: Logger,
  ) {}

  isActive(): boolean {
    return Boolean(this.readRow());
  }

  activate(): ContactsSyncState {
    const tx = this.db.transaction(() => {
      const existing = this.readRow();
      if (existing) return this.reconcile(existing).state;
      const nodeId = randomUUID();
      const current = readContactsSnapshot(this.db);
      const captured = captureContactsSnapshot(
        createEmptyContactsSyncState(),
        createEmptyContactsSnapshot(),
        current,
        nodeId,
      );
      this.insertRow(nodeId, captured.state, current);
      return captured.state;
    });
    return tx();
  }

  readState(): ContactsSyncState | null {
    const tx = this.db.transaction(() => {
      const row = this.readRow();
      return row ? this.reconcile(row).state : null;
    });
    return tx();
  }

  mergeRemoteState(raw: unknown): boolean {
    if (!isValidContactsSyncState(raw)) {
      throw new ContactsError("invalid-params", "invalid contacts sync state");
    }
    const tx = this.db.transaction(() => {
      let row = this.readRow();
      if (!row) {
        const nodeId = randomUUID();
        const current = readContactsSnapshot(this.db);
        const captured = captureContactsSnapshot(
          createEmptyContactsSyncState(),
          createEmptyContactsSnapshot(),
          current,
          nodeId,
        );
        this.insertRow(nodeId, captured.state, current);
        row = this.readRow();
      }
      if (!row)
        throw new ContactsError("io-error", "contacts sync activation failed");
      const local = this.reconcile(row);
      const merged = mergeContactsSyncStates(local.state, raw);
      if (JSON.stringify(merged) === JSON.stringify(local.state)) return false;

      const projection = materializeContactsSyncState(merged);
      writeContactsSnapshot(this.db, projection);
      this.updateRow(row.node_id, merged, projection);
      return true;
    });
    return tx();
  }

  private reconcile(row: PersistedSyncRow): {
    state: ContactsSyncState;
    projection: ContactsDataSnapshot;
    changed: boolean;
  } {
    const state = this.parseState(row.state_json);
    const previous = this.parseProjection(row.projection_json);
    const current = readContactsSnapshot(this.db);
    const captured = captureContactsSnapshot(
      state,
      previous,
      current,
      row.node_id,
    );
    const projectionChanged =
      JSON.stringify(previous) !== JSON.stringify(current);
    if (captured.changed || projectionChanged) {
      this.updateRow(row.node_id, captured.state, current);
    }
    return {
      state: captured.state,
      projection: current,
      changed: captured.changed,
    };
  }

  private parseState(json: string): ContactsSyncState {
    try {
      const value: unknown = JSON.parse(json);
      if (isValidContactsSyncState(value)) return value;
    } catch {
      // 统一落到下面的 fail-closed 错误。
    }
    throw new ContactsError(
      "io-error",
      "stored contacts sync state is invalid",
    );
  }

  private parseProjection(json: string): ContactsDataSnapshot {
    try {
      const value: unknown = JSON.parse(json);
      if (isSnapshotShape(value)) return value;
    } catch {
      // 统一落到下面的 fail-closed 错误。
    }
    throw new ContactsError(
      "io-error",
      "stored contacts sync projection is invalid",
    );
  }

  private readRow(): PersistedSyncRow | null {
    return (
      (this.db
        .prepare(
          `SELECT node_id, state_json, projection_json
           FROM contacts_sync_state WHERE singleton = 1`,
        )
        .get() as PersistedSyncRow | undefined) ?? null
    );
  }

  private insertRow(
    nodeId: string,
    state: ContactsSyncState,
    projection: ContactsDataSnapshot,
  ): void {
    this.db
      .prepare(
        `INSERT INTO contacts_sync_state(singleton, node_id, state_json, projection_json)
         VALUES (1, ?, ?, ?)`,
      )
      .run(nodeId, JSON.stringify(state), JSON.stringify(projection));
    this.logger.info("contacts device sync state initialized");
  }

  private updateRow(
    nodeId: string,
    state: ContactsSyncState,
    projection: ContactsDataSnapshot,
  ): void {
    this.db
      .prepare(
        `UPDATE contacts_sync_state
         SET node_id = ?, state_json = ?, projection_json = ?
         WHERE singleton = 1`,
      )
      .run(nodeId, JSON.stringify(state), JSON.stringify(projection));
  }
}
