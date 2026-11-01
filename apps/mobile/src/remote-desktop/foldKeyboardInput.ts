export type FoldKeyEvent = { kind: "key"; code: string; down: boolean };
export type FoldKeyLatch = "held" | "once" | "locked";

const REMOTE_MODIFIERS = ["ControlLeft", "AltLeft", "ShiftLeft", "MetaLeft"];
/** Fn only changes which code a key sends; hosts never receive it. */
export const FOLD_FN = "Fn";
/** Hosts cannot toggle a real Caps Lock, so letters send Shift instead. */
export const FOLD_CAPS = "CapsLock";
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

export function foldFnCode(code: string) {
  return FN_LAYER[code] ?? code;
}

function isLatchable(code: string) {
  return code === FOLD_FN || REMOTE_MODIFIERS.includes(code);
}

/**
 * Key state for every finger on the keyboard. A modifier reaches the host only
 * with a key, so tapping Win or Alt alone cannot open a host menu. Holding it
 * chords with the keys pressed meanwhile; tapping it applies to the next key,
 * tapping again locks it, and a third tap clears it.
 */
export class FoldKeyInput {
  private held = new Map<string | number, { code: string; used: boolean }>();
  private presses = new Map<string | number, string[]>();
  private latches = new Map<string, "once" | "locked">();
  private remote: string[] = [];
  private caps = false;

  latch(code: string): FoldKeyLatch | null {
    if (code === FOLD_CAPS) return this.caps ? "locked" : null;
    for (const key of this.held.values()) if (key.code === code) return "held";
    return this.latches.get(code) ?? null;
  }

  /** True when letters would be typed in upper case. */
  uppercase() {
    return (this.latch("ShiftLeft") !== null) !== this.caps;
  }

  press(touch: string | number, code: string): FoldKeyEvent[] {
    if (this.held.has(touch) || this.presses.has(touch)) return [];
    if (code === FOLD_CAPS) {
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
    const resolved = active.has(FOLD_FN) ? foldFnCode(code) : code;
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
    const events = keys
      .filter((key) => !this.remote.includes(key))
      .map((key) => ({ kind: "key" as const, code: key, down: true }));
    this.remote.push(...events.map((event) => event.code));
    return events;
  }

  release(touch: string | number, cancelled = false): FoldKeyEvent[] {
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
