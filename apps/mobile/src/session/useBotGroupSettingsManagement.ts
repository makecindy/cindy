import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { randomUUID } from 'expo-crypto';
import type { BotGroupRemoteActionId, BotGroupRemoteChatData } from '@cindy/maker-shared/botGroupChat';
import { chatGroupView, type ChatActor, type ChatGroupSettingsAction } from '@/chat/chatServerClient';
import { useChatClient } from '@/chat/useChatServer';
import { canManageBotGroup } from './botGroupRemote';

export type GroupSettingsActionId = BotGroupRemoteActionId | 'set-member-role';
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
  const pending = useRef<{ binding: typeof binding; key: string; operationId: string; managerId: string; action: ChatGroupSettingsAction } | null>(null);
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
    if (!valid() || !current?.managerId || !canManageBotGroup(current.group) || current.group.dissolvedAt || writing.current) throw new Error('PERMISSION_DENIED');
    let action: ChatGroupSettingsAction;
    if (actionId === 'update' || actionId === 'delete') {
      const expectedRevision = input.expectedRevision ?? current.group.revision;
      if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1) throw new Error('REVISION_CONFLICT');
      action = { type: 'update', expectedRevision: Number(expectedRevision) };
      if (actionId === 'delete') action.archived = true;
      else {
        if (typeof input.name === 'string') action.name = input.name;
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
      : { binding, key, operationId: randomUUID(), managerId: current.managerId, action };
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
  const own = state?.binding === binding;
  const settings = own ? state.settings : undefined;
  const loading = enabled && (!own || state.loading);
  const editable = !loading && !!settings?.managerId && canManageBotGroup(settings.group) && !settings.group.dissolvedAt;
  return { group: settings?.group, act, refresh, loading, editable,
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
  return state?.owner === api.owner && enabled ? state : { rows: [], loading: enabled, failed: false };
}
