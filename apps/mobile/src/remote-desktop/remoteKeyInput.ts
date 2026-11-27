export type RemoteKeyEvent = { kind: "key"; code: string; down: boolean };
export type KeyLatch = "held" | "once" | "locked";

const REMOTE_MODIFIERS = ["ControlLeft", "AltLeft", "ShiftLeft", "MetaLeft"];
/** Fn only changes which code a key sends; hosts never receive it. */
export const KEY_FN = "Fn";
/** Hosts cannot toggle a real Caps Lock, so letters send Shift instead. */
export const KEY_CAPS = "CapsLock";
const FN_LAYER: Record<string, string> = {
  ...Object.fromEntries(
    [..."1234567890"].map((key, index) => [`Digit${key}`, `F${index + 1}`]),
  ),
  Minus: "F11",
  Equal: "F12",
  Backspace: "Delete",
  ArrowLeft: "Home",
  ArrowRight: "End",
  ArrowUp: "PageUp",
  ArrowDown: "PageDown",
};

export function fnLayerCode(code: string) {
  return FN_LAYER[code] ?? code;
}

function isLatchable(code: string) {
  return code === KEY_FN || REMOTE_MODIFIERS.includes(code);
}

/**
 * Key state for every finger on the keyboard. A modifier reaches the host only
 * with a key, so tapping Win or Alt alone cannot open a host menu. Holding it
 * chords with the keys pressed meanwhile; tapping it applies to the next key,
 * tapping again locks it, and a third tap clears it.
 */
export class RemoteKeyInput {
  private held = new Map<string | number, { code: string; used: boolean }>();
  private presses = new Map<string | number, string[]>();
  private latches = new Map<string, "once" | "locked">();
  private remote: string[] = [];
  private caps = false;

  latch(code: string): KeyLatch | null {
    if (code === KEY_CAPS) return this.caps ? "locked" : null;
    for (const key of this.held.values()) if (key.code === code) return "held";
    return this.latches.get(code) ?? null;
  }

  /** True when letters would be typed in upper case. */
  uppercase() {
    return (this.latch("ShiftLeft") !== null) !== this.caps;
  }

  press(touch: string | number, code: string): RemoteKeyEvent[] {
    if (this.held.has(touch) || this.presses.has(touch)) return [];
    if (code === KEY_CAPS) {
      this.caps = !this.caps;
      return [];
    }
    if (isLatchable(code)) {
      this.held.set(touch, { code, used: false });
      return [];
    }
    const active = new Set(this.latches.keys());
    for (const key of this.held.values()) {
      key.used = true;
      active.add(key.code);
    }
    const resolved = active.has(KEY_FN) ? fnLayerCode(code) : code;
    if (this.caps && /^Key[A-Z]$/.test(resolved)) {
      if (active.has("ShiftLeft")) active.delete("ShiftLeft");
      else active.add("ShiftLeft");
    }
    const keys = [
      ...REMOTE_MODIFIERS.filter((key) => active.has(key)),
      resolved,
    ];
    this.presses.set(touch, keys);
    for (const [key, latch] of this.latches)
      if (latch === "once") this.latches.delete(key);
    // The host's modifiers must match this press, not whatever an earlier,
    // still-held key needed: a used one-shot Shift must not reach the next key.
    const stale = this.remote
      .filter((key) => REMOTE_MODIFIERS.includes(key) && !keys.includes(key))
      .reverse();
    this.remote = this.remote.filter((key) => !stale.includes(key));
    const events: RemoteKeyEvent[] = stale.map((key) => ({
      kind: "key",
      code: key,
      down: false,
    }));
    const pressed = keys.filter((key) => !this.remote.includes(key));
    events.push(
      ...pressed.map((key) => ({
        kind: "key" as const,
        code: key,
        down: true,
      })),
    );
    this.remote.push(...pressed);
    return events;
  }

  release(touch: string | number, cancelled = false): RemoteKeyEvent[] {
    const key = this.held.get(touch);
    if (key) {
      this.held.delete(touch);
      if (!key.used && !cancelled) this.advanceLatch(key.code);
    }
    this.presses.delete(touch);
    const needed = new Set([...this.presses.values()].flat());
    for (const held of this.held.values()) if (held.used) needed.add(held.code);
    const released = this.remote.filter((code) => !needed.has(code)).reverse();
    this.remote = this.remote.filter((code) => needed.has(code));
    return released.map((code) => ({ kind: "key", code, down: false }));
  }

  /** Lets go of everything held on the host, keeping this input's own record. */
  suspend(): RemoteKeyEvent[] {
    return [...this.remote]
      .reverse()
      .map((code) => ({ kind: "key", code, down: false }));
  }

  /**
   * Presses again the modifiers this input still holds. A shortcut sent around it
   * (the strip's undo, search) lets go of the modifiers it used, which may be
   * ones the user is still holding.
   */
  resync(): RemoteKeyEvent[] {
    // Only modifiers come back: a typing key's down is the keystroke itself, so
    // replaying a held one would type it again. Its touch release stays harmless.
    this.remote = this.remote.filter((code) => REMOTE_MODIFIERS.includes(code));
    return this.remote.map((code) => ({ kind: "key", code, down: true }));
  }

  /** Forgets everything; the caller tells the host to release its keys. */
  reset() {
    this.held.clear();
    this.presses.clear();
    this.latches.clear();
    this.remote = [];
    this.caps = false;
  }

  private advanceLatch(code: string) {
    const latch = this.latches.get(code);
    if (!latch) this.latches.set(code, "once");
    else if (latch === "once") this.latches.set(code, "locked");
    else this.latches.delete(code);
  }
}
