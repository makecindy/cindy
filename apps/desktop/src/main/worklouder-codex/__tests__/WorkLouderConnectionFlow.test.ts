import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkLouderCodexDefaultSettings } from '../../../shared/workLouderCodex.js';
import { WorkLouderAccessories } from '../accessories.js';
import { WorkLouderCodexHostClient } from '../WorkLouderCodexHostClient.js';
import { WorkLouderCodexLightingController } from '../WorkLouderCodexLightingController.js';

class Child extends EventEmitter {
  postMessage = vi.fn();
  kill = vi.fn(() => true);
}

afterEach(() => vi.useRealTimers());

describe('Creator identity, ownership, lights and actions', () => {
  it('hands off both ways, retaining protected policy, current lights and separate actions', async () => {
    vi.useFakeTimers();
    const children: Child[] = [];
    const client = new WorkLouderCodexHostClient({
      resolveSdk: () => ({ entry: 'test-sdk', source: 'openai-app' }),
      fork: () => {
        const child = new Child();
        children.push(child);
        return child;
      },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    client.setNativeOwnerPresent(true);
    const dispatch = vi.fn();
    const controller = new WorkLouderCodexLightingController(
      client,
      vi.fn(),
      async () => ['task'],
      dispatch,
    );
    const accessories = new WorkLouderAccessories(controller, () => client.probe());
    const settings = createWorkLouderCodexDefaultSettings('creator-micro-2');
    settings.deviceEnabled = true;
    settings.keymapPolicy = 'preserve';
    settings.layout.slots.ACT07.action = { type: 'command', commandId: 'composer.queue' };
    settings.layout.slots.ACT08.action = { type: 'command', commandId: 'composer.steer' };
    accessories.applySettings('creator-micro-2', settings);
    await controller.resumeTaskSlots();
    controller.updateSessionActivity([
      { sessionId: 'task', phase: 'running', attention: false, compactDetail: '' },
    ]);
    expect(children).toHaveLength(0);

    client.setNativeOwnerPresent(false);
    accessories.setNativeOwnerPresent(false);
    expect(children).toHaveLength(1);
    const first = children[0];
    expect(first.postMessage).toHaveBeenCalledWith({ kind: 'discover' });
    // Discovery never opens HID. Receiving identity chooses the correct model,
    // sends its preservation policy, then starts listening/lighting.
    first.emit('message', {
      kind: 'presence',
      present: true,
      deviceType: 'creator-micro-2',
      isUsbConnection: true,
    });
    const requests = first.postMessage.mock.calls.map(([request]) => request);
    expect(
      requests.findIndex(
        (request) => request.kind === 'set-creator-keymap-policy' && request.policy === 'preserve',
      ),
    ).toBeLessThan(requests.findIndex((request) => request.kind === 'listen'));
    expect(
      requests.filter((request) => request.kind === 'apply').at(-1)?.frame.threads[0],
    ).toMatchObject({ color: 0x4c6fff, brightness: expect.any(Number) });

    first.emit('message', { kind: 'hid', event: { key: 'ACT07', act: 1 } });
    first.emit('message', { kind: 'hid', event: { key: 'ACT08', act: 1 } });
    expect(dispatch).toHaveBeenCalledWith({ type: 'command', commandId: 'composer.queue' });
    expect(dispatch).toHaveBeenCalledWith({ type: 'command', commandId: 'composer.steer' });

    client.setNativeOwnerPresent(true);
    accessories.setNativeOwnerPresent(true);
    first.emit('message', { kind: 'stopped' });
    controller.updateSessionActivity([
      { sessionId: 'task', phase: 'completed', attention: true, compactDetail: '' },
    ]);
    expect(children).toHaveLength(1);
    expect(controller.getState().settings.keymapPolicy).toBe('preserve');

    client.setNativeOwnerPresent(false);
    accessories.setNativeOwnerPresent(false);
    expect(children).toHaveLength(2);
    const second = children[1];
    expect(second.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'init', creatorKeymapPolicy: 'preserve' }),
    );
    const restored = second.postMessage.mock.calls
      .map(([request]) => request)
      .filter((request) => request.kind === 'apply')
      .at(-1);
    expect(restored?.frame.threads[0]).toMatchObject({ color: 0x35c759 });
    expect(restored?.frame.threads[0].brightness).toBeGreaterThan(0);
    const disposed = controller.dispose();
    second.emit('message', { kind: 'stopped' });
    await disposed;
  });
});
