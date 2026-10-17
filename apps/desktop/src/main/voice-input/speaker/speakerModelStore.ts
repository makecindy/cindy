import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  SPEAKER_MODEL_ASSETS,
  SPEAKER_MODEL_TOTAL_BYTES,
  speakerModelAsset,
  speakerModelCdnPath,
  speakerModelLocalName,
  type SpeakerModelAsset,
} from '@cindy/voice-input-core';

import { DownloadError, createDownloader, type DownloadOptions, type DownloadResult } from '../../downloader';
import type { VoiceSpeakerFilterStatus } from '../../../shared/voiceSpeakerFilter';

export type SpeakerModelPaths = { vadModel: string; embeddingModel: string };

type ModelState = Pick<VoiceSpeakerFilterStatus, 'modelState' | 'downloadedBytes' | 'totalBytes' | 'downloadError'>;

type SpeakerModelStoreOptions = {
  /** Directory owned by this store; models are shared by every account. */
  dir: () => string;
  cdnBaseUrl: () => string;
  download?: (options: DownloadOptions) => Promise<DownloadResult>;
  onChange?: () => void;
  logger?: { info(message: string, meta?: unknown): void; warn(message: string, meta?: unknown): void };
};

/**
 * Downloads the speaker-gate models on demand and reports where they are.
 *
 * Files are fetched from the region CDN by content hash. Cached files must
 * also pass SHA-256 before use; size alone cannot detect local corruption.
 * Verification is reused while the file identity and timestamps are unchanged,
 * keeping status polls and audio chunks from repeatedly hashing the models.
 * One download runs at a time; asking again while it runs joins it.
 */
export class SpeakerModelStore {
  private readonly download: (options: DownloadOptions) => Promise<DownloadResult>;
  private inflight: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private progress = new Map<string, number>();
  private lastError: VoiceSpeakerFilterStatus['downloadError'];
  private readonly checkedFiles = new Map<string, { file: string; stamp: string; valid: boolean }>();

  constructor(private readonly options: SpeakerModelStoreOptions) {
    this.download = options.download ?? createDownloader();
  }

  /** Model files ready to load, or null while any is missing. */
  getModelPaths(): SpeakerModelPaths | null {
    if (!SPEAKER_MODEL_ASSETS.every((asset) => this.isInstalled(asset))) return null;
    return {
      vadModel: this.localPath(speakerModelAsset('vad')),
      embeddingModel: this.localPath(speakerModelAsset('embedding')),
    };
  }

  getState(): ModelState {
    if (this.inflight) {
      let downloaded = 0;
      for (const asset of SPEAKER_MODEL_ASSETS) {
        downloaded += this.isInstalled(asset) ? asset.bytes : Math.min(asset.bytes, this.progress.get(asset.sha256) ?? 0);
      }
      return { modelState: 'downloading', downloadedBytes: downloaded, totalBytes: SPEAKER_MODEL_TOTAL_BYTES };
    }
    if (this.getModelPaths()) {
      return { modelState: 'ready', downloadedBytes: SPEAKER_MODEL_TOTAL_BYTES, totalBytes: SPEAKER_MODEL_TOTAL_BYTES };
    }
    return {
      modelState: this.lastError ? 'failed' : 'missing',
      downloadedBytes: 0,
      totalBytes: SPEAKER_MODEL_TOTAL_BYTES,
      ...(this.lastError ? { downloadError: this.lastError } : {}),
    };
  }

  /** Starts (or joins) the download. Resolves when every model is in place. */
  ensureDownloaded(): Promise<void> {
    if (this.getModelPaths()) return Promise.resolve();
    if (this.inflight) return this.inflight;
    const controller = new AbortController();
    this.abort = controller;
    this.lastError = undefined;
    this.progress = new Map();
    const run = this.downloadAll(controller.signal).finally(() => {
      if (this.inflight === run) {
        this.inflight = null;
        this.abort = null;
      }
      this.options.onChange?.();
    });
    this.inflight = run;
    this.options.onChange?.();
    return run;
  }

  cancelDownload(): void {
    this.abort?.abort();
  }

  private async downloadAll(signal: AbortSignal): Promise<void> {
    const base = this.options.cdnBaseUrl().replace(/\/+$/, '');
    if (!/^https:\/\//i.test(base)) {
      this.lastError = 'unavailable';
      throw new Error('speaker model CDN is not configured');
    }
    const dir = this.options.dir();
    try {
      fs.mkdirSync(dir, { recursive: true });
      for (const asset of SPEAKER_MODEL_ASSETS) {
        if (this.isInstalled(asset)) continue;
        let lastNotified = 0;
        await this.download({
          url: `${base}/${speakerModelCdnPath(asset)}`,
          targetPath: this.localPath(asset),
          sha256: asset.sha256,
          expectedSize: asset.bytes,
          maxBytes: asset.bytes,
          // CDN edges may redirect; content is pinned by SHA-256 either way.
          isUrlAllowed: (url) => /^https:\/\//i.test(url),
          signal,
          onProgress: (event) => {
            this.progress.set(asset.sha256, event.loaded);
            // Throttle pushes to the renderer; the final state is sent on completion.
            const now = Date.now();
            if (now - lastNotified >= 250) {
              lastNotified = now;
              this.options.onChange?.();
            }
          },
        });
        this.options.logger?.info('speaker model downloaded', { file: asset.fileName, bytes: asset.bytes });
      }
      this.removeStaleFiles(dir);
    } catch (error) {
      this.lastError = classifyDownloadError(error);
      this.options.logger?.warn('speaker model download failed', {
        kind: this.lastError ?? 'cancelled',
        code: error instanceof DownloadError ? error.code : undefined,
      });
      throw error;
    }
  }

  private localPath(asset: SpeakerModelAsset): string {
    return path.join(this.options.dir(), speakerModelLocalName(asset));
  }

  private isInstalled(asset: SpeakerModelAsset): boolean {
    const file = this.localPath(asset);
    try {
      const stamp = this.fileStamp(file, asset.bytes);
      if (stamp === null) {
        this.checkedFiles.delete(asset.sha256);
        return false;
      }
      const checked = this.checkedFiles.get(asset.sha256);
      if (checked?.file === file && checked.stamp === stamp) return checked.valid;

      const valid = createHash('sha256').update(fs.readFileSync(file)).digest('hex') === asset.sha256;
      // Do not publish a result for a file replaced or written during the read.
      if (this.fileStamp(file, asset.bytes) !== stamp) {
        this.checkedFiles.delete(asset.sha256);
        return false;
      }
      // Remember mismatches too, so polling a corrupt model does not rehash it.
      this.checkedFiles.set(asset.sha256, { file, stamp, valid });
      return valid;
    } catch {
      this.checkedFiles.delete(asset.sha256);
      return false;
    }
  }

  private fileStamp(file: string, bytes: number): string | null {
    const stat = fs.statSync(file, { bigint: true });
    if (!stat.isFile() || stat.size !== BigInt(bytes)) return null;
    // ctime and file identity catch replacements even when mtime is preserved.
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  }

  /** Drops files from older model versions; keeps partial downloads. */
  private removeStaleFiles(dir: string): void {
    const keep = new Set(SPEAKER_MODEL_ASSETS.map(speakerModelLocalName));
    for (const name of fs.readdirSync(dir)) {
      if (keep.has(name) || !name.endsWith('.onnx')) continue;
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch {
        // A file still open elsewhere is retried on the next download.
      }
    }
  }
}

function classifyDownloadError(error: unknown): VoiceSpeakerFilterStatus['downloadError'] {
  if (!(error instanceof DownloadError)) return 'network';
  switch (error.code) {
    case 'ABORTED':
      // User cancelled: back to "missing", no error to show.
      return undefined;
    case 'DISK':
    case 'EXISTS':
      return 'disk';
    case 'CHECKSUM':
    case 'SIZE':
      return 'checksum';
    case 'HTTP_4XX':
    case 'URL_POLICY':
    case 'INVALID_ARG':
      return 'unavailable';
    default:
      return 'network';
  }
}
