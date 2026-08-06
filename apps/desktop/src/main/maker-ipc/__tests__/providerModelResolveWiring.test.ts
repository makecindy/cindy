import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const registerSource = readFileSync(resolve(__dirname, '..', 'register.ts'), 'utf8').replace(
  /\r\n?/g,
  '\n',
);

describe('provider model resolve wiring', () => {
  it('projects saved runtime models through the chat-mode resolve boundary', () => {
    const savedStart = registerSource.indexOf(
      'async function resolveSavedCustomProviderModels(providerId: string)',
    );
    const savedEnd = registerSource.indexOf(
      'registerProviderHandlers(createElectronIpcHandlerRegistry()',
      savedStart,
    );
    const saved = registerSource.slice(savedStart, savedEnd);

    expect(savedStart).toBeGreaterThan(-1);
    expect(savedEnd).toBeGreaterThan(savedStart);
    expect(saved).toContain('...(m.mode !== undefined ? { mode: m.mode } : {})');
    expect(saved).toContain('...(m.maxOutput !== undefined ? { maxOutput: m.maxOutput } : {})');
    expect(saved).toContain('const resolveModels = toModelResolveRequestModels(');
    expect(saved).toContain('models: resolveModels,');
    const ownerCapture = saved.indexOf('const ownerAtStart = getActiveAppSession();');
    const configRead = saved.indexOf('const cfg = await getCustomProvider(providerId);');
    const postReadOwnerCheck = saved.indexOf(
      'ownerAfterRead.dataOwnerId !== ownerAtStart.dataOwnerId',
    );
    const resolveCall = saved.indexOf('resolveProviderModelEntries(');
    expect(ownerCapture).toBeGreaterThan(-1);
    expect(configRead).toBeGreaterThan(ownerCapture);
    expect(postReadOwnerCheck).toBeGreaterThan(configRead);
    expect(resolveCall).toBeGreaterThan(postReadOwnerCheck);
  });

  it('preserves provider-verified context windows in discovered catalog additions', () => {
    const additionsStart = registerSource.indexOf(
      'const additions = effectiveModels.map((m) => ({',
    );
    const additionsEnd = registerSource.indexOf(
      'setDiscoveredProviderModels(providerId, agent, additions);',
      additionsStart,
    );
    const additions = registerSource.slice(additionsStart, additionsEnd);

    expect(additionsStart).toBeGreaterThan(-1);
    expect(additionsEnd).toBeGreaterThan(additionsStart);
    expect(additions).toContain('contextWindowVerified: m.contextWindowVerified,');
    expect(additions).toContain('modalities: m.modalities');
    expect(additions).toContain('capabilities: m.capabilities');
  });

  it('rechecks the latest apply token before any resolved model reaches a consumer', () => {
    const resolveStart = registerSource.indexOf(
      '.then(async (resolved) => {',
      registerSource.indexOf('resolveFetchedModels: (spec, result) => {'),
    );
    const resolveEnd = registerSource.indexOf('.catch(() => undefined);', resolveStart);
    const consumer = registerSource.slice(resolveStart, resolveEnd);

    expect(resolveStart).toBeGreaterThan(-1);
    expect(resolveEnd).toBeGreaterThan(resolveStart);
    expect(consumer).toMatch(
      /if \(!resolved \|\| !isLatestModelResolveResult\(resolved\)\) return;/,
    );
    expect(consumer.indexOf('isLatestModelResolveResult(resolved)')).toBeLessThan(
      consumer.indexOf('broadcastToAllWindows(MAKER_PUSH.PROVIDER_MODELS_RESOLVED'),
    );
    expect(consumer.indexOf('isLatestModelResolveResult(resolved)')).toBeLessThan(
      consumer.indexOf('setResolvedProviderModels('),
    );
    const configRead = consumer.indexOf('await getCustomProvider(spec.savedProviderId)');
    const configWrite = consumer.indexOf('await updateCustomProviderIfUnchanged(');
    const postReadGuard = consumer.indexOf(
      'if (!isLatestModelResolveResult(resolved)) return;',
      configRead,
    );
    expect(configRead).toBeGreaterThan(-1);
    expect(postReadGuard).toBeGreaterThan(configRead);
    expect(configWrite).toBeGreaterThan(postReadGuard);
  });

  it('isolates unsaved form apply slots without changing the fixed server provider identity', () => {
    const resolveStart = registerSource.indexOf('resolveFetchedModels: (spec, result) => {');
    const resolveEnd = registerSource.indexOf('.catch(() => undefined);', resolveStart);
    const resolveConsumer = registerSource.slice(resolveStart, resolveEnd);

    expect(resolveStart).toBeGreaterThan(-1);
    expect(resolveEnd).toBeGreaterThan(resolveStart);
    expect(resolveConsumer).toContain(
      "const resolveProviderId = spec.savedProviderId ?? UNSAVED_FORM_RESOLVE_PROVIDER_ID;",
    );
    expect(resolveConsumer).toContain('{ localApplyScope: spec.requestId }');
    expect(resolveConsumer).toContain('providerId: resolveProviderId,');
    expect(resolveConsumer).toContain('releaseModelResolveApplyResult(resolved)');
  });
});
