/**
 * 智能通讯录的设备间同步契约。
 *
 * 状态只包含确定性的 LWW/删除标记，不依赖模型或墙钟先后。每台设备维护单调
 * Lamport counter；并发写入用 nodeId 打破平局，因此任意数量设备、任意交换顺序
 * 都会得到同一个结果。
 */

import type { ContactKind, ContactSource, ContactStatus } from "../types.js";

export const CONTACTS_SYNC_VERSION = 1;

export interface ContactsSyncStamp {
  counter: number;
  nodeId: string;
}

export interface ContactsSyncClock {
  nodeId: string;
  counter: number;
}

export interface ContactsStampedValue<T> {
  value: T;
  stamp: ContactsSyncStamp;
}

/** 一次确认写入时已知的同身份冲突成员指纹。 */
export interface ContactsSyncConflictMembership {
  platform: string;
  normalizedValue: string;
  membershipHash: string;
}

export interface ContactsSyncStatusValue extends ContactsStampedValue<ContactStatus> {
  /**
   * 跟随 status 写入，旧客户端会把未知字段随整个 stamped value 原样转发；
   * 若旧客户端自己改写 status，则视为一次没有因果确认信息的新裁决。
   */
  acknowledgedConflicts?: ContactsSyncConflictMembership[];
}

export interface ContactsSyncContact {
  id: string;
  kind: ContactsStampedValue<ContactKind>;
  displayName: ContactsStampedValue<string>;
  aliases: ContactsStampedValue<string[]>;
  summary: ContactsStampedValue<string>;
  narrative: ContactsStampedValue<string>;
  agentNotes: ContactsStampedValue<string>;
  status: ContactsSyncStatusValue;
  source: ContactsStampedValue<ContactSource>;
  createdAt: ContactsStampedValue<string>;
  updatedAt: ContactsStampedValue<string>;
  /** UUID 不复用；一旦删除，旧档案永不因离线副本重新出现。 */
  deleted?: ContactsSyncStamp;
}

export interface ContactsSyncEntity<T> {
  id: string;
  value: ContactsStampedValue<T>;
  deleted?: ContactsSyncStamp;
}

export interface ContactsSyncIdentityValue {
  contactId: string;
  platform: string;
  value: string;
  normalizedValue: string;
  label: string;
  note: string;
  createdAt: string;
}

export interface ContactsSyncEventValue {
  contactId: string;
  date: string;
  text: string;
  source: string;
  createdAt: string;
}

export interface ContactsSyncGroupValue {
  name: string;
  description: string;
  createdAt: string;
}

export interface ContactsSyncMembershipValue {
  groupId: string;
  contactId: string;
}

export interface ContactsSyncRelationValue {
  fromId: string;
  toId: string;
  relation: string;
  note: string;
  createdAt: string;
}

/** 可直接 JSON 序列化、在设备间做状态式交换的完整同步状态。 */
export interface ContactsSyncState {
  version: typeof CONTACTS_SYNC_VERSION;
  clocks: ContactsSyncClock[];
  contacts: ContactsSyncContact[];
  identities: Array<ContactsSyncEntity<ContactsSyncIdentityValue>>;
  events: Array<ContactsSyncEntity<ContactsSyncEventValue>>;
  groups: Array<ContactsSyncEntity<ContactsSyncGroupValue>>;
  memberships: Array<ContactsSyncEntity<ContactsSyncMembershipValue>>;
  relations: Array<ContactsSyncEntity<ContactsSyncRelationValue>>;
}

/** 当前 SQLite 主表的无时间戳逻辑快照；FTS 是派生数据，不进入同步。 */
export interface ContactsDataSnapshot {
  contacts: ContactsSnapshotContact[];
  identities: ContactsSnapshotIdentity[];
  events: ContactsSnapshotEvent[];
  groups: ContactsSnapshotGroup[];
  memberships: ContactsSnapshotMembership[];
  relations: ContactsSnapshotRelation[];
}

export interface ContactsSnapshotContact {
  id: string;
  kind: ContactKind;
  displayName: string;
  aliases: string[];
  summary: string;
  narrative: string;
  agentNotes: string;
  status: ContactStatus;
  source: ContactSource;
  createdAt: string;
  updatedAt: string;
}

export interface ContactsSnapshotIdentity extends ContactsSyncIdentityValue {
  id: string;
}

export interface ContactsSnapshotEvent extends ContactsSyncEventValue {
  id: string;
}

export interface ContactsSnapshotGroup extends ContactsSyncGroupValue {
  id: string;
}

export interface ContactsSnapshotMembership extends ContactsSyncMembershipValue {
  id: string;
}

export interface ContactsSnapshotRelation extends ContactsSyncRelationValue {
  id: string;
}

export function createEmptyContactsSyncState(): ContactsSyncState {
  return {
    version: CONTACTS_SYNC_VERSION,
    clocks: [],
    contacts: [],
    identities: [],
    events: [],
    groups: [],
    memberships: [],
    relations: [],
  };
}

export function createEmptyContactsSnapshot(): ContactsDataSnapshot {
  return {
    contacts: [],
    identities: [],
    events: [],
    groups: [],
    memberships: [],
    relations: [],
  };
}

/** 复合主键只用于同步快照，不进入产品数据。 */
export function membershipSyncId(groupId: string, contactId: string): string {
  return `${groupId}\u0000${contactId}`;
}
