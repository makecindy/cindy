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

export interface ContactsSyncContact {
  id: string;
  kind: ContactsStampedValue<ContactKind>;
  displayName: ContactsStampedValue<string>;
  aliases: ContactsStampedValue<string[]>;
  summary: ContactsStampedValue<string>;
  narrative: ContactsStampedValue<string>;
  agentNotes: ContactsStampedValue<string>;
  status: ContactsStampedValue<ContactStatus>;
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

/** source 档案已显式并入 target；id 使用 sourceId，value 保存直接 target。 */
export interface ContactsSyncMergeValue {
  targetId: string;
}

/** 可直接 JSON 序列化、在设备间做状态式交换的完整同步状态。 */
export interface ContactsSyncState {
  version: typeof CONTACTS_SYNC_VERSION;
  clocks: ContactsSyncClock[];
  /**
   * merge redirect 使用独立时钟域：旧客户端会丢未知 merges，但不会因此确认其 stamp。
   * 节点首次写普通状态时也以 counter=1 登记在此，声明该作者理解 redirect；这样
   * 接收端可区分新版真实删除与经旧 hop 丢证据的 merge tombstone。字段可选用于
   * 兼容升级前已落盘 / 旧客户端发来的 v1 状态。
   */
  mergeClocks?: ContactsSyncClock[];
  contacts: ContactsSyncContact[];
  identities: Array<ContactsSyncEntity<ContactsSyncIdentityValue>>;
  events: Array<ContactsSyncEntity<ContactsSyncEventValue>>;
  groups: Array<ContactsSyncEntity<ContactsSyncGroupValue>>;
  memberships: Array<ContactsSyncEntity<ContactsSyncMembershipValue>>;
  relations: Array<ContactsSyncEntity<ContactsSyncRelationValue>>;
  /**
   * 显式 source→target 合并证据。可选用于兼容升级前已落盘 / 旧客户端发来的 v1 状态；
   * 新状态始终写出数组。旧客户端会忽略未知字段，新客户端合并时不会丢本地记录。
   */
  merges?: Array<ContactsSyncEntity<ContactsSyncMergeValue>>;
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
    mergeClocks: [],
    contacts: [],
    identities: [],
    events: [],
    groups: [],
    memberships: [],
    relations: [],
    merges: [],
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
