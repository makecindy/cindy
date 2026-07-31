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
  isValidContactsDataSnapshot,
  isValidContactsSyncState,
} from "./validation.js";

interface PersistedSyncRow {
  node_id: string;
  state_json: string;
  projection_json: string;
}

export class ContactsSyncRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly logger: Logger,
  ) {}

  isActive(): boolean {
    return Boolean(this.readRow());
  }

  activate(): { state: ContactsSyncState; materialized: boolean } {
    const tx = this.db.transaction(() => {
      const existing = this.readRow();
      if (existing) {
        const reconciled = this.reconcile(existing);
        return {
          state: reconciled.state,
          materialized: reconciled.materialized,
        };
      }
      const nodeId = randomUUID();
      const current = readContactsSnapshot(this.db);
      const captured = captureContactsSnapshot(
        createEmptyContactsSyncState(),
        createEmptyContactsSnapshot(),
        current,
        nodeId,
      );
      this.insertRow(nodeId, captured.state, current);
      return { state: captured.state, materialized: false };
    });
    return tx();
  }

  readState(): { state: ContactsSyncState; materialized: boolean } | null {
    const tx = this.db.transaction(() => {
      const row = this.readRow();
      if (!row) return null;
      const reconciled = this.reconcile(row);
      return {
        state: reconciled.state,
        materialized: reconciled.materialized,
      };
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
      if (!isValidContactsSyncState(merged)) {
        throw new ContactsError(
          "invalid-params",
          "merged contacts sync state exceeds limits",
        );
      }
      const projection = materializeContactsSyncState(merged);
      const stateUnchanged =
        JSON.stringify(merged) === JSON.stringify(local.state);
      const projectionUnchanged =
        JSON.stringify(projection) === JSON.stringify(local.projection);
      // CRDT 状态相同不代表 SQLite 投影一定最新：唯一约束隐藏的并发输家在
      // 赢家后续改名后可能重新可见。只有状态和当前投影都一致才可以幂等返回。
      if (stateUnchanged && projectionUnchanged) return local.materialized;

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
    materialized: boolean;
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
    // 唯一约束隐藏的并发输家不在 previous/current 中，但仍保留在 CRDT state。
    // 当本地赢家改名或删除解除冲突时，必须立即从新状态重新物化；不能等对端回包。
    const projection = materializeContactsSyncState(captured.state);
    const materializationRequired =
      JSON.stringify(projection) !== JSON.stringify(current);
    const projectionChanged =
      JSON.stringify(previous) !== JSON.stringify(projection);
    if (materializationRequired) {
      writeContactsSnapshot(this.db, projection);
    }
    if (captured.changed || projectionChanged || materializationRequired) {
      this.updateRow(row.node_id, captured.state, projection);
    }
    return {
      state: captured.state,
      projection,
      changed: captured.changed,
      materialized: materializationRequired,
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
      if (isValidContactsDataSnapshot(value)) return value;
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
    this.assertPersistableState(state);
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
    this.assertPersistableState(state);
    this.db
      .prepare(
        `UPDATE contacts_sync_state
         SET node_id = ?, state_json = ?, projection_json = ?
         WHERE singleton = 1`,
      )
      .run(nodeId, JSON.stringify(state), JSON.stringify(projection));
  }

  /** 所有本地捕获路径共用的最终写盘门，拒绝后由外层事务完整回滚。 */
  private assertPersistableState(state: ContactsSyncState): void {
    if (!isValidContactsSyncState(state)) {
      throw new ContactsError(
        "invalid-params",
        "contacts sync state exceeds limits",
      );
    }
  }
}
