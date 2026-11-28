import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';

import { createLogger } from '../../logger.js';
import { assertTrustedAppRendererEvent, isTrustedAppRendererWindow } from '../../security/trustedAppRenderer.js';
import {
  VOICE_LOCAL_ASR_CHANNELS,
  type VoiceLocalAsrChooseDirResult,
  type VoiceLocalAsrStatus,
} from '../../../shared/voiceLocalAsr.js';
import { LocalAsrEngineHost, type LocalAsrDecodeEngine } from './localAsrEngineHost.js';
import { inspectLocalAsrModelDir, LocalAsrModelStore } from './localAsrModelStore.js';

const log = createLogger('voice-local-asr');

/** Platforms sherpa-onnx-node ships a prebuilt addon for and Cindy packages. */
const SUPPORTED_PLATFORMS = new Set(['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64', 'linux-arm64']);

class LocalAsrService {
  readonly supported = SUPPORTED_PLATFORMS.has(`${process.platform}-${process.arch}`);
  private readonly store = new LocalAsrModelStore(() => app.getPath('userData'));
  private readonly engine = new LocalAsrEngineHost(() => this.store.resolveModel().spec);
  private onChangedListeners = new Set<() => void>();

  onModelChanged(listener: () => void): () => void {
    this.onChangedListeners.add(listener);
    return () => this.onChangedListeners.delete(listener);
  }

  getStatus(): VoiceLocalAsrStatus {
    if (!this.supported) {
      return {
        supported: false,
        ready: false,
        error: 'unsupported_platform',
      };
    }
    const { configuredDir, spec, invalidConfiguredDir } = this.store.resolveModel();
    if (spec) {
      return {
        supported: true,
        ready: true,
        modelDir: spec.modelDir,
        modelDirName: path.basename(spec.modelDir),
        modelKind: spec.kind,
      };
    }
    if (invalidConfiguredDir && configuredDir) {
      return {
        supported: true,
        ready: false,
        modelDir: configuredDir,
        modelDirName: path.basename(configuredDir),
        error: 'invalid_model_dir',
      };
    }
    return {
      supported: true,
      ready: false,
      error: 'not_configured',
    };
  }

  isReady(): boolean {
    return this.getStatus().ready;
  }

  getEngine(): LocalAsrDecodeEngine {
    return this.engine;
  }

  warm(language?: string): Promise<void> {
    if (!this.supported) return Promise.reject(new Error('Local offline ASR is not supported on this platform.'));
    return this.engine.warm(language);
  }

  async chooseModelDir(parentWindow: BrowserWindow | null): Promise<VoiceLocalAsrChooseDirResult> {
    if (!this.supported) {
      return { ok: false, error: 'unsupported_platform', status: this.getStatus() };
    }
    const dialogOptions: Electron.OpenDialogOptions = {
      properties: ['openDirectory'],
    };
    const result = parentWindow && !parentWindow.isDestroyed()
      ? await dialog.showOpenDialog(parentWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: true, cancelled: true, status: this.getStatus() };
    }
    const chosenDir = result.filePaths[0];
    const detected = inspectLocalAsrModelDir(chosenDir);
    if (!detected) {
      log.info('selected local ASR directory does not contain a supported sherpa-onnx model');
      return { ok: false, error: 'invalid_model_dir', status: this.getStatus() };
    }
    this.store.saveConfiguredDir(detected.modelDir);
    this.engine.shutdown('model_changed');
    const status = this.getStatus();
    log.info('configured local offline ASR model', { kind: detected.kind });
    this.notifyChanged(status);
    return { ok: true, status };
  }

  clearModelDir(): VoiceLocalAsrStatus {
    this.store.clearConfiguredDir();
    this.engine.shutdown('model_cleared');
    const status = this.getStatus();
    this.notifyChanged(status);
    return status;
  }

  shutdown(): void {
    this.engine.shutdown('quit');
  }

  private notifyChanged(status: VoiceLocalAsrStatus): void {
    for (const listener of this.onChangedListeners) {
      try {
        listener();
      } catch {
        // non-fatal
      }
    }
    BrowserWindow.getAllWindows().forEach((window) => {
      if (!isTrustedAppRendererWindow(window)) return;
      window.webContents.send(VOICE_LOCAL_ASR_CHANNELS.statusChanged, status);
    });
  }
}

let service: LocalAsrService | null = null;

export function getLocalAsrService(): LocalAsrService {
  service ??= new LocalAsrService();
  return service;
}

let ipcRegistered = false;

export function registerVoiceLocalAsrIpc(onModelChanged?: () => void): void {
  if (onModelChanged) {
    getLocalAsrService().onModelChanged(onModelChanged);
  }
  if (ipcRegistered) return;
  ipcRegistered = true;
  const channels = VOICE_LOCAL_ASR_CHANNELS;

  ipcMain.handle(channels.getStatus, (event): VoiceLocalAsrStatus => {
    assertTrustedAppRendererEvent(event);
    return getLocalAsrService().getStatus();
  });

  ipcMain.handle(channels.chooseModelDir, async (event): Promise<VoiceLocalAsrChooseDirResult> => {
    assertTrustedAppRendererEvent(event);
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    return getLocalAsrService().chooseModelDir(parentWindow);
  });

  ipcMain.handle(channels.clearModelDir, (event): VoiceLocalAsrStatus => {
    assertTrustedAppRendererEvent(event);
    return getLocalAsrService().clearModelDir();
  });

  app.once('before-quit', () => service?.shutdown());
}
