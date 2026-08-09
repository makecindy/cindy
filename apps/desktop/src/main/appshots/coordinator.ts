import fs from 'node:fs/promises';

import {
  coerceAppshotMetadata,
  type AppshotCaptureResult,
  type AppshotMetadata,
} from '../../shared/appshots.js';
import { readBoundedFileNoFollow } from '../utils/readBoundedFile.js';
import type { MacAppshotNativeResult } from './MacAppshotNativeHost.js';

export type AppshotFailureCode =
  | 'unsupported-platform'
  | 'capture-in-progress'
  | 'screen-permission'
  | 'no-window'
  | 'window-closed'
  | 'protected-content'
  | 'native-failure';

export class AppshotCaptureError extends Error {
  constructor(readonly code: AppshotFailureCode) {
    super(code);
    this.name = 'AppshotCaptureError';
  }
}

export interface AppshotCoordinatorDeps {
  captureNative: (outputDir: string) => Promise<MacAppshotNativeResult>;
  ingestPng: (bytes: Uint8Array) => Promise<{ url: string; filename: string }>;
  makeTempDir: () => Promise<string>;
  removeTempDir: (path: string) => Promise<void>;
  now: () => Date;
  randomUUID: () => string;
  publish: (result: AppshotCaptureResult) => void;
}

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PNG_BYTES = 100 * 1024 * 1024;
const MAX_PENDING = 10;

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

function copyResult(result: AppshotCaptureResult): AppshotCaptureResult {
  return {
    captureId: result.captureId,
    image: { ...result.image },
    metadata: { ...result.metadata },
  };
}

function validateNativeMetadata(value: MacAppshotNativeResult): Omit<AppshotMetadata, 'schemaVersion' | 'captureId' | 'capturedAt'> | null {
  const validated = coerceAppshotMetadata({
    schemaVersion: 1,
    captureId: 'native-validation',
    capturedAt: '2026-01-01T00:00:00.000Z',
    applicationName: value.applicationName,
    bundleIdentifier: value.bundleIdentifier,
    windowTitle: value.windowTitle,
    accessibilityText: value.accessibilityText,
    accessibilityTruncated: value.accessibilityTruncated,
    ...(value.accessibilityUnavailableReason === undefined
      ? {}
      : { accessibilityUnavailableReason: value.accessibilityUnavailableReason }),
  });
  if (!validated) return null;
  return {
    applicationName: validated.applicationName,
    bundleIdentifier: validated.bundleIdentifier,
    windowTitle: validated.windowTitle,
    accessibilityText: validated.accessibilityText,
    accessibilityTruncated: validated.accessibilityTruncated,
    ...(validated.accessibilityUnavailableReason === undefined
      ? {}
      : { accessibilityUnavailableReason: validated.accessibilityUnavailableReason }),
  };
}

function appshotFailureCode(error: unknown): AppshotFailureCode {
  if (error instanceof AppshotCaptureError) return error.code;
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return code === 'screen-permission'
    || code === 'no-window'
    || code === 'window-closed'
    || code === 'protected-content'
    || code === 'unsupported-platform'
    || code === 'capture-in-progress'
    || code === 'native-failure'
    ? code
    : 'native-failure';
}

export class AppshotCoordinator {
  private inFlight: Promise<AppshotCaptureResult> | null = null;
  private pending: AppshotCaptureResult[] = [];

  constructor(
    private readonly deps: AppshotCoordinatorDeps,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  capture(): Promise<AppshotCaptureResult> {
    if (this.platform !== 'darwin') return Promise.reject(new AppshotCaptureError('unsupported-platform'));
    if (this.inFlight) return Promise.reject(new AppshotCaptureError('capture-in-progress'));
    const capture = this.captureOne();
    this.inFlight = capture;
    void capture.finally(() => {
      if (this.inFlight === capture) this.inFlight = null;
    }).catch(() => undefined);
    return capture;
  }

  listPending(): readonly AppshotCaptureResult[] {
    return this.pending.map(copyResult);
  }

  ack(captureId: string): boolean {
    if (!captureId) return false;
    const index = this.pending.findIndex((capture) => capture.captureId === captureId);
    if (index < 0) return false;
    this.pending.splice(index, 1);
    return true;
  }

  clear(): void {
    this.pending = [];
  }

  private async captureOne(): Promise<AppshotCaptureResult> {
    let root: string | null = null;
    let result: AppshotCaptureResult | null = null;
    let failure: AppshotCaptureError | null = null;
    try {
      root = await this.deps.makeTempDir();
      const rootRealPath = await fs.realpath(root);
      const native = await this.deps.captureNative(root);
      const metadata = validateNativeMetadata(native);
      if (!metadata || typeof native.pngPath !== 'string' || native.pngPath.length === 0) {
        throw new AppshotCaptureError('native-failure');
      }

      const bytes = await readBoundedFileNoFollow(native.pngPath, MAX_PNG_BYTES, {
        containWithin: rootRealPath,
      });
      if (!bytes || bytes.byteLength === 0 || !isPng(bytes)) {
        throw new AppshotCaptureError('native-failure');
      }
      const image = await this.deps.ingestPng(bytes);
      const captureId = this.deps.randomUUID();
      result = {
        captureId,
        image: { ...image, size: bytes.byteLength, mimeType: 'image/png' },
        metadata: {
          schemaVersion: 1,
          captureId,
          capturedAt: this.deps.now().toISOString(),
          ...metadata,
        },
      };
    } catch (error) {
      failure = new AppshotCaptureError(appshotFailureCode(error));
    }

    if (root !== null) {
      try {
        await this.deps.removeTempDir(root);
      } catch {
        failure ??= new AppshotCaptureError('native-failure');
      }
    }
    if (failure) throw failure;
    if (!result) throw new AppshotCaptureError('native-failure');

    this.pending.push(copyResult(result));
    if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
    try {
      this.deps.publish(copyResult(result));
    } catch {
      // Renderer delivery is best-effort; listPending remains the recovery path.
    }
    return copyResult(result);
  }
}

export type { MacAppshotNativeResult } from './MacAppshotNativeHost.js';
