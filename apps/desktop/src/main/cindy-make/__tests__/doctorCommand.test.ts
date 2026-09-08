import { describe, expect, it, vi } from 'vitest';
import { createMakeDoctorCommand } from '../doctorCommand.js';
import { DesktopCommandRegistry } from '../../commands/registry.js';
import type { MakeDoctorEnvironment } from '../doctor.js';
import { MAKE_DOCTOR_CHECK_IDS, type MakeDoctorReport } from '../../../shared/cindyMakeDoctor.js';

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
    await expect(
      command.execute({ senderWebContentsId: 2, doctorRunId: 'second' }),
    ).rejects.toThrow('already running');
    finish({ runId: 'first', mode: 'prepare', status: 'completed', checks: [] } as never);
    await expect(pending).resolves.toMatchObject({ doctorReport: { mode: 'prepare' } });
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
    const searchUpstream = vi.fn(async () => ({ status: 'notFound' as const, items: [] }));
    const prepare = vi.fn(async (_id, _env, _signal, publishReport) => {
      publishReport(report);
      return report;
    });
    const command = createMakeDoctorCommand({
      name: 'cindy-make',
      environment,
      publish,
      prepare,
      searchUpstream,
      allowInstallTest: () => true,
      description: () => '',
    });
    return { command, publish, searchUpstream, prepare };
  }
  it('automatically searches after every check passes and publishes the final result', async () => {
    const h = workflow();
    const result = await h.command.execute({
      doctorRunId: 'make',
      senderWebContentsId: 1,
      makeRequest: '滚动闪烁',
      forceManagedTools: true,
    });
    expect(h.searchUpstream).toHaveBeenCalledWith('滚动闪烁', expect.any(AbortSignal));
    const snapshots = h.publish.mock.calls.map(([, report]) => report);
    expect(snapshots.slice(0, -1).every((report) => report.status === 'running')).toBe(true);
    expect(result).toMatchObject({
      doctorReport: { upstream: { status: 'notFound' }, forceManagedTools: true },
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
    },
  );
  it('bare Make asks for a request, while Settings preparation remains environment-only', async () => {
    const h = workflow();
    expect(await h.command.execute({ senderWebContentsId: 1, makeRequest: '' })).toMatchObject({
      doctorReport: { upstream: { status: 'needsRequest' } },
    });
    const result = await h.command.execute({ senderWebContentsId: 1 });
    expect(result).toEqual({ success: true, doctorReport: ready() });
    expect(h.searchUpstream).not.toHaveBeenCalled();
  });
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
