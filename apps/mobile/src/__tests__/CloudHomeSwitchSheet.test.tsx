// @vitest-environment jsdom
// 测试价值
// - 生产入口与可观察结果：CloudHomeSwitchSheet 选中目标电脑后请主力电脑交出伙伴；交出请求异常时，界面是进入「已换好」
//   还是显示哪条失败文案。
// - 规则依据：docs/product-rules/cloud-companions.md「回执丢失时发起方立即重读主力电脑，按服务器上的实际主力电脑显示」。
// - 覆盖缺口：此前没有该组件的测试；任何异常都被当成离线，已换成功也报「换电脑失败」。
// - 最小失败输入：hand-over invoke 抛出（回执丢失 / 超时），服务器上的主力已是目标电脑。
// - tier：unit（jsdom，device-link 与服务器读取均为内存替身）。
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { COMPANION_CLOUD_CAPS_CHANNEL, COMPANION_CLOUD_HAND_OVER_CHANNEL, COMPANION_CLOUD_TARGETS_CHANNEL } from '@cindy/device-link';

const h = vi.hoisted(() => ({ invoke: vi.fn(), alert: vi.fn() }));
vi.mock('react-native', () => ({
  ActivityIndicator: () => null,
  Alert: { alert: h.alert },
  StyleSheet: { create: (s: unknown) => s },
  View: ({ children }: any) => createElement('div', null, children),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, options?: Record<string, unknown>) => options?.context ? `${key}:${JSON.stringify(options)}` : key,
}) }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: any) => createElement('span', null, children) }));
vi.mock('@/theme', () => ({ useThemedStyles: () => ({}) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: h.invoke }) }));
vi.mock('@/session/CompanionSheet', () => ({ CompanionSheet: ({ children }: any) => createElement('div', null, children) }));
vi.mock('@/session/CompanionSettingsRow', () => ({ CompanionSettingsRow: ({ onPress, testID }: any) =>
  createElement('button', { onClick: onPress, 'data-testid': testID }) }));
import { CloudHomeSwitchSheet } from '@/session/CloudHomeSwitchSheet';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  h.invoke.mockImplementation(async (_device: string, channel: string) => {
    if (channel === COMPANION_CLOUD_CAPS_CHANNEL) return { companionCloud: 3 };
    if (channel === COMPANION_CLOUD_TARGETS_CHANNEL) return [{ deviceId: 'mac', name: 'Mac', online: true }];
    if (channel === COMPANION_CLOUD_HAND_OVER_CHANNEL) throw new Error('INVOKE_TIMEOUT');
    throw new Error(`unexpected ${channel}`);
  });
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

// #12112, unit: a known refusal must explain oversized skills without claiming a move,
// while generic version refusals from older homes must not acquire a false skill cause.
it.each([
  { code: 'SKILL_TARGET_OUTDATED', error: 'devices.cloudCompanion.skillTargetOutdated' },
  { code: 'SKILL_TARGET_OUTDATED', error: 'devices.cloudCompanion.skillTargetOutdated', oversizedSkill: { slug: 'research-paper-writing', bodyBytes: 71_560 } },
  { code: 'TARGET_OUTDATED', error: 'devices.cloudCompanion.switchFailed' },
])('keeps the current home and shows the hand-over refusal ($code)', async ({ code, error, oversizedSkill }) => {
  const invoke = h.invoke.getMockImplementation()!;
  h.invoke.mockImplementation(async (device: string, channel: string) => channel === COMPANION_CLOUD_HAND_OVER_CHANNEL
    ? { ok: false, code, oversizedSkill } : invoke(device, channel));
  const onMoved = vi.fn();
  const readHome = vi.fn();
  await act(async () => root.render(<CloudHomeSwitchSheet visible onClose={() => {}} botId="bot" name="Writer"
    homeDeviceId="pc" homeName="PC" onMoved={onMoved} readHome={readHome} />));
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="cloudHome.target.mac"]')!.click());
  const buttons = h.alert.mock.calls[0]![2] as Array<{ onPress?: () => void }>;
  await act(async () => buttons.at(-1)!.onPress!());
  expect(host.textContent).toContain(oversizedSkill
    ? `${error}:${JSON.stringify({ name: 'Writer', device: 'Mac', context: 'skill', ...oversizedSkill })}` : error);
  expect(onMoved).not.toHaveBeenCalled();
  expect(readHome).not.toHaveBeenCalled();
});

it.each([
  { home: 'mac', moved: true, error: null },
  { home: 'pc', moved: false, error: 'devices.cloudCompanion.switchFailed' },
  { home: 'laptop', moved: false, error: 'devices.cloudCompanion.switchConflict' },
  { home: new Error('CLOUD_ROSTER_FAILED'), moved: false, error: 'devices.cloudCompanion.switchFailed' },
])('after a lost hand-over answer, shows where the server says it runs now ($home)', async ({ home, moved, error }) => {
  const onMoved = vi.fn();
  const readHome = vi.fn(() => home instanceof Error ? Promise.reject(home) : Promise.resolve(home));
  await act(async () => root.render(<CloudHomeSwitchSheet visible onClose={() => {}} botId="bot" name="Writer"
    homeDeviceId="pc" homeName="PC" onMoved={onMoved} readHome={readHome} />));
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="cloudHome.target.mac"]')!.click());
  const buttons = h.alert.mock.calls[0]![2] as Array<{ onPress?: () => void }>;
  await act(async () => buttons.at(-1)!.onPress!());
  expect(readHome).toHaveBeenCalledTimes(1);
  expect(onMoved).toHaveBeenCalledTimes(moved ? 1 : 0);
  if (error) expect(host.textContent).toContain(error);
  else expect(host.textContent).not.toContain('devices.cloudCompanion.switch');
});
