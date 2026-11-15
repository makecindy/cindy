import { describe, expect, it, vi } from 'vitest';

import { refreshGhostLocalizationIfChanged } from '../ghostLocalizationRefresh';
import { GhostTaskEventIndex } from '../taskEventIndex.js';
import { hasPluginHostToolGroupApproval } from '../taskCapability.js';
import { ghostInstallApprovalToken, type InstalledGhost } from '../../../shared/ghost.js';
import { createGhostProductionCallbacks } from './ghostProductionCallbacksFixture.js';

const GHOSTS = ['plugin-a', 'plugin-b'];

// Unit: exercise the production refresh routing. The localization helper alone
// cannot catch a caller accidentally scheduling installation work on every push.
// Roster changes also rebuild the task-event index; locale-only projection must not.
const refreshCallbacks = createGhostProductionCallbacks<{
  refreshGhostLocalization(locale: string): void;
  broadcastGhostsChanged(ghosts: InstalledGhost[]): void;
  setGhostWorkdirDisabledAndNotify(dir: string, id: string, disabled: boolean): string[];
}>({ functions: ['refreshGhostLocalization', 'broadcastGhostsChanged', 'setGhostWorkdirDisabledAndNotify'] });

function routing(activeComputer = true) {
  const ghosts = [{ manifest: { id: 'plugin-a', agent: { hostTools: ['computer'] } }, enabled: true,
    approval: { state: 'approved', revision: 'fixture' }, approvedHostToolGroups: ['computer'] }] as InstalledGhost[];
  const taskEventIndex = new GhostTaskEventIndex();
  const installation = {
    apps: vi.fn(), manifest: vi.fn(), unread: vi.fn(), browser: vi.fn(), computer: vi.fn(), skills: vi.fn(), index: vi.fn(),
    taskEvents: vi.spyOn(taskEventIndex, 'replace'),
  };
  const push = vi.fn(), remote = vi.fn(), setupChanged = vi.fn(), contextChanged = vi.fn();
  const list = vi.fn(() => ghosts);
  const manager = { list, invalidateNotificationCandidates: installation.index };
  let disabled = false;
  const callbacks = refreshCallbacks({
    managerSingleton: manager, getGhostManager: () => manager,
    taskEventIndex, getGhostOwnerPushStamp: () => ({ dataOwnerId: 'owner', ownerGeneration: 1 }),
    currentGhostAppContext: () => ({ context: { region: 'global' } }), getResolvedMainLocale: () => 'en',
    refreshGhostLocalizationIfChanged, sendToGhostLogic: contextChanged,
    refreshPluginApps: installation.apps, getGhostSetupManifestTracker: () => ({ note: installation.manifest }),
    sweepRevokedGhostUnread: installation.unread, getGhostBrowserExtensionSlot: () => ({ reconcile: installation.browser }),
    hasPluginHostTools: () => activeComputer,
    reconcilePluginHostTools: installation.computer, hasPluginHostToolGroupApproval, ghostInstallApprovalToken,
    scheduleGhostSkillReconcile: installation.skills,
    isGhostAvailableForActiveSession: () => true, projectGhostForRenderer: (ghost: InstalledGhost) => ghost,
    findGhostForInstanceId: () => ghosts[0], isGhostBoundaryPending: () => false,
    broadcastGhostWindowPush: push, notifyMobilePluginsChanged: remote, ghostsChangedObserver: null,
    isGhostDisabledForWorkdir: () => disabled,
    setGhostDisabledForWorkdir: (_dir: string, id: string, value: boolean) => { disabled = value; return value ? [id] : []; },
    normalizeWorkdirKey: () => '/project', getGhostSetupChangeBus: () => ({ emit: setupChanged }),
  });
  return { callbacks, ghosts, installation, push, remote, setupChanged, contextChanged, list };
}

it('projects a locale change without installation effects, while real roster changes still reconcile', () => {
  const r = routing();
  r.callbacks.refreshGhostLocalization('zh-CN');
  expect(r.push).toHaveBeenCalledWith('ghosts:changed', { ghosts: r.ghosts });
  expect(r.contextChanged).toHaveBeenCalledOnce();
  expect(r.remote).toHaveBeenCalledOnce();
  const { apps, ...installation } = r.installation;
  expect(apps).toHaveBeenCalledOnce();
  for (const effect of Object.values(installation)) expect(effect).not.toHaveBeenCalled();
  r.callbacks.broadcastGhostsChanged(r.ghosts);
  expect(apps).toHaveBeenCalledTimes(2);
  for (const effect of Object.values(installation)) expect(effect).toHaveBeenCalledOnce();
  expect(installation.computer).toHaveBeenCalledWith(new Map([['plugin-a', 'approved:fixture']]));
});

// Unit performance regression: the production roster callback built a computer
// approval map with no live consumer; existing cases always had one. Zero live
// connections must skip the new reconciliation without skipping ordinary effects.
it('skips computer approval reconciliation when no plugin has a live computer runtime', () => {
  const r = routing(false);
  r.callbacks.broadcastGhostsChanged(r.ghosts);
  expect(r.installation.computer).not.toHaveBeenCalled();
  expect(r.installation.apps).toHaveBeenCalledOnce();
  expect(r.push).toHaveBeenCalledWith('ghosts:changed', { ghosts: r.ghosts });
});

it('publishes only the changed directory policy and retains setup and remote invalidation', () => {
  const r = routing();
  expect(r.callbacks.setGhostWorkdirDisabledAndNotify('/project/', 'plugin-a', true)).toEqual(['plugin-a']);
  expect(r.push).toHaveBeenCalledExactlyOnceWith('ghosts:workdir-prefs-changed', { workdirKey: '/project', disabled: ['plugin-a'] });
  expect(r.setupChanged).toHaveBeenCalledExactlyOnceWith('plugin-a', { source: 'workdir_policy' });
  expect(r.remote).toHaveBeenCalledOnce();
  expect(r.list).not.toHaveBeenCalled();
  for (const effect of Object.values(r.installation)) expect(effect).not.toHaveBeenCalled();
  r.callbacks.setGhostWorkdirDisabledAndNotify('/project', 'plugin-a', true);
  expect(r.push).toHaveBeenCalledOnce();
  expect(r.remote).toHaveBeenCalledOnce();
});

function setup() {
  const broadcastChanged = vi.fn();
  const sendContextChanged = vi.fn();
  const refresh = (previousLocale: 'zh-CN' | 'en' | 'zh-TW' | 'ja', currentLocale: 'zh-CN' | 'en' | 'zh-TW' | 'ja') =>
    refreshGhostLocalizationIfChanged({
      region: 'global',
      previousLocale,
      currentLocale,
      list: () => GHOSTS,
      broadcastChanged,
      sendContextChanged,
    });
  return { refresh, broadcastChanged, sendContextChanged };
}

describe('refreshGhostLocalizationIfChanged', () => {
  it('stays silent when the plugin-visible app-context is unchanged (same locale, or startup locale re-sent)', () => {
    const { refresh, broadcastChanged, sendContextChanged } = setup();
    refresh('zh-CN', 'zh-CN');
    refresh('en', 'en');
    expect(broadcastChanged).not.toHaveBeenCalled();
    expect(sendContextChanged).not.toHaveBeenCalled();
  });

  it('notifies each plugin once with the new context, then stays silent on a repeat', () => {
    const { refresh, broadcastChanged, sendContextChanged } = setup();
    refresh('zh-CN', 'en');
    expect(broadcastChanged).toHaveBeenCalledTimes(1);
    expect(sendContextChanged).toHaveBeenCalledTimes(2);
    expect(sendContextChanged).toHaveBeenCalledWith('plugin-a', {
      type: 'host-context-changed',
      ok: true,
      context: { region: 'global', locale: 'en', uiLocale: 'en' },
    });
    expect(sendContextChanged).toHaveBeenCalledWith('plugin-b', expect.objectContaining({ type: 'host-context-changed' }));

    refresh('en', 'en');
    expect(broadcastChanged).toHaveBeenCalledTimes(1);
    expect(sendContextChanged).toHaveBeenCalledTimes(2);
  });

  it('still notifies when the protocol locale stays en but uiLocale changes', () => {
    const { refresh, sendContextChanged } = setup();
    refresh('en', 'zh-TW');
    expect(sendContextChanged).toHaveBeenCalledTimes(2);
    expect(sendContextChanged).toHaveBeenCalledWith('plugin-a', expect.objectContaining({
      context: { region: 'global', locale: 'en', uiLocale: 'zh-TW' },
    }));
  });
});
