import { telegramIm } from '../im/host.js';
import { listTelegramKnownGroups } from '../im/telegram/groupWindow.js';
import { getTelegramBehaviorSettingsStore } from '../im/telegram/behaviorStore.js';
import { additionalSettingsSchemas, type SettingsEditableValue } from '../../shared/settingsEditableCatalog.js';
import type { OverrideSettingsCommitOptions } from '../maker-host/override-settings-file.js';
import { HostSettingsError } from './operations.js';

function inspect() {
  const state = getTelegramBehaviorSettingsStore().inspect();
  if (state.status !== 'ready') return state;
  const always = Object.entries(state.value.groupActivation ?? {}).filter(([, mode]) => mode === 'always').map(([id]) => id);
  additionalSettingsSchemas.telegramGroups.parse({ always });
  return { status: 'ready' as const, revision: state.revision, value: { always }, defaults: { always: [] }, customizedKeys: always.length ? ['always'] : [], isCustomized: always.length > 0 };
}
export const nativeTelegramGroupSettings = {
  inspect,
  async read() {
    const state = inspect();
    if (state.status !== 'ready') return state;
    const context = telegramIm.botContextId;
    const groups = context ? await listTelegramKnownGroups(context) : [];
    if (telegramIm.botContextId !== context) throw new HostSettingsError('CONFLICT');
    if (!groups.length && !state.isCustomized) return { status: 'unavailable' as const, revision: null };
    return { ...state, choices: { always: groups.map(group => ({ value: group.chatId, label: group.chatName || group.chatId })) } };
  },
  async commit(change: { set: Record<string, SettingsEditableValue>; clear: string[] }, options: OverrideSettingsCommitOptions) {
    const context = telegramIm.botContextId;
    const groups = context ? await listTelegramKnownGroups(context) : [];
    const always = change.clear.includes('always') ? [] : additionalSettingsSchemas.telegramGroups.parse(change.set).always;
    const assertCurrent = () => { options.assertCurrent?.(); if (telegramIm.botContextId !== context) throw new HostSettingsError('CONFLICT'); };
    assertCurrent();
    const state = await getTelegramBehaviorSettingsStore().commitAtomic(current => {
      for (const id of always) if (current.value.groupActivation?.[id] !== 'always' && !groups.some(group => group.chatId === id)) throw new HostSettingsError('UNSUPPORTED_CAPABILITY');
      return always.length ? { set: { groupActivation: Object.fromEntries(always.map(id => [id, 'always' as const])) } } : { clear: ['groupActivation'] };
    }, { ...options, assertCurrent });
    return { status: 'ready' as const, revision: state.revision, value: { always }, defaults: { always: [] }, customizedKeys: always.length ? ['always'] : [], isCustomized: always.length > 0 };
  },
};
