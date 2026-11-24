// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type MockInstance } from 'vitest';
import { CLOUD_SYNC_DEBOUNCE_MS } from '../cloudSettingsSync';
import { CLOUD_RECONNECT_DELAYS_MS, CloudSettingsPanel } from '../CloudSettingsView';
import { toast } from '@/lib/toast';
import { createTrialCloudSettingsClient } from '../trialClient';
import { SETTINGS_SEARCH_ENTRIES } from '@/components/settings/settingsSearchCatalog';
import { cloudSearchEntryAllowed } from '../search';
import type { CloudSettingsClient } from '../client';
import {
  CLOUD_SETTINGS_DOMAINS,
  CLOUD_SETTINGS_GROUPS,
  type CloudSettingsDomain,
} from '../../../../shared/cloudSettings';
import { SETTINGS_DISPLAY_LOCALES } from '../../../../shared/settingsReadCatalog';
import {
  CLOUD_SETTINGS_ALL_SECTIONS,
  CLOUD_SETTINGS_VISIBILITY,
  cloudLinkOpensDeviceCard,
  cloudTabFromLink,
  type CloudSettingsVisibility,
} from '../cloudSettingsVisibility';
vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  // Search reads its text with an empty default and skips anything that is still a key.
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; names?: string }) =>
      options?.defaultValue === ''
        ? `text ${key}`
        : options?.names
          ? `${key} ${options.names}`
          : key,
  }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// Whether access could be rechecked, as the provider reports it.
const accessCheck = vi.hoisted(() => {
  let unverified = false;
  const listeners = new Set<() => void>();
  return {
    get: () => unverified,
    set(value: boolean) { unverified = value; listeners.forEach((listener) => listener()); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
});
vi.mock('../CloudInstanceAccess', async (original) => {
  const { useSyncExternalStore } = await import('react');
  return { ...(await original<typeof import('../CloudInstanceAccess')>()),
    useCloudInstanceAccessUnverified: () => useSyncExternalStore(accessCheck.subscribe, accessCheck.get) };
});
vi.mock('@/contexts/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: vi.fn(),
}));
// Model pickers read the target catalog over DeviceLink; covered in model-settings.test.tsx.
vi.mock('../CloudModelSettings', () => ({
  CloudAuxiliarySettings: () => null,
  CloudBotsSettings: () => null,
  CloudSubagentSettings: () => null,
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => true) }),
}));
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
afterEach(cleanup);
function setup(
  configure?: (client: CloudSettingsClient) => void,
  visibility: CloudSettingsVisibility = CLOUD_SETTINGS_ALL_SECTIONS,
  /** The trial page names itself in the page notice; a read failure shows only outside it. */
  trial = true,
) {
  Object.assign(window, {
    electronAPI: new Proxy(
      {},
      {
        get() {
          throw Error('LOCAL_API_FORBIDDEN');
        },
      },
    ),
  });
  const client = createTrialCloudSettingsClient();
  configure?.(client);
  const original = client.save.bind(client);
  const save = vi.spyOn(client, 'save');
  render(
    <CloudSettingsPanel
      name="Cloud trial"
      client={client}
      online
      trial={trial}
      onBack={vi.fn()}
      visibility={visibility}
    />,
  );
  fireEvent.click(screen.getByRole('tab', { name: 'settings.tabs.personalization' }));
  return { client, save, original };
}
const ready = async (input: HTMLElement) =>
  waitFor(() => expect(input.matches(':disabled')).toBe(false));
const general = async () => {
  fireEvent.click(screen.getByRole('tab', { name: 'settings.tabs.general' }));
  await screen.findByText('settings.agentResource.title');
  const input = within(document.querySelector('#settings-agent-resource')!).getByRole('spinbutton');
  await ready(input);
  return input;
};
describe('shared native cloud settings', () => {
  it('uses native blur submission, rejects intermediate invalid values, then resets the cloud default', async () => {
    const { save } = setup();
    const input = await general();
    for (const value of ['', '-1', '3.5', '99']) {
      fireEvent.change(input, { target: { value } });
      fireEvent.blur(input);
    }
    expect(save).not.toHaveBeenCalled();
    for (const [index, value] of ['6', '7'].entries()) {
      fireEvent.change(input, { target: { value } });
      expect(save).toHaveBeenCalledTimes(index);
      fireEvent.blur(input);
      await waitFor(() => expect(save).toHaveBeenCalledTimes(index + 1));
      await ready(input);
      expect((input as HTMLInputElement).value).toBe(value);
    }
    fireEvent.click(
      within(input.closest('section')!).getByRole('button', { name: 'settings.defaults.restore' }),
    );
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('4'));
  });
  it('applies the native balanced preset using target CPU count, in one cloud write', async () => {
    const { client, save } = setup();
    const input = await general();
    fireEvent.click(screen.getByRole('radio', { name: 'settings.agentResource.presets.balanced' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await ready(input);
    // Keys the instance already holds are not written again; the result is the preset.
    expect(save.mock.calls[0][1]).toEqual({ processPriority: 'low' });
    const [stored] = await client.read(['agentResource']);
    expect(stored?.value).toEqual({
      maxConcurrentCommands: 4,
      processPriority: 'low',
      capToolchainThreads: true,
    });
    expect(
      screen
        .getByRole('radio', { name: 'settings.agentResource.presets.balanced' })
        .getAttribute('aria-checked'),
    ).toBe('true');
  });
  it('confirms a write without rereading the category, and still rereads on a category switch', async () => {
    let read: MockInstance<CloudSettingsClient['read']>;
    const { save } = setup((client) => {
      read = vi.spyOn(client, 'read');
    });
    const input = await general();
    const before = read!.mock.calls.length;
    fireEvent.click(screen.getByRole('radio', { name: 'settings.agentResource.presets.balanced' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await ready(input);
    expect(read!.mock.calls.length).toBe(before);
    fireEvent.click(screen.getByRole('tab', { name: 'settings.tabs.personalization' }));
    await waitFor(() => expect(read!.mock.calls.length).toBe(before + 1));
  });
  // The prompt's explicit save holds the page while it writes; when it
  // finishes, only its own group is current again, and the category is not read again for it.
  it('confirms a prompt save without rereading the category', async () => {
    let read: MockInstance<CloudSettingsClient['read']>;
    const { save } = setup((client) => {
      read = vi.spyOn(client, 'read');
    });
    const input = await screen.findByRole('textbox', { name: 'settings.personalization.ariaLabel' });
    await ready(input);
    const before = read!.mock.calls.length;
    fireEvent.change(input, { target: { value: 'saved once' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.personalization.save' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await ready(input);
    expect(read!.mock.calls.length).toBe(before);
  });
  // Unit: access cannot be rechecked for a moment (the network dropped). The page and the unsaved
  // instructions stay, saving waits, and it resumes when the check succeeds again.
  it('keeps an unsaved prompt and holds saving while access cannot be rechecked', async () => {
    onTestFinished(() => accessCheck.set(false));
    const { save } = setup();
    const input = await screen.findByRole('textbox', { name: 'settings.personalization.ariaLabel' });
    await ready(input);
    fireEvent.change(input, { target: { value: 'unsaved draft' } });
    act(() => accessCheck.set(true));
    expect((screen.getByRole('button', { name: 'settings.personalization.save' }) as HTMLButtonElement).disabled).toBe(true);
    act(() => accessCheck.set(false));
    await waitFor(() => expect((screen.getByRole('button', { name: 'settings.personalization.save' }) as HTMLButtonElement).disabled).toBe(false));
    expect((input as HTMLTextAreaElement).value).toBe('unsaved draft');
    expect(save).not.toHaveBeenCalled();
  });
  it('retains the native prompt editor draft across categories without a write', async () => {
    const { save } = setup();
    const input = await screen.findByRole('textbox', {
      name: 'settings.personalization.ariaLabel',
    });
    fireEvent.change(input, { target: { value: 'cloud-only draft' } });
    await general();
    fireEvent.click(screen.getByRole('tab', { name: 'settings.tabs.personalization' }));
    await ready(input);
    expect((input as HTMLTextAreaElement).value).toBe('cloud-only draft');
    expect(save).not.toHaveBeenCalled();
  });
  // A prompt save with an unknown outcome is read back once, never sent again,
  // and the page keeps reading instead of waiting for a reload.
  describe('a prompt save with an unknown outcome', () => {
    beforeEach(() => {
      vi.mocked(toast.error).mockClear();
      vi.mocked(toast.success).mockClear();
    });
    const prompt = async () => {
      const input = await screen.findByRole('textbox', { name: 'settings.personalization.ariaLabel' });
      await ready(input);
      return input as HTMLTextAreaElement;
    };
    it('says nothing when the save did arrive', async () => {
      const { save, original } = setup();
      const input = await prompt();
      save.mockImplementationOnce(async (...args) => {
        await original(...args);
        throw Error('CLOUD_SETTINGS_SAVE_UNCONFIRMED');
      });
      fireEvent.change(input, { target: { value: 'arrived' } });
      fireEvent.click(screen.getByRole('button', { name: 'settings.personalization.save' }));
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      expect(toast.error).not.toHaveBeenCalled();
      expect(save).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('alert')).toBeNull();
      await ready(input);
      expect(input.value).toBe('arrived');
    });
    it('reports a save that did not arrive, keeps the text and does not send it again', async () => {
      const { save } = setup();
      const input = await prompt();
      save.mockRejectedValueOnce(Error('CLOUD_SETTINGS_SAVE_UNCONFIRMED'));
      fireEvent.change(input, { target: { value: 'lost' } });
      fireEvent.click(screen.getByRole('button', { name: 'settings.personalization.save' }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('hostSettings.saveFailed'));
      expect(save).toHaveBeenCalledTimes(1);
      expect(screen.queryByText('bots.remoteSettings.loadFailed')).toBeNull();
      await ready(input);
      expect(input.value).toBe('lost');
    });
    it('shows the read failure notice when the check cannot read', async () => {
      const { client, save } = setup(undefined, undefined, false);
      const input = await prompt();
      save.mockRejectedValueOnce(Error('CLOUD_SETTINGS_SAVE_UNCONFIRMED'));
      // Reading stays broken: the notice stays until it works again.
      vi.spyOn(client, 'read').mockRejectedValue(Error('CLOUD_SETTINGS_UNAVAILABLE'));
      fireEvent.change(input, { target: { value: 'unknown' } });
      fireEvent.click(screen.getByRole('button', { name: 'settings.personalization.save' }));
      // The page's 「正在管理」 notice says so, with its retry.
      await screen.findByText('bots.remoteSettings.loadFailed');
      expect(save).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'settings.ghosts.remote.retry' })).toBeTruthy();
    });
  });
  it('preserves the native memory dependency between Cindy and agent memory', async () => {
    const { save } = setup();
    await screen.findByText('settings.memory.title');
    const memory = document.querySelector<HTMLElement>(
      '#settings-search-target-personalization-memory',
    )!;
    const switches = within(memory).getAllByRole('switch');
    expect(switches[1].matches(':disabled')).toBe(true);
    expect(switches[2].matches(':disabled')).toBe(true);
    fireEvent.click(switches[0]);
    await ready(switches[0]);
    await waitFor(() => expect(switches[1].matches(':disabled')).toBe(false));
    expect(switches[3].matches(':disabled')).toBe(true);
    expect(save.mock.calls[0][1]).toEqual({ maker: false });
    // Turning Cindy memory back on must not save the agent switches as customized.
    fireEvent.click(switches[1]);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await ready(switches[0]);
    fireEvent.click(switches[0]);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(3));
    // Back to the default it had before this page wrote it: the override is cleared, not rewritten.
    expect(save.mock.calls[2][1]).toEqual({});
    expect(save.mock.calls[2][2]).toEqual(['maker']);
    await ready(switches[0]);
    expect(switches[1].getAttribute('aria-checked')).toBe('false');
  });
  it('removes obsolete global compaction controls and reads only current domains', async () => {
    let read: MockInstance<CloudSettingsClient['read']>;
    setup((client) => {
      read = vi.spyOn(client, 'read');
    });
    await screen.findByText('settings.memory.title');
    expect(screen.queryByText('settings.compaction.title')).toBeNull();
    expect(read!.mock.calls.flat(2)).not.toContain('claudeCompaction');
    expect(read!.mock.calls.flat(2)).not.toContain('piCompaction');
  });
  it('shows an unavailable saved shell instead of an empty selection without changing it', async () => {
    const { save } = setup((client) => {
      const read = client.read;
      client.read = async (domains) =>
        (await read(domains)).map((s) =>
          s.domain === 'terminal'
            ? {
                ...s,
                value: { defaultShellPref: 'fish' },
                customizedKeys: ['defaultShellPref'],
                isCustomized: true,
              }
            : s,
        );
    });
    const shell = await screen.findByRole('combobox', {
      name: 'settings.terminalShell.card.selectAria',
    });
    await ready(shell);
    expect(shell.textContent).toContain('settings.terminalShell.unavailable');
    expect(save).not.toHaveBeenCalled();
  });
  // These only change the instance's own window.
  it('leaves instance-window-only preferences to the remote desktop', async () => {
    const { save } = setup();
    await screen.findByText('settings.memory.title');
    expect(screen.queryByRole('tab', { name: 'settings.tabs.appearance' })).toBeNull();
    for (const text of [
      'settings.linkOpen.title',
      'settings.promptRecommendation.label',
      'settings.messageNavRail.cell.label',
    ])
      expect(screen.queryByText(text)).toBeNull();
    await general();
    expect(screen.queryByText('settings.composer.title')).toBeNull();
    expect(
      screen.queryByRole('switch', { name: 'settings.notifications.sessionDoneAria' }),
    ).toBeNull();
    expect(screen.getByText('settings.language.title')).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });
  it('keeps controls absent when the cloud does not advertise desktop preferences', async () => {
    setup((client) => {
      const connect = client.connect;
      client.connect = async () => {
        const cap = await connect();
        return { ...cap, domains: cap.domains.filter((d) => d !== 'desktopGeneral') };
      };
    });
    await screen.findByText('settings.memory.title');
    await general();
    expect(screen.queryByText('settings.language.title')).toBeNull();
  });
  it('offers the newer display languages only when the instance lists them', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.releasePointerCapture = vi.fn();
    const menu = async () => {
      await general();
      fireEvent.keyDown(screen.getByRole('combobox', { name: 'settings.language.ariaLabel' }), {
        key: 'ArrowDown',
      });
      return screen.getAllByRole('option').map((option) => option.textContent);
    };
    setup();
    expect(await menu()).toEqual(
      ['system', 'en', 'zh-CN', 'zh-TW', 'ja', 'ko'].map((l) => `settings.language.options.${l}`),
    );
    cleanup();
    setup((client) => {
      const read = client.read;
      client.read = async (domains) =>
        (await read(domains)).map((s) =>
          s.domain === 'desktopGeneral'
            ? {
                ...s,
                choices: {
                  ...s.choices,
                  locale: SETTINGS_DISPLAY_LOCALES.map((value) => ({ value, label: value })),
                },
              }
            : s,
        );
    });
    expect((await menu()).slice(6)).toEqual(
      ['es', 'fr', 'de', 'pt-PT', 'pt-BR', 'classical'].map(
        (l) => `settings.language.options.${l}`,
      ),
    );
  });
  // The instance may use a display language outside the cloud wire.
  it('sends an unrepresentable instance language to the cloud desktop', async () => {
    setup((client) => {
      const read = client.read;
      client.read = async (domains) =>
        (await read(domains)).map((s) =>
          s.domain === 'desktopGeneral'
            ? { domain: 'desktopGeneral', status: 'unavailable', revision: null }
            : s,
        );
    });
    await screen.findByText('settings.memory.title');
    await general();
    const language = document.querySelector<HTMLElement>(
      '#settings-search-target-general-language',
    )!;
    expect(within(language).getByText('settings.language.title')).toBeTruthy();
    expect(
      within(language).getByRole('button', { name: 'cloudSettings.openInCloudDesktop' }),
    ).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'settings.language.ariaLabel' })).toBeNull();
    expect(screen.queryByText('cloudSettings.readFailed')).toBeNull();
  });
  // The page title lived only inside the prompt editor, so it vanished with the prompt.
  it('keeps the personalization title when the cloud does not report the prompt', async () => {
    setup((client) => {
      const connect = client.connect;
      client.connect = async () => {
        const cap = await connect();
        return { ...cap, domains: cap.domains.filter((d) => d !== 'personalization') };
      };
    });
    await screen.findByText('settings.memory.title');
    expect(screen.getAllByText('settings.personalization.title')).toHaveLength(1);
    expect(
      screen.queryByRole('textbox', { name: 'settings.personalization.ariaLabel' }),
    ).toBeNull();
  });
  it('shows the instance runtime version in About like the local app version', async () => {
    setup();
    cleanup();
    render(
      <CloudSettingsPanel
        name="Cloud trial"
        client={createTrialCloudSettingsClient()}
        online
        trial
        version="0.1.120-cloud.1-cn-amd64"
        onBack={vi.fn()}
        visibility={CLOUD_SETTINGS_ALL_SECTIONS}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'settings.tabs.about' }));
    await screen.findByText('settings.about.appVersionLabel');
    // An info row is a SettingsRow: the value sits in the row's trailing slot.
    expect(screen.getByText('0.1.120-cloud.1-cn-amd64')).toBeTruthy();
  });
  it('removes cached controls when the cloud withdraws a capability', async () => {
    let supported = true;
    const { save } = setup((client) => {
      const connect = client.connect;
      client.connect = async () => {
        const cap = await connect();
        return { ...cap, domains: cap.domains.filter((d) => supported || d !== 'terminal') };
      };
    });
    await screen.findByText('settings.terminalShell.title');
    supported = false;
    // Coming back to the window reads again.
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(screen.queryByText('settings.terminalShell.title')).toBeNull());
    expect(save).not.toHaveBeenCalled();
  });
  // Without a plugin page (a browser), the category is not a dead end.
  it('opens the cloud desktop for plugins when the page cannot manage them', async () => {
    setup();
    await screen.findByText('settings.memory.title');
    fireEvent.click(screen.getByRole('tab', { name: 'settings.tabs.ghosts' }));
    expect(
      await screen.findByRole('button', { name: 'cloudSettings.openInCloudDesktop' }),
    ).toBeTruthy();
  });
  // The native client supplies its plugin page for the instance; a browser supplies none.
  it('shows the supplied plugin page instead of the cloud desktop entry', async () => {
    const client = createTrialCloudSettingsClient();
    const plugins = vi.fn((active: boolean) => <p data-testid="plugins">{String(active)}</p>);
    render(
      <CloudSettingsPanel
        name="Cloud trial"
        client={client}
        online
        trial
        onBack={vi.fn()}
        plugins={plugins}
      />,
    );
    expect(screen.getByTestId('plugins').textContent).toBe('false');
    fireEvent.click(screen.getByRole('tab', { name: 'settings.tabs.ghosts' }));
    await waitFor(() => expect(screen.getByTestId('plugins').textContent).toBe('true'));
    expect(screen.queryByRole('button', { name: 'cloudSettings.openInCloudDesktop' })).toBeNull();
    // The page scrolls inside itself, as the local Plugins tab does.
    expect(document.querySelector('#settings-panel-ghosts')!.className).toContain('flex-1');
  });
  it('filters automation search by the individual capability', () => {
    for (const [id, domain] of [
      ['settings.computerUse.browser.title', 'browserTools'],
      ['settings.computerUse.directControl.title', 'computerTools'],
    ] as const) {
      const entry = SETTINGS_SEARCH_ENTRIES.find((e) => e.id === id)!;
      expect(cloudSearchEntryAllowed(entry, [domain], false)).toBe(true);
      expect(
        cloudSearchEntryAllowed(
          entry,
          [domain === 'browserTools' ? 'computerTools' : 'browserTools'],
          false,
        ),
      ).toBe(false);
    }
  });
  // Searching 提示词 must find the prompt. A real instance answers the prompt over
  // DeviceLink, so its open never lists the personalization domain; the entry needs no domain there.
  it('finds the personal instructions on a real instance, where the prompt has no CIS domain', () => {
    for (const id of ['personalization.userPrompt', 'personalization.instructions']) {
      const entry = SETTINGS_SEARCH_ENTRIES.find((e) => e.id === id)!;
      expect(cloudSearchEntryAllowed(entry, ['memory', 'subagentModel'], false), id).toBe(true);
      // The trial reports the prompt as a CIS group, and shows it only when it does.
      expect(cloudSearchEntryAllowed(entry, ['memory'], true), id).toBe(false);
      expect(cloudSearchEntryAllowed(entry, ['personalization'], true), id).toBe(true);
    }
  });
  it('uses native search and filters unsupported local-only entries without removing navigation', async () => {
    setup();
    await screen.findByRole('textbox', { name: 'settings.personalization.ariaLabel' });
    const search = screen.getByRole('combobox', { name: 'settings.search.ariaLabel' });
    fireEvent.change(search, { target: { value: 'shortcuts' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.queryByRole('tab', { name: 'settings.tabs.appearance' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'settings.tabs.providers' })).toBeTruthy();
    const allowed = SETTINGS_SEARCH_ENTRIES.filter((e) =>
      cloudSearchEntryAllowed(e, [...CLOUD_SETTINGS_DOMAINS], false),
    );
    expect(allowed.some((e) => e.id === 'settings.agentResource.preset')).toBe(true);
    expect(allowed.some((e) => e.id === 'general.language')).toBe(true);
    // A cloud instance cannot reach the user's Android devices: no ADB entry or domain.
    expect(CLOUD_SETTINGS_DOMAINS).not.toContain('androidTools');
    expect(allowed.some((e) => e.tab === 'computer-use' && /android/i.test(e.id))).toBe(false);
    expect(allowed.some((e) => e.id === 'settings.about.analyticsLabel')).toBe(true);
    // Device setup, files and settings that only change the instance's own window are not
    // target settings.
    for (const denied of [
      'general.appearance',
      'general.notifications',
      'general.composer',
      'settings.composer.sendShortcut.label',
      'personalization.linkOpen',
      'settings.promptRecommendation.label',
      'settings.appearance.themeLabel',
      'settings.appearance.font.uiSize.label',
      'appearance.streamFade',
      'settings.computerUse.android.adb.title',
      'settings.appearance.wallpaper.title',
      'settings.appearance.localThemes.title',
      'settings.appearance.font.terminalFamily.label',
      'settings.about.storage.cleanupLabel',
    ])
      expect(
        allowed.some((e) => e.id === denied),
        denied,
      ).toBe(false);
  });
  it('does not write any settings just by opening every supported category', async () => {
    const { save } = setup();
    await screen.findByRole('textbox', { name: 'settings.personalization.ariaLabel' });
    for (const tab of screen.getAllByRole('tab')) {
      fireEvent.click(tab);
      await waitFor(() => expect(screen.queryByText('settings.ghosts.remote.configurationLoading')).toBeNull());
    }
    expect(save).not.toHaveBeenCalled();
  });
});
describe('cloud settings page chrome', () => {
  const panel = (props: { online: boolean; connecting?: boolean }, client = bare()) =>
    render(<CloudSettingsPanel name="Cloud A" client={client} onBack={vi.fn()} {...props} />);
  // No instance overview: the page opens on the first settings category.
  const bare = () => {
    const client = createTrialCloudSettingsClient();
    delete (client as Partial<CloudSettingsClient>).instance;
    return client;
  };
  // The page's 「正在管理」 notice says what it is doing.
  it('says it is loading until the instance has been read, and offline only after that', () => {
    const first = panel({ online: false, connecting: true });
    expect(screen.getByText('settings.ghosts.remote.configurationLoading')).toBeTruthy();
    expect(screen.queryByText('settings.ghosts.remote.offlineNotice')).toBeNull();
    first.unmount();
    panel({ online: false });
    expect(screen.getByText('settings.ghosts.remote.offlineNotice')).toBeTruthy();
    expect(screen.queryByText('settings.ghosts.remote.configurationLoading')).toBeNull();
  });
  it('keeps the provider and IM categories in place before the instance answers', () => {
    panel({ online: false, connecting: true });
    expect(screen.getByRole('tab', { name: 'settings.tabs.providers' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'settings.tabs.imBot' })).toBeTruthy();
  });
  it('drops a category once the instance says it cannot manage it', async () => {
    const client = bare();
    const connect = client.connect.bind(client);
    vi.spyOn(client, 'connect').mockImplementation(async () => {
      const capabilities = await connect();
      delete capabilities.providerAuthorization;
      delete capabilities.botAuthorization;
      return capabilities;
    });
    panel({ online: true }, client);
    await waitFor(() =>
      expect(screen.queryByRole('tab', { name: 'settings.tabs.providers' })).toBeNull(),
    );
    expect(screen.queryByRole('tab', { name: 'settings.tabs.imBot' })).toBeNull();
  });
});
// Every supported category, in the local page's order, then More settings. The overview lives on
// the device card.
describe('the shown cloud settings', () => {
  const SHOWN = [
    'settings.tabs.general',
    'settings.tabs.personalization',
    'settings.tabs.providers',
    'settings.tabs.imBot',
    'settings.tabs.ghosts',
    'settings.tabs.builtinTools',
    'settings.tabs.computerUse',
    'settings.tabs.storage',
    'settings.tabs.about',
  ];
  const tabNames = () => screen.getAllByRole('tab').map((tab) => tab.textContent);
  const selected = (name: string) =>
    screen.getByRole('tab', { name }).getAttribute('aria-selected');
  const readDomains = (client: CloudSettingsClient) => {
    const read = vi.spyOn(client, 'read');
    return () => read.mock.calls.flatMap(([domains]) => domains);
  };
  const renderShown = (client = createTrialCloudSettingsClient(), initialTab?: 'providers') => {
    Object.assign(window, { electronAPI: {} });
    render(
      <CloudSettingsPanel
        name="Cloud trial"
        client={client}
        online
        trial
        onBack={vi.fn()}
        initialTab={initialTab}
      />,
    );
  };
  it('lists every supported category in the local order, then More settings, and opens General', async () => {
    renderShown();
    expect(tabNames()).toEqual([...SHOWN, 'cloudSettings.moreSettings']);
    expect(screen.queryByRole('button', { name: 'cloudSettings.instance.title' })).toBeNull();
    expect(selected('settings.tabs.general')).toBe('true');
    await waitFor(() => expect(screen.queryByText('settings.ghosts.remote.configurationLoading')).toBeNull());
  });
  it('moves off model providers when the instance does not offer them', async () => {
    const client = createTrialCloudSettingsClient();
    const connect = client.connect;
    client.connect = async () => ({ ...(await connect()), providerAuthorization: undefined });
    renderShown(client, 'providers');
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'settings.tabs.providers' })).toBeNull());
    await waitFor(() => expect(selected('settings.tabs.general')).toBe('true'));
  });
  // There is no global teammate model chain editor, so General does not show it.
  it('shows each category whole and reads only the open one, without the removed teammate model chain', async () => {
    const client = createTrialCloudSettingsClient();
    const domains = readDomains(client);
    const save = vi.spyOn(client, 'save');
    renderShown(client);
    for (const id of ['settings-collaboration', 'settings-agent-resource'])
      await waitFor(() => expect(document.querySelector(`#settings-panel-general #${id}`), id).toBeTruthy());
    expect(document.querySelector('#settings-bots')).toBeNull();
    expect(new Set(domains())).toEqual(new Set(CLOUD_SETTINGS_GROUPS.general));
    fireEvent.click(screen.getByRole('tab', { name: 'settings.tabs.personalization' }));
    await screen.findByText('settings.memory.title');
    for (const shown of [
      'settings-search-target-personalization-subagents',
      'settings-search-target-personalization-auxiliary-models',
      'settings-search-target-personalization-terminal-shell',
      'settings-search-target-personalization-tips',
    ])
      expect(document.querySelector(`#settings-panel-personalization #${shown}`), shown).toBeTruthy();
    expect(document.querySelector('#settings-panel-personalization #settings-bots')).toBeNull();
    expect(new Set(domains())).toEqual(
      new Set([...CLOUD_SETTINGS_GROUPS.general, ...CLOUD_SETTINGS_GROUPS.personalization]),
    );
    expect(save).not.toHaveBeenCalled();
  });
  it('hides the agent memory rows without touching their saved values', async () => {
    const { save } = setup(undefined, { ...CLOUD_SETTINGS_VISIBILITY, memoryAgentRows: false });
    await screen.findByText('settings.memory.title');
    const memory = document.querySelector<HTMLElement>(
      '#settings-search-target-personalization-memory',
    )!;
    const [maker, ...agents] = within(memory).getAllByRole('switch');
    expect(agents).toHaveLength(0);
    await ready(maker);
    fireEvent.click(maker);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][1]).toEqual({ maker: false });
    expect(save.mock.calls[0][2]).toBeUndefined();
  });
  it('sends everything else to the cloud desktop from More settings', async () => {
    const openRemoteDesktop = vi.fn(async () => undefined);
    Object.assign(window, { electronAPI: { openRemoteDesktop } });
    render(
      <CloudSettingsPanel
        name="Cloud trial"
        client={createTrialCloudSettingsClient()}
        online
        trial
        onBack={vi.fn()}
        initialTab="more"
      />,
    );
    const open = await screen.findByRole('button', { name: 'cloudSettings.openInCloudDesktop' });
    await ready(open);
    expect(screen.getByText('cloudSettings.moreSettingsFallback')).toBeTruthy();
    fireEvent.click(open);
    expect(openRemoteDesktop).toHaveBeenCalledWith({
      deviceId: 'cloud-settings-trial',
      name: 'Cloud trial',
    });
  });
  it('points an unreachable instance at its device card instead of an empty page', async () => {
    const onOpenDeviceCard = vi.fn();
    Object.assign(window, { electronAPI: {} });
    const client = createTrialCloudSettingsClient();
    const connect = vi.spyOn(client, 'connect');
    render(
      <CloudSettingsPanel
        name="Cloud trial"
        client={client}
        online={false}
        onBack={vi.fn()}
        onOpenDeviceCard={onOpenDeviceCard}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'settings.tabs.remoteControl' }));
    await waitFor(() => expect(onOpenDeviceCard).toHaveBeenCalledOnce());
    expect(screen.getByText('settings.ghosts.remote.offlineNotice')).toBeTruthy();
    expect(connect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: 'cloudSettings.moreSettings' }));
    expect(
      screen.getByRole('button', { name: 'cloudSettings.openInCloudDesktop' }).matches(':disabled'),
    ).toBe(true);
  });
  it('lands old links on the closest shown category', () => {
    const land = (tab: string | null) => cloudTabFromLink(CLOUD_SETTINGS_VISIBILITY, tab);
    expect(land(null)).toBeUndefined();
    // General is shown again: its links stay there instead of going to personalization.
    for (const tab of ['general', 'personalization', 'providers', 'im-bot', 'builtin-tools', 'computer-use', 'storage', 'about'])
      expect(land(tab), tab).toBe(tab);
    for (const tab of ['appearance', 'shortcuts', 'remote-control']) expect(land(tab), tab).toBe('more');
    expect(land('ghosts')).toBe('ghosts');
    expect(land('not-a-category')).toBeUndefined();
    const toCard = (tab: string | null, section: string | null = null) =>
      cloudLinkOpensDeviceCard(CLOUD_SETTINGS_VISIBILITY, tab, section);
    expect(toCard('instance')).toBe(true);
    expect(toCard(null, 'maintenance')).toBe(true);
    expect(toCard('general', 'maintenance')).toBe(true);
    expect(toCard('general')).toBe(false);
  });
  it('searches only what is shown and opens a General result in General', async () => {
    setup(undefined, CLOUD_SETTINGS_VISIBILITY);
    // The section target scrolls to and marks the setting once its category is open.
    Object.assign(window, { matchMedia: () => ({ matches: true }) });
    HTMLElement.prototype.scrollTo = vi.fn();
    // Search lands only on a target that is laid out (useSettingsSectionTarget); jsdom lays out
    // nothing, so a shown element gets a box, as in settingsSearchNavigation.test.tsx.
    const rects = vi
      .spyOn(HTMLElement.prototype, 'getClientRects')
      .mockImplementation(function (this: HTMLElement) {
        const list = this.closest('[hidden]') ? [] : [{} as DOMRect];
        return Object.assign(list, { item: (index: number) => list[index] ?? null }) as DOMRectList;
      });
    onTestFinished(() => rects.mockRestore());
    await screen.findByText('settings.memory.title');
    fireEvent.click(screen.getByRole('tab', { name: 'cloudSettings.moreSettings' }));
    const search = screen.getByRole('combobox', { name: 'settings.search.ariaLabel' });
    const options = (titleKey: string) => {
      expect(
        SETTINGS_SEARCH_ENTRIES.some((entry) => entry.titleKey === titleKey),
        titleKey,
      ).toBe(true);
      fireEvent.change(search, { target: { value: `text ${titleKey}` } });
      return screen.queryAllByRole('option');
    };
    for (const hidden of [
      'settings.appearance.font.title',
      'settings.remoteControl.sections.ssh',
    ])
      expect(options(hidden), hidden).toHaveLength(0);
    // Shown categories are found.
    for (const shown of [
      'settings.sections.collaboration',
      'settings.about.analyticsLabel',
      'settings.computerUse.browser.title',
    ])
      expect(options(shown).length, shown).toBeGreaterThan(0);
    expect(options('settings.sections.bots')).toHaveLength(0);
    const results = options('settings.sections.collaboration');
    fireEvent.click(results[0]);
    await waitFor(() => expect(selected('settings.tabs.general')).toBe('true'));
  });
});

// A cloud change never locks the page: each change shows at once and syncs in the background;
// failures fall back to the instance. A setting changed and changed back stays an explicit value,
// as on this computer, so every cloud group that can be customized needs the local reset. Through
// the real page: change → "customized" → reset → the instance stores no key for it again.
describe('restoring defaults on the instance', () => {
  const restore = 'settings.defaults.restore';
  // The control's own row: the nearest ancestor that holds a reset button.
  const rowOf = (control: HTMLElement) => {
    let row: HTMLElement | null = control;
    while (row && !within(row).queryByRole('button', { name: restore })) row = row.parentElement;
    return row!;
  };
  const cases: Array<
    [string, string, CloudSettingsDomain, () => Promise<HTMLElement>, (control: HTMLElement) => void]
  > = [
    ['LSP', 'settings.tabs.general', 'lsp', () => screen.findByRole('switch', { name: 'settings.lspMode.toggleAria' }), fireEvent.click],
    ['Worker hard limit', 'settings.tabs.general', 'collaboration',
      async () => (await screen.findAllByRole('spinbutton')).find((input) => input.closest('#settings-collaboration'))!,
      (input) => fireEvent.change(input, { target: { value: '9' } })],
    ['browser automation', 'settings.tabs.computerUse', 'browserTools', () => screen.findByRole('switch', { name: 'settings.computerUse.browser.toggleAria' }), fireEvent.click],
    ['browser target', 'settings.tabs.computerUse', 'browserBackend',
      async () => within(await screen.findByRole('radiogroup', { name: 'settings.computerUse.browserBackend.title' })).getAllByRole('radio').find((radio) => radio.getAttribute('aria-checked') === 'false')!,
      fireEvent.click],
    ['direct control', 'settings.tabs.computerUse', 'computerTools', () => screen.findByRole('switch', { name: 'settings.computerUse.directControl.toggleAria' }), fireEvent.click],
    ['document tools', 'settings.tabs.builtinTools', 'builtinTools',
      // Rows follow the page's order: browser first, then the instance's built-in tools.
      async () => (await screen.findAllByRole('switch', { name: 'settings.builtinTools.toggleAria' }))[
        ['browser', 'feishu_bot', 'wechat', 'slack', 'ssh', 'docs'].indexOf('docs')
      ]!,
      fireEvent.click],
    // "Do not remind" (databaseWarning) already had its reset; the trial instance cannot save that group.
    ['usage statistics', 'settings.tabs.about', 'privacy', () => screen.findByRole('switch', { name: 'settings.about.analyticsLabel' }), fireEvent.click],
    ['debug log', 'settings.tabs.about', 'desktopNotifications', () => screen.findByRole('switch', { name: 'settings.about.debugLogLabel' }), fireEvent.click],
    ['crash upload', 'settings.tabs.about', 'diagnostics', () => screen.findByRole('switch', { name: 'settings.about.logUpload.crashAutoLabel' }), fireEvent.click],
    ['memory', 'settings.tabs.personalization', 'memory',
      async () => {
        await screen.findByText('settings.memory.title');
        return within(document.querySelector<HTMLElement>('#settings-search-target-personalization-memory')!).getAllByRole('switch')[0]!;
      },
      fireEvent.click],
  ];
  it.each(cases)('%s', async (_name, tab, domain, find, change) => {
    const { client, save } = setup();
    fireEvent.click(screen.getByRole('tab', { name: tab }));
    const control = await find();
    await ready(control);
    change(control);
    if (control.matches('input')) fireEvent.blur(control);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const row = await waitFor(() => rowOf(control));
    await waitFor(() => expect(within(row).getByRole<HTMLButtonElement>('button', { name: restore }).disabled).toBe(false));
    fireEvent.click(within(row).getByRole('button', { name: restore }));
    await waitFor(async () => {
      const [stored] = await client.read([domain]);
      expect(stored?.customizedKeys).toEqual([]);
    });
  });
});

describe('optimistic cloud writes', () => {
  beforeEach(() => vi.mocked(toast.error).mockClear());
  const memory = async () => {
    await screen.findByText('settings.memory.title');
    const section = document.querySelector<HTMLElement>(
      '#settings-search-target-personalization-memory',
    )!;
    const maker = within(section).getAllByRole('switch')[0];
    await ready(maker);
    return maker;
  };
  const failure = () => vi.mocked(toast.error).mock.calls.at(-1);
  it('shows the new value at once and keeps the control usable while the instance confirms', async () => {
    const { save, original } = setup();
    const maker = await memory();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    save.mockImplementationOnce((...args) => gate.then(() => original(...args)));
    fireEvent.click(maker);
    expect(maker.getAttribute('aria-checked')).toBe('false');
    expect(maker.matches(':disabled')).toBe(false);
    release();
    await waitFor(() => expect(save.mock.results[0]?.type).toBe('return'));
    expect(save).toHaveBeenCalledTimes(1);
    expect(maker.getAttribute('aria-checked')).toBe('false');
    expect(toast.error).not.toHaveBeenCalled();
  });
  // As the client's settings: a change that did not save says so in a toast without a
  // button, and the control shows what the instance holds.
  it('reverts a refused change and shows the latest value, without a retry', async () => {
    const { save } = setup();
    const maker = await memory();
    save.mockRejectedValueOnce(Error('CLOUD_SETTINGS_REJECTED'));
    fireEvent.click(maker);
    await waitFor(() => expect(failure()?.[0]).toBe('cloudSettings.sync.rejected'));
    expect(failure()?.[1]).toBeUndefined();
    expect(maker.getAttribute('aria-checked')).toBe('true');
    expect(save).toHaveBeenCalledTimes(1);
  });
  it('reverts a change that did not reach the instance, without sending it again or a retry', async () => {
    const { save } = setup();
    const maker = await memory();
    save.mockRejectedValueOnce(Error('CLOUD_SETTINGS_BUSY'));
    fireEvent.click(maker);
    await waitFor(() => expect(failure()?.[0]).toBe('cloudSettings.sync.unavailable'));
    expect(failure()?.[1]?.action).toBeUndefined();
    expect(maker.getAttribute('aria-checked')).toBe('true');
    expect(save).toHaveBeenCalledTimes(1);
  });
  it('rereads an unconfirmed write instead of sending it again', async () => {
    let read!: MockInstance<CloudSettingsClient['read']>;
    const { save, original } = setup((client) => {
      read = vi.spyOn(client, 'read');
    });
    const maker = await memory();
    save.mockRejectedValueOnce(Error('CLOUD_SETTINGS_SAVE_UNCONFIRMED'));
    read.mockClear();
    fireEvent.click(maker);
    await waitFor(() => expect(failure()?.[0]).toBe('cloudSettings.sync.notSaved'));
    expect(read).toHaveBeenCalledWith(['memory']);
    expect(maker.getAttribute('aria-checked')).toBe('true');
    // The same outcome after the write did land: the instance value is kept, nothing to say.
    vi.mocked(toast.error).mockClear();
    save.mockImplementationOnce(async (...args) => {
      await original(...args);
      throw Error('CLOUD_SETTINGS_SAVE_UNCONFIRMED');
    });
    fireEvent.click(maker);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(maker.getAttribute('aria-checked')).toBe('false'));
    expect(save).toHaveBeenCalledTimes(2);
    expect(toast.error).not.toHaveBeenCalled();
  });
  // A number changed just before leaving is saved, not dropped:
  // one write with the latest value, sent at once, and the session closes after it.
  it('saves a stepper change made right before leaving the page, once, with the latest value', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    onTestFinished(() => void vi.useRealTimers());
    const { client, save } = setup();
    const close = vi.spyOn(client, 'close');
    const input = await general();
    for (const value of ['6', '7']) {
      fireEvent.change(input, { target: { value } });
      fireEvent.blur(input);
    }
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'settings.back' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][1]).toEqual({ maxConcurrentCommands: 7 });
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(close.mock.invocationCallOrder[0]).toBeGreaterThan(save.mock.invocationCallOrder[0]);
    // The debounce that was waiting does not send it a second time.
    await vi.advanceTimersByTimeAsync(CLOUD_SYNC_DEBOUNCE_MS * 2);
    expect(save).toHaveBeenCalledTimes(1);
  });
  // Three quick ↑ presses on the Worker hard limit add 3: a save must not disable the page, or the
  // focused field loses focus and the next presses go nowhere.
  it('keeps a stepper focused and mounted through quick ↑ presses, in at most two writes', async () => {
    const user = userEvent.setup();
    const { save } = setup();
    await general();
    const field = () =>
      document.querySelector<HTMLInputElement>(
        '[data-setting-id="settings.collaboration.workerHardLimit"] input, input[data-setting-id="settings.collaboration.workerHardLimit"]',
      )!;
    await waitFor(() => expect(field()).toBeTruthy());
    const input = field();
    const before = Number(input.value);
    await user.click(input);
    for (let press = 1; press <= 3; press++) {
      // jsdom does not step number fields on ↑; do what the browser does: step, then input.
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
      (document.activeElement as HTMLInputElement).stepUp();
      fireEvent.change(document.activeElement!, {
        target: { value: (document.activeElement as HTMLInputElement).value },
      });
      // Shown at once, before the instance answers.
      expect(field().value).toBe(String(before + press));
    }
    await waitFor(() => expect(save).toHaveBeenCalled());
    await waitFor(() => expect(save.mock.results.every((r) => r.type === 'return')).toBe(true));
    expect(save.mock.calls.length).toBeLessThanOrEqual(2);
    expect(save.mock.calls.at(-1)![1]).toEqual({ workerHardLimit: before + 3 });
    // The same element, still focused: nothing was remounted or disabled on the way.
    expect(field()).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe(String(before + 3));
  });
  it('shows the instance value after a revision conflict', async () => {
    const { client, save, original } = setup();
    const maker = await memory();
    // Someone else changed the group after this page read it.
    const [stale] = await client.read(['memory']);
    await original(stale, { pi: false });
    fireEvent.click(maker);
    await waitFor(() => expect(failure()?.[0]).toBe('cloudSettings.sync.conflict'));
    // A retry would write over the other change.
    expect(failure()?.[1]).toBeUndefined();
    expect(save).toHaveBeenCalledTimes(1);
    const section = maker.closest('section')!;
    await waitFor(() =>
      expect(within(section).getAllByRole('switch')[3].getAttribute('aria-checked')).toBe('false'),
    );
    expect(maker.getAttribute('aria-checked')).toBe('true');
  });
});

// No reload button on the page. A failed read rebuilds the session on its own;
// only when that keeps failing does a notice with a reload appear.
describe('reading after the session broke', () => {
  // A test above leaves a matchMedia without listeners; model providers subscribe to it.
  beforeEach(() => {
    Object.assign(window, {
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    });
  });
  const allTabs = async () => {
    for (const tab of screen.getAllByRole('tab')) {
      fireEvent.click(tab);
      await waitFor(() => expect(screen.queryByText('settings.ghosts.remote.configurationLoading')).toBeNull());
    }
  };
  it('shows no reload button anywhere while reading works', async () => {
    setup();
    await screen.findByText('settings.memory.title');
    await allTabs();
    expect(screen.queryByRole('button', { name: 'settings.ghosts.remote.retry' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'commonUi.retry' })).toBeNull();
  });
  it('reconnects on its own and reads again, with nothing to press', async () => {
    let read!: MockInstance<CloudSettingsClient['read']>;
    let reconnect!: MockInstance<CloudSettingsClient['reconnect']>;
    setup((client) => {
      read = vi.spyOn(client, 'read');
      reconnect = vi.spyOn(client, 'reconnect');
    });
    await screen.findByText('settings.memory.title');
    read.mockRejectedValueOnce(Error('CLOUD_SETTINGS_SCOPE_CHANGED'));
    fireEvent.click(screen.getByRole('tab', { name: 'settings.tabs.general' }));
    await waitFor(() => expect(reconnect).toHaveBeenCalledTimes(1));
    await screen.findByText('settings.agentResource.title');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'settings.ghosts.remote.retry' })).toBeNull();
  });
  it('shows the read failure notice once three reconnects have failed, and reloads from it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    onTestFinished(() => void vi.useRealTimers());
    let read!: MockInstance<CloudSettingsClient['read']>;
    let reconnect!: MockInstance<CloudSettingsClient['reconnect']>;
    setup((client) => {
      read = vi.spyOn(client, 'read');
      reconnect = vi.spyOn(client, 'reconnect');
    }, undefined, false);
    await screen.findByText('settings.memory.title');
    read.mockRejectedValue(Error('CLOUD_SETTINGS_SCOPE_CHANGED'));
    fireEvent.click(screen.getByRole('tab', { name: 'settings.tabs.general' }));
    // In the page's 「正在管理」 notice, with its retry.
    const notice = () => screen.queryByText('bots.remoteSettings.loadFailed');
    for (let second = 0; second < 30 && !notice(); second++) {
      // Not before the last reconnect has failed too.
      expect(reconnect.mock.calls.length).toBeLessThanOrEqual(CLOUD_RECONNECT_DELAYS_MS.length);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(notice()).toBeTruthy();
    expect(reconnect).toHaveBeenCalledTimes(CLOUD_RECONNECT_DELAYS_MS.length);
    // The code is in the details, folded.
    expect(screen.queryByText('CLOUD_SETTINGS_SCOPE_CHANGED')).toBeNull();
    read.mockRestore();
    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.remote.retry' }));
    await waitFor(() => expect(reconnect).toHaveBeenCalledTimes(CLOUD_RECONNECT_DELAYS_MS.length + 1));
    await waitFor(() => expect(screen.queryByText('bots.remoteSettings.loadFailed')).toBeNull());
    await screen.findByText('settings.agentResource.title');
  });
  it('does not reconnect while a write is in flight', async () => {
    let read!: MockInstance<CloudSettingsClient['read']>;
    let reconnect!: MockInstance<CloudSettingsClient['reconnect']>;
    const { save, original } = setup((client) => {
      read = vi.spyOn(client, 'read');
      reconnect = vi.spyOn(client, 'reconnect');
    });
    await screen.findByText('settings.memory.title');
    const section = document.querySelector<HTMLElement>('#settings-search-target-personalization-memory')!;
    const maker = within(section).getAllByRole('switch')[0]!;
    await ready(maker);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    save.mockImplementationOnce((...args) => gate.then(() => original(...args)));
    fireEvent.click(maker);
    read.mockRejectedValueOnce(Error('CLOUD_SETTINGS_SCOPE_CHANGED'));
    const reads = read.mock.calls.length;
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(reads));
    await expect(read.mock.results[reads]!.value).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reconnect).not.toHaveBeenCalled();
    release();
    await waitFor(() => expect(reconnect).toHaveBeenCalledTimes(1));
    expect(reconnect.mock.invocationCallOrder[0]).toBeGreaterThan(save.mock.invocationCallOrder[0]!);
  });
  // "Reading…" never stays on top of content already shown.
  it('says it is reading only before anything has been shown', async () => {
    setup();
    await screen.findByText('settings.memory.title');
    for (const tab of ['settings.tabs.general', 'settings.tabs.about', 'settings.tabs.personalization']) {
      fireEvent.click(screen.getByRole('tab', { name: tab }));
      expect(screen.queryByText('settings.ghosts.remote.configurationLoading')).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.queryByText('settings.ghosts.remote.configurationLoading')).toBeNull();
    }
  });
});

// A group or list the instance does not answer is read again on its own, three times; only then
// does it say so. Reading only, never writing. A settings group says so in its heading row; a list
// keeps its notice.
describe('a part of the page that cannot be read', () => {
  beforeEach(() => {
    Object.assign(window, {
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    onTestFinished(() => void vi.useRealTimers());
  });
  // In the group's heading row, named as on the page.
  const NOTICE = 'cloudSettings.groupReadFailed settings.agentResource.title';
  /** Runs the automatic tries until the notice shows (or 30 s), checking it waits for all three. */
  const untilNotice = async (title: string, tries: () => number) => {
    for (let second = 0; second < 30 && !screen.queryByText(title); second++) {
      expect(tries()).toBeLessThanOrEqual(CLOUD_RECONNECT_DELAYS_MS.length);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(screen.getByText(title)).toBeTruthy();
    expect(tries()).toBe(CLOUD_RECONNECT_DELAYS_MS.length);
  };
  // agentResource answers "unreadable" while `broken` says so; reads of it alone are counted.
  const unreadableGroup = (broken: () => boolean, trial = true) => {
    let alone = 0;
    const { client, save } = setup((c) => {
      const read = c.read.bind(c);
      c.read = async (domains) => {
        if (domains.length === 1 && domains[0] === 'agentResource') alone++;
        return (await read(domains)).map((state) =>
          state.domain === 'agentResource' && broken()
            ? {
                domain: 'agentResource',
                status: 'unreadable',
                revision: null,
                readErrorCode: 'SETTINGS_REQUEST_FAILED',
              }
            : state,
        );
      };
    }, undefined, trial);
    fireEvent.click(screen.getByRole('tab', { name: 'settings.tabs.general' }));
    return { client, save, alone: () => alone };
  };
  it('reads a group again on its own and says nothing once it comes back', async () => {
    let failures = 2;
    const { save, alone } = unreadableGroup(() => failures-- > 0);
    await screen.findByText('settings.agentResource.title', undefined, { timeout: 10_000 });
    expect(alone()).toBeGreaterThan(0);
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });
  it('says so in its heading row once three reads failed, and reloads only that group', async () => {
    let broken = true;
    const { save, alone } = unreadableGroup(() => broken);
    await untilNotice(NOTICE, alone);
    const status = screen.getByText(NOTICE).closest<HTMLElement>('[data-cloud-group-status]')!;
    // Only the failure and the retry: no explanation line falls back in.
    expect(within(status).queryByText(/Body$|ReloadReadsOnly$/)).toBeNull();
    // Where the group would be: after Collaboration, only its heading row and none of its controls.
    const place = status.closest<HTMLElement>('#settings-agent-resource-unreadable')!;
    expect(place.previousElementSibling?.id).toBe('settings-collaboration');
    expect(within(place).getByText('settings.agentResource.title')).toBeTruthy();
    expect(within(place).queryByRole('spinbutton')).toBeNull();
    expect(document.getElementById('settings-agent-resource')).toBeNull();
    broken = false;
    fireEvent.click(within(status).getByRole('button', { name: 'commonUi.retry' }));
    await screen.findByText('settings.agentResource.title');
    expect(alone()).toBe(CLOUD_RECONNECT_DELAYS_MS.length + 1);
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });
  it('leaves the notice to the page while the page itself cannot read', async () => {
    const { client, alone } = unreadableGroup(() => true, false);
    await untilNotice(NOTICE, alone);
    vi.spyOn(client, 'read').mockRejectedValue(Error('CLOUD_SETTINGS_SCOPE_CHANGED'));
    document.dispatchEvent(new Event('visibilitychange'));
    for (let second = 0; second < 30 && !screen.queryByText('bots.remoteSettings.loadFailed'); second++)
      await vi.advanceTimersByTimeAsync(1_000);
    expect(screen.getByText('bots.remoteSettings.loadFailed')).toBeTruthy();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
  it('names every group of a shared card in one notice above it', async () => {
    const broken = new Set(['privacy', 'diagnostics']);
    let alone = 0;
    setup((c) => {
      const read = c.read.bind(c);
      c.read = async (domains) => {
        if (domains.every((d) => broken.has(d))) alone++;
        return (await read(domains)).map((state) =>
          broken.has(state.domain)
            ? { domain: state.domain, status: 'unreadable', revision: null, readErrorCode: 'SETTINGS_REQUEST_FAILED' }
            : state,
        );
      };
    });
    fireEvent.click(screen.getByRole('tab', { name: 'settings.tabs.about' }));
    const title =
      'cloudSettings.groupReadFailed settings.about.analyticsLabelcloudSettings.groupNameSeparatorsettings.about.logUpload.crashAutoLabel';
    await untilNotice(title, () => alone);
    // The readable row stays; the unreadable rows are not shown with stale or default values.
    expect(screen.getByRole('switch', { name: 'settings.about.debugLogLabel' })).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'settings.about.analyticsLabel' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'settings.about.logUpload.crashAutoLabel' })).toBeNull();
  });
  it('gives two unreadable groups a notice each, in their own places', async () => {
    const broken = new Set(['collaboration', 'agentResource']);
    let alone = 0;
    setup((c) => {
      const read = c.read.bind(c);
      c.read = async (domains) => {
        if (domains.every((d) => broken.has(d))) alone++;
        return (await read(domains)).map((state) =>
          broken.has(state.domain)
            ? { domain: state.domain, status: 'unreadable', revision: null, readErrorCode: 'SETTINGS_REQUEST_FAILED' }
            : state,
        );
      };
    });
    fireEvent.click(screen.getByRole('tab', { name: 'settings.tabs.general' }));
    await untilNotice(NOTICE, () => alone);
    expect(screen.getByText('cloudSettings.groupReadFailed settings.sections.collaboration')).toBeTruthy();
    expect(document.getElementById('settings-collaboration')).toBeNull();
    expect(document.getElementById('settings-agent-resource')).toBeNull();
    expect(document.getElementById('settings-collaboration-unreadable')?.nextElementSibling?.id).toBe(
      'settings-agent-resource-unreadable',
    );
  });
  it.each([
    ['the IM bot authorization list', 'settings.tabs.imBot', 'cloudSettings.botsReadFailed', 'manage'],
  ] as const)('does the same for %s', async (_label, tab, title, method) => {
    let broken = true;
    let lists = 0;
    setup((c) => {
      const call = (c[method] as (command: { operation: string }) => Promise<unknown>).bind(c);
      Object.assign(c, {
        [method]: async (command: { operation: string; section?: string }) => {
          if (command.operation === 'list' && command.section === 'bots') {
            lists++;
            if (broken) throw Error('CLOUD_SETTINGS_UNAVAILABLE');
          }
          return call(command);
        },
      });
    });
    fireEvent.click(screen.getByRole('tab', { name: tab }));
    // The first read, then the automatic tries.
    const first = 1;
    await untilNotice(title, () => lists - first);
    const notice = screen.getByText(title).closest<HTMLElement>('[role="alert"]')!;
    broken = false;
    fireEvent.click(within(notice).getByRole('button', { name: 'cloudSettings.reload' }));
    await waitFor(() => expect(screen.queryByText(title)).toBeNull());
    expect(lists - first).toBe(CLOUD_RECONNECT_DELAYS_MS.length + 1);
  });
});
