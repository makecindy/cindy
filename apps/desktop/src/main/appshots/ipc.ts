import type { AppshotCaptureResult } from '../../shared/appshots.js';
import { throwIpcError } from '../utils/ipcValidate.js';

import { AppshotCaptureError, type AppshotFailureCode } from './coordinator.js';

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

export interface AppshotIpcMain {
  handle(channel: string, handler: IpcHandler): void;
}

export interface AppshotIpcCoordinator {
  capture(): Promise<AppshotCaptureResult>;
  listPending(): readonly AppshotCaptureResult[];
  ack(captureId: string): boolean;
}

interface RegisterAppshotIpcDeps {
  ipcMain: AppshotIpcMain;
  coordinator: AppshotIpcCoordinator;
  assertTrustedSender: (event: unknown) => void;
}

function cloneResult(result: AppshotCaptureResult): AppshotCaptureResult {
  return {
    ...result,
    image: { ...result.image },
    metadata: { ...result.metadata },
  };
}

function failureCode(error: unknown): AppshotFailureCode {
  if (error instanceof AppshotCaptureError) return error.code;
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return code === 'capture-in-progress'
    || code === 'unsupported-platform'
    || code === 'screen-permission'
    || code === 'no-window'
    || code === 'window-closed'
    || code === 'protected-content'
    ? code
    : 'native-failure';
}

function throwCaptureIpcError(error: unknown): never {
  const code = failureCode(error);
  const ipcCode = code === 'capture-in-progress'
    ? 'PRECONDITION_FAILED'
    : code === 'unsupported-platform'
      ? 'UNSUPPORTED_CAPABILITY'
      : code === 'screen-permission'
        ? 'PERMISSION_DENIED'
        : 'INTERNAL';
  throwIpcError(ipcCode, `Appshot capture failed: ${code}`);
}

function isValidCaptureId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
}

export function registerAppshotIpc({
  ipcMain,
  coordinator,
  assertTrustedSender,
}: RegisterAppshotIpcDeps): void {
  ipcMain.handle('appshots:capture', async (event, ...args): Promise<{ accepted: true }> => {
    assertTrustedSender(event);
    if (args.length !== 0) throwIpcError('INVALID_PARAMS', 'appshot capture does not accept parameters');
    try {
      await coordinator.capture();
      return { accepted: true };
    } catch (error) {
      return throwCaptureIpcError(error);
    }
  });
  ipcMain.handle('appshots:list-pending', async (event, ...args): Promise<AppshotCaptureResult[]> => {
    assertTrustedSender(event);
    if (args.length !== 0) throwIpcError('INVALID_PARAMS', 'appshot list does not accept parameters');
    return coordinator.listPending().map(cloneResult);
  });
  ipcMain.handle('appshots:ack', async (event, ...args): Promise<{ acknowledged: boolean }> => {
    assertTrustedSender(event);
    if (args.length !== 1) throwIpcError('INVALID_PARAMS', 'appshot ack requires one captureId');
    if (!isValidCaptureId(args[0])) throwIpcError('INVALID_PARAMS', 'captureId is required');
    return { acknowledged: coordinator.ack(args[0]) };
  });
}

interface AppshotPublisherWindow {
  isDestroyed(): boolean;
}

interface AppshotPublisherDeps<TWindow extends AppshotPublisherWindow> {
  getMainWindow: () => TWindow | null;
  isTrustedWindow: (window: TWindow) => boolean;
  send: (window: TWindow, channel: 'appshots:captured', result: AppshotCaptureResult) => void;
  focus: () => void;
}

export function createAppshotPublisher<TWindow extends AppshotPublisherWindow>(
  deps: AppshotPublisherDeps<TWindow>,
): (result: AppshotCaptureResult) => void {
  return (result) => {
    const target = deps.getMainWindow();
    if (!target || target.isDestroyed() || !deps.isTrustedWindow(target)) return;
    deps.send(target, 'appshots:captured', result);
    deps.focus();
  };
}
