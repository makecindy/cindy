import { describe, expect, it, vi } from 'vitest';
import { MAKER_INVOKE } from '../channels.js';
import { registerPluginEnableHandlers } from '../pluginEnableHandlers.js';
import { IpcHarness } from './helpers/ipcHarness.js';

/** #10409: IPC validation and commit ordering; bridge behavior lives in piEnvironment.test.ts.
 * These rejected/pending writes were not covered by the project-policy or Codex refresh tests.
 * Minimal input: a machine toggle whose persistence has not succeeded. Unit tier, no disk/OS input.
 */
function setup() {
  const harness = new IpcHarness();
  const pluginRegistry = { setEnabled: vi.fn(async () => true), clearEnabled: vi.fn(async () => true) };
  const invalidatePiEnvironment = vi.fn();
  const refreshCodexMcpEnvironment = vi.fn(async () => ({ codexMcpRefreshed: false }));
  registerPluginEnableHandlers(harness, {
    getPluginRegistry: () => pluginRegistry, invalidatePiEnvironment, refreshCodexMcpEnvironment,
  });
  return { harness, pluginRegistry, invalidatePiEnvironment, refreshCodexMcpEnvironment };
}

const mutations = [
  [MAKER_INVOKE.PLUGINS_SET_ENABLED, 'setEnabled', ['computer', true]],
  [MAKER_INVOKE.PLUGINS_CLEAR_ENABLED, 'clearEnabled', ['computer']],
] as const;

describe('plugin enable handlers', () => {
  it.each(mutations)('%s waits for persistence before invalidating shared environments', async (channel, method, args) => {
    const state = setup();
    let finish!: (result: boolean) => void;
    state.pluginRegistry[method].mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const saved = state.harness.invoke(channel, ...args);
    expect(state.invalidatePiEnvironment).not.toHaveBeenCalled();
    expect(state.refreshCodexMcpEnvironment).not.toHaveBeenCalled();
    finish(true);
    await expect(saved).resolves.toEqual({ codexMcpRefreshed: false });
    expect(state.invalidatePiEnvironment).toHaveBeenCalledTimes(1);
  });

  it.each(mutations)('%s rejects essential plugins and storage errors without refreshing', async (channel, method, args) => {
    const state = setup();
    state.pluginRegistry[method].mockResolvedValueOnce(false);
    await expect(state.harness.invoke(channel, ...args)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    state.pluginRegistry[method].mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(state.harness.invoke(channel, ...args)).rejects.toThrow('storage unavailable');
    expect(state.invalidatePiEnvironment).not.toHaveBeenCalled();
    expect(state.refreshCodexMcpEnvironment).not.toHaveBeenCalled();
  });

  it('keeps ordinary defaults independent of shared MCP lifecycles', async () => {
    const state = setup();
    await expect(state.harness.invoke(MAKER_INVOKE.PLUGINS_SET_ENABLED, 'docs', false))
      .resolves.toEqual({ codexMcpRefreshed: true });
    await expect(state.harness.invoke(MAKER_INVOKE.PLUGINS_CLEAR_ENABLED, 'docs'))
      .resolves.toEqual({ codexMcpRefreshed: true });
    expect(state.pluginRegistry.setEnabled).toHaveBeenCalledWith('docs', false);
    expect(state.pluginRegistry.clearEnabled).toHaveBeenCalledWith('docs');
    expect(state.invalidatePiEnvironment).not.toHaveBeenCalled();
    expect(state.refreshCodexMcpEnvironment).not.toHaveBeenCalled();
  });

  it.each([
    [MAKER_INVOKE.PLUGINS_SET_ENABLED, [null, true]],
    [MAKER_INVOKE.PLUGINS_SET_ENABLED, ['computer', 'true']],
    [MAKER_INVOKE.PLUGINS_CLEAR_ENABLED, [null]],
  ])('%s rejects invalid payloads before mutation', async (channel, args) => {
    const state = setup();
    await expect(state.harness.invoke(channel, ...args)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(state.pluginRegistry.setEnabled).not.toHaveBeenCalled();
    expect(state.pluginRegistry.clearEnabled).not.toHaveBeenCalled();
    expect(state.invalidatePiEnvironment).not.toHaveBeenCalled();
  });
});
