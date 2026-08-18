import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const bootstrapSource = readFileSync(
  resolve(__dirname, '..', '..', 'bootstrap-electron.ts'),
  'utf8',
);
const makerIpcSource = readFileSync(
  resolve(__dirname, '..', '..', 'maker-ipc', 'register.ts'),
  'utf8',
);
const makerHostSource = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf8');
const compactBootstrapSource = bootstrapSource.replace(/\s+/g, ' ');

describe('account provider readiness wiring', () => {
  it('arms provider discovery without keeping local-db ensure-ready behind it', () => {
    const workdirSweep = bootstrapSource.indexOf("logStartupPhase('dialogue-workdir-sweep')");
    const barrierStart = compactBootstrapSource.indexOf('accountProviderReadinessBarrier.start(');
    const readableDone = compactBootstrapSource.indexOf(
      "logStartupPhase('post-db-hooks-scheduled')",
    );
    const compactWorkdirSweep = compactBootstrapSource.indexOf(
      "logStartupPhase('dialogue-workdir-sweep')",
    );

    expect(workdirSweep).toBeGreaterThanOrEqual(0);
    expect(compactWorkdirSweep).toBeGreaterThanOrEqual(0);
    expect(barrierStart).toBeGreaterThan(compactWorkdirSweep);
    expect(readableDone).toBeGreaterThan(barrierStart);
    expect(compactBootstrapSource).not.toContain('await accountProviderReadinessBarrier.start(');
  });

  it('publishes Maker provider configuration immediately and orders account route refreshes', () => {
    const configureCoordinator = makerIpcSource.indexOf('configureProviderModelAutoRefresh({');
    const configuredCallback = makerIpcSource.indexOf(
      'options.onProviderModelAutoRefreshConfigured()',
      configureCoordinator,
    );
    const providerHandlers = makerIpcSource.indexOf(
      'registerProviderHandlers(',
      configuredCallback,
    );
    expect(configureCoordinator).toBeGreaterThanOrEqual(0);
    expect(configuredCallback).toBeGreaterThan(configureCoordinator);
    expect(providerHandlers).toBeGreaterThan(configuredCallback);
    expect(bootstrapSource).toContain(
      'onProviderModelAutoRefreshConfigured: markMakerProviderRefreshConfigured',
    );
    expect(bootstrapSource).not.toContain('await makerProviderRefreshConfigured');
    expect(bootstrapSource).toContain(
      'startPendingAccountProviderReadiness = { ownerId: userId, start: startProviderReadiness }',
    );

    const barrierStart = bootstrapSource.indexOf('accountProviderReadinessBarrier.start(');
    const makerRecreated = bootstrapSource.indexOf('getMakerCore();', barrierStart);
    const initialMcpRefresh = bootstrapSource.indexOf(
      'await waitForInitialCustomMcpRefresh()',
      makerRecreated,
    );
    const customMcpRefresh = bootstrapSource.indexOf(
      'await refreshCustomMcpProviders()',
      initialMcpRefresh,
    );
    const customProviderRefresh = bootstrapSource.indexOf(
      'await refreshCustomProvidersIntoCatalog(',
      customMcpRefresh,
    );
    const runtimeReset = bootstrapSource.indexOf(
      'await resetAccountProviderRuntimes(',
      customProviderRefresh,
    );
    const providerRefresh = bootstrapSource.indexOf(
      'await discoverAccountProviderModels(',
      runtimeReset,
    );
    const piShutdown = bootstrapSource.indexOf('await shutdownPiEnvironment()', providerRefresh);

    expect(makerRecreated).toBeGreaterThanOrEqual(0);
    expect(initialMcpRefresh).toBeGreaterThan(makerRecreated);
    expect(customMcpRefresh).toBeGreaterThan(initialMcpRefresh);
    expect(customProviderRefresh).toBeGreaterThan(customMcpRefresh);
    expect(runtimeReset).toBeGreaterThan(customProviderRefresh);
    expect(providerRefresh).toBeGreaterThan(runtimeReset);
    expect(piShutdown).toBeGreaterThan(providerRefresh);
  });

  it('registers every agent MCP provider array before the initial custom MCP refresh', () => {
    const piProviders = makerHostSource.indexOf('const piMcpProviders = [');
    const registerArrays = makerHostSource.indexOf('registerCustomMcpArrays(');
    const initialRefresh = makerHostSource.indexOf(
      '_initialCustomMcpRefresh = refreshCustomMcpProviders()',
      registerArrays,
    );
    const registration = makerHostSource.slice(registerArrays, initialRefresh);

    expect(piProviders).toBeGreaterThanOrEqual(0);
    expect(registerArrays).toBeGreaterThan(piProviders);
    expect(registration).toContain('claudeMcpProviders');
    expect(registration).toContain('codexMcpProviders');
    expect(registration).toContain('piMcpProviders');
    expect(initialRefresh).toBeGreaterThan(registerArrays);
  });

  it('gates route resolution and the final Maker start hook', () => {
    const bootstrapSession = makerIpcSource.indexOf('async function bootstrapSession');
    const routeGate = makerIpcSource.indexOf(
      'await options.waitForAccountProviderModelsReady()',
      bootstrapSession,
    );
    const routeResolution = makerIpcSource.indexOf(
      'const didInjectOrcaInstructions',
      bootstrapSession,
    );
    expect(routeGate).toBeGreaterThan(bootstrapSession);
    expect(routeResolution).toBeGreaterThan(routeGate);

    const prepareStartOptions = makerHostSource.indexOf('prepareStartOptions: async');
    const hostGate = makerHostSource.indexOf(
      'await ensureCurrentAccountProviderReadiness()',
      prepareStartOptions,
    );
    const failClosed = makerHostSource.indexOf('!providerReady', hostGate);
    const persistedOrca = makerHostSource.indexOf(
      'await preparePersistedOrcaSessionStart',
      prepareStartOptions,
    );
    expect(hostGate).toBeGreaterThan(prepareStartOptions);
    expect(failClosed).toBeGreaterThan(hostGate);
    expect(persistedOrca).toBeGreaterThan(hostGate);
  });

  it('adopts same-owner generation rollover instead of restarting account-switch discovery', () => {
    const waitFn = bootstrapSource.indexOf(
      'async function waitForCurrentAccountProviderModelsReady',
    );
    expect(waitFn).toBeGreaterThanOrEqual(0);
    expect(
      bootstrapSource.indexOf('ensureCurrentAccountProviderReadiness()', waitFn),
    ).toBeGreaterThan(waitFn);

    const unchanged = bootstrapSource.indexOf("dbClientTakeover.mode === 'unchanged'");
    const unchangedEnsure = bootstrapSource.indexOf(
      'ensureCurrentAccountProviderReadiness()',
      unchanged,
    );
    const unchangedReturn = bootstrapSource.indexOf('return;', unchangedEnsure);
    expect(unchanged).toBeGreaterThanOrEqual(0);
    expect(unchangedEnsure).toBeGreaterThan(unchanged);
    expect(unchangedReturn).toBeGreaterThan(unchangedEnsure);
    expect(bootstrapSource).toContain('shouldKeepPendingReadinessStart');
    expect(bootstrapSource).toContain('shouldClearCatalogAfterJoiningPreviousScope');
    expect(bootstrapSource).toMatch(
      /handle\.isLive\(\)\s*&&\s*accountProviderReadinessBarrier\.isCurrentAdoptable\(\)/,
    );

    expect(bootstrapSource).toContain(
      'accountProviderReadinessArm.publish(userId, startProviderReadiness, resumeIncompleteDiscovery)',
    );
    expect(bootstrapSource).toContain('accountProviderReadinessArm.clear()');
    expect(bootstrapSource).toContain('startPendingAccountProviderReadiness = null');
    expect(bootstrapSource).toContain('invalidateAdoption()');
    expect(bootstrapSource).toContain('needsIncompleteDiscoveryResume');
    expect(bootstrapSource).toContain('shouldFirePendingReadinessStart');
    expect(bootstrapSource).toContain('handle.isLive()');
    expect(bootstrapSource).toContain('const entryStillLive = () => handle.isLive();');
    expect(bootstrapSource).toContain(
      'handle.isLive() && accountProviderReadinessBarrier.isCurrentAdoptable()',
    );
    expect(bootstrapSource).not.toContain(
      'handle.isLive() && !isAppSessionBoundaryPending()',
    );
    expect(bootstrapSource).toContain('handle.markDiscoveryComplete()');
    expect(bootstrapSource).toContain('startedHandle?.isLive()');
    expect(bootstrapSource).toContain('markDiscoveryComplete()');
    expect(bootstrapSource).toContain('discoverAccountProviderModels(');
    expect(bootstrapSource).toContain('resetAccountProviderRuntimes(');
  });

  it('starts autonomous route consumers only after provider readiness settles', () => {
    const settledContinuation = bootstrapSource.indexOf('void providerReadiness.then(() =>');
    const integrations = bootstrapSource.indexOf(
      'startAccountIntegrationsAfterOwnerDbReady',
      settledContinuation,
    );
    const scheduler = bootstrapSource.indexOf('attemptStartScheduler()', settledContinuation);

    expect(settledContinuation).toBeGreaterThanOrEqual(0);
    expect(integrations).toBeGreaterThan(settledContinuation);
    expect(scheduler).toBeGreaterThan(settledContinuation);
    expect(bootstrapSource).not.toContain('await attemptStartScheduler()');
  });

  it('clears owner-scoped custom routes before replacing account runtimes', () => {
    const teardown = bootstrapSource.indexOf('async function teardownAuthAccountBoundary');
    const clearCustomProviders = bootstrapSource.indexOf('setCustomProviders([])', teardown);
    const makerShutdown = bootstrapSource.indexOf('await maker.shutdown()', teardown);
    const joinPrevious = bootstrapSource.indexOf(
      'waitForPreviousScope(',
      makerShutdown,
    );
    const clearAfterJoin = bootstrapSource.indexOf(
      'shouldClearCatalogAfterJoiningPreviousScope(',
      joinPrevious,
    );

    expect(teardown).toBeGreaterThanOrEqual(0);
    expect(clearCustomProviders).toBeGreaterThan(teardown);
    expect(makerShutdown).toBeGreaterThan(clearCustomProviders);
    expect(joinPrevious).toBeGreaterThan(makerShutdown);
    expect(clearAfterJoin).toBeGreaterThan(joinPrevious);
  });
});
