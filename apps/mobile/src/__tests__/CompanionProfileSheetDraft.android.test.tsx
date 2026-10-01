// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  account: 1, sheet: {} as any, inputs: {} as Record<string, any>, buttons: {} as Record<string, any>, pressables: {} as Record<string, any>,
  alert: vi.fn(), read: vi.fn(), openLink: vi.fn(), invoke: vi.fn(), close: vi.fn(),
}));
vi.mock('react-native', async () => {
  const { createElement: el } = await import('react');
  return {
    Platform: { OS: 'android' }, StyleSheet: { create: (v: unknown) => v, hairlineWidth: 1 }, View: 'div', Alert: { alert: h.alert }, Image: 'img', ScrollView: 'div', Switch: () => null,
    ActivityIndicator: () => null,
    Pressable: (p: any) => {
      if (p.accessibilityLabel) h.pressables[p.accessibilityLabel] = p;
      if (p.testID) h.pressables[p.testID] = p;
      return el('div', null, typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
    },
  };
});
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-id' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('lucide-react-native', () => Object.fromEntries(['Brain','Camera','Check','ChevronRight','Clock3','FileText','Hand','History','Info','Link2','MessageCircle','Search','Settings2','Sparkles','UserRound'].map(key => [key, () => null])));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: h.account }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: h.invoke, openLink: h.openLink }) }));
vi.mock('@/device-link/remoteResources', () => ({ invokeRemoteResourceAction: (...args: unknown[]) => h.invoke(...args) }));
vi.mock('@/components/AppText', () => ({ Text: 'span', TextInput: (p: any) => { h.inputs[p.accessibilityLabel] = p; return null; } }));
vi.mock('@/components/MobilePrimitives', () => ({ MainWindowActionButton: (p: any) => { h.buttons[p.action.label] = p.action; return null; } }));
vi.mock('@/components/RemoteCompanionAvatar', () => ({ RemoteCompanionAvatar: () => null }));
vi.mock('@/platform/chrome', () => ({ NativePullDownMenu: () => null, usesNativePullDownMenu: () => false }));
vi.mock('@/session/CompanionSettingsRow', () => ({ CompanionSettingsRow: (p: any) => { if (p.testID) h.pressables[p.testID] = p; return null; } }));
vi.mock('@/session/CompanionSheet', async () => {
  const { createElement: el } = await import('react');
  return { CompanionSheet: (p: any) => { h.sheet = p; return el('div', null, p.children); } };
});
vi.mock('@/session/CompanionProfileArtifacts', () => ({ CompanionProfileArtifacts: () => null }));
vi.mock('@/theme', async () => ({ ...await import('@/theme/tokens'), useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}) }));
vi.mock('@/session/companionProfileData', async original => ({ ...await original<object>(), loadCompanionProfile: (...args: unknown[]) => h.read(...args) }));
// 伙伴设置页按 iOS 重组后新增的依赖(与 CompanionProfileSheet.android.test 同口径)。
vi.mock('@/session/CompanionChoice', () => ({ CompanionChoice: () => null }));
vi.mock('@/session/CompanionMemoryPage', () => ({ CompanionMemoryPage: () => null }));
vi.mock('@/session/useCompanionMemory', () => ({ useCompanionMemory: () => ({ busy: false, dirty: false, flush: async () => true, back: async () => false }) }));
vi.mock('@/session/CompanionPortraitPicker', async original => ({ ...await original<object>(), CompanionPortraitPicker: () => null }));
vi.mock('@/session/CompanionProfileNativeView', () => ({ CompanionProfileNativeView: () => { throw new Error('iOS view on Android'); } }));
vi.mock('@/session/CompanionCreateNativeView', () => ({ CompanionCreateNativeView: () => { throw new Error('iOS view on Android'); } }));
vi.mock('@/session/CompanionModelChain', () => ({ readCompanionModelChain: () => [], CompanionModelChain: () => null, CompanionModelPicker: () => null }));
import { CompanionProfileSheet } from '@/session/CompanionProfileSheet';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const resource = { ref: { collectionId: 'teammates', kind: 'bot', id: 'bot' }, display: { title: 'Cindy' }, links: [], revision: 'v1' };
const profilePanel = (disabled = false) => ({ id: 'profile', values: { name: 'Cindy' },
  action: { id: 'grant', label: 'Save', disabled, fields: [{ id: 'name', label: 'Name', kind: 'text' }] } });
let root: Root | undefined;
async function render(online = true) {
  root ??= createRoot(document.createElement('div'));
  await act(async () => root!.render(createElement(CompanionProfileSheet, { visible: true, resource, collectionId: 'teammates', deviceId: 'host', deviceName: 'Mac', online, onClose: h.close, onOpenSearch() {} } as any)));
}
async function openProfile() {
  // 与 iOS 相同,个人资料从首页「个人资料」行进入。
  await act(async () => h.pressables['companionProfile.profile'].onPress());
}
function alertButton(label: string) {
  const buttons = h.alert.mock.calls.at(-1)?.[2] as { text: string; onPress?: () => void }[];
  return buttons.find(button => button.text === label)!;
}
beforeEach(() => {
  vi.clearAllMocks(); h.inputs = {}; h.buttons = {}; h.pressables = {};
  h.read.mockResolvedValue({ resource, panels: [profilePanel()] });
  h.invoke.mockResolvedValue({ effects: [] });
});
afterEach(() => { act(() => root?.unmount()); root = undefined; });

it('keeps a host-disabled action read-only like iOS', async () => {
  h.read.mockResolvedValue({ resource, panels: [profilePanel(true)] });
  await render(); await openProfile();
  expect(h.inputs.Name.editable).toBe(false);
  expect(h.buttons['devices.companionProfile.save'].disabled).toBe(true);
});

it('asks to discard an offline draft on back instead of trapping the page', async () => {
  await render(); await openProfile();
  await act(async () => h.inputs.Name.onChangeText('Unsaved'));
  await render(false);
  await act(async () => h.sheet.onBack());
  expect(h.alert).toHaveBeenCalledOnce(); expect(h.invoke).not.toHaveBeenCalled();
  // Keep editing: the draft and page stay.
  alertButton('devices.common.cancel').onPress?.();
  expect(h.inputs.Name.value).toBe('Unsaved'); expect(h.sheet.onBack).toBeDefined();
  await act(async () => h.sheet.onBack());
  await act(async () => alertButton('devices.companions.automation.discard').onPress!());
  expect(h.sheet.onBack).toBeUndefined(); expect(h.close).not.toHaveBeenCalled();
});

it('closes only after discarding either an offline or online draft', async () => {
  await render(); await openProfile();
  await act(async () => h.inputs.Name.onChangeText('Unsaved'));
  await render(false);
  await act(async () => h.sheet.onClose());
  await act(async () => alertButton('devices.companions.automation.discard').onPress!());
  expect(h.close).toHaveBeenCalledOnce(); expect(h.invoke).not.toHaveBeenCalled();

  h.close.mockClear(); h.alert.mockClear();
  await render(true); await openProfile();
  await act(async () => h.inputs.Name.onChangeText('Unsaved online'));
  await act(async () => h.sheet.onClose());
  expect(h.alert).toHaveBeenCalledOnce(); expect(h.invoke).not.toHaveBeenCalled(); expect(h.close).not.toHaveBeenCalled();
  await act(async () => alertButton('devices.companions.automation.discard').onPress!());
  expect(h.invoke).not.toHaveBeenCalled();
  expect(h.close).toHaveBeenCalledOnce();
});
