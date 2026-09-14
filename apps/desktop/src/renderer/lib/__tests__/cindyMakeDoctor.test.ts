import { afterEach, describe, expect, it, vi } from 'vitest';
import { startMakeDoctor } from '../cindyMakeDoctor';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { MAKE_DOCTOR_CHECK_IDS, type MakeDoctorReport } from '../../../shared/cindyMakeDoctor';

const done = (runId: string): MakeDoctorReport => ({
  runId,
  platform: 'win32',
  arch: 'x64',
  status: 'completed',
  checks: [{ id: 'git', status: 'passed', version: '2.55.0' }],
});
const reports = new Map<string, MakeDoctorReport>();
const onReport = (report: MakeDoctorReport) => reports.set(report.runId, report);
const getMakeDoctorReport = (runId: string) => reports.get(runId);
afterEach(() => {
  setDataOwnerGeneration(null);
  reports.clear();
});

describe('Main-owned progress in the doctor card', () => {
  it('subscribes before starting, isolates run ids, and reconciles from the invoke result', async () => {
    let listener:
      ((event: { command: string; doctorReport: MakeDoctorReport }) => void) | undefined;
    let complete:
      ((result: { success: boolean; doctorReport: MakeDoctorReport }) => void) | undefined;
    const unsubscribe = vi.fn();
    const executeDesktopCommand = vi.fn((_command, ctx) => {
      expect(listener).toBeDefined();
      listener!({
        command: 'cindy-make-doctor',
        doctorReport: { ...done(ctx.doctorRunId), status: 'running' },
      });
      listener!({ command: 'cindy-make-doctor', doctorReport: done('another-run') });
      return new Promise<{ success: boolean; doctorReport: MakeDoctorReport }>((resolve) => {
        complete = resolve;
      });
    });
    const runId = startMakeDoctor(onReport, {
      executeDesktopCommand,
      onDesktopCommandTriggered: (handler) => {
        // Insert the message before Main can emit any progress.
        expect([...reports.values()]).toMatchObject([{ status: 'running', platform: '' }]);
        listener = handler;
        return unsubscribe;
      },
    });
    expect(executeDesktopCommand).toHaveBeenCalledWith('cindy-make-doctor', { doctorRunId: runId });
    expect(getMakeDoctorReport(runId)).toMatchObject({ status: 'running', platform: 'win32' });
    expect(getMakeDoctorReport('another-run')).toBeUndefined();
    // Final push may be missed when the view changes; the returned result is authoritative.
    complete!({ success: true, doctorReport: done(runId) });
    await vi.waitFor(() => expect(getMakeDoctorReport(runId)?.status).toBe('completed'));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('a failed invoke ends the spinner with a recoverable error', async () => {
    const unsubscribe = vi.fn();
    const runId = startMakeDoctor(onReport, {
      executeDesktopCommand: vi.fn().mockRejectedValue(new Error('private diagnostic')),
      onDesktopCommandTriggered: () => unsubscribe,
    });
    await vi.waitFor(() => expect(getMakeDoctorReport(runId)?.status).toBe('failed'));
    expect(JSON.stringify(getMakeDoctorReport(runId))).not.toContain('private');
    expect(
      getMakeDoctorReport(runId)?.checks.some((check) =>
        ['pending', 'checking'].includes(check.status),
      ),
    ).toBe(false);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('late results cannot cross an account change', async () => {
    setDataOwnerGeneration('first');
    let complete:
      ((result: { success: boolean; doctorReport: MakeDoctorReport }) => void) | undefined;
    const unsubscribe = vi.fn();
    const runId = startMakeDoctor(onReport, {
      executeDesktopCommand: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
      onDesktopCommandTriggered: () => unsubscribe,
    });
    setDataOwnerGeneration('second');
    complete!({ success: true, doctorReport: done(runId) });
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalled());
    expect(getMakeDoctorReport(runId)?.status).not.toBe('completed');
  });

  it.each(['source', 'upstream'] as const)(
    'ends the active %s step after an invoke failure without losing completed steps',
    async (step) => {
      let listener!: (event: { command: string; doctorReport: MakeDoctorReport }) => void;
      const unsubscribe = vi.fn();
      const checks = MAKE_DOCTOR_CHECK_IDS.map((id) => ({ id, status: 'passed' as const }));
      const runId = startMakeDoctor(
        onReport,
        {
          onDesktopCommandTriggered: (handler) => {
            listener = handler;
            return unsubscribe;
          },
          executeDesktopCommand: async (_command, ctx) => {
            listener({
              command: 'cindy-make',
              doctorReport: {
                ...done(ctx!.doctorRunId!),
                mode: 'prepare',
                status: 'running',
                checks,
                source:
                  step === 'source'
                    ? {
                        status: 'preparing',
                        path: 'managed-source',
                        progress: { stage: 'receiving', percent: 20 },
                      }
                    : { status: 'ready', path: 'managed-source' },
                upstream: { status: step === 'source' ? 'pending' : 'searching', items: [] },
              },
            });
            throw new Error('private diagnostic');
          },
        },
        'cindy-make',
        { request: 'fix scrolling' },
      );
      await vi.waitFor(() => expect(getMakeDoctorReport(runId)?.status).toBe('failed'));
      expect(getMakeDoctorReport(runId)).toMatchObject({
        checks,
        source: { status: step === 'source' ? 'failed' : 'ready', path: 'managed-source' },
        upstream: { status: step === 'source' ? 'pending' : 'failed' },
      });
      expect(getMakeDoctorReport(runId)?.source?.progress).toBeUndefined();
      expect(JSON.stringify(getMakeDoctorReport(runId))).not.toContain('private diagnostic');
      expect(unsubscribe).toHaveBeenCalledOnce();
    },
  );
});
