import { expect, it, vi } from 'vitest';
import { createBotSessionTaskRouteBridge } from '../botSessionTaskRouteBridge.js';
import { GroupToolAuthorizationError } from '../botGroupToolAuthorization.js';

it('checks the captured group grant after reading the task runtime and before changing it', async () => {
  let current = true;
  const route = { agentKind: 'codex' as const, model: 'model', providerId: 'provider', effort: null, fastMode: false };
  const setSessionRuntime = vi.fn();
  const bridge = createBotSessionTaskRouteBridge({
    getSessionRuntime: vi.fn(async () => {
      current = false;
      return { ok: true, runtime: { runtimeGeneration: 1, effectiveProfile: route } } as never;
    }),
    setSessionRuntime,
    readConfiguredCandidate: vi.fn(),
  });
  await expect(bridge.advance('child', 1, route, async () => {
    if (!current) throw new GroupToolAuthorizationError();
  })).rejects.toMatchObject({ code: 'GROUP_AUTHORIZATION_REQUIRED' });
  expect(setSessionRuntime).not.toHaveBeenCalled();
});
