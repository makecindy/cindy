import type { InputDeviceRendererAction } from '../../shared/inputDevices.js';
import {
  cloneXboxGamepadSettings,
  createXboxGamepadDefaultSettings,
  emptyGamepadDevice,
  emptyGamepadPreview,
  GAMEPAD_FAMILIES,
  isGamepadFamily,
  resolveGamepadFamily,
  type GamepadAccessoriesState,
  type GamepadFamily,
  type XboxGamepadConnectionStatus,
  type XboxGamepadDeviceInfo,
  type XboxGamepadPreviewInput,
  type XboxGamepadSettings,
  type XboxGamepadState,
} from '../../shared/xboxGamepad.js';
import {
  reduceXboxGamepadFrame,
  xboxGamepadActiveHolds,
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

interface AccessorySlot {
  settings: XboxGamepadSettings;
  devicePresent: boolean | null;
  deviceName: string | null;
  device: XboxGamepadDeviceInfo;
  connectionStatus: XboxGamepadConnectionStatus;
  previousFrame: XboxGamepadFrame | null;
}

function createSlot(family: GamepadFamily): AccessorySlot {
  return {
    settings: createXboxGamepadDefaultSettings(),
    devicePresent: null,
    deviceName: null,
    device: emptyGamepadDevice(family),
    connectionStatus: 'disabled',
    previousFrame: null,
  };
}

export class XboxGamepadController {
  private readonly slots = Object.fromEntries(
    GAMEPAD_FAMILIES.map((family) => [family, createSlot(family)]),
  ) as Record<GamepadFamily, AccessorySlot>;
  private hostError: string | null = null;
  private layoutPreviewFamily: GamepadFamily | null = null;
  private listeners = new Set<(state: GamepadAccessoriesState) => void>();

  constructor(private readonly deps: XboxGamepadControllerDeps) {}

  getState(family: GamepadFamily = 'xbox'): XboxGamepadState {
    return snapshot(this.slots[family]);
  }

  getAccessories(): GamepadAccessoriesState {
    return Object.fromEntries(
      GAMEPAD_FAMILIES.map((family) => [family, snapshot(this.slots[family])]),
    ) as GamepadAccessoriesState;
  }

  subscribe(listener: (state: GamepadAccessoriesState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getAccessories());
    return () => this.listeners.delete(listener);
  }

  applySettings(family: GamepadFamily, settings: XboxGamepadSettings): void {
    const slot = this.slots[family];
    const wasDispatching = this.shouldDispatch(slot);
    const layoutChanged = JSON.stringify(slot.settings.layout) !== JSON.stringify(settings.layout);
    if (layoutChanged) this.releaseHolds(slot);
    slot.settings = cloneXboxGamepadSettings(settings);
    this.syncConnectionStatus(slot);
    if (wasDispatching && !this.shouldDispatch(slot)) this.releaseHolds(slot);
    this.emit();
  }

  setCindyFrontmost(frontmost: boolean): void {
    if (frontmost) return;
    for (const family of GAMEPAD_FAMILIES) this.releaseHolds(this.slots[family]);
  }

  setLayoutPreviewActive(active: boolean, family: GamepadFamily | null = null): void {
    const next = active ? family : null;
    if (this.layoutPreviewFamily === next) return;
    this.layoutPreviewFamily = next;
    if (next) {
      for (const held of GAMEPAD_FAMILIES) this.releaseHolds(this.slots[held]);
    }
  }

  handleHostMessage(message: XboxGamepadHostMessage): void {
    if (message.kind === 'host-error') {
      this.hostError = message.message;
      for (const family of GAMEPAD_FAMILIES) {
        const slot = this.slots[family];
        slot.devicePresent = false;
        slot.deviceName = null;
        slot.device = emptyGamepadDevice(family);
        this.syncConnectionStatus(slot);
        this.releaseHolds(slot);
        this.emitPreview(emptyGamepadPreview(family));
      }
      this.emit();
      return;
    }
    if (message.kind === 'presence') {
      this.hostError = null;
      if (!message.present && message.family === undefined) {
        for (const family of GAMEPAD_FAMILIES) this.applyAbsence(this.slots[family], family);
        this.emit();
        return;
      }
      const family = resolveGamepadFamily({
        family: message.family,
        name: message.name,
        category: message.category,
      });
      const slot = this.slots[family];
      slot.devicePresent = message.present;
      slot.deviceName = message.present ? (message.name ?? slot.deviceName) : null;
      slot.device = message.present ? deviceFromPresence(message, family) : emptyGamepadDevice(family);
      this.syncConnectionStatus(slot);
      if (!message.present) {
        this.releaseHolds(slot);
        this.emitPreview(emptyGamepadPreview(family));
      }
      this.emit();
      return;
    }
    if (message.kind !== 'frame') return;
    const frame = parseXboxGamepadFrame(message);
    if (!frame) return;
    const family = isGamepadFamily(message.family) ? message.family : 'xbox';
    const slot = this.slots[family];
    this.hostError = null;
    this.emitPreview(xboxGamepadPreviewFromFrame(frame, family));
    if (!this.shouldDispatch(slot)) {
      this.releaseHolds(slot);
      return;
    }
    const actions = reduceXboxGamepadFrame(slot.previousFrame, frame, slot.settings.layout);
    slot.previousFrame = frame;
    this.emitActions(slot, actions);
  }

  markUnavailable(): void {
    for (const family of GAMEPAD_FAMILIES) {
      const slot = this.slots[family];
      slot.connectionStatus = slot.settings.deviceEnabled ? 'unavailable' : 'disabled';
      slot.devicePresent = false;
      slot.deviceName = null;
      slot.device = emptyGamepadDevice(family);
      this.releaseHolds(slot);
      this.emitPreview(emptyGamepadPreview(family));
    }
    this.emit();
  }

  private applyAbsence(slot: AccessorySlot, family: GamepadFamily): void {
    slot.devicePresent = false;
    slot.deviceName = null;
    slot.device = emptyGamepadDevice(family);
    this.syncConnectionStatus(slot);
    this.releaseHolds(slot);
    this.emitPreview(emptyGamepadPreview(family));
  }

  private shouldDispatch(slot: AccessorySlot): boolean {
    return (
      slot.settings.deviceEnabled &&
      this.deps.isCindyFrontmost() &&
      this.layoutPreviewFamily === null
    );
  }

  private emitPreview(input: XboxGamepadPreviewInput): void {
    if (this.layoutPreviewFamily !== input.family) return;
    this.deps.preview?.(input);
  }

  private syncConnectionStatus(slot: AccessorySlot): void {
    if (!slot.settings.deviceEnabled) {
      slot.connectionStatus = slot.devicePresent
        ? 'disabled'
        : slot.devicePresent === false
          ? 'not-detected'
          : 'disabled';
      return;
    }
    if (this.hostError) slot.connectionStatus = 'error';
    else if (slot.devicePresent) slot.connectionStatus = 'connected';
    else if (slot.devicePresent === false) slot.connectionStatus = 'not-detected';
    else slot.connectionStatus = 'connecting';
  }

  private releaseHolds(slot: AccessorySlot): void {
    const actions = xboxGamepadHoldReleases(slot.previousFrame, slot.settings.layout);
    slot.previousFrame = null;
    this.emitActions(slot, actions);
  }

  private emitActions(origin: AccessorySlot, actions: InputDeviceRendererAction[]): void {
    for (const action of actions) {
      if (action.type === 'voice' && action.phase === 'release' && this.otherVoiceHeld(origin)) {
        continue;
      }
      if (action.type === 'scroll-stop') {
        const remaining = this.otherScroll(origin);
        if (remaining) {
          this.deps.dispatch(remaining);
          continue;
        }
      }
      this.deps.dispatch(action);
    }
  }

  private otherVoiceHeld(except: AccessorySlot): boolean {
    for (const family of GAMEPAD_FAMILIES) {
      const slot = this.slots[family];
      if (slot === except || !this.shouldDispatch(slot)) continue;
      if (xboxGamepadActiveHolds(slot.previousFrame, slot.settings.layout).voice) return true;
    }
    return false;
  }

  private otherScroll(
    except: AccessorySlot,
  ): Extract<InputDeviceRendererAction, { type: 'scroll' }> | null {
    let best: Extract<InputDeviceRendererAction, { type: 'scroll' }> | null = null;
    for (const family of GAMEPAD_FAMILIES) {
      const slot = this.slots[family];
      if (slot === except || !this.shouldDispatch(slot)) continue;
      const scroll = xboxGamepadActiveHolds(slot.previousFrame, slot.settings.layout).scroll;
      if (scroll && (!best || scroll.intensity > best.intensity)) best = scroll;
    }
    return best;
  }

  private emit(): void {
    const state = this.getAccessories();
    for (const listener of this.listeners) listener(state);
  }
}

function snapshot(slot: AccessorySlot): XboxGamepadState {
  return {
    connectionStatus: slot.connectionStatus,
    devicePresent: slot.devicePresent,
    deviceName: slot.deviceName,
    device: { ...slot.device },
    settings: cloneXboxGamepadSettings(slot.settings),
  };
}

function deviceFromPresence(
  message: Extract<XboxGamepadHostMessage, { kind: 'presence' }>,
  family: GamepadFamily,
): XboxGamepadDeviceInfo {
  return {
    name: message.name ?? null,
    category: message.category ?? null,
    family,
    transport: message.transport ?? 'unknown',
    batteryPercentage:
      typeof message.batteryPercentage === 'number' ? Math.round(message.batteryPercentage) : null,
    batteryState: message.batteryState ?? 'unknown',
  };
}
