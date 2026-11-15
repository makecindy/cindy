// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { executeRenderer, rendererFunction, rendererSource } from './fixtures/messageRendererComponents';
import { parseSettingsNavigationUrl } from '@cindy/maker-shared/settings-navigation';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SettingsLinkSpan } from '../session/SettingsLinkSpan';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), push: vi.fn(), alert: vi.fn() }));
vi.mock('react-native', () => ({ Alert: { alert: mocks.alert } }));
vi.mock('@/components/AppText', () => ({ Text: ({ onPress, children }: { onPress: () => void; children: string }) => createElement('button', { onClick: onPress }, children) }));
vi.mock('react-i18next', async (importOriginal) => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: mocks.invoke, readDeviceList: async () => ({ devices: [{ deviceId: 'studio', name: 'Studio' }] }) }) }));
vi.mock('@/utils/useGuardedPush', () => ({ useGuardedPush: () => mocks.push }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function mount() { render(<SettingsLinkSpan target={{ tab: 'appearance', deviceId: 'studio' }} label="Open Studio settings" />); }
// Unit: a mobile link must preserve its source computer and not open a viewer on old-host failure.
it('opens the remote screen after that computer confirms settings navigation', async () => {
  mocks.invoke.mockResolvedValue({ ok: true, deviceId: 'studio' });
  mount();
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith({ pathname: '/devices/desktop/[deviceId]', params: { deviceId: 'studio', name: 'Studio' } }));
  expect(mocks.invoke).toHaveBeenCalledWith('studio', 'maker:settings:navigate', [{ tab: 'appearance', deviceId: 'studio' }]);
});
it('keeps the task visible and explains an unsupported or offline target', async () => {
  mocks.invoke.mockRejectedValue(new Error('CHANNEL_NOT_ALLOWED'));
  mount();
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() => expect(mocks.alert).toHaveBeenCalledWith('settings.navigation.unavailable'));
  expect(mocks.push).not.toHaveBeenCalled();
});

// Unit regression for #10635 / r4577204474: real renderInline must pass the
// caller's native-text component through SettingsLinkSpan. Existing button-only
// tests missed iOS UITextView's requirement that descendants use native spans.
// This adapter marks the native boundary; no UIKit layout is claimed here.
it('preserves the iOS selectable span through the production inline renderer', async () => {
  const NativeSpan = ({ children, onPress, style }: { children?: ReactNode; onPress?: () => void; style?: unknown }) =>
    createElement('span', { 'data-testid': 'native-span', 'data-style': JSON.stringify(style), onClick: onPress }, children);
  const inlineRenderer = executeRenderer<(inline: unknown, index: number, styles: unknown, ctx: unknown) => ReactNode>(
    rendererFunction('renderInline').getText(rendererSource) + '; return renderInline;', {
      SettingsLinkSpan, parseSettingsNavigationUrl, MarkdownSelectableSpan: NativeSpan,
      UITextView: NativeSpan, Text: NativeSpan, MessageBodyText: NativeSpan,
      clickableInlineStyle: (_styles: unknown, _press: unknown, baseStyle: unknown) => baseStyle,
    });
  const style = { fontSize: 16, lineHeight: 24 };
  mocks.invoke.mockResolvedValue({ ok: true, deviceId: 'studio' });
  render(createElement('div', { 'data-testid': 'native-paragraph' }, inlineRenderer(
    { type: 'link', url: 'cindy://settings-link/appearance?device=studio', text: 'Open Studio settings' },
    0, {}, { SpanText: NativeSpan, baseStyle: style },
  )));
  const span = screen.getByTestId('native-span');
  expect(span.textContent).toBe('Open Studio settings');
  expect(span.getAttribute('data-style')).toBe(JSON.stringify(style));
  expect(screen.queryByRole('button')).toBeNull();
  fireEvent.click(span);
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith({ pathname: '/devices/desktop/[deviceId]', params: { deviceId: 'studio', name: 'Studio' } }));
});
