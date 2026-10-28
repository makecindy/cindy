import { describe, it, expect, vi } from 'vitest';
import { createHudController } from '../controller';
// Value: user consent and window recovery at real controller entry. No existing HUD coverage.
// Minimal input: permission revoked while capture awaits. Unit, injected OS, no real screen.
function setup() {
  let allowed = true;
  const deps = {
    allowed: () => allowed,
    enter: vi.fn(),
    exit: vi.fn(),
    hide: vi.fn(),
    reveal: vi.fn(),
    capture: vi.fn(async () => new Uint8Array([1, 2])),
    changed: vi.fn(),
  };
  return {
    deps,
    controller: createHudController(deps),
    revoke: () => {
      allowed = false;
    },
  };
}
describe('HUD lifecycle and one-shot capture', () => {
  it('does not capture outside HUD or without consent', async () => {
    const { controller, deps, revoke } = setup();
    await expect(controller.capture()).rejects.toThrow('HUD_INACTIVE');
    controller.setActive(true);
    revoke();
    await expect(controller.capture()).rejects.toThrow('HUD_SCREEN_DISABLED');
    expect(deps.capture).not.toHaveBeenCalled();
    expect(deps.hide).not.toHaveBeenCalled();
  });
  it('discards revoked in-flight pixels, rejects concurrent capture and restores visibility', async () => {
    const { controller, deps, revoke } = setup();
    let finish!: (v: Uint8Array<ArrayBuffer>) => void;
    deps.capture.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    controller.setActive(true);
    const pending = controller.capture();
    await expect(controller.capture()).rejects.toThrow('HUD_BUSY');
    revoke();
    finish(new Uint8Array([42]));
    await expect(pending).rejects.toThrow('HUD_SCREEN_DISABLED');
    expect(deps.reveal).toHaveBeenCalledTimes(1);
    expect(controller.snapshot()).toEqual({ active: true, capturing: false });
  });
  it('restores on failure and exits without changing the current task', async () => {
    const { controller, deps } = setup();
    controller.setActive(true);
    controller.setActive(true);
    expect(deps.enter).toHaveBeenCalledTimes(1);
    deps.capture.mockRejectedValue(new Error('capture failed'));
    await expect(controller.capture()).rejects.toThrow('capture failed');
    expect(deps.reveal).toHaveBeenCalledTimes(1);
    controller.setActive(false);
    expect(deps.exit).toHaveBeenCalledTimes(1);
  });
  it('discards capture when HUD exits while awaiting pixels', async () => {
    const { controller, deps } = setup();
    let finish!: (v: Uint8Array<ArrayBuffer>) => void;
    deps.capture.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    controller.setActive(true);
    const pending = controller.capture();
    controller.setActive(false);
    finish(new Uint8Array([42]));
    await expect(pending).rejects.toThrow('HUD_INACTIVE');
    expect(controller.snapshot().active).toBe(false);
  });
});
