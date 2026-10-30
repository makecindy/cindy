import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { randomUUID } from 'expo-crypto';
import type { BotGroupRemoteActionId, BotGroupRemoteChatData } from '@cindy/maker-shared/botGroupChat';
import { chatGroupMembership } from '@cindy/maker-shared/botGroupPresentation';
import { chatGroupView, type ChatActor, type ChatGroupSettingsAction } from '@/chat/chatServerClient';
import { useChatClient } from '@/chat/useChatServer';
import { canManageBotGroup } from './botGroupRemote';

/**
 * `archive` also restores an archived group; `nickname`, `avatar`, `bot-access` and adding your
 * own teammate are written as yourself, every other write as the owner or admin you control.
 */
export type GroupSettingsActionId = BotGroupRemoteActionId | 'set-member-role' | 'archive' | 'transfer' | 'nickname' | 'avatar' | 'bot-access';
const SELF_ACTIONS = new Set<GroupSettingsActionId>(['nickname', 'avatar', 'bot-access', 'add-member']);
type Settings = { group: BotGroupRemoteChatData; managerId?: string };

/** Cloud settings use the account's chat service, never device discovery or a host link. */
export function useBotGroupSettingsManagement(source: BotGroupRemoteChatData, enabled: boolean) {
  const api = useChatClient();
  const groupId = source.id;
  const binding = useMemo(() => Symbol(), [api.owner, groupId, enabled]);
  const active = useRef<typeof binding | null>(binding); active.current = binding;
  useEffect(() => { active.current = binding; return () => { active.current = null; }; }, [binding]);
  const sequence = useRef(0);
  const verified = useRef<{ binding: typeof binding; settings: Settings } | null>(null);
  const writing = useRef<symbol | null>(null);
  const [state, setState] = useState<{ binding: typeof binding; settings?: Settings; loading: boolean; failed: boolean }>();
  const pending = useRef<{ binding: typeof binding; key: string; operationId: string; managerId: string | undefined; action: ChatGroupSettingsAction } | null>(null);
  const valid = useCallback(() => enabled && api.enabled && api.current() && active.current === binding, [api, enabled, binding]);
  const refresh = useCallback(async () => {
    if (!valid()) return;
    const run = ++sequence.current;
    verified.current = null;
    setState(previous => ({ binding, settings: previous?.binding === binding ? previous.settings : undefined, loading: true, failed: false }));
    try {
      const { snapshot, self, manager } = await api.client.groupSettings(groupId);
      if (!valid() || sequence.current !== run) return;
      const settings = { group: { ...chatGroupView({ snapshot, messages: [], before: null }, self), ...api.client.lifecycleCapabilities() }, managerId: manager?.id };
      verified.current = { binding, settings };
      setState({ binding, settings, loading: false, failed: false });
    } catch {
      if (valid() && sequence.current === run) setState({ binding, loading: false, failed: true });
    }
  }, [api, binding, groupId, valid]);
  // The parent already subscribes to server changes. Recheck only settings/membership changes.
  const sourceVersion = JSON.stringify([source.revision, source.archived, source.dissolvedAt,
    source.members.map(member => [member.actorId, member.role, member.status])]);
  useEffect(() => { void refresh(); }, [refresh, sourceVersion]);

  const act = useCallback(async (actionId: GroupSettingsActionId, input: Record<string, unknown> = {}) => {
    const current = verified.current?.binding === binding ? verified.current.settings : undefined;
    const asSelf = SELF_ACTIONS.has(actionId);
    // An archived group only takes 取消归档 from its managers.
    const allowed = asSelf ? !current?.group.archived : actionId === 'archive'
      ? !!current?.managerId && chatGroupMembership(current.group).manager : !!current?.managerId && canManageBotGroup(current.group);
    if (!valid() || !current || !allowed || current.group.dissolvedAt || writing.current) throw new Error('PERMISSION_DENIED');
    const revision = (value: unknown) => {
      const expected = value ?? current.group.revision;
      if (!Number.isSafeInteger(expected) || Number(expected) < 1) throw new Error('REVISION_CONFLICT');
      return Number(expected);
    };
    const actor = () => { const id = String(input.actorId ?? ''); if (!id) throw new Error('INVALID_PARAMS'); return id; };
    let action: ChatGroupSettingsAction;
    if (actionId === 'nickname') {
      action = { type: 'nickname', actorId: actor(), nickname: typeof input.nickname === 'string' && input.nickname.trim() ? input.nickname.trim() : null };
    } else if (actionId === 'avatar') {
      if (!current.group.supportsMemberAvatar) throw new Error('CHAT_UNAVAILABLE');
      action = { type: 'avatar', actorId: actor(), avatar: typeof input.avatar === 'string' ? input.avatar : null };
    } else if (actionId === 'transfer') {
      action = { type: 'transfer', actorId: actor() };
    } else if (actionId === 'bot-access') {
      if (input.access !== 'none' && input.access !== 'chat' && input.access !== 'tools') throw new Error('INVALID_PARAMS');
      action = { type: 'botAccess', actorId: actor(), access: input.access, expectedRevision: revision(input.expectedRevision) };
    } else if (actionId === 'update' || actionId === 'delete' || actionId === 'archive') {
      action = { type: 'update', expectedRevision: revision(input.expectedRevision) };
      if (actionId !== 'update') action.archived = actionId === 'delete' || input.archived !== false;
      else {
        if (typeof input.name === 'string') action.name = input.name;
        if (typeof input.topic === 'string') action.topic = input.topic;
        if (typeof input.description === 'string') action.description = input.description;
        if (input.replyMode === 'all' || input.replyMode === 'mentioned') action.responseMode = input.replyMode;
        if (input.speakingMode === 'auto' || input.speakingMode === 'sequential') action.speakingMode = input.speakingMode;
        if (typeof input.organizerBotId === 'string' || input.organizerBotId === null) action.organizerId = input.organizerBotId;
      }
    } else if (actionId === 'add-member' || actionId === 'remove-member' || actionId === 'set-member-role') {
      action = { type: 'member', actorId: String(input.actorId ?? input.botId ?? ''),
        action: actionId === 'add-member' ? 'invite' : actionId === 'remove-member' ? 'remove' : 'role' };
      if (actionId === 'set-member-role') {
        if (input.role !== 'admin' && input.role !== 'member') throw new Error('INVALID_PARAMS');
        action.role = input.role;
      }
    } else throw new Error('UNSUPPORTED_CHAT_ACTION');
    // A readback may advance the revision after a lost acknowledgement. Retry the original
    // receipt and body for the same intended edit, rather than creating another mutation.
    const key = JSON.stringify(action.type === 'update' ? { ...action, expectedRevision: undefined } : action);
    const prior = pending.current;
    const operation = prior?.binding === binding && prior.key === key ? prior
      : { binding, key, operationId: randomUUID(), managerId: asSelf ? undefined : current.managerId, action };
    pending.current = operation;
    const write = Symbol(); writing.current = write;
    // Fence reads started before this mutation, including the parent subscription refresh.
    ++sequence.current; verified.current = null;
    try {
      await api.client.manageGroup(groupId, operation.managerId, operation.action, operation.operationId);
      if (!valid()) throw new Error('OWNER_CHANGED');
      pending.current = null;
      return { effects: [] };
    } catch (error) {
      // A definite rejection may be corrected; an uncertain network result keeps its receipt ID.
      const status = (error as { status?: number } | null)?.status;
      if (valid() && status && status >= 400 && status < 500) pending.current = null;
      throw error;
    } finally {
      if (writing.current === write) writing.current = null;
      if (valid()) await refresh();
    }
  }, [api, binding, groupId, refresh, valid]);
  /** A join link from the owner or admin you control; revoking takes the same link back. */
  const invite = useCallback(async (revoke?: string) => {
    const current = verified.current?.binding === binding ? verified.current.settings : undefined;
    if (!valid() || !current?.managerId || current.group.dissolvedAt || current.group.archived) throw new Error('PERMISSION_DENIED');
    const operationId = randomUUID();
    if (revoke) { await api.client.revokeInvite(groupId, current.managerId, revoke, operationId); return null; }
    const link = await api.client.createInvite(groupId, current.managerId, operationId);
    if (!valid()) throw new Error('OWNER_CHANGED');
    return link;
  }, [api, binding, groupId, valid]);
  const own = state?.binding === binding;
  const settings = own ? state.settings : undefined;
  const loading = enabled && (!own || state.loading);
  const editable = !loading && !!settings?.managerId && canManageBotGroup(settings.group) && !settings.group.dissolvedAt;
  // Settings reads skip `/actors`; the chat page already knows which computer runs each of your teammates.
  const homes = new Map(source.members.flatMap(member => member.homeDeviceId && member.actorId ? [[member.actorId, member.homeDeviceId] as const] : []));
  const group = settings && homes.size ? { ...settings.group, members: settings.group.members.map(member =>
    member.homeDeviceId === null && member.actorId && homes.has(member.actorId) ? { ...member, homeDeviceId: homes.get(member.actorId) } : member) }
    : settings?.group;
  return { group, act, invite, refresh, loading, editable, ready: !loading && !!settings,
    reason: loading ? null : own && state.failed ? 'unavailable' as const : editable ? null : 'permission' as const };
}

/** Own cloud actors remain addable while their execution computers are offline. */
export function useCloudGroupCandidates(enabled: boolean) {
  const api = useChatClient();
  const [state, setState] = useState<{ owner: string; rows: ChatActor[]; loading: boolean; failed: boolean }>();
  useEffect(() => {
    if (!enabled || !api.enabled) return;
    let cancelled = false;
    setState({ owner: api.owner, rows: [], loading: true, failed: false });
    void api.client.actors().then(rows => {
      if (!cancelled && api.current()) setState({ owner: api.owner, rows: rows.filter(row => row.kind === 'bot'), loading: false, failed: false });
    }).catch(() => { if (!cancelled && api.current()) setState({ owner: api.owner, rows: [], loading: false, failed: true }); });
    return () => { cancelled = true; };
  }, [api, enabled]);
  return state?.owner === api.owner && enabled && api.enabled ? state : { rows: [], loading: enabled && api.enabled, failed: false };
}
