// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ComposerPluginPalette, ContextSheetPlugins } from '@/session/ContextSheetPlugins';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';

const state = vi.hoisted(() => ({
  epoch: 1,
  accountGeneration: 1,
  openLink: vi.fn(async () => undefined),
  maker: { listComposerPlugins: vi.fn() },
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: state.accountGeneration }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ openLink: state.openLink, connectionEpoch: state.epoch }) }));
vi.mock('@/device-link/useMobileMakerTransport', () => ({ useMobileMakerTransport: () => state.maker }));
vi.mock('@/theme', () => ({
  fontWeight: { medium: '500' }, lineHeight: { body: 20, caption: 16 }, radius: { container: 12 }, spacing: { sm: 8, md: 12 }, typeScale: { body: 16, caption: 12 },
  iconSize: { lg: 20, md: 18 }, iconStroke: { regular: 1.5, bold: 2 },
  useTheme: () => ({ colors: { textPrimary: 'black', textSecondary: 'gray', textTertiary: 'silver', surfaceElevated: 'white', border: 'gray', surfaceChip: '#eee' } }),
  useThemedStyles: (factory: (colors: any) => any) => factory({ textPrimary: 'black', textSecondary: 'gray', textTertiary: 'silver', surfaceElevated: 'white', border: 'gray', surfaceChip: '#eee' }),
}));
vi.mock('@/components/AppText', () => ({ Text: ({ children, numberOfLines, ...props }: any) => <span {...props}>{children}</span> }));
vi.mock('react-native', () => ({
  ActivityIndicator: () => <span>loading</span>,
  Pressable: ({ children, onPress, testID, disabled }: any) => <button data-testid={testID} disabled={disabled} onClick={onPress}>{children}</button>,
  ScrollView: ({ children }: any) => <div>{children}</div>,
  StyleSheet: { create: (value: any) => value, hairlineWidth: 1 },
  View: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('expo-image', () => ({ Image: () => <span /> }));
vi.mock('lucide-react-native', () => ({ Plug: () => <span />, RotateCcw: () => <span /> }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/session/ContextSheet', () => ({
  ContextSheetGroup: ({ label, children }: any) => <section aria-label={label}>{children}</section>,
  ContextSheetRow: ({ disabled, busy, onPress, label, detail, trailing, testID, dismissBeforePress }: any) => (
    <button disabled={disabled || busy} onClick={onPress} data-testid={testID} data-dismiss={dismissBeforePress}>
      {label}<span>{detail}</span>{trailing}
    </button>
  ),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const art = { manifest: { id: 'art', name: 'Art', command: 'art' }, enabled: true };
let root: Root;
let host: HTMLDivElement;
let onOpen: ReturnType<typeof vi.fn>;
let onSelect: ReturnType<typeof vi.fn>;
const renderEntry = (disabled = false) => act(async () => root.render(
  <ContextSheetPlugins disabled={disabled} onOpen={onOpen} testID="plugins" />,
));
const renderPalette = (deviceId = 'host', enabled = true, draft = '$art', visible = enabled, workingDir = '/project') => act(async () => root.render(
  <ComposerPluginPalette deviceId={deviceId} workingDir={workingDir} enabled={enabled} visible={visible} draft={draft} onSelect={onSelect} testID="plugins" />,
));
beforeEach(() => {
  state.epoch = 1;
  state.accountGeneration = 1;
  setMobileAuthOwner('ui-test');
  state.openLink.mockClear();
  state.maker.listComposerPlugins.mockReset().mockResolvedValue([art]);
  onOpen = vi.fn();
  onSelect = vi.fn();
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

it('keeps the + sheet compact and opens the composer palette entry', async () => {
  await renderEntry();
  const row = host.querySelector('[data-testid="plugins.entry"]') as HTMLButtonElement;
  expect(row.textContent).toContain('session.common.plugins');
  expect(row.dataset.dismiss).toBe('true');
  act(() => row.click());
  expect(onOpen).toHaveBeenCalledOnce();
});

it('loads the list only while the palette is open and scopes it to the workdir', async () => {
  await renderPalette('host', false);
  expect(state.maker.listComposerPlugins).not.toHaveBeenCalled();
  await renderPalette();
  expect(state.maker.listComposerPlugins).toHaveBeenCalledExactlyOnceWith('/project');
  await renderPalette('host', false);
  await renderPalette();
  expect(state.maker.listComposerPlugins).toHaveBeenCalledTimes(2);
  state.epoch++;
  await renderPalette();
  expect(state.maker.listComposerPlugins).toHaveBeenCalledTimes(3);
});

it('preloads from the + sheet without rendering rows and opens the real list immediately', async () => {
  await renderPalette('host', true, '$', false);
  expect(host.textContent).toBe('');
  expect(state.maker.listComposerPlugins).toHaveBeenCalledExactlyOnceWith('/project');
  await renderPalette('host', true, '$', true);
  expect(host.textContent).toContain('Art');
  expect(host.textContent).not.toContain('pluginsLoading');
  expect(state.maker.listComposerPlugins).toHaveBeenCalledTimes(1);
});

it('keeps the last real list visible on reopening and replaces it with the fresh response', async () => {
  await renderPalette();
  await renderPalette('host', false);
  let resolve!: (value: unknown) => void;
  state.maker.listComposerPlugins.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  await renderPalette();
  expect(host.textContent).toContain('Art');
  expect(host.textContent).not.toContain('pluginsLoading');
  await act(async () => resolve([{ ...art, manifest: { id: 'new', name: 'New Plugin', command: 'art' } }]));
  expect(host.textContent).toContain('New Plugin');
  expect(host.querySelector('[data-testid="plugins.art"]')).toBeNull();
});

it.each(['device', 'workdir', 'connection', 'account'])('hides the previous list immediately when %s changes', async (change) => {
  await renderPalette();
  state.maker.listComposerPlugins.mockReturnValueOnce(new Promise(() => {}));
  if (change === 'connection') state.epoch++;
  if (change === 'account') {
    state.accountGeneration++;
    setMobileAuthOwner('other-account');
  }
  await renderPalette(change === 'device' ? 'other-host' : 'host', true, '$', true, change === 'workdir' ? '/other' : '/project');
  expect(host.textContent).not.toContain('Art');
  expect(host.textContent).toContain('pluginsLoading');
});

it('clears the retained list when refresh fails instead of leaving stale selections available', async () => {
  await renderPalette();
  await renderPalette('host', false);
  state.maker.listComposerPlugins.mockRejectedValueOnce(new Error('DEVICE_OFFLINE'));
  await renderPalette();
  expect(host.textContent).not.toContain('Art');
  expect(host.textContent).toContain('pluginsReload');
});

it('filters rows by the live $ query and selects an installed command', async () => {
  const roster = [art, { ...art, manifest: { id: 'other', name: 'Other', command: 'other' }, enabled: true }];
  state.maker.listComposerPlugins.mockResolvedValue(roster);
  await renderPalette('host', true, '$art');
  const row = host.querySelector('[data-testid="plugins.art"]') as HTMLButtonElement;
  expect(row.textContent).toContain('Art');
  expect(host.querySelector('[data-testid="plugins.other"]')).toBeNull();
  act(() => row.click());
  expect(onSelect).toHaveBeenCalledWith(art, roster);
});

it('offers retry and discards a late response after switching devices', async () => {
  state.maker.listComposerPlugins.mockRejectedValueOnce(new Error('CHANNEL_NOT_ALLOWED'));
  await renderPalette();
  expect(host.textContent).toContain('pluginsReload');
  await act(async () => (host.querySelector('[data-testid="plugins.retry"]') as HTMLButtonElement).click());
  expect(host.textContent).toContain('Art');

  let resolve!: (value: unknown) => void;
  state.maker.listComposerPlugins.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  await renderPalette('old-host');
  await renderPalette('new-host');
  await act(async () => resolve([{ ...art, manifest: { id: 'old', name: 'Old Host', command: 'old' } }]));
  expect(host.textContent).toContain('Art');
  expect(host.textContent).not.toContain('Old Host');
});
