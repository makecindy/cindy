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

    const failed = bootstrapSource.indexOf("dbClientTakeover.mode === 'failed'");
    const failedResume = bootstrapSource.indexOf('await resumeInputDeviceTaskSlots();', failed);
    const failedReturn = bootstrapSource.indexOf('return;', failedResume);
    expect(failed).toBeGreaterThanOrEqual(0);
    expect(failedResume).toBeGreaterThan(failed);
    expect(failedReturn).toBeGreaterThan(failedResume);

    const unchanged = bootstrapSource.indexOf("dbClientTakeover.mode === 'unchanged'");
    const unchangedEnsure = bootstrapSource.indexOf(
      'ensureCurrentAccountProviderReadiness()',
      unchanged,
    );
    const unchangedResume = bootstrapSource.indexOf('await resumeInputDeviceTaskSlots();', unchanged);
    const unchangedReturn = bootstrapSource.indexOf('return;', unchangedResume);
    expect(unchanged).toBeGreaterThanOrEqual(0);
    expect(unchangedEnsure).toBeGreaterThan(unchanged);
    expect(unchangedResume).toBeGreaterThan(unchangedEnsure);
    expect(unchangedReturn).toBeGreaterThan(unchangedResume);
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
    const suspendHardware = bootstrapSource.indexOf('suspendInputDeviceTaskSlots();', teardown);
    const clearCustomProviders = bootstrapSource.indexOf('setCustomProviders([])', teardown);
    // The boundary must name itself: an unlabelled shutdown fails closed to
    // 'account-boundary' in Maker, but the real logout path states it.
    const makerShutdown = bootstrapSource.indexOf(
      "await maker.shutdown({ reason: 'account-boundary' })",
      teardown,
    );
    const joinPrevious = bootstrapSource.indexOf(
      'waitForPreviousScope(',
      makerShutdown,
    );
    const clearAfterJoin = bootstrapSource.indexOf(
      'shouldClearCatalogAfterJoiningPreviousScope(',
      joinPrevious,
    );

    expect(teardown).toBeGreaterThanOrEqual(0);
    expect(suspendHardware).toBeGreaterThan(teardown);
    expect(suspendHardware).toBeLessThan(clearCustomProviders);
    expect(clearCustomProviders).toBeGreaterThan(teardown);
    expect(makerShutdown).toBeGreaterThan(clearCustomProviders);
    expect(joinPrevious).toBeGreaterThan(makerShutdown);
    expect(clearAfterJoin).toBeGreaterThan(joinPrevious);
  });

  it('stops every PI Subagent runner of the outgoing owner at the account boundary', () => {
    const teardown = bootstrapSource.indexOf('async function teardownAuthAccountBoundary');
    const makerShutdown = bootstrapSource.indexOf(
      "await maker.shutdown({ reason: 'account-boundary' })",
      teardown,
    );
    // maker.shutdown only reaches tasks that still hold a live handle. A
    // detached runner whose parent task was closed earlier has none, so the
    // boundary must also sweep the agent home before the owner DB goes away.
    const sweep = bootstrapSource.indexOf('stopAllPiSubagentRunsForExit(', makerShutdown);
    const resetMakerCall = bootstrapSource.indexOf('resetMaker();', sweep);
    const closeDb = bootstrapSource.indexOf('close local DB on', sweep);

    expect(teardown).toBeGreaterThanOrEqual(0);
    expect(makerShutdown).toBeGreaterThan(teardown);
    expect(sweep).toBeGreaterThan(makerShutdown);
    expect(resetMakerCall).toBeGreaterThan(sweep);
    expect(closeDb).toBeGreaterThan(sweep);
  });

  it('refuses Subagent control for a run owned by another live instance', () => {
    // stop / steer / follow_up all fall through to the same control write, so
    // gating once between the resume early-return and that write covers all
    // three. It must sit *before* the write: the point is not to touch another
    // live instance's mailbox at all.
    const handler = makerIpcSource.indexOf('MAKER_INVOKE.CONTROL_PI_SUBAGENT');
    const resumeBranch = makerIpcSource.indexOf("body.action === 'resume'", handler);
    const gate = makerIpcSource.indexOf('canHostControlPiSubagentRun(run, process.pid)', handler);
    const controlWrite = makerIpcSource.indexOf('await controlPiSubagentRuns(', handler);

    expect(handler).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(resumeBranch);
    expect(controlWrite).toBeGreaterThan(gate);
    // Refusal has to reach the user, not fail silently as "0 controlled".
    expect(makerIpcSource).toContain(
      'This Subagent run belongs to another running Cindy instance.',
    );
  });

  it('gates the detached stop fallback on the same ownership check', () => {
    // Both Subagent stop buttons reach STOP_AGENT_TASK, which falls back to
    // enumerating durable runs when no handle is loaded. That fallback bypassed
    // the gate that only guarded CONTROL_PI_SUBAGENT.
    const fallback = makerIpcSource.indexOf('stopDetachedTask: async (sessionId, taskId)');
    const discovery = makerIpcSource.indexOf('await listPiSubagentRuns(runRoot)', fallback);
    const gate = makerIpcSource.indexOf('canHostControlPiSubagentRun(run, process.pid)', fallback);
    const stopWrite = makerIpcSource.indexOf("controlPiSubagentRuns(runRoot, run.runId, 'stop')", fallback);

    expect(fallback).toBeGreaterThanOrEqual(0);
    expect(discovery).toBeGreaterThan(fallback);
    expect(gate).toBeGreaterThan(discovery);
    expect(stopWrite).toBeGreaterThan(gate);
  });

  it('names the quit boundary so it is never mistaken for an ownership change', () => {
    expect(bootstrapSource).toContain("await m.shutdown({ reason: 'app-quit' })");
    expect(bootstrapSource).not.toContain('await m.shutdown();');
  });
});
