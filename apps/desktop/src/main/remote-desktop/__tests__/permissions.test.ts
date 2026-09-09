import { describe, expect, it, vi } from 'vitest';
import { RemoteDesktopPermissionsService } from '../permissions';
function harness() {
  const deps = {
    required: true,
    screen: vi.fn(() => 'missing' as const),
    accessibility: vi.fn(async () => 'granted' as const),
    request: vi.fn(
      async (_permission: string, _isCurrent: () => boolean, _signal: AbortSignal) => {},
    ),
    openSettings: vi.fn(async () => {}),
    showGuide: vi.fn(),
  };
  return { deps, service: new RemoteDesktopPermissionsService(deps) };
}
describe('remote desktop OS permissions', () => {
  it('reads the two real permissions independently without requesting or opening anything', async () => {
    const { service, deps } = harness();
    expect(await service.read()).toEqual({ screenRecording: 'missing', accessibility: 'granted' });
    expect(deps.request).not.toHaveBeenCalled();
    expect(deps.openSettings).not.toHaveBeenCalled();
    expect(deps.showGuide).not.toHaveBeenCalled();
  });
  it('does not claim a failed probe is granted', async () => {
    const { service, deps } = harness();
    deps.accessibility.mockRejectedValue(new Error('helper unavailable'));
    expect((await service.read()).accessibility).toBe('unknown');
  });
  it('coalesces simultaneous checks but reads fresh permission state afterwards', async () => {
    const { service, deps } = harness();
    await Promise.all([service.read(), service.read()]);
    expect(deps.accessibility).toHaveBeenCalledTimes(1);
    await service.read();
    expect(deps.accessibility).toHaveBeenCalledTimes(2);
  });
  it('only displays the in-app guide once, without triggering an OS prompt', () => {
    const { service, deps } = harness();
    service.show();
    service.show();
    expect(deps.showGuide).toHaveBeenCalledOnce();
    expect(deps.request).not.toHaveBeenCalled();
    service.dismiss();
    expect(service.guideOpen).toBe(false);
  });
  it('cancels a pending OS follow-up after the guide closes', async () => {
    const { service, deps } = harness();
    let finish!: () => void;
    let isCurrent!: () => boolean;
    let signal!: AbortSignal;
    deps.request.mockImplementation((_permission, current, abortSignal) => {
      isCurrent = current;
      signal = abortSignal;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const open = service.open('accessibility');
    service.dismiss();
    expect(isCurrent()).toBe(false);
    expect(signal.aborted).toBe(true);
    finish();
    await open;
    expect(deps.openSettings).not.toHaveBeenCalled();
  });
  it('still opens settings when the native request fails, without marking permissions granted', async () => {
    const { service, deps } = harness();
    deps.request.mockRejectedValue(new Error('request failed'));
    await service.open('screenRecording');
    expect(deps.openSettings).toHaveBeenCalledWith('screenRecording');
    expect((await service.read()).screenRecording).toBe('missing');
  });
  it('does not reopen a dismissed guide when an old enable preflight resolves', async () => {
    const { service, deps } = harness();
    let finish!: () => void;
    deps.accessibility.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve('granted');
        }),
    );
    const enable = service.showIfNeeded(() => true);
    service.dismiss();
    finish();
    await enable;
    expect(deps.showGuide).not.toHaveBeenCalled();
  });
  it('does not probe or open macOS permissions on other platforms', async () => {
    const { service, deps } = harness();
    deps.required = false;
    expect(await service.read()).toEqual({
      screenRecording: 'notRequired',
      accessibility: 'notRequired',
    });
    service.show();
    await service.open('accessibility');
    expect(deps.accessibility).not.toHaveBeenCalled();
    expect(deps.request).not.toHaveBeenCalled();
    expect(deps.showGuide).not.toHaveBeenCalled();
  });
});
