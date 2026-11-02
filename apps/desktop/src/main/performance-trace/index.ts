import { app, ipcMain, shell, type BrowserWindow, type WebContents } from 'electron';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  PERFORMANCE_TRACE_CHANNEL,
  PERFORMANCE_TRACE_EVENTS_CHANNEL,
} from '../../shared/performanceTrace';
import {
  activeOwnerScopeKey,
  onAppSessionInvalidated,
  ownerScopedUserDataPath,
} from '../appSessionState';
import { onQuit } from '../lifecycle';
import {
  assertTrustedAppRendererEvent,
  isTrustedAppRendererEvent,
  isTrustedAppRendererWindow,
} from '../security/trustedAppRenderer';
import { throwIpcError } from '../utils/ipcValidate';
import { uploadPerformanceTraceReport } from '../log-upload';
import { generateUploadCode } from '../log-upload/uploadCode';
import { PerformanceTraceController, type TraceCapture } from './controller';
import { beginNativeTrace } from './capture';
import { createTraceCommandHandler, createTraceStatePublisher } from './ipc';
import { readTraceArtifacts } from './artifacts';
import { cleanupTraceReports, startTraceRetention } from './retention';

let registered = false;

export function initPerformanceTraceService(getMainWindow: () => BrowserWindow | null): void {
  if (registered) return;
  registered = true;
  // Capture the owner's path at start; a later account switch must not redirect the save.
  const directories = new Map<string, string>();
  const directory = (id: string) => {
    const result = directories.get(id);
    if (!result) throw new Error('Unknown recording');
    return result;
  };
  let source: WebContents | null = null;
  const controller = new PerformanceTraceController({
    now: Date.now,
    owner: activeOwnerScopeKey,
    reportId: () => generateUploadCode((size) => crypto.randomBytes(size)),
    environment: () => ({
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
    }),
    changed: createTraceStatePublisher({
      getMainWindow,
      isTrustedWindow: isTrustedAppRendererWindow,
    }),
    save: async (report) => {
      const dir = directory(report.reportId);
      await mkdir(dir, { recursive: true });
      const temporary = path.join(dir, 'report.json.tmp');
      await writeFile(temporary, JSON.stringify(report), { mode: 0o600 });
      await rename(temporary, path.join(dir, 'report.json'));
    },
    upload: (report, note) =>
      uploadPerformanceTraceReport(report, note, () =>
        readTraceArtifacts(directory(report.reportId)),
      ),
    reveal: async (id) => {
      shell.showItemInFolder(path.join(directory(id), 'report.json'));
    },
    begin: async (id, startedAt, isCurrent): Promise<TraceCapture> => {
      const sender = source!;
      const root = ownerScopedUserDataPath('diagnostics', 'performance-traces');
      const dir = path.join(root, id);
      directories.clear();
      directories.set(id, dir);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await cleanup();
      if (!isCurrent() || sender.isDestroyed())
        throwIpcError('PRECONDITION_FAILED', 'Recording session changed before capture started');
      return beginNativeTrace({
        dir,
        source: sender,
        startedAt,
        isCurrent,
        onSample: (sample) => controller.sample(sample),
        onEvent: (events) => controller.events(events),
        onStop: () => controller.close(),
      });
    },
  });
  const cleanup = () => {
    const owner = activeOwnerScopeKey();
    return cleanupTraceReports(
      ownerScopedUserDataPath('diagnostics', 'performance-traces'),
      (id) => owner === activeOwnerScopeKey() && controller.releaseExpiredReport(id),
    );
  };
  const stopRetention = startTraceRetention(cleanup);
  ipcMain.handle(
    PERFORMANCE_TRACE_CHANNEL,
    createTraceCommandHandler({
      controller,
      authorize: assertTrustedAppRendererEvent,
      isSource: (event) => source === event.sender,
      isSourceDestroyed: () => source?.isDestroyed() === true,
      isMainWindow: (event) => event.sender === getMainWindow()?.webContents,
      selectSource: (event) => {
        source = event.sender;
      },
      showFolder: async () => {
        const root = ownerScopedUserDataPath('diagnostics', 'performance-traces');
        await mkdir(root, { recursive: true });
        if (await shell.openPath(root))
          throwIpcError('INTERNAL', 'Could not open local recordings');
      },
    }),
  );
  ipcMain.on(PERFORMANCE_TRACE_EVENTS_CHANNEL, (event, values: unknown) => {
    if (
      !isTrustedAppRendererEvent(event) ||
      event.sender !== source ||
      !Array.isArray(values) ||
      values.length > 100
    )
      return;
    controller.events(values);
  });
  onQuit(
    'performance-trace',
    () => {
      stopRetention();
      return controller.close();
    },
    'async',
  );
  onAppSessionInvalidated(() => {
    void controller
      .invalidate()
      .then(cleanup)
      .catch(() => {});
  });
}
