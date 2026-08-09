import type { AppShortcutCombo } from './appShortcuts';
import { formatAppShortcutCombo, normalizeAppShortcutCombo } from './appShortcuts';

export interface AppshotMetadata {
  schemaVersion: 1;
  captureId: string;
  capturedAt: string;
  applicationName: string;
  bundleIdentifier: string | null;
  windowTitle: string | null;
  accessibilityText: string | null;
  accessibilityTruncated: boolean;
  accessibilityUnavailableReason?: 'permission' | 'unsupported' | 'timeout' | 'removed';
}

export interface AppshotCaptureResult {
  captureId: string;
  image: {
    url: string;
    filename: string;
    size: number;
    mimeType: 'image/png';
  };
  metadata: AppshotMetadata;
}

export type AppshotDualModifier = 'command' | 'option' | 'shift';
export type AppshotShortcut =
  | { kind: 'dual-modifier'; modifier: AppshotDualModifier }
  | { kind: 'accelerator'; combo: AppShortcutCombo };

export interface AppshotShortcutPreferences {
  preferred: AppshotShortcut;
  fallback: AppshotShortcut;
}

export const DEFAULT_APPSHOT_SHORTCUT_PREFERENCES: AppshotShortcutPreferences = {
  preferred: { kind: 'dual-modifier', modifier: 'command' },
  fallback: {
    kind: 'accelerator',
    combo: { code: 'KeyA', meta: true, ctrl: false, alt: false, shift: true },
  },
};

const MAX_SCALAR_LENGTH = 4 * 1024;
const MAX_ACCESSIBILITY_BYTES = 512 * 1024;
const UNAVAILABLE_REASONS = new Set(['permission', 'unsupported', 'timeout', 'removed']);

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isBoundedString(value: unknown, allowEmpty = true): value is string {
  return (
    typeof value === 'string' &&
    utf8ByteLength(value) <= MAX_SCALAR_LENGTH &&
    (allowEmpty || value.length > 0)
  );
}

export function coerceAppshotMetadata(value: unknown): AppshotMetadata | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.schemaVersion !== 1 ||
    !isBoundedString(raw.captureId, false) ||
    !isBoundedString(raw.capturedAt, false) ||
    !isBoundedString(raw.applicationName, false) ||
    !(raw.bundleIdentifier === null || isBoundedString(raw.bundleIdentifier)) ||
    !(raw.windowTitle === null || isBoundedString(raw.windowTitle)) ||
    !(
      raw.accessibilityText === null ||
      (typeof raw.accessibilityText === 'string' &&
        utf8ByteLength(raw.accessibilityText) <= MAX_ACCESSIBILITY_BYTES)
    ) ||
    typeof raw.accessibilityTruncated !== 'boolean' ||
    !(
      raw.accessibilityUnavailableReason === undefined ||
      UNAVAILABLE_REASONS.has(raw.accessibilityUnavailableReason as string)
    )
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    captureId: raw.captureId,
    capturedAt: raw.capturedAt,
    applicationName: raw.applicationName,
    bundleIdentifier: raw.bundleIdentifier,
    windowTitle: raw.windowTitle,
    accessibilityText: raw.accessibilityText,
    accessibilityTruncated: raw.accessibilityTruncated,
    ...(raw.accessibilityUnavailableReason !== undefined
      ? {
          accessibilityUnavailableReason: raw.accessibilityUnavailableReason as
            | 'permission'
            | 'unsupported'
            | 'timeout'
            | 'removed',
        }
      : {}),
  };
}

export function normalizeAppshotShortcut(value: unknown): AppshotShortcut | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.kind === 'dual-modifier' &&
    (raw.modifier === 'command' || raw.modifier === 'option' || raw.modifier === 'shift')
  ) {
    return { kind: 'dual-modifier', modifier: raw.modifier };
  }
  if (raw.kind === 'accelerator') {
    const combo = normalizeAppShortcutCombo(raw.combo);
    if (combo) return { kind: 'accelerator', combo };
  }
  return null;
}

function cloneDefaultPreferences(): AppshotShortcutPreferences {
  return {
    preferred: { kind: 'dual-modifier', modifier: 'command' },
    fallback: {
      kind: 'accelerator',
      combo: { code: 'KeyA', meta: true, ctrl: false, alt: false, shift: true },
    },
  };
}

export function normalizeAppshotShortcutPreferences(value: unknown): AppshotShortcutPreferences {
  if (!value || typeof value !== 'object') return cloneDefaultPreferences();
  const raw = value as Record<string, unknown>;
  const preferred = normalizeAppshotShortcut(raw.preferred);
  const fallback = normalizeAppshotShortcut(raw.fallback);
  return preferred && fallback ? { preferred, fallback } : cloneDefaultPreferences();
}

export function isDualModifierSnapshot(
  keys: readonly string[],
  modifier: AppshotDualModifier,
): boolean {
  const expected = {
    command: ['MetaLeft', 'MetaRight'],
    option: ['AltLeft', 'AltRight'],
    shift: ['ShiftLeft', 'ShiftRight'],
  }[modifier];
  return keys.length === 2 && expected.every((key) => keys.includes(key));
}

export function formatAppshotShortcut(shortcut: AppshotShortcut, platform = 'darwin'): string {
  if (shortcut.kind === 'accelerator') return formatAppShortcutCombo(shortcut.combo, platform);
  return `Double ${shortcut.modifier[0].toUpperCase()}${shortcut.modifier.slice(1)}`;
}

function cleanXml(value: string): string {
  let result = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;
    if (
      codePoint === 0x9 ||
      codePoint === 0xa ||
      codePoint === 0xd ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff)
    ) {
      result += character;
    }
  }
  return result;
}

function escapeXmlText(value: string): string {
  return cleanXml(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function formatAppshotContext(metadata: AppshotMetadata): string {
  const attributes = [`app="${escapeXmlAttribute(metadata.applicationName)}"`];
  if (metadata.bundleIdentifier !== null) {
    attributes.push(`bundle-identifier="${escapeXmlAttribute(metadata.bundleIdentifier)}"`);
  }
  if (metadata.windowTitle !== null) {
    attributes.push(`window-title="${escapeXmlAttribute(metadata.windowTitle)}"`);
  }

  const lines = [`<appshot ${attributes.join(' ')}>`];
  if (metadata.windowTitle !== null) {
    lines.push(
      `Window: "${escapeXmlText(metadata.windowTitle)}", App: ${escapeXmlText(metadata.applicationName)}.`,
    );
  } else {
    lines.push(`App: ${escapeXmlText(metadata.applicationName)}.`);
  }
  if (metadata.accessibilityText !== null) {
    lines.push(
      '<accessibility-tree>',
      escapeXmlText(metadata.accessibilityText),
      '</accessibility-tree>',
    );
  } else if (metadata.accessibilityUnavailableReason) {
    lines.push(`Accessibility unavailable: ${metadata.accessibilityUnavailableReason}.`);
  }
  lines.push('</appshot>');
  return lines.join('\n');
}
