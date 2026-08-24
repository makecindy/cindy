import type { InputDeviceRendererAction } from '../../shared/inputDevices.js';
import {
  cloneXboxGamepadSettings,
  createXboxGamepadDefaultSettings,
  XBOX_GAMEPAD_EMPTY_DEVICE,
  XBOX_GAMEPAD_EMPTY_PREVIEW,
  type XboxGamepadConnectionStatus,
  type XboxGamepadDeviceInfo,
  type XboxGamepadPreviewInput,
  type XboxGamepadSettings,
  type XboxGamepadState,
} from '../../shared/xboxGamepad.js';
import {
  reduceXboxGamepadFrame,
  xboxGamepadHoldReleases,
  xboxGamepadPreviewFromFrame,
  type XboxGamepadFrame,
} from './bindings.js';
import { parseXboxGamepadFrame, type XboxGamepadHostMessage } from './protocol.js';

export interface XboxGamepadControllerDeps {
  isCindyFrontmost(): boolean;
  dispatch(action: InputDeviceRendererAction): void;
  preview?(input: XboxGamepadPreviewInput): void;
}

export class XboxGamepadController {
  private settings: XboxGamepadSettings = createXboxGamepadDefaultSettings();
  private devicePresent: boolean | null = null;
  private deviceName: string | null = null;
  private device: XboxGamepadDeviceInfo = { ...XBOX_GAMEPAD_EMPTY_DEVICE };
  private connectionStatus: XboxGamepadConnectionStatus = 'disabled';
  private previousFrame: XboxGamepadFrame | null = null;
  private hostError: string | null = null;
  private layoutPreviewActive = false;
  private listeners = new Set<(state: XboxGamepadState) => void>();

  constructor(private readonly deps: XboxGamepadControllerDeps) {}

  getState(): XboxGamepadState {
    return {
      connectionStatus: this.connectionStatus,
      devicePresent: this.devicePresent,
      deviceName: this.deviceName,
      device: { ...this.device },
      settings: cloneXboxGamepadSettings(this.settings),
    };
  }

  subscribe(listener: (state: XboxGamepadState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  applySettings(settings: XboxGamepadSettings): void {
    const wasDispatching = this.shouldDispatch();
    const layoutChanged =
      JSON.stringify(this.settings.layout) !== JSON.stringify(settings.layout);
    if (layoutChanged) this.releaseHolds();
    this.settings = cloneXboxGamepadSettings(settings);
    this.syncConnectionStatus();
    if (wasDispatching && !this.shouldDispatch()) this.releaseHolds();
    this.emit();
  }

  setCindyFrontmost(frontmost: boolean): void {
    if (frontmost) return;
    this.releaseHolds();
  }

  setLayoutPreviewActive(active: boolean): void {
    if (this.layoutPreviewActive === active) return;
    this.layoutPreviewActive = active;
    if (active) this.releaseHolds();
  }

  handleHostMessage(message: XboxGamepadHostMessage): void {
    if (message.kind === 'host-error') {
      this.hostError = message.message;
      this.devicePresent = false;
      this.deviceName = null;
      this.device = { ...XBOX_GAMEPAD_EMPTY_DEVICE };
      this.syncConnectionStatus();
      this.releaseHolds();
      this.emitPreview(XBOX_GAMEPAD_EMPTY_PREVIEW);
      this.emit();
      return;
    }
    if (message.kind === 'presence') {
      this.hostError = null;
      this.devicePresent = message.present;
      this.deviceName = message.present ? (message.name ?? this.deviceName) : null;
      this.device = message.present ? deviceFromPresence(message) : { ...XBOX_GAMEPAD_EMPTY_DEVICE };
      this.syncConnectionStatus();
      if (!message.present) {
        this.releaseHolds();
        this.emitPreview(XBOX_GAMEPAD_EMPTY_PREVIEW);
      }
      this.emit();
      return;
    }
    if (message.kind !== 'frame') return;
    const frame = parseXboxGamepadFrame(message);
    if (!frame) return;
    this.hostError = null;
    this.emitPreview(xboxGamepadPreviewFromFrame(frame));
    if (!this.shouldDispatch()) {
      this.previousFrame = null;
      return;
    }
    const actions = reduceXboxGamepadFrame(this.previousFrame, frame, this.settings.layout);
    this.previousFrame = frame;
    for (const action of actions) this.deps.dispatch(action);
  }

  markUnavailable(): void {
    this.connectionStatus = this.settings.deviceEnabled ? 'unavailable' : 'disabled';
    this.devicePresent = false;
    this.deviceName = null;
    this.device = { ...XBOX_GAMEPAD_EMPTY_DEVICE };
    this.releaseHolds();
    this.emitPreview(XBOX_GAMEPAD_EMPTY_PREVIEW);
    this.emit();
  }

  private shouldDispatch(): boolean {
    return this.settings.deviceEnabled && this.deps.isCindyFrontmost() && !this.layoutPreviewActive;
  }

  private emitPreview(input: XboxGamepadPreviewInput): void {
    if (!this.layoutPreviewActive) return;
    this.deps.preview?.(input);
  }

  private syncConnectionStatus(): void {
    if (!this.settings.deviceEnabled) {
      this.connectionStatus = this.devicePresent
        ? 'disabled'
        : this.devicePresent === false
          ? 'not-detected'
          : 'disabled';
      return;
    }
    if (this.hostError) this.connectionStatus = 'error';
    else if (this.devicePresent) this.connectionStatus = 'connected';
    else if (this.devicePresent === false) this.connectionStatus = 'not-detected';
    else this.connectionStatus = 'connecting';
  }

  private releaseHolds(): void {
    const actions = xboxGamepadHoldReleases(this.previousFrame, this.settings.layout);
    this.previousFrame = null;
    for (const action of actions) this.deps.dispatch(action);
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }
}

function deviceFromPresence(message: Extract<XboxGamepadHostMessage, { kind: 'presence' }>): XboxGamepadDeviceInfo {
  return {
    name: message.name ?? null,
    category: message.category ?? null,
    transport: message.transport ?? 'unknown',
    batteryPercentage:
      typeof message.batteryPercentage === 'number' ? Math.round(message.batteryPercentage) : null,
    batteryState: message.batteryState ?? 'unknown',
  };
}
