import type { SettingsTarget, SettingsTargetApi } from '@/components/settings/settingsTarget';
import {
  CLOUD_HOOK_PROVIDER_ACTION_URL,
  CLOUD_IM_SETTINGS_CHANNEL,
  cloudImSettingsReplySchema,
  type CloudImSettingsCall,
} from '../../../shared/cloudImSettings';
import type { NeutralHookProvider, SlackHookView } from '../../../shared/hookControlIpc';
import { isForeground, onForegroundChange } from './foreground';
import { openCloudExternal } from './openCloudExternal';

type HookControl = SettingsTargetApi['hookControl'];
type HookReply = { hook: SlackHookView };

/**
 * Binding flows that open an authorization page run as cloud authorization tickets, so the
 * page opens beside this client as it does for the other cloud cards.
 */
export interface CloudImAuthorization {
  start(
    request:
      | { kind: 'slack' }
      | { kind: 'slack-rebind'; teamId: string }
      | { kind: 'slack-communications'; teamId: string }
      | { kind: 'provider'; provider: NeutralHookProvider },
  ): Promise<void>;
  /** Cancels the running ticket of this card; false when none is running. */
  cancel(card: 'slack' | NeutralHookProvider): Promise<boolean>;
  /** Older Hosts do not list every provider's authorization action. */
  canAuthorizeProvider?(provider: NeutralHookProvider): boolean;
  canAuthorizeSlackCommunications?(teamId: string): boolean;
}

/** One call over the instance's private IM channel; the reply must belong to the same account. */
export function createCloudImCaller(deviceId: string) {
  let generation: number | null = null;
  return async function call<T = unknown>(name: CloudImSettingsCall, ...args: unknown[]): Promise<T> {
    const raw = await window.electronAPI.deviceLink.invoke(deviceId, CLOUD_IM_SETTINGS_CHANNEL, [
      { call: name, args },
    ]);
    const reply = cloudImSettingsReplySchema.parse(raw);
    if (generation !== null && reply.ownerGeneration !== generation)
      throw new Error('[OWNER_CHANGED] the instance account changed');
    generation = reply.ownerGeneration;
    return reply.result as T;
  };
}

/**
 * Connection status that changes on the instance's side, such as a binding confirmed from the
 * IM app. Writes from this page refresh on their own reply, and binding flows have their own
 * ticket progress, so this follows the 5 s budget of time-sensitive status (§8.7).
 */
const POLL_MS = 5_000;

/** The cards' target plus the raw caller for instance-only rows (WeChat directory, bot status). */
export type CloudImTarget = SettingsTarget & {
  call: ReturnType<typeof createCloudImCaller>;
  /** Whether the IM page is shown: a hidden page stops polling and refreshes on its return. */
  setActive(active: boolean): void;
};

/**
 * The local IM cards' API for a cloud instance. Settings run the instance's own handlers; only
 * binding flows go through tickets, and provider links open on this computer. There is no push
 * across the link: the connection snapshot is polled while a card listens on a shown IM page in
 * a window in front of the user, other views reload after each write as the local page does.
 */
export function createCloudImTarget(
  deviceId: string,
  deps: {
    authorization: CloudImAuthorization;
    pickDirectory(): Promise<string | null>;
  },
): CloudImTarget {
  const call = createCloudImCaller(deviceId);
  const get = () => call<HookReply>('maker:hook-control:get');
  const after = async (action: () => Promise<unknown>): Promise<HookReply> => {
    await action();
    return get();
  };
  const statusListeners = new Set<(view: SlackHookView) => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopFollowingWindow: (() => void) | null = null;
  let polling = false;
  let last = '';
  let active = true;
  // A slow reply never stacks a second read behind it in the instance's queue.
  const poll = () => {
    if (polling || !isForeground()) return;
    polling = true;
    void get()
      .then(({ hook }) => {
        const serialized = JSON.stringify(hook);
        if (serialized === last || !statusListeners.size) return;
        last = serialized;
        for (const listener of statusListeners) listener(hook);
      })
      .catch(() => {})
      .finally(() => {
        polling = false;
      });
  };
  // Each poll is a call in the instance's one-at-a-time queue: poll only while a card on a
  // shown IM page listens and the window is in front of the user. The window is followed
  // only while a card listens; coming back to the front reads once without waiting a tick.
  const sync = () => {
    const listening = active && statusListeners.size > 0;
    if (listening)
      stopFollowingWindow ??= onForegroundChange((foreground) => {
        sync();
        if (foreground) poll();
      });
    else if (stopFollowingWindow) {
      stopFollowingWindow();
      stopFollowingWindow = null;
    }
    if (listening && isForeground()) timer ??= setInterval(poll, POLL_MS);
    else if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  const onStatusChanged: HookControl['onStatusChanged'] = (listener) => {
    statusListeners.add(listener);
    sync();
    return () => {
      statusListeners.delete(listener);
      if (!statusListeners.size) last = '';
      sync();
    };
  };
  const setActive = (next: boolean) => {
    if (active === next) return;
    active = next;
    sync();
    // Back on the page: show changes made meanwhile without waiting for the next tick.
    if (active && statusListeners.size) poll();
  };
  const quiet = () => () => {};
  const hookControl: HookControl = {
    get,
    setEnabled: (enabled) =>
      enabled
        ? after(() => deps.authorization.start({ kind: 'slack' }))
        : call('maker:hook-control:set-enabled', { enabled: false }),
    setLifecycleAnnouncement: (enabled) =>
      call('maker:hook-control:set-lifecycle-announcement', { enabled }),
    setProviderEnabled: async (provider, enabled) => {
      // Retained bindings only resume their connection; a new bind needs a controller-side
      // ticket so its authorization page and cancellation stay on this computer.
      if (
        enabled &&
        deps.authorization.canAuthorizeProvider?.(provider) !== false &&
        (await get()).hook[provider].binding?.state !== 'confirmed'
      )
        return after(() => deps.authorization.start({ kind: 'provider', provider }));
      return call('maker:hook-control:set-provider-enabled', { provider, enabled });
    },
    addProject: (directory) => call('maker:hook-control:add-project', { directory }),
    setXCompanion: () => Promise.reject(new Error('[UNSUPPORTED] teammates are set on the instance')),
    setProviderDefaultWorkspace: (provider, alias) =>
      call('maker:hook-control:set-provider-default-workspace', { provider, alias }),
    bindStart: async () => {
      await deps.authorization.start({ kind: 'slack' });
      return { ok: true as const };
    },
    bindRevoke: async () => {
      await call('maker:hook-control:set-enabled', { enabled: false });
      return { ok: true as const };
    },
    addBinding: () => after(() => deps.authorization.start({ kind: 'slack' })),
    rebindTeam: (teamId) => after(() => deps.authorization.start({ kind: 'slack-rebind', teamId })),
    setSlackCommunications: (teamId, enabled) =>
      enabled && deps.authorization.canAuthorizeSlackCommunications?.(teamId) !== false
        ? after(() => deps.authorization.start({ kind: 'slack-communications', teamId }))
        : call('maker:hook-control:set-slack-communications', { teamId, enabled }),
    revokeTeam: (teamId) => call('maker:hook-control:revoke-team', { teamId }),
    cancelPendingBind: async () =>
      (await deps.authorization.cancel('slack')) ? get() : call('maker:hook-control:cancel-pending-bind'),
    providerBindStart: (provider) =>
      after(() => deps.authorization.start({ kind: 'provider', provider })),
    providerBindSelect: (provider) => call('maker:hook-control:provider-bind-select', { provider }),
    providerBindCancel: async (provider) =>
      (await deps.authorization.cancel(provider))
        ? get()
        : call('maker:hook-control:provider-bind-cancel', { provider }),
    providerBindRevoke: (provider) => call('maker:hook-control:provider-bind-revoke', { provider }),
    openProviderAction: async (provider, action) => {
      await openCloudExternal(async () => {
        const { url } = await call<{ url: string }>(CLOUD_HOOK_PROVIDER_ACTION_URL, { provider, action });
        return url;
      });
      return { ok: true as const };
    },
    getSharedProjectPrefs: () => call('maker:hook-control:shared-prefs-get'),
    setSharedProjectPrefs: (workspace, patch) =>
      call('maker:hook-control:shared-prefs-set', { workspace, patch }),
    getTelegramBehavior: (bindingId) => call('maker:hook-control:telegram-behavior-get', { bindingId }),
    setTelegramBehavior: (bindingId, patch) =>
      call('maker:hook-control:telegram-behavior-set', { bindingId, patch }),
    listTelegramGroups: (bindingId) => call('maker:hook-control:telegram-groups-list', { bindingId }),
    setTelegramGroupActivation: (bindingId, chatId, mode) =>
      call('maker:hook-control:telegram-group-activation-set', { bindingId, chatId, mode }),
    getWorkspaceProviderSources: () => call('maker:hook-control:workspace-provider-source-get'),
    setWorkspaceProviderSource: (payload) =>
      call('maker:hook-control:workspace-provider-source-set', payload),
    onWorkspaceProviderSourcesChanged: quiet,
    onSharedProjectPrefsChanged: quiet,
    onTelegramBehaviorChanged: quiet,
    onStatusChanged,
  };
  return {
    deviceId,
    call,
    setActive,
    api: {
      hookControl,
      telegramBot: {
        getBehavior: () => call('telegramBot:get-behavior'),
        setBehavior: (patch) => call('telegramBot:set-behavior', patch),
        getPersona: () => call('telegramBot:get-persona'),
        setPersona: (payload) => call('telegramBot:set-persona', payload),
        listGroups: () => call('telegramBot:list-groups'),
        setGroupActivation: (payload) => call('telegramBot:set-group-activation', payload),
      },
      imDefaultSettingsGet: (channel) => call('maker:im-default-settings:get', channel),
      showOpenDirectoryDialog: async () => {
        const path = await deps.pickDirectory();
        return path ? { canceled: false, path } : { canceled: true };
      },
    },
  };
}
