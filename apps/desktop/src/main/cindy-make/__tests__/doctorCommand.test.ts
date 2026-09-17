import { describe, expect, it, vi } from 'vitest';
import { createMakeDoctorCommand } from '../doctorCommand.js';
import { cindyMakeManager } from '../manager.js';
import { DesktopCommandRegistry } from '../../commands/registry.js';
import type { MakeDoctorEnvironment } from '../doctor.js';
import { MAKE_DOCTOR_CHECK_IDS, type MakeDoctorReport } from '../../../shared/cindyMakeDoctor.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function harness() {
  const environment = vi.fn((): MakeDoctorEnvironment => ({
    platform: 'linux',
    arch: 'x64',
    probe: async () => ({ status: 'missing', stdout: '' }),
    native: async () => ({ status: 'missing', stdout: '' }),
    storage: async () => ({ path: '/data', writable: true, freeGiB: 40 }),
  }));
  const publish = vi.fn();
  const registry = new DesktopCommandRegistry();
  registry.register(
    createMakeDoctorCommand({ environment, publish, description: () => 'Check local tools' }),
  );
  return { environment, publish, registry };
}

describe('/cindy-make-doctor command', () => {
  it('Doctor remains check-only even if a preparer is available', async () => {
    const { environment } = harness();
    const prepare = vi.fn();
    const command = createMakeDoctorCommand({
      environment,
      prepare,
      publish: vi.fn(),
      description: () => '',
    });
    await command.execute({ senderWebContentsId: 1 });
    expect(prepare).not.toHaveBeenCalled();
  });
  it('Make invokes preparation and prevents a second preparation from racing the first', async () => {
    const { environment } = harness();
    let finish!: (report: never) => void;
    const prepare = vi.fn(
      () =>
        new Promise<never>((resolve) => {
          finish = resolve;
        }),
    );
    const command = createMakeDoctorCommand({
      name: 'cindy-make',
      environment,
      prepare,
      publish: vi.fn(),
      description: () => '',
    });
    const pending = command.execute({ senderWebContentsId: 1, doctorRunId: 'first' });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    const attached = command.execute({ senderWebContentsId: 2, doctorRunId: 'second' });
    // A source-only run is global and may coexist with tool provisioning: it is
    // not rejected as busy but runs to its own outcome (unavailable here, so failed).
    await expect(
      command.execute({
        senderWebContentsId: 2,
        doctorRunId: 'source',
        makeAction: 'prepare-source',
      }),
    ).resolves.toMatchObject({ doctorReport: { runId: 'source', status: 'failed' } });
    finish({ runId: 'first', mode: 'prepare', status: 'completed', checks: [] } as never);
    await expect(pending).resolves.toMatchObject({ doctorReport: { mode: 'prepare' } });
    await expect(attached).resolves.toMatchObject({
      doctorReport: { runId: 'second', mode: 'prepare' },
    });
  });
  it('is discoverable and returns the same terminal snapshot as progress', async () => {
    const { registry, publish } = harness();
    expect(registry.list()).toContainEqual({
      name: 'cindy-make-doctor',
      kind: 'desktop',
      description: 'Check local tools',
    });
    const result = await registry.execute('cindy-make-doctor', {
      senderWebContentsId: 1,
      doctorRunId: 'abc',
    });
    expect(result).toMatchObject({ success: true, doctorReport: publish.mock.calls.at(-1)?.[1] });
  });
  it.each([
    { deviceId: 'remote' },
    { remoteHostId: 'ssh' },
    { args: 'fix bug' },
    { doctorRunId: '../escape' },
    { doctorAction: 'install' },
    { forceManagedTools: 'true' },
  ])('rejects unsupported or invalid context before running tools: %j', async (extra) => {
    const { registry, environment, publish } = harness();
    await expect(
      registry.execute('cindy-make-doctor', { senderWebContentsId: 1, ...extra } as never),
    ).rejects.toThrow();
    expect(environment).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
  it('requires an invoking Desktop window', async () => {
    const { registry, environment } = harness();
    await expect(registry.execute('cindy-make-doctor', {})).rejects.toThrow('INVALID_PARAMS');
    expect(environment).not.toHaveBeenCalled();
  });

  it('rejects the test switch outside development before probing or installing', async () => {
    const { environment } = harness();
    const prepare = vi.fn();
    const command = createMakeDoctorCommand({
      name: 'cindy-make',
      environment,
      prepare,
      publish: vi.fn(),
      description: () => '',
      allowInstallTest: () => false,
    });
    await expect(
      command.execute({ senderWebContentsId: 1, forceManagedTools: true }),
    ).rejects.toThrow('UNSUPPORTED_CAPABILITY');
    expect(environment).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('uses the explicit test option for discovery, labels results, and keeps Doctor read-only', async () => {
    const { environment } = harness();
    const publish = vi.fn();
    const prepare = vi.fn();
    const command = createMakeDoctorCommand({
      environment,
      prepare,
      publish,
      description: () => '',
      allowInstallTest: () => true,
    });
    const result = await command.execute({ senderWebContentsId: 1, forceManagedTools: true });
    expect(environment).toHaveBeenCalledWith(expect.objectContaining({ forceManagedTools: true }));
    expect(result).toMatchObject({ doctorReport: { forceManagedTools: true } });
    expect(publish.mock.calls.every(([, report]) => report.forceManagedTools)).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
  });
  it('only the invoking window can cancel a run; cancellation releases capacity', async () => {
    const { registry, environment } = harness();
    environment.mockReturnValue({
      platform: 'linux',
      arch: 'x64',
      probe: (_name, _args, signal) =>
        new Promise((resolve) =>
          signal.addEventListener('abort', () => resolve({ status: 'failed', stdout: '' }), {
            once: true,
          }),
        ),
      native: vi.fn(),
      storage: vi.fn(),
    });
    const pending = registry.execute('cindy-make-doctor', {
      senderWebContentsId: 1,
      doctorRunId: 'active',
    });
    await expect(
      registry.execute('cindy-make-doctor', {
        senderWebContentsId: 2,
        doctorRunId: 'active',
        doctorAction: 'cancel',
      }),
    ).rejects.toThrow('another window');
    await expect(
      registry.execute('cindy-make-doctor', { senderWebContentsId: 1, doctorRunId: 'active' }),
    ).rejects.toThrow('already running');
    await registry.execute('cindy-make-doctor', {
      senderWebContentsId: 1,
      doctorRunId: 'active',
      doctorAction: 'cancel',
    });
    await expect(pending).resolves.toMatchObject({ doctorReport: { status: 'cancelled' } });
    expect(environment).toHaveBeenCalledTimes(1);
  });
});

describe('Make upstream workflow', () => {
  const ready = (): MakeDoctorReport => ({
    runId: 'make',
    platform: 'win32',
    arch: 'x64',
    mode: 'prepare',
    status: 'completed',
    checks: MAKE_DOCTOR_CHECK_IDS.map((id) => ({ id, status: 'passed' })),
  });
  function workflow(report = ready()) {
    const { environment } = harness();
    const publish = vi.fn();
    const searchUpstream = vi.fn(async (_request: string, _signal: AbortSignal) => ({
      status: 'notFound' as const,
      items: [],
    }));
    const prepare = vi.fn(async (_id, _env, _signal, publishReport) => {
      publishReport(report);
      return report;
    });
    const prepareSource = vi.fn(
      async (_id, _env, _signal, publishReport): Promise<MakeDoctorReport> => {
        const sourceReport: MakeDoctorReport = {
          ...report,
          checks: [],
          source: { status: 'ready', path: 'managed-source', ref: 'main', commit: 'abc1234' },
        };
        publishReport(sourceReport);
        return sourceReport;
      },
    );
    const command = createMakeDoctorCommand({
      name: 'cindy-make',
      environment,
      publish,
      prepare,
      prepareSource,
      searchUpstream,
      allowInstallTest: () => true,
      description: () => '',
    });
    return { command, environment, publish, searchUpstream, prepare, prepareSource };
  }
  it('automatically prepares source after checks, then searches and retains all step results', async () => {
    const h = workflow();
    const result = await h.command.execute({
      doctorRunId: 'make',
      senderWebContentsId: 1,
      makeRequest: '滚动闪烁',
      forceManagedTools: true,
    });
    expect(h.searchUpstream).toHaveBeenCalledWith('滚动闪烁', expect.any(AbortSignal));
    expect(h.prepareSource).toHaveBeenCalledOnce();
    const snapshots = h.publish.mock.calls.map(([, report]) => report);
    expect(snapshots.slice(0, -1).every((report) => report.status === 'running')).toBe(true);
    expect(result).toMatchObject({
      doctorReport: {
        checks: ready().checks,
        source: { status: 'ready', path: 'managed-source', commit: 'abc1234' },
        upstream: { status: 'notFound' },
        forceManagedTools: true,
      },
    });
    expect(result).toMatchObject({ doctorReport: snapshots.at(-1) });
  });
  it.each(['missing', 'warning', 'failed', 'cancelled', 'absent', 'empty'])(
    'blocks search when a prerequisite is %s',
    async (status) => {
      const report = ready();
      if (status === 'empty') report.checks = [];
      else if (status === 'absent') report.checks.pop();
      else report.checks[0].status = status as 'missing' | 'warning' | 'failed' | 'cancelled';
      const h = workflow(report);
      await h.command.execute({ senderWebContentsId: 1, makeRequest: 'scrolling' });
      expect(h.searchUpstream).not.toHaveBeenCalled();
      expect(h.prepareSource).not.toHaveBeenCalled();
    },
  );
  it('bare Make asks for a request, while Settings preparation remains environment-only', async () => {
    const h = workflow();
    expect(await h.command.execute({ senderWebContentsId: 1, makeRequest: '' })).toMatchObject({
      doctorReport: { upstream: { status: 'needsRequest' } },
    });
    const result = await h.command.execute({ senderWebContentsId: 1, doctorRunId: 'make' });
    expect(result).toEqual({ success: true, doctorReport: ready() });
    expect(h.searchUpstream).not.toHaveBeenCalled();
    expect(h.prepareSource).not.toHaveBeenCalled();
  });
  it.each(['settings', 'workflow'])(
    'shares only the environment when %s starts first',
    async (first) => {
      const setup = workflow();
      const environment = deferred<MakeDoctorReport>();
      const source = deferred<MakeDoctorReport>();
      setup.prepare.mockImplementationOnce(() => environment.promise);
      setup.prepareSource.mockImplementationOnce(() => source.promise);
      const startSettings = () =>
        setup.command.execute({
          senderWebContentsId: 1,
          doctorRunId: 'settings-shared',
        });
      const startWorkflow = () =>
        setup.command.execute({
          senderWebContentsId: 2,
          doctorRunId: 'workflow-shared',
          makeRequest: 'scrolling',
        });
      const firstRun = first === 'settings' ? startSettings() : startWorkflow();
      await vi.waitFor(() => expect(setup.prepare).toHaveBeenCalledOnce());
      const secondRun = first === 'settings' ? startWorkflow() : startSettings();
      const settingsRun = first === 'settings' ? firstRun : secondRun;
      const workflowRun = first === 'workflow' ? firstRun : secondRun;
      let workflowFinished = false;
      void Promise.resolve(workflowRun).then(() => {
        workflowFinished = true;
      });
      environment.resolve(ready());
      await expect(settingsRun).resolves.toMatchObject({
        doctorReport: { runId: 'settings-shared', status: 'completed', checks: ready().checks },
      });
      await vi.waitFor(() => expect(setup.prepareSource).toHaveBeenCalledOnce());
      expect(workflowFinished).toBe(false);
      expect(setup.environment).toHaveBeenCalledOnce();
      expect(setup.prepare).toHaveBeenCalledOnce();
      expect(setup.prepareSource.mock.calls[0][1]).toBe(setup.prepare.mock.calls[0][1]);
      const snapshot = cindyMakeManager.getState().environmentPrepare;
      expect(snapshot).toMatchObject({ active: false, report: { status: 'completed' } });
      expect(snapshot?.report.source).toBeUndefined();
      expect(snapshot?.report.upstream).toBeUndefined();
      expect(
        setup.publish.mock.calls
          .filter(([context]) => context.senderWebContentsId === 2)
          .every(([, report]) => report.runId === 'workflow-shared' && report.status === 'running'),
      ).toBe(true);
      source.resolve({
        ...ready(),
        checks: [],
        source: { status: 'ready', path: 'managed-source' },
      });
      await expect(workflowRun).resolves.toMatchObject({
        doctorReport: {
          runId: 'workflow-shared',
          status: 'completed',
          source: { status: 'ready' },
          upstream: { status: 'notFound' },
        },
      });
      expect(setup.searchUpstream).toHaveBeenCalledWith('scrolling', expect.any(AbortSignal));
      expect(cindyMakeManager.getState().environmentPrepare).toEqual(snapshot);
    },
  );

  it('continues two distinct requests independently after one shared preparation', async () => {
    const setup = workflow();
    const environment = deferred<MakeDoctorReport>();
    setup.prepare.mockImplementationOnce(() => environment.promise);
    setup.searchUpstream.mockImplementation(async (request: string) => ({
      status: 'notFound',
      items: [],
      terms: [request],
    }));
    const first = setup.command.execute({
      senderWebContentsId: 1,
      doctorRunId: 'scrolling',
      makeRequest: 'fix scrolling',
    });
    await vi.waitFor(() => expect(setup.prepare).toHaveBeenCalledOnce());
    const second = setup.command.execute({
      senderWebContentsId: 2,
      doctorRunId: 'keyboard',
      makeRequest: 'fix keyboard',
    });
    environment.resolve(ready());
    const results = await Promise.all([first, second]);
    expect(results).toMatchObject([
      { doctorReport: { runId: 'scrolling', upstream: { terms: ['fix scrolling'] } } },
      { doctorReport: { runId: 'keyboard', upstream: { terms: ['fix keyboard'] } } },
    ]);
    expect(setup.environment).toHaveBeenCalledOnce();
    expect(setup.prepare).toHaveBeenCalledOnce();
    expect(setup.prepareSource).toHaveBeenCalledTimes(2);
    expect(setup.prepareSource.mock.calls.map(([runId]) => runId).sort()).toEqual([
      'keyboard',
      'scrolling',
    ]);
    expect(
      setup.prepareSource.mock.calls.every(([, env]) => env === setup.prepare.mock.calls[0][1]),
    ).toBe(true);
    expect(setup.searchUpstream).toHaveBeenCalledTimes(2);
    for (const [context, report] of setup.publish.mock.calls) {
      expect(report.runId).toBe(context.doctorRunId);
      if (report.upstream?.terms) expect(report.upstream.terms).toEqual([context.makeRequest]);
    }
  });

  it.each(['canonical', 'attached'])(
    'allows a trusted settings observer or attached caller to explicitly cancel using %s',
    async (target) => {
      const setup = workflow();
      setup.prepare.mockImplementationOnce(async (_runId, _env, signal: AbortSignal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return ready();
      });
      const first = setup.command.execute({ senderWebContentsId: 1, doctorRunId: 'canonical' });
      await vi.waitFor(() => expect(setup.prepare).toHaveBeenCalledOnce());
      const attached = setup.command.execute({
        senderWebContentsId: 2,
        doctorRunId: 'attached',
        makeRequest: 'scrolling',
      });
      const snapshot = cindyMakeManager.getState().environmentPrepare;
      expect(snapshot).toMatchObject({ active: true, report: { runId: 'canonical' } });
      await setup.command.execute({
        senderWebContentsId: target === 'canonical' ? 99 : 2,
        doctorRunId: target === 'canonical' ? snapshot!.report.runId : 'attached',
        doctorAction: 'cancel',
      });
      await expect(first).resolves.toMatchObject({ doctorReport: { status: 'cancelled' } });
      await expect(attached).resolves.toMatchObject({
        doctorReport: { runId: 'attached', status: 'cancelled' },
      });
      expect(setup.prepareSource).not.toHaveBeenCalled();
      expect(setup.searchUpstream).not.toHaveBeenCalled();
      expect(cindyMakeManager.getState().environmentPrepare).toMatchObject({
        active: false,
        report: { status: 'cancelled' },
      });
      await expect(
        setup.command.execute({ senderWebContentsId: 2, doctorRunId: 'attached' }),
      ).resolves.toMatchObject({ doctorReport: { status: 'completed' } });
    },
  );

  it.each([{ remoteHostId: 'ssh' }, { deviceId: 'device' }, { senderWebContentsId: undefined }])(
    'does not admit an untrusted or remote cancellation context: %j',
    async (extra) => {
      const setup = workflow();
      const environment = deferred<MakeDoctorReport>();
      setup.prepare.mockImplementationOnce(() => environment.promise);
      const pending = setup.command.execute({
        senderWebContentsId: 1,
        doctorRunId: 'trusted-only',
      });
      await vi.waitFor(() => expect(setup.prepare).toHaveBeenCalledOnce());
      try {
        await expect(
          setup.command.execute({
            senderWebContentsId: 99,
            doctorRunId: 'trusted-only',
            doctorAction: 'cancel',
            ...extra,
          }),
        ).rejects.toThrow();
        expect(setup.prepare.mock.calls[0][2].aborted).toBe(false);
      } finally {
        environment.resolve(ready());
        await pending;
      }
    },
  );

  it('shares environment failure without starting either workflow and allows a retry', async () => {
    const setup = workflow();
    const environment = deferred<MakeDoctorReport>();
    setup.prepare.mockImplementationOnce(() => environment.promise);
    const first = setup.command.execute({
      senderWebContentsId: 1,
      doctorRunId: 'failed-first',
      makeRequest: 'scrolling',
    });
    await vi.waitFor(() => expect(setup.prepare).toHaveBeenCalledOnce());
    const second = setup.command.execute({
      senderWebContentsId: 2,
      doctorRunId: 'failed-second',
      makeRequest: 'keyboard',
    });
    environment.reject(new Error('tool preparation failed'));
    await expect(first).resolves.toMatchObject({ doctorReport: { status: 'failed' } });
    await expect(second).resolves.toMatchObject({ doctorReport: { status: 'failed' } });
    expect(setup.prepareSource).not.toHaveBeenCalled();
    await expect(
      setup.command.execute({
        senderWebContentsId: 2,
        doctorRunId: 'failed-second',
        makeRequest: 'retry',
      }),
    ).resolves.toMatchObject({
      doctorReport: { status: 'completed', upstream: { status: 'notFound' } },
    });
  });

  it('shares an environment timeout with attached callers and releases the operation', async () => {
    vi.useFakeTimers();
    try {
      const setup = workflow();
      setup.prepare.mockImplementationOnce(async (_runId, _env, signal: AbortSignal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return ready();
      });
      const first = setup.command.execute({ senderWebContentsId: 1, doctorRunId: 'timeout-first' });
      await vi.waitFor(() => expect(setup.prepare).toHaveBeenCalledOnce());
      const attached = setup.command.execute({
        senderWebContentsId: 2,
        doctorRunId: 'timeout-attached',
        makeRequest: 'scrolling',
      });
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      await expect(first).resolves.toMatchObject({ doctorReport: { status: 'failed' } });
      await expect(attached).resolves.toMatchObject({ doctorReport: { status: 'failed' } });
      expect(setup.prepareSource).not.toHaveBeenCalled();
      expect(setup.searchUpstream).not.toHaveBeenCalled();
      expect(cindyMakeManager.getState().environmentPrepare).toMatchObject({
        active: false,
        report: { status: 'failed' },
      });
      await expect(
        setup.command.execute({
          senderWebContentsId: 2,
          doctorRunId: 'timeout-attached',
          makeRequest: 'retry',
        }),
      ).resolves.toMatchObject({
        doctorReport: { status: 'completed', upstream: { status: 'notFound' } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels one workflow continuation without cancelling the other request', async () => {
    const setup = workflow();
    const environment = deferred<MakeDoctorReport>();
    const firstSearch = deferred<{ status: 'notFound'; items: never[] }>();
    const secondSearch = deferred<{ status: 'notFound'; items: never[] }>();
    setup.prepare.mockImplementationOnce(() => environment.promise);
    setup.searchUpstream.mockImplementation((request: string) =>
      request === 'scrolling' ? firstSearch.promise : secondSearch.promise,
    );
    const first = setup.command.execute({
      senderWebContentsId: 1,
      doctorRunId: 'private-first',
      makeRequest: 'scrolling',
    });
    await vi.waitFor(() => expect(setup.prepare).toHaveBeenCalledOnce());
    const second = setup.command.execute({
      senderWebContentsId: 2,
      doctorRunId: 'private-second',
      makeRequest: 'keyboard',
    });
    environment.resolve(ready());
    await vi.waitFor(() => expect(setup.searchUpstream).toHaveBeenCalledTimes(2));
    await expect(
      setup.command.execute({
        senderWebContentsId: 99,
        doctorRunId: 'private-first',
        doctorAction: 'cancel',
      }),
    ).rejects.toThrow('another window');
    await setup.command.execute({
      senderWebContentsId: 1,
      doctorRunId: 'private-first',
      doctorAction: 'cancel',
    });
    await expect(first).resolves.toMatchObject({
      doctorReport: {
        runId: 'private-first',
        status: 'cancelled',
        upstream: { status: 'cancelled' },
      },
    });
    const secondSignal = setup.searchUpstream.mock.calls.find(
      ([request]) => request === 'keyboard',
    )?.[1];
    expect(secondSignal?.aborted).toBe(false);
    secondSearch.resolve({ status: 'notFound', items: [] });
    await expect(second).resolves.toMatchObject({
      doctorReport: {
        runId: 'private-second',
        status: 'completed',
        upstream: { status: 'notFound' },
      },
    });
    const publishCount = setup.publish.mock.calls.length;
    firstSearch.resolve({ status: 'notFound', items: [] });
    await Promise.resolve();
    expect(setup.publish).toHaveBeenCalledTimes(publishCount);
  });
  it('waits for each step before starting the next and preserves environment checks during checkout', async () => {
    const h = workflow();
    let finishEnvironment!: (report: MakeDoctorReport) => void;
    let finishSource!: (report: MakeDoctorReport) => void;
    h.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishEnvironment = resolve;
        }),
    );
    h.prepareSource.mockImplementationOnce((_id, _env, _signal, publishReport) => {
      publishReport({
        ...ready(),
        status: 'running',
        checks: [],
        source: { status: 'preparing', path: 'managed-source' },
      });
      return new Promise((resolve) => {
        finishSource = resolve;
      });
    });
    const pending = h.command.execute({
      doctorRunId: 'make',
      senderWebContentsId: 1,
      makeRequest: 'scrolling',
    });
    await vi.waitFor(() => expect(h.prepare).toHaveBeenCalledOnce());
    expect(h.prepareSource).not.toHaveBeenCalled();
    expect(h.searchUpstream).not.toHaveBeenCalled();
    finishEnvironment(ready());
    await vi.waitFor(() => expect(h.prepareSource).toHaveBeenCalled());
    expect(h.prepareSource).toHaveBeenCalledWith(
      'make',
      expect.anything(),
      expect.any(AbortSignal),
      expect.any(Function),
    );
    await vi.waitFor(() => expect(h.prepareSource).toHaveBeenCalledOnce());
    expect(h.searchUpstream).not.toHaveBeenCalled();
    expect(h.publish.mock.calls.at(-1)?.[1]).toMatchObject({
      status: 'running',
      checks: ready().checks,
      source: { status: 'preparing' },
      upstream: { status: 'pending' },
    });
    expect(cindyMakeManager.getState().reports?.make).toMatchObject({
      status: 'running',
      checks: ready().checks,
      source: { status: 'preparing' },
      upstream: { status: 'pending' },
    });
    finishSource({ ...ready(), checks: [], source: { status: 'ready', path: 'managed-source' } });
    await expect(pending).resolves.toMatchObject({
      doctorReport: { upstream: { status: 'notFound' } },
    });
    expect(h.searchUpstream).toHaveBeenCalledOnce();
  });
  it.each(['failed', 'cancelled', 'missing', 'pending', 'empty-path', 'throw'])(
    'stops before search when source preparation is %s',
    async (outcome) => {
      const h = workflow();
      h.prepareSource.mockImplementationOnce(async () => {
        if (outcome === 'throw') throw new Error('checkout failed');
        return {
          ...ready(),
          checks: [],
          status:
            outcome === 'cancelled' ? 'cancelled' : outcome === 'failed' ? 'failed' : 'completed',
          source: {
            status:
              outcome === 'empty-path'
                ? 'ready'
                : (outcome as 'failed' | 'cancelled' | 'missing' | 'pending'),
            path: outcome === 'empty-path' ? '' : 'managed-source',
            ...(outcome === 'failed' ? { error: 'tagNotFound' as const } : {}),
          },
        };
      });
      const result = await h.command.execute({
        doctorRunId: 'make',
        senderWebContentsId: 1,
        makeRequest: 'scrolling',
      });
      const status = outcome === 'cancelled' ? 'cancelled' : 'failed';
      expect(result).toMatchObject({
        doctorReport: {
          status,
          checks: ready().checks,
          upstream: { status: 'pending' },
          source: { status },
        },
      });
      if (outcome === 'failed')
        expect(result).toMatchObject({ doctorReport: { source: { error: 'tagNotFound' } } });
      expect(h.searchUpstream).not.toHaveBeenCalled();
    },
  );
  it.each(['cancel', 'timeout'])(
    'handles %s during source preparation without searching or accepting late progress',
    async (action) => {
      vi.useFakeTimers();
      try {
        const h = workflow();
        let finishSource!: (report: MakeDoctorReport) => void;
        let publishSource!: (report: MakeDoctorReport) => void;
        h.prepareSource.mockImplementationOnce((_id, _env, _signal, publishReport) => {
          publishSource = publishReport;
          return new Promise((resolve) => {
            finishSource = resolve;
          });
        });
        const pending = h.command.execute({
          doctorRunId: 'make',
          senderWebContentsId: 1,
          makeRequest: 'scrolling',
        });
        await vi.waitFor(() => expect(h.prepareSource).toHaveBeenCalledOnce());
        if (action === 'cancel') {
          await h.command.execute({
            doctorRunId: 'make',
            senderWebContentsId: 1,
            doctorAction: 'cancel',
          });
        } else {
          await vi.advanceTimersByTimeAsync(20 * 60_000);
        }
        const status = action === 'cancel' ? 'cancelled' : 'failed';
        await expect(pending).resolves.toMatchObject({
          doctorReport: { status, source: { status }, checks: ready().checks },
        });
        expect(h.searchUpstream).not.toHaveBeenCalled();
        const count = h.publish.mock.calls.length;
        const late = {
          ...ready(),
          checks: [],
          source: { status: 'ready' as const, path: 'managed-source' },
        };
        publishSource(late);
        finishSource(late);
        await Promise.resolve();
        expect(h.publish).toHaveBeenCalledTimes(count);
        await expect(
          h.command.execute({ senderWebContentsId: 1, makeRequest: 'retry' }),
        ).resolves.toMatchObject({ doctorReport: { upstream: { status: 'notFound' } } });
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it('stops a search, releases capacity and ignores its late completion', async () => {
    const h = workflow();
    let resolve!: (value: { status: 'notFound'; items: never[] }) => void;
    h.searchUpstream.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = h.command.execute({
      doctorRunId: 'make',
      senderWebContentsId: 1,
      makeRequest: 'scrolling',
    });
    await vi.waitFor(() => expect(h.searchUpstream).toHaveBeenCalled());
    await expect(
      h.command.execute({ doctorRunId: 'make', senderWebContentsId: 2, doctorAction: 'cancel' }),
    ).rejects.toThrow('another window');
    await h.command.execute({
      doctorRunId: 'make',
      senderWebContentsId: 1,
      doctorAction: 'cancel',
    });
    expect(await pending).toMatchObject({
      doctorReport: { status: 'cancelled', upstream: { status: 'cancelled' } },
    });
    const count = h.publish.mock.calls.length;
    resolve({ status: 'notFound', items: [] });
    await Promise.resolve();
    expect(h.publish).toHaveBeenCalledTimes(count);
    expect(
      await h.command.execute({ senderWebContentsId: 1, makeRequest: 'scrolling' }),
    ).toMatchObject({ doctorReport: { upstream: { status: 'notFound' } } });
  });
});

describe('Make source preparation action', () => {
  const readyEnvironment = (): MakeDoctorEnvironment => ({
    platform: 'win32',
    arch: 'x64',
    probe: async (command, args) => {
      const stdout =
        command === 'git' && args[0] === 'lfs'
          ? 'git-lfs/3.5.0'
          : command === 'git'
            ? 'git version 2.45.0'
            : command === 'node'
              ? 'v22.12.0'
              : command === 'pnpm'
                ? '10.7.0'
                : 'Python 3.9.0';
      return { status: 'ok', stdout, path: `C:\\tools\\${command}.exe` };
    },
    native: async () => ({ status: 'ok', stdout: '', path: 'C:\\BuildTools' }),
    storage: async () => ({ path: 'C:\\', writable: true, freeGiB: 40 }),
  });

  function commandWith(
    environment: MakeDoctorEnvironment,
    prepareSource: Parameters<typeof createMakeDoctorCommand>[0]['prepareSource'],
  ) {
    const publish = vi.fn();
    const command = createMakeDoctorCommand({
      name: 'cindy-make',
      environment: () => environment,
      prepareSource,
      publish,
      description: () => '',
    });
    return { command, publish };
  }

  it('prepares source without running or publishing a full environment check', async () => {
    const prepareSource = vi.fn(async (runId, env, _signal, publishReport) => {
      const report: MakeDoctorReport = {
        runId,
        platform: env.platform,
        arch: env.arch,
        mode: 'prepare',
        status: 'completed',
        checks: [],
        source: { status: 'ready', path: 'C:\\cindy-make\\source', ref: 'main' },
      };
      publishReport(report);
      return report;
    });
    const environment = readyEnvironment();
    environment.probe = vi.fn();
    environment.native = vi.fn();
    environment.storage = vi.fn();
    const h = commandWith(environment, prepareSource);
    const result = await h.command.execute({
      senderWebContentsId: 1,
      doctorRunId: 'source-ready',
      makeRequest: '修复消息流闪烁',
      makeAction: 'prepare-source',
    });
    expect(prepareSource).toHaveBeenCalledTimes(1);
    expect(environment.probe).not.toHaveBeenCalled();
    expect(environment.native).not.toHaveBeenCalled();
    expect(environment.storage).not.toHaveBeenCalled();
    for (const [, report] of h.publish.mock.calls) {
      expect(report.checks).toEqual([]);
      expect(report.upstream).toBeUndefined();
    }
    expect(result).toMatchObject({
      doctorReport: { status: 'completed', source: { status: 'ready' } },
    });
  });

  it('allows Settings to prepare source without a chat request', async () => {
    const prepareSource = vi.fn(async (runId, env) => ({
      runId,
      platform: env.platform,
      arch: env.arch,
      mode: 'prepare' as const,
      status: 'completed' as const,
      checks: MAKE_DOCTOR_CHECK_IDS.map((id) => ({ id, status: 'passed' as const })),
      source: { status: 'ready' as const, path: 'C:\\cindy-make\\source', ref: 'main' },
    }));
    const h = commandWith(readyEnvironment(), prepareSource);
    const result = await h.command.execute({
      senderWebContentsId: 1,
      doctorRunId: 'settings-source',
      makeAction: 'prepare-source',
    });
    expect(prepareSource).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      doctorReport: { status: 'completed', source: { status: 'ready' } },
    });
  });

  it('clears source without running environment checks or re-pulling', async () => {
    const prepareSource = vi.fn(async (runId, env) => ({
      runId,
      platform: env.platform,
      arch: env.arch,
      mode: 'prepare' as const,
      status: 'completed' as const,
      checks: MAKE_DOCTOR_CHECK_IDS.map((id) => ({ id, status: 'passed' as const })),
      source: { status: 'missing' as const, path: 'C:\\cindy-make\\source' },
    }));
    const h = commandWith(readyEnvironment(), prepareSource);
    const result = await h.command.execute({
      senderWebContentsId: 1,
      doctorRunId: 'source-clear',
      makeAction: 'clear-source',
    });
    expect(prepareSource).toHaveBeenCalledWith(
      'source-clear',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { clearOnly: true },
    );
    expect(result).toMatchObject({
      doctorReport: { status: 'completed', source: { status: 'missing' } },
    });
  });

  it('returns a Git-specific failure from source preparation without checking build prerequisites', async () => {
    const prepareSource = vi.fn(async (runId, env) => ({
      runId,
      platform: env.platform,
      arch: env.arch,
      mode: 'prepare' as const,
      status: 'failed' as const,
      checks: [],
      source: { status: 'failed' as const, path: '', error: 'gitUnavailable' as const },
    }));
    const environment = readyEnvironment();
    environment.probe = async () => ({ status: 'missing', stdout: '' });
    const h = commandWith(environment, prepareSource);
    const result = (await h.command.execute({
      senderWebContentsId: 1,
      doctorRunId: 'source-blocked',
      makeRequest: '修复消息流闪烁',
      makeAction: 'prepare-source',
    })) as { doctorReport: MakeDoctorReport };
    expect(prepareSource).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      doctorReport: { status: 'failed', checks: [], source: { error: 'gitUnavailable' } },
    });
  });

  it('returns cancelled when source preparation is cancelled', async () => {
    const prepareSource = vi.fn(
      async (_runId, _env, signal) =>
        await new Promise<MakeDoctorReport>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        }),
    );
    const h = commandWith(readyEnvironment(), prepareSource);
    const pending = h.command.execute({
      senderWebContentsId: 1,
      doctorRunId: 'source-cancel',
      makeRequest: '修复消息流闪烁',
      makeAction: 'prepare-source',
    });
    await vi.waitFor(() => expect(prepareSource).toHaveBeenCalledTimes(1));
    await h.command.execute({
      senderWebContentsId: 1,
      doctorRunId: 'source-cancel',
      doctorAction: 'cancel',
    });
    await expect(pending).resolves.toMatchObject({ doctorReport: { status: 'cancelled' } });
  });

  it('returns failed when source preparation throws', async () => {
    const prepareSource = vi.fn(async () => {
      throw new Error('checkout failed');
    });
    const h = commandWith(readyEnvironment(), prepareSource);
    const result = await h.command.execute({
      senderWebContentsId: 1,
      doctorRunId: 'source-failed',
      makeRequest: '修复消息流闪烁',
      makeAction: 'prepare-source',
    });
    expect(result).toMatchObject({ doctorReport: { status: 'failed' } });
  });
});
