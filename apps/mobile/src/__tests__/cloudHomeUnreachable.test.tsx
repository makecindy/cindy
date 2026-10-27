// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({ StyleSheet: { create: (v: unknown) => v }, View: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/AppText', () => ({ Text: () => null }));
vi.mock('@/theme', () => ({ lineHeight: {}, radius: {}, spacing: {}, typeScale: {}, useThemedStyles: () => ({}) }));
vi.mock('@/session/CompanionCardButton', () => ({ CompanionCardButton: () => null }));
import { CLOUD_HOME_UNREACHABLE_AFTER_MS, useSustained } from '../session/CloudHomeUnreachableNotice';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot>;
const seen: boolean[] = [];
function Harness({ waiting }: { waiting: boolean }) { seen.push(useSustained(waiting)); return null; }
const render = (waiting: boolean) => act(() => root.render(<Harness waiting={waiting} />));
beforeEach(() => { vi.useFakeTimers(); seen.length = 0; root = createRoot(document.createElement('div')); });
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });

it('offers the switch only after a message has waited for the main computer the whole time', () => {
  render(true);
  act(() => { vi.advanceTimersByTime(CLOUD_HOME_UNREACHABLE_AFTER_MS - 1); });
  expect(seen.at(-1)).toBe(false);
  act(() => { vi.advanceTimersByTime(1); });
  expect(seen.at(-1)).toBe(true);
  // Delivered: the prompt goes away at once, and a new wait starts the clock again.
  render(false);
  expect(seen.at(-1)).toBe(false);
  render(true);
  expect(seen.at(-1)).toBe(false);
  act(() => { vi.advanceTimersByTime(CLOUD_HOME_UNREACHABLE_AFTER_MS / 2); });
  render(false); render(true);
  act(() => { vi.advanceTimersByTime(CLOUD_HOME_UNREACHABLE_AFTER_MS / 2); });
  expect(seen.at(-1)).toBe(false);
});
