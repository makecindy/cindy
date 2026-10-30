import {
  isInputHandoffDeviceCode,
  type InputHandoffControl,
  type InputHandoffSnapshot,
  type InputHandoffValues,
} from '@cindy/device-link';

/**
 * 代输入 card model. The snapshot carries step structure only; values the
 * owner types live in the card's local state and leave only through
 * makerTransport.submitInputHandoff.
 */

const PHASES = new Set([
  'reading',
  'ready',
  'working',
  'finishing',
  'succeeded',
  'cancelled',
  'failed',
  'expired',
]);

/** Light shape check for pushes; the Host is the authority for every field. */
export function parsePendingInputHandoff(raw: unknown): InputHandoffSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const source = v.source as Record<string, unknown> | undefined;
  if (
    v.kind !== 'input_handoff' ||
    typeof v.requestId !== 'string' ||
    !v.requestId ||
    !Number.isSafeInteger(v.revision) ||
    !PHASES.has(String(v.phase)) ||
    typeof v.purpose !== 'string' ||
    !Array.isArray(v.controls) ||
    !source ||
    typeof source.app !== 'string'
  )
    return null;
  return raw as InputHandoffSnapshot;
}

export function isInputHandoffAwaitingOwner(snapshot: InputHandoffSnapshot | null): boolean {
  return !!snapshot && snapshot.terminal !== true;
}

export type InputHandoffTextControl = Extract<InputHandoffControl, { kind: 'text' }>;

/** The fields the owner types into, in screen order. */
export function textFields(snapshot: InputHandoffSnapshot): InputHandoffTextControl[] {
  return snapshot.controls.filter((control): control is InputHandoffTextControl => control.kind === 'text');
}

/** Only fields the owner typed into are applied; text already on the screen stays. */
export function changedValues(
  snapshot: InputHandoffSnapshot,
  draft: InputHandoffValues,
): InputHandoffValues {
  const out: InputHandoffValues = {};
  for (const control of textFields(snapshot)) {
    const value = draft[control.id];
    if (value) out[control.id] = value;
  }
  return out;
}

/** Standard platform autofill hints so password managers recognize the field. */
export function autoCompleteFor(control: InputHandoffTextControl): string {
  switch (control.contentType) {
    case 'password':
      return 'current-password';
    case 'one-time-code':
      return 'one-time-code';
    case 'username':
      return 'username';
    case 'email':
      return 'email';
    case 'tel':
      return 'tel';
    case 'url':
      return 'url';
    default:
      return 'off';
  }
}

export function inputTypeFor(control: InputHandoffTextControl): string {
  switch (control.contentType) {
    case 'password':
      return 'password';
    case 'email':
      return 'email';
    case 'tel':
      return 'tel';
    case 'url':
      return 'url';
    case 'search':
      return 'search';
    default:
      return 'text';
  }
}

export function inputModeFor(
  control: InputHandoffTextControl,
): 'numeric' | 'email' | 'tel' | 'url' | 'text' {
  switch (control.contentType) {
    case 'one-time-code':
    case 'number':
      return 'numeric';
    case 'email':
      return 'email';
    case 'tel':
      return 'tel';
    case 'url':
      return 'url';
    default:
      return 'text';
  }
}

/** Where the value goes, as the owner checks it: a secure site's host (with a lock), otherwise the origin or app. */
export function inputHandoffPlace(source: InputHandoffSnapshot['source']): { label: string; secure: boolean } {
  const origin = source.origin;
  if (!origin) return { label: source.app, secure: false };
  if (origin.startsWith('https://') && !source.warning) return { label: origin.slice('https://'.length), secure: true };
  return { label: origin, secure: false };
}

export type InputHandoffPlaceKind = 'web' | 'terminal' | 'app';

export const inputHandoffPlaceKind = (snapshot: InputHandoffSnapshot): InputHandoffPlaceKind =>
  snapshot.command ? 'terminal' : snapshot.source.origin ? 'web' : 'app';

/** The dialog opens only on a screen with something for the owner: fields, a picture, a QR code or a sign-in code. */
export function inputHandoffDialogHasContent(snapshot: InputHandoffSnapshot, heldElsewhere: boolean): boolean {
  if (snapshot.terminal || snapshot.phase !== 'ready' || heldElsewhere) return false;
  return Boolean(snapshot.picture) || isInputHandoffDeviceCode(snapshot.deviceCode) || textFields(snapshot).length > 0;
}

/** What the dialog asks for: typing, a QR code to scan, a sign-in code to use elsewhere, or a picture of the screen. */
export function inputHandoffDialogMode(snapshot: InputHandoffSnapshot): 'qr' | 'picture' | 'code' | 'fields' {
  if (snapshot.picture && snapshot.qr === 'scan') return 'qr';
  if (snapshot.picture) return 'picture';
  if (isInputHandoffDeviceCode(snapshot.deviceCode) && textFields(snapshot).length === 0) return 'code';
  return 'fields';
}
