/**
 * contactsService — 智能通讯录 IPC 的 renderer 封装。
 *
 * preload 的 window.electronAPI.maker.contacts 用 unknown 透传, 这里收敛为
 * @cindy/maker-core contacts 类型(type-only import, 无 runtime 依赖)。
 * IPC 错误统一走 extractIpcError 转 code(如 IDENTITY_CONFLICT)供 UI 分支。
 */

import { extractIpcError } from '@/utils/ipcError';

import type {
  AddIdentityInput,
  AddRelationInput,
  ImportContactRecord,
  ImportContactsOptions,
  ImportSummary,
  ContactRelation,
  RelatedContactRef,
  AppendEventInput,
  ContactEvent,
  ContactGroup,
  ContactGroupWithCount,
  ContactIdentity,
  ContactProfile,
  ContactSummary,
  ContactsSearchHit,
  ContactsStats,
  CreateContactInput,
  ListContactsOptions,
  MergeResult,
  ResolveHit,
  UpdateContactInput,
} from '@cindy/maker-core';

const api = () => window.electronAPI.maker.contacts;

export type {
  AddIdentityInput,
  AddRelationInput,
  ImportContactRecord,
  ImportContactsOptions,
  ImportSummary,
  ContactRelation,
  RelatedContactRef,
  AppendEventInput,
  ContactEvent,
  ContactGroup,
  ContactGroupWithCount,
  ContactIdentity,
  ContactProfile,
  ContactSummary,
  ContactsSearchHit,
  ContactsStats,
  CreateContactInput,
  ListContactsOptions,
  MergeResult,
  ResolveHit,
  UpdateContactInput,
};

export interface ContactsDeviceSyncStatus {
  available: boolean;
  enabled: boolean;
  phase: 'off' | 'waiting' | 'syncing' | 'up-to-date' | 'error';
  onlineDeviceCount: number;
  lastSyncAt: string | null;
  lastSyncDeviceId: string | null;
  lastSyncDeviceName: string | null;
  lastRoute: 'lan' | 'relay' | null;
  errorCode: 'secure-storage-unavailable' | 'peer-identity-changed' | 'sync-failed' | null;
}

export const contactsService = {
  settingsGet: () => api().settingsGet(),
  settingsSet: (enabled: boolean) => api().settingsSet(enabled),
  syncStatusGet: () => api().syncStatusGet() as Promise<ContactsDeviceSyncStatus>,
  syncEnabledSet: (enabled: boolean) =>
    api().syncEnabledSet(enabled) as Promise<ContactsDeviceSyncStatus>,
  syncNow: () => api().syncNow() as Promise<ContactsDeviceSyncStatus>,

  list: (opts?: ListContactsOptions) => api().list(opts) as Promise<ContactSummary[]>,
  get: (id: string) => api().get(id) as Promise<ContactProfile>,
  create: (input: CreateContactInput) => api().create(input) as Promise<ContactProfile>,
  update: (id: string, patch: UpdateContactInput) =>
    api().update(id, patch) as Promise<ContactProfile>,
  delete: (id: string) => api().delete(id),
  merge: (targetId: string, sourceId: string) =>
    api().merge(targetId, sourceId) as Promise<MergeResult>,
  search: (
    query: string,
    opts?: {
      kind?: 'person' | 'org';
      status?: 'confirmed' | 'pending';
      groupId?: string;
      limit?: number;
    },
  ) => api().search(query, opts) as Promise<ContactsSearchHit[]>,
  resolve: (value: string, opts?: { platform?: string; limit?: number }) =>
    api().resolve(value, opts) as Promise<ResolveHit[]>,
  stats: () => api().stats() as Promise<ContactsStats>,

  addIdentity: (contactId: string, input: AddIdentityInput) =>
    api().addIdentity(contactId, input) as Promise<ContactIdentity>,
  removeIdentity: (identityId: string) => api().removeIdentity(identityId),
  appendEvent: (contactId: string, input: AppendEventInput) =>
    api().appendEvent(contactId, input) as Promise<ContactEvent>,
  deleteEvent: (eventId: string) => api().deleteEvent(eventId),

  addRelation: (fromId: string, input: AddRelationInput) =>
    api().addRelation(fromId, input) as Promise<ContactRelation>,
  removeRelation: (relationId: string) => api().removeRelation(relationId),

  groupsList: () => api().groupsList() as Promise<ContactGroupWithCount[]>,
  groupsCreate: (name: string, description?: string) =>
    api().groupsCreate(name, description) as Promise<ContactGroup>,
  groupsUpdate: (groupId: string, patch: { name?: string; description?: string }) =>
    api().groupsUpdate(groupId, patch) as Promise<ContactGroup>,
  groupsDelete: (groupId: string) => api().groupsDelete(groupId),
  groupsSetMembers: (groupId: string, payload: { add?: string[]; remove?: string[] }) =>
    api().groupsSetMembers(groupId, payload),

  resetAll: () => api().resetAll(),
  systemRead: () => api().systemRead() as Promise<ImportContactRecord[]>,
  parseVcf: (text: string) => api().parseVcf(text) as Promise<ImportContactRecord[]>,
  import: (records: ImportContactRecord[], opts?: Pick<ImportContactsOptions, 'groupId'>) =>
    api().import(records, opts) as Promise<ImportSummary>,
  onChanged: (cb: () => void) => api().onChanged(cb),
  onSyncStatusChanged: (cb: (status: ContactsDeviceSyncStatus) => void) =>
    api().onSyncStatusChanged((status) => cb(status as ContactsDeviceSyncStatus)),
};

/** contacts UI 有专属文案的 IPC 错误码(settings.contacts.ipcError.* 四语言齐备) */
const CONTACTS_ERROR_CODES = new Set([
  'IDENTITY_CONFLICT',
  'PERMISSION_DENIED',
  'UNSUPPORTED_CAPABILITY',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'INVALID_PARAMS',
]);

/**
 * IPC 错误 → contacts 专属 i18n key(规则 13: 统一 extractIpcError 解码,
 * 禁止手写 message.includes 判 code)。没有专属文案的 code 落 INTERNAL 兜底。
 */
export function contactsErrorI18nKey(err: unknown): string {
  const ipc = extractIpcError(err);
  if (ipc && CONTACTS_ERROR_CODES.has(ipc.code)) {
    return `settings.contacts.ipcError.${ipc.code}`;
  }
  return 'settings.contacts.ipcError.INTERNAL';
}

/** 判某个 IPC 错误是否指定 code(UI 分支用, 如导入向导的授权引导) */
export function isContactsIpcCode(err: unknown, code: string): boolean {
  return extractIpcError(err)?.code === code;
}
