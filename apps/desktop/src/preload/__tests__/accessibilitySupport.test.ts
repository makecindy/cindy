import { beforeEach, expect, it, vi } from 'vitest';
import { ACCESSIBILITY_SUPPORT_CHANGED, ACCESSIBILITY_SUPPORT_GET } from '../../shared/accessibilitySupport';
const mocks = vi.hoisted(() => ({ on: vi.fn(), sendSync: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: mocks }));
import { createAccessibilitySupportBridge } from '../accessibilitySupport';
beforeEach(() => vi.clearAllMocks());

it.each([true, false, null, undefined])('reads initial state %s before first render', initial => {
  mocks.sendSync.mockReturnValue(initial);
  const bridge = createAccessibilitySupportBridge();
  expect(mocks.sendSync).toHaveBeenCalledWith(ACCESSIBILITY_SUPPORT_GET);
  expect(bridge.getSync()).toBe(initial !== false);
});

it('closes the render/subscribe gap, filters payloads, strips events and unsubscribes', () => {
  mocks.sendSync.mockReturnValue(false);
  const bridge = createAccessibilitySupportBridge();
  expect(mocks.on.mock.calls[0][0]).toBe(ACCESSIBILITY_SUPPORT_CHANGED);
  const emit = (value: unknown) => mocks.on.mock.calls[0][1]({ sender: 'private' }, value);
  emit(true);
  const callback = vi.fn();
  const unsubscribe = bridge.onChanged(callback);
  expect(callback).toHaveBeenLastCalledWith(true);
  emit('false'); expect(bridge.getSync()).toBe(true);
  expect(callback).toHaveBeenCalledTimes(1);
  emit(false); expect(callback).toHaveBeenLastCalledWith(false);
  unsubscribe(); emit(true);
  expect(callback).toHaveBeenCalledTimes(2);
  expect(bridge.getSync()).toBe(true);
});
