import type {
  DictationDictionaryAdviceInput,
  DictationDictionaryLearningAction,
  DictationDictionaryLearningCandidateState,
  DictationDictionaryLearningEntryState,
  DictationRefinementContext,
} from '@cindy/voice-input-core';
import type { CindyRegion } from '@cindy/maker-shared/brand-identity';
export {
  compactVoiceInputHistoryIfNeeded,
  estimateVoiceInputHistoryContextChars,
  MAX_REFINEMENT_HISTORY_ITEM_CHARS,
  VOICE_INPUT_HISTORY_COMPACT_CHARS,
  VOICE_INPUT_HISTORY_COMPACT_TARGET_CHARS,
  VOICE_INPUT_HISTORY_COMPACT_KEEP_ENTRIES,
  VOICE_INPUT_HISTORY_HEADER,
} from '@cindy/voice-input-core';

import { CURRENT_CINDY_REGION } from './brandRegion';
import { SUPPORTED_LOCALES, type SupportedLocale } from './locale';
import type { IpcErrorCode } from './ipc-errors';

/** 同步 voice-input IPC 不能通过 Promise reject 传错时使用的可解码结果。 */
export type VoiceInputSyncErrorResult = {
  ok: false;
  code: IpcErrorCode;
  message: string;
};

export type VoiceInputLanguage = 'auto' | SupportedLocale;
export type VoiceInputDictionaryEntrySource = 'manual' | 'automatic';
export type VoiceInputShortcutTrigger = 'keyboard' | 'modifier';
export type VoiceInputModifierShortcutCode =
  | 'MetaLeft'
  | 'MetaRight'
  | 'AltLeft'
  | 'AltRight'
  | 'ControlLeft'
  | 'ControlRight'
  | 'Fn';

export interface VoiceInputShortcut {
  trigger?: VoiceInputShortcutTrigger;
  code: string;
  key: string;
  modifiers: {
    meta: boolean;
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    fn: boolean;
  };
}

export interface VoiceInputDictionaryAlias {
  text: string;
  count: number;
  lastSeenAt: number;
}

export interface VoiceInputDictionaryEntry {
  id: string;
  text: string;
  source: VoiceInputDictionaryEntrySource;
  frequency: number;
  aliases: VoiceInputDictionaryAlias[];
  createdAt: number;
  updatedAt: number;
}

export interface VoiceInputDictionaryCandidate {
  text: string;
  evidenceCount: number;
  aliases: VoiceInputDictionaryAlias[];
  createdAt: number;
  updatedAt: number;
}

export interface VoiceInputSettings {
  language: VoiceInputLanguage;
  microphoneDeviceId: string | null;
  muteSystemAudio: boolean;
  playInteractionSound: boolean;
  fastActivationEnabled: boolean;
  refinementEnabled: boolean;
  refinementInstructions: string;
  autoDictionaryEnabled: boolean;
  /**
   * 是否在本账号的桌面设备之间自动同步词典(**有效值** = 默认 + 用户 override)。
   *
   * 刻意不复用 device-link 的「允许被控」开关:那个开关的语义是「允许别的设备操作
   * 我这台电脑」,而词典同步是自己设备之间的数据流动,两者该分开决定。
   *
   * 读这个字段即可;写请走 {@link dictionarySyncEnabledOverride}。
   */
  dictionarySyncEnabled: boolean;
  /**
   * 用户对上面那个开关的显式选择;`undefined` = 从未自定义,跟随当前版本默认值。
   *
   * 按 `docs/dev-rules/configuration-and-overrides.md` §2,持久化只记录 override,
   * 不把默认值固化进用户配置 —— 否则任何一次无关的设置保存都会把所有用户永久钉死
   * 在当时的默认值上,以后改默认值也带不动他们,「恢复默认」也失去意义。
   */
  dictionarySyncEnabledOverride?: boolean | null;
  dictionaryEntries: VoiceInputDictionaryEntry[];
  dictionaryCandidates: VoiceInputDictionaryCandidate[];
  suppressedAutomaticDictionaryTexts: string[];
  shortcut: VoiceInputShortcut | null;
}

export interface VoiceInputHistoryEntry {
  id: string;
  text: string;
  createdAt: number;
}

export interface VoiceInputDataSnapshot {
  settings: VoiceInputSettings;
  history: VoiceInputHistoryEntry[];
}

export type VoiceInputDictionaryLearningEvidence = Pick<
  DictationDictionaryAdviceInput,
  'source' | 'rawTranscriptText' | 'beforeText' | 'afterText' | 'context'
>;

/** 词典跨设备同步的系统默认值。改这里即可让未自定义的用户随版本跟随。 */
export const DEFAULT_DICTIONARY_SYNC_ENABLED = true;

export const MAX_VOICE_INPUT_REFINEMENT_INSTRUCTIONS_CHARS = 1_000;
export const MAX_VOICE_INPUT_DICTIONARY_ENTRIES = 1_000;
export const MAX_VOICE_INPUT_DICTIONARY_CANDIDATES = 200;
export const MAX_VOICE_INPUT_DICTIONARY_ENTRY_CHARS = 120;
export const MAX_VOICE_INPUT_DICTIONARY_ALIASES = 8;
export const MAX_VOICE_INPUT_DICTIONARY_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_VISIBLE_VOICE_INPUT_HISTORY_ENTRIES = 5;
export const VOICE_INPUT_MODIFIER_SHORTCUT_CODES: readonly VoiceInputModifierShortcutCode[] = [
  'MetaLeft',
  'MetaRight',
  'AltLeft',
  'AltRight',
  'ControlLeft',
  'ControlRight',
  'Fn',
];

export const MAC_NATIVE_KEY_CODE_TO_VOICE_INPUT_KEY: Readonly<Record<number, { code: string; key: string }>> = {
  0: { code: 'KeyA', key: 'a' },
  1: { code: 'KeyS', key: 's' },
  2: { code: 'KeyD', key: 'd' },
  3: { code: 'KeyF', key: 'f' },
  4: { code: 'KeyH', key: 'h' },
  5: { code: 'KeyG', key: 'g' },
  6: { code: 'KeyZ', key: 'z' },
  7: { code: 'KeyX', key: 'x' },
  8: { code: 'KeyC', key: 'c' },
  9: { code: 'KeyV', key: 'v' },
  11: { code: 'KeyB', key: 'b' },
  12: { code: 'KeyQ', key: 'q' },
  13: { code: 'KeyW', key: 'w' },
  14: { code: 'KeyE', key: 'e' },
  15: { code: 'KeyR', key: 'r' },
  16: { code: 'KeyY', key: 'y' },
  17: { code: 'KeyT', key: 't' },
  18: { code: 'Digit1', key: '1' },
  19: { code: 'Digit2', key: '2' },
  20: { code: 'Digit3', key: '3' },
  21: { code: 'Digit4', key: '4' },
  22: { code: 'Digit6', key: '6' },
  23: { code: 'Digit5', key: '5' },
  24: { code: 'Equal', key: '=' },
  25: { code: 'Digit9', key: '9' },
  26: { code: 'Digit7', key: '7' },
  27: { code: 'Minus', key: '-' },
  28: { code: 'Digit8', key: '8' },
  29: { code: 'Digit0', key: '0' },
  30: { code: 'BracketRight', key: ']' },
  31: { code: 'KeyO', key: 'o' },
  32: { code: 'KeyU', key: 'u' },
  33: { code: 'BracketLeft', key: '[' },
  34: { code: 'KeyI', key: 'i' },
  35: { code: 'KeyP', key: 'p' },
  36: { code: 'Enter', key: 'Enter' },
  37: { code: 'KeyL', key: 'l' },
  38: { code: 'KeyJ', key: 'j' },
  39: { code: 'Quote', key: "'" },
  40: { code: 'KeyK', key: 'k' },
  41: { code: 'Semicolon', key: ';' },
  42: { code: 'Backslash', key: '\\' },
  43: { code: 'Comma', key: ',' },
  44: { code: 'Slash', key: '/' },
  45: { code: 'KeyN', key: 'n' },
  46: { code: 'KeyM', key: 'm' },
  47: { code: 'Period', key: '.' },
  48: { code: 'Tab', key: 'Tab' },
  49: { code: 'Space', key: ' ' },
  50: { code: 'Backquote', key: '`' },
  51: { code: 'Backspace', key: 'Backspace' },
  53: { code: 'Escape', key: 'Escape' },
  64: { code: 'F17', key: 'F17' },
  79: { code: 'F18', key: 'F18' },
  80: { code: 'F19', key: 'F19' },
  90: { code: 'F20', key: 'F20' },
  96: { code: 'F5', key: 'F5' },
  97: { code: 'F6', key: 'F6' },
  98: { code: 'F7', key: 'F7' },
  99: { code: 'F3', key: 'F3' },
  100: { code: 'F8', key: 'F8' },
  101: { code: 'F9', key: 'F9' },
  103: { code: 'F11', key: 'F11' },
  105: { code: 'F13', key: 'F13' },
  106: { code: 'F16', key: 'F16' },
  107: { code: 'F14', key: 'F14' },
  109: { code: 'F10', key: 'F10' },
  111: { code: 'F12', key: 'F12' },
  113: { code: 'F15', key: 'F15' },
  117: { code: 'Delete', key: 'Delete' },
  118: { code: 'F4', key: 'F4' },
  120: { code: 'F2', key: 'F2' },
  122: { code: 'F1', key: 'F1' },
  123: { code: 'ArrowLeft', key: 'ArrowLeft' },
  124: { code: 'ArrowRight', key: 'ArrowRight' },
  125: { code: 'ArrowDown', key: 'ArrowDown' },
  126: { code: 'ArrowUp', key: 'ArrowUp' },
};

export const VOICE_INPUT_CODE_TO_MAC_NATIVE_KEY_CODE: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(MAC_NATIVE_KEY_CODE_TO_VOICE_INPUT_KEY).map(([keyCode, value]) => [value.code, Number(keyCode)]),
);

const VOICE_INPUT_FUNCTION_KEY_CODE_PATTERN = /^F(?:[1-9]|1[0-9]|2[0-4])$/;

export const DEFAULT_VOICE_INPUT_REFINEMENT_INSTRUCTIONS = [
  '让文本清楚自然，不明显改写；保留我的语气，不改成公文或客服话术。',
  '保留技术词、模型名、产品名、变量、路径、命令和大小写。',
  '可补标点、断句和必要换行；删除无意义口头词、口吃和重复。',
  '遇到“不对”“不是”“我的意思是”等自我修正，以后面的说法为准。',
].join('\n');

export function getDefaultVoiceInputShortcut(platform?: string): VoiceInputShortcut | null {
  if (platform === 'linux') {
    return null;
  }
  if (platform === 'darwin') {
    return {
      trigger: 'keyboard',
      code: 'Space',
      key: ' ',
      modifiers: {
        meta: false,
        ctrl: false,
        alt: true,
        shift: false,
        fn: false,
      },
    };
  }

  return {
    trigger: 'keyboard',
    code: 'Space',
    key: ' ',
    modifiers: {
      meta: false,
      ctrl: true,
      alt: false,
      shift: true,
      fn: false,
    },
  };
}

export function normalizeVoiceInputShortcut(raw: unknown): VoiceInputShortcut | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<VoiceInputShortcut>;
  const modifiers = candidate.modifiers;
  const trigger = candidate.trigger === 'modifier' ? 'modifier' : 'keyboard';
  if (
    typeof candidate.code !== 'string' ||
    candidate.code.trim().length === 0
  ) {
    return null;
  }
  if (trigger === 'modifier') {
    if (!isVoiceInputModifierShortcutCode(candidate.code)) return null;
    return {
      trigger: 'modifier',
      code: candidate.code,
      key: typeof candidate.key === 'string' ? candidate.key : candidate.code,
      modifiers: {
        meta: false,
        ctrl: false,
        alt: false,
        shift: false,
        fn: false,
      },
    };
  }
  if (!modifiers || typeof modifiers !== 'object') return null;

  return {
    trigger: 'keyboard',
    code: candidate.code,
    key: typeof candidate.key === 'string' ? candidate.key : candidate.code,
    modifiers: {
      meta: Boolean(modifiers.meta),
      ctrl: Boolean(modifiers.ctrl),
      alt: Boolean(modifiers.alt),
      shift: Boolean(modifiers.shift),
      fn: Boolean((modifiers as { fn?: unknown }).fn),
    },
  };
}

export function isVoiceInputModifierShortcutCode(code: string): code is VoiceInputModifierShortcutCode {
  return (VOICE_INPUT_MODIFIER_SHORTCUT_CODES as readonly string[]).includes(code);
}

export function isVoiceInputModifierShortcut(
  shortcut: VoiceInputShortcut | null | undefined,
): shortcut is VoiceInputShortcut & { trigger: 'modifier' } {
  return Boolean(shortcut?.trigger === 'modifier' && isVoiceInputModifierShortcutCode(shortcut.code));
}

export function isVoiceInputBareFunctionKeyShortcut(
  shortcut: VoiceInputShortcut | null | undefined,
): shortcut is VoiceInputShortcut & { trigger: 'keyboard' } {
  if (!shortcut || shortcut.trigger === 'modifier') return false;
  return (
    VOICE_INPUT_FUNCTION_KEY_CODE_PATTERN.test(shortcut.code) &&
    !shortcut.modifiers.meta &&
    !shortcut.modifiers.ctrl &&
    !shortcut.modifiers.alt &&
    !shortcut.modifiers.shift &&
    !shortcut.modifiers.fn
  );
}

export function isVoiceInputMacNativeKeyboardShortcut(
  shortcut: VoiceInputShortcut | null | undefined,
): shortcut is VoiceInputShortcut & { trigger: 'keyboard' } {
  if (!shortcut || shortcut.trigger === 'modifier') return false;
  if (isVoiceInputBareFunctionKeyShortcut(shortcut)) return true;
  if (!shortcut.modifiers.fn) return false;
  return (
    shortcut.code in VOICE_INPUT_CODE_TO_MAC_NATIVE_KEY_CODE ||
    VOICE_INPUT_FUNCTION_KEY_CODE_PATTERN.test(shortcut.code)
  );
}

export function voiceInputShortcutNeedsMacNativeListener(
  shortcut: VoiceInputShortcut | null | undefined,
  platform: string,
): boolean {
  if (platform !== 'darwin') return false;
  if (isVoiceInputModifierShortcut(shortcut)) return true;
  if (!shortcut || shortcut.trigger === 'modifier') return false;
  return isVoiceInputMacNativeKeyboardShortcut(shortcut);
}

export function voiceInputShortcutNeedsWindowsNativeListener(
  shortcut: VoiceInputShortcut | null | undefined,
  platform: string,
): boolean {
  return platform === 'win32' && isVoiceInputBareFunctionKeyShortcut(shortcut);
}

export function createVoiceInputShortcutFromMacNativeKeys(keys: readonly string[]): VoiceInputShortcut | null {
  const keySet = new Set(keys);
  const fnDown = keySet.has('Fn');
  if (!fnDown) return null;
  if (keys.length === 1) {
    return {
      trigger: 'modifier',
      code: 'Fn',
      key: 'Fn',
      modifiers: {
        meta: false,
        ctrl: false,
        alt: false,
        shift: false,
        fn: false,
      },
    };
  }

  const nonModifierKeys = keys.filter(
    (key) => key.startsWith('KeyCode:') || key.startsWith('Function:'),
  );
  if (nonModifierKeys.length !== 1) return null;
  const nativeKey = nonModifierKeys[0];
  const functionCode = nativeKey.startsWith('Function:')
    ? nativeKey.slice('Function:'.length)
    : null;
  const keyCode = nativeKey.startsWith('KeyCode:')
    ? Number(nativeKey.slice('KeyCode:'.length))
    : Number.NaN;
  const mapped =
    functionCode && VOICE_INPUT_FUNCTION_KEY_CODE_PATTERN.test(functionCode)
      ? { code: functionCode, key: functionCode }
      : MAC_NATIVE_KEY_CODE_TO_VOICE_INPUT_KEY[keyCode];
  if (!mapped) return null;

  return {
    trigger: 'keyboard',
    code: mapped.code,
    key: mapped.key,
    modifiers: {
      meta: keySet.has('MetaLeft') || keySet.has('MetaRight'),
      ctrl: keySet.has('ControlLeft') || keySet.has('ControlRight'),
      alt: keySet.has('AltLeft') || keySet.has('AltRight'),
      shift: keySet.has('ShiftLeft') || keySet.has('ShiftRight'),
      fn: true,
    },
  };
}

export function isVoiceInputMacNativeKeyboardShortcutPressed(
  keys: readonly string[],
  shortcut: VoiceInputShortcut,
): boolean {
  if (!isVoiceInputMacNativeKeyboardShortcut(shortcut)) return false;
  const keySet = new Set(keys);
  const expectedNativeKey = getMacNativeShortcutKey(shortcut);
  if (!expectedNativeKey) return false;
  const nonModifierKeys = keys.filter(
    (key) => key.startsWith('KeyCode:') || key.startsWith('Function:'),
  );
  if (nonModifierKeys.length !== 1 || nonModifierKeys[0] !== expectedNativeKey) return false;

  return (
    keySet.has('Fn') === shortcut.modifiers.fn &&
    hasMacNativeModifierGroup(keySet, 'MetaLeft', 'MetaRight') === shortcut.modifiers.meta &&
    hasMacNativeModifierGroup(keySet, 'ControlLeft', 'ControlRight') === shortcut.modifiers.ctrl &&
    hasMacNativeModifierGroup(keySet, 'AltLeft', 'AltRight') === shortcut.modifiers.alt &&
    hasMacNativeModifierGroup(keySet, 'ShiftLeft', 'ShiftRight') === shortcut.modifiers.shift
  );
}

export function isVoiceInputMacNativeKeyboardShortcutTargetDown(
  keys: readonly string[],
  shortcut: VoiceInputShortcut,
): boolean {
  if (!isVoiceInputMacNativeKeyboardShortcut(shortcut)) return false;
  const expectedNativeKey = getMacNativeShortcutKey(shortcut);
  return Boolean(expectedNativeKey && keys.includes(expectedNativeKey));
}

function getMacNativeShortcutKey(shortcut: VoiceInputShortcut): string | null {
  if (VOICE_INPUT_FUNCTION_KEY_CODE_PATTERN.test(shortcut.code)) {
    return `Function:${shortcut.code}`;
  }
  const expectedKeyCode = VOICE_INPUT_CODE_TO_MAC_NATIVE_KEY_CODE[shortcut.code];
  return typeof expectedKeyCode === 'number' ? `KeyCode:${expectedKeyCode}` : null;
}

export function getDefaultVoiceInputSettings(
  platform?: string,
  region: CindyRegion = CURRENT_CINDY_REGION,
): VoiceInputSettings {
  return {
    // Global cannot assume a spoken language; the Mainland China build uses
    // Chinese as its product default. A persisted user choice still wins in
    // normalizeVoiceInputSettings below.
    language: region === 'cn' ? 'zh-CN' : 'auto',
    microphoneDeviceId: null,
    muteSystemAudio: true,
    playInteractionSound: true,
    fastActivationEnabled: false,
    refinementEnabled: true,
    refinementInstructions: DEFAULT_VOICE_INPUT_REFINEMENT_INSTRUCTIONS,
    autoDictionaryEnabled: true,
    // 有效值 = 默认;override 缺省不写(见 dictionarySyncEnabledOverride 注释)。
    dictionarySyncEnabled: DEFAULT_DICTIONARY_SYNC_ENABLED,
    dictionaryEntries: [],
    dictionaryCandidates: [],
    suppressedAutomaticDictionaryTexts: [],
    shortcut: getDefaultVoiceInputShortcut(platform),
  };
}

export function normalizeVoiceInputSettings(
  raw: unknown,
  platform?: string,
  region: CindyRegion = CURRENT_CINDY_REGION,
): VoiceInputSettings {
  const defaults = getDefaultVoiceInputSettings(platform, region);
  if (!raw || typeof raw !== 'object') return defaults;
  const candidate = raw as Partial<VoiceInputSettings>;
  const legacyPlayStartSound = (candidate as { playStartSound?: unknown }).playStartSound;
  const shortcut =
    'shortcut' in candidate
      ? normalizeVoiceInputShortcut(candidate.shortcut)
      : defaults.shortcut;
  return {
    language: isVoiceInputLanguage(candidate.language) ? candidate.language : defaults.language,
    microphoneDeviceId:
      typeof candidate.microphoneDeviceId === 'string' && candidate.microphoneDeviceId.trim().length > 0
        ? candidate.microphoneDeviceId
        : defaults.microphoneDeviceId,
    muteSystemAudio:
      typeof candidate.muteSystemAudio === 'boolean'
        ? candidate.muteSystemAudio
        : defaults.muteSystemAudio,
    playInteractionSound:
      typeof candidate.playInteractionSound === 'boolean'
        ? candidate.playInteractionSound
        : typeof legacyPlayStartSound === 'boolean'
          ? legacyPlayStartSound
          : defaults.playInteractionSound,
    fastActivationEnabled:
      typeof candidate.fastActivationEnabled === 'boolean'
        ? candidate.fastActivationEnabled
        : defaults.fastActivationEnabled,
    refinementEnabled:
      typeof candidate.refinementEnabled === 'boolean'
        ? candidate.refinementEnabled
        : defaults.refinementEnabled,
    refinementInstructions: normalizeRefinementInstructions(
      candidate.refinementInstructions,
      defaults.refinementInstructions,
    ),
    autoDictionaryEnabled:
      typeof candidate.autoDictionaryEnabled === 'boolean'
        ? candidate.autoDictionaryEnabled
        : defaults.autoDictionaryEnabled,
    // 只认 override 字段。历史数据里可能存过有效值(本 PR 早期版本),那时无法
    // 区分「用户选的」和「当时的默认」——按规则 §3 只做一次性兼容:仅当它与当前
    // 默认不同时才当作用户的显式选择,相同则视为未自定义。
    ...normalizeDictionarySyncOverride(candidate),
    dictionaryEntries: normalizeVoiceInputDictionaryEntries(
      candidate.dictionaryEntries ?? (candidate as { customDictionary?: unknown }).customDictionary,
    ),
    dictionaryCandidates: normalizeVoiceInputDictionaryCandidates(candidate.dictionaryCandidates),
    suppressedAutomaticDictionaryTexts: normalizeSuppressedAutomaticDictionaryTexts(
      candidate.suppressedAutomaticDictionaryTexts,
    ),
    shortcut: platform === 'linux' ? null : shortcut,
  };
}

export function normalizeVoiceInputDataSnapshot(
  raw: unknown,
  platform?: string,
): VoiceInputDataSnapshot {
  if (!raw || typeof raw !== 'object') {
    return {
      settings: getDefaultVoiceInputSettings(platform),
      history: [],
    };
  }
  const candidate = raw as Partial<VoiceInputDataSnapshot>;
  return {
    settings: normalizeVoiceInputSettings(candidate.settings, platform),
    history: normalizeVoiceInputHistory(candidate.history),
  };
}

export function normalizeVoiceInputDictionaryEntryText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, MAX_VOICE_INPUT_DICTIONARY_ENTRY_CHARS)
    .trim();
}

export function createManualVoiceInputDictionaryEntry(text: string): VoiceInputDictionaryEntry | null {
  const normalized = normalizeVoiceInputDictionaryEntryText(text);
  if (!normalized) return null;
  return createVoiceInputDictionaryEntry(normalized, 'manual', Date.now());
}

export type VoiceInputDictionaryCsvParseResult =
  | {
      ok: true;
      terms: string[];
      duplicateRowCount: number;
      skippedTooLongCount: number;
    }
  | {
      ok: false;
      reason: 'empty' | 'invalidCsv';
    };

export interface VoiceInputDictionaryCsvMergeResult {
  entries: VoiceInputDictionaryEntry[];
  importedCount: number;
  duplicateExistingCount: number;
  capacitySkippedCount: number;
}

export function parseVoiceInputDictionaryCsv(text: string): VoiceInputDictionaryCsvParseResult {
  const rows = parseSingleFileCsvRows(text.replace(/^\uFEFF/, ''));
  if (!rows) return { ok: false, reason: 'invalidCsv' };
  const terms: string[] = [];
  const seen = new Set<string>();
  let duplicateRowCount = 0;
  let skippedTooLongCount = 0;

  for (const row of rows) {
    if (row.some((field) => field.includes('\0'))) {
      return { ok: false, reason: 'invalidCsv' };
    }
    const filled = row.map((field) => field.trim()).filter((field) => field.length > 0);
    if (filled.length === 0) continue;
    if (filled.length > 1) {
      return { ok: false, reason: 'invalidCsv' };
    }
    const term = normalizeVoiceInputDictionaryCsvTerm(filled[0]);
    if (!term) {
      skippedTooLongCount += 1;
      continue;
    }
    const key = dictionaryTextKey(term);
    if (seen.has(key)) {
      duplicateRowCount += 1;
      continue;
    }
    seen.add(key);
    terms.push(term);
  }

  return terms.length > 0
    ? { ok: true, terms, duplicateRowCount, skippedTooLongCount }
    : { ok: false, reason: 'empty' };
}

export function mergeVoiceInputDictionaryCsvTerms(
  existingEntries: ReadonlyArray<VoiceInputDictionaryEntry>,
  terms: readonly string[],
): VoiceInputDictionaryCsvMergeResult {
  const entries = normalizeVoiceInputDictionaryEntries(existingEntries);
  const seen = new Set(entries.map((entry) => dictionaryTextKey(entry.text)));
  let importedCount = 0;
  let duplicateExistingCount = 0;
  let capacitySkippedCount = 0;
  const now = Date.now();

  for (const rawTerm of terms) {
    const term = normalizeVoiceInputDictionaryCsvTerm(rawTerm);
    if (!term) continue;
    const key = dictionaryTextKey(term);
    if (seen.has(key)) {
      duplicateExistingCount += 1;
      continue;
    }
    if (entries.length >= MAX_VOICE_INPUT_DICTIONARY_ENTRIES) {
      capacitySkippedCount += 1;
      continue;
    }
    seen.add(key);
    importedCount += 1;
    entries.push(createVoiceInputDictionaryEntry(term, 'manual', now, {
      frequency: 1,
      aliases: [],
    }));
  }

  return {
    entries,
    importedCount,
    duplicateExistingCount,
    capacitySkippedCount,
  };
}

export function formatVoiceInputDictionary(entries: ReadonlyArray<VoiceInputDictionaryEntry>): string {
  const normalized = normalizeVoiceInputDictionaryEntries(entries);
  const manual = normalized
    .filter((entry) => entry.source === 'manual')
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const automatic = normalized
    .filter((entry) => entry.source === 'automatic')
    .sort((a, b) => b.frequency - a.frequency || b.updatedAt - a.updatedAt);
  const formatEntry = (entry: VoiceInputDictionaryEntry): string => `- ${entry.text}`;
  const sections = [
    manual.length > 0 ? ['手动添加:', ...manual.map(formatEntry)].join('\n') : '',
    automatic.length > 0 ? ['自动添加:', ...automatic.map(formatEntry)].join('\n') : '',
  ].filter(Boolean);
  return sections.join('\n\n');
}

export function buildVoiceInputDictionaryAliasHints(
  entries: ReadonlyArray<VoiceInputDictionaryEntry>,
): NonNullable<DictationRefinementContext['dictionaryAliasHints']> | undefined {
  const hints = normalizeVoiceInputDictionaryEntries(entries)
    .filter((entry) => entry.aliases.length > 0)
    .sort((a, b) => b.frequency - a.frequency || b.updatedAt - a.updatedAt)
    .map((entry) => ({
      term: entry.text,
      frequency: entry.frequency,
      aliases: entry.aliases
        .slice()
        .sort((a, b) => b.count - a.count || b.lastSeenAt - a.lastSeenAt)
        .slice(0, MAX_VOICE_INPUT_DICTIONARY_ALIASES)
        .map((alias) => ({
          text: alias.text,
          count: alias.count,
        })),
    }))
    .filter((entry) => entry.aliases.length > 0);
  return hints.length > 0 ? hints : undefined;
}

export function getNewAutomaticDictionaryEntries(
  previousEntries: ReadonlyArray<VoiceInputDictionaryEntry>,
  nextEntries: ReadonlyArray<VoiceInputDictionaryEntry>,
): Array<Pick<VoiceInputDictionaryEntry, 'id' | 'text'>> {
  const previousAutomaticKeys = new Set(
    normalizeVoiceInputDictionaryEntries(previousEntries)
      .filter((entry) => entry.source === 'automatic')
      .map((entry) => dictionaryTextKey(entry.text)),
  );
  return normalizeVoiceInputDictionaryEntries(nextEntries)
    .filter((entry) => entry.source === 'automatic')
    .filter((entry) => !previousAutomaticKeys.has(dictionaryTextKey(entry.text)))
    .map((entry) => ({ id: entry.id, text: entry.text }));
}

export function getNewAutomaticDictionaryEntryTexts(
  previousEntries: ReadonlyArray<VoiceInputDictionaryEntry>,
  nextEntries: ReadonlyArray<VoiceInputDictionaryEntry>,
): string[] {
  return getNewAutomaticDictionaryEntries(previousEntries, nextEntries).map((entry) => entry.text);
}

export function applyVoiceInputDictionaryLearningActions(
  current: VoiceInputSettings,
  actions: DictationDictionaryLearningAction[],
): VoiceInputSettings {
  if (actions.length === 0) return current;
  if (!current.refinementEnabled || !current.autoDictionaryEnabled) return current;

  let dictionaryEntries = current.dictionaryEntries;
  let dictionaryCandidates = current.dictionaryCandidates;
  const suppressed = new Set(current.suppressedAutomaticDictionaryTexts.map(dictionaryTextKey));
  const now = Date.now();
  let changed = false;

  actions.forEach((action) => {
    const text = normalizeVoiceInputDictionaryEntryText(action.term);
    const aliasTexts = action.aliases
      .map(normalizeVoiceInputDictionaryEntryText)
      .filter((alias): alias is string => Boolean(alias && alias !== text));
    if (!text || aliasTexts.length === 0 || action.confidence === 'low') return;

    const key = dictionaryTextKey(text);
    const entryIndex = dictionaryEntries.findIndex((entry) => dictionaryTextKey(entry.text) === key);
    const candidateIndex = dictionaryCandidates.findIndex((entry) => dictionaryTextKey(entry.text) === key);
    const existingCandidate = candidateIndex >= 0 ? dictionaryCandidates[candidateIndex] : null;

    if (entryIndex >= 0 || action.action === 'add_entry' || action.action === 'update_entry') {
      if (entryIndex >= 0) {
        const entry = dictionaryEntries[entryIndex];
        const nextEntry: VoiceInputDictionaryEntry = {
          ...entry,
          frequency: entry.frequency + 1,
          aliases: mergeVoiceInputDictionaryAliases(entry.aliases, aliasTexts, now),
          updatedAt: now,
        };
        dictionaryEntries = [
          ...dictionaryEntries.slice(0, entryIndex),
          nextEntry,
          ...dictionaryEntries.slice(entryIndex + 1),
        ];
      } else {
        if (suppressed.has(key)) return;
        const aliases = mergeVoiceInputDictionaryAliases(existingCandidate?.aliases ?? [], aliasTexts, now);
        const frequency = (existingCandidate?.evidenceCount ?? 0) + 1;
        dictionaryEntries = [
          ...dictionaryEntries,
          createVoiceInputDictionaryEntry(text, 'automatic', now, {
            frequency,
            aliases,
          }),
        ];
      }
      dictionaryCandidates = candidateIndex >= 0
        ? [
            ...dictionaryCandidates.slice(0, candidateIndex),
            ...dictionaryCandidates.slice(candidateIndex + 1),
          ]
        : dictionaryCandidates;
      changed = true;
      return;
    }

    if (suppressed.has(key)) return;
    const nextCandidate: VoiceInputDictionaryCandidate = existingCandidate
      ? {
          ...existingCandidate,
          evidenceCount: existingCandidate.evidenceCount + 1,
          aliases: mergeVoiceInputDictionaryAliases(existingCandidate.aliases, aliasTexts, now),
          updatedAt: now,
        }
      : {
          text,
          evidenceCount: 1,
          aliases: mergeVoiceInputDictionaryAliases([], aliasTexts, now),
          createdAt: now,
          updatedAt: now,
        };
    dictionaryCandidates = candidateIndex >= 0
      ? [
          ...dictionaryCandidates.slice(0, candidateIndex),
          nextCandidate,
          ...dictionaryCandidates.slice(candidateIndex + 1),
        ]
      : [...dictionaryCandidates, nextCandidate];
    changed = true;
  });

  if (!changed) return current;
  return {
    ...current,
    dictionaryEntries,
    dictionaryCandidates,
  };
}

export function deleteVoiceInputDictionaryEntriesFromSettings(
  current: VoiceInputSettings,
  entryIds: string[],
): VoiceInputSettings {
  const entryIdSet = new Set(entryIds.map((entryId) => entryId.trim()).filter(Boolean));
  if (entryIdSet.size === 0) return current;
  const entries = current.dictionaryEntries.filter((candidate) => entryIdSet.has(candidate.id));
  if (entries.length === 0) return current;
  const deletedKeys = new Set(entries.map((entry) => dictionaryTextKey(entry.text)));
  const suppressedKeys = new Set(current.suppressedAutomaticDictionaryTexts.map(dictionaryTextKey));
  const suppressedAutomaticDictionaryTexts = [...current.suppressedAutomaticDictionaryTexts];
  entries
    .filter((entry) => entry.source === 'automatic')
    .forEach((entry) => {
      const key = dictionaryTextKey(entry.text);
      if (suppressedKeys.has(key)) return;
      suppressedKeys.add(key);
      suppressedAutomaticDictionaryTexts.push(entry.text);
    });
  return normalizeVoiceInputSettings({
    ...current,
    dictionaryEntries: current.dictionaryEntries.filter((candidate) => !entryIdSet.has(candidate.id)),
    dictionaryCandidates: current.dictionaryCandidates.filter(
      (candidate) => !deletedKeys.has(dictionaryTextKey(candidate.text)),
    ),
    suppressedAutomaticDictionaryTexts,
  });
}

export function toDictionaryLearningEntryState(
  entries: VoiceInputDictionaryEntry[],
): DictationDictionaryLearningEntryState[] {
  return entries.map((entry) => ({
    term: entry.text,
    source: entry.source,
    frequency: entry.frequency,
    aliases: entry.aliases.map((alias) => ({
      text: alias.text,
      count: alias.count,
    })),
  }));
}

export function toDictionaryLearningCandidateState(
  candidates: VoiceInputDictionaryCandidate[],
): DictationDictionaryLearningCandidateState[] {
  return candidates.map((candidate) => ({
    term: candidate.text,
    evidenceCount: candidate.evidenceCount,
    aliases: candidate.aliases.map((alias) => ({
      text: alias.text,
      count: alias.count,
    })),
  }));
}

export function normalizeVoiceInputHistory(raw: unknown): VoiceInputHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeVoiceInputHistoryEntry)
    .filter((entry): entry is VoiceInputHistoryEntry => Boolean(entry))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function createVoiceInputHistoryEntry(text: string, timestamp = Date.now()): VoiceInputHistoryEntry | null {
  const normalizedText = text.trim();
  if (!normalizedText) return null;
  return {
    id: createId('voice', timestamp),
    text: normalizedText,
    createdAt: timestamp,
  };
}

/**
 * 把持久化里的 override 归一成 { 有效值, override? }。
 *
 * 返回的对象直接展开进 settings:没有 override 时**不产生该字段**,这样它不会被
 * 写回用户配置。
 */
function normalizeDictionarySyncOverride(
  candidate: Partial<VoiceInputSettings>,
): Pick<VoiceInputSettings, 'dictionarySyncEnabled'> & { dictionarySyncEnabledOverride?: boolean } {
  // null = 用户要求恢复默认:丢掉 override,重新跟随当前版本默认值。
  if (candidate.dictionarySyncEnabledOverride === null) {
    return { dictionarySyncEnabled: DEFAULT_DICTIONARY_SYNC_ENABLED };
  }
  const override = typeof candidate.dictionarySyncEnabledOverride === 'boolean'
    ? candidate.dictionarySyncEnabledOverride
    : legacyDictionarySyncOverride(candidate.dictionarySyncEnabled);
  if (override === undefined) return { dictionarySyncEnabled: DEFAULT_DICTIONARY_SYNC_ENABLED };
  return { dictionarySyncEnabled: override, dictionarySyncEnabledOverride: override };
}

/**
 * 一次性兼容:本 PR 早期版本把有效值直接写进了配置,没有自定义标记。
 * 规则 §3 不允许靠旧值猜意图,所以只在它与当前默认**不同**时才认作显式选择——
 * 那种值只可能来自用户主动关闭;与默认相同的一律当作未自定义。
 */
function legacyDictionarySyncOverride(value: unknown): boolean | undefined {
  if (typeof value !== 'boolean') return undefined;
  return value === DEFAULT_DICTIONARY_SYNC_ENABLED ? undefined : value;
}

function isVoiceInputLanguage(value: unknown): value is VoiceInputLanguage {
  if (value === 'auto') return true;
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

function hasMacNativeModifierGroup(keySet: ReadonlySet<string>, left: string, right: string): boolean {
  return keySet.has(left) || keySet.has(right);
}

function normalizeRefinementInstructions(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value
    .replace(/\r\n?/g, '\n')
    .slice(0, MAX_VOICE_INPUT_REFINEMENT_INSTRUCTIONS_CHARS);
  return normalized.trim().length > 0 ? normalized : fallback;
}

function dictionaryTextKey(text: string): string {
  return normalizeVoiceInputDictionaryEntryText(text).toLocaleLowerCase();
}

function normalizeVoiceInputDictionaryCsvTerm(value: string): string | null {
  const normalized = value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  if (!normalized || normalized.length > MAX_VOICE_INPUT_DICTIONARY_ENTRY_CHARS) {
    return null;
  }
  return normalized;
}

function parseSingleFileCsvRows(text: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let afterQuote = false;
  let fieldStartedWithQuote = false;

  const pushField = () => {
    row.push(field);
    field = '';
    afterQuote = false;
    fieldStartedWithQuote = false;
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      if (field.length === 0 && !fieldStartedWithQuote && !afterQuote) {
        inQuotes = true;
        fieldStartedWithQuote = true;
        continue;
      }
      return null;
    }

    if (afterQuote && char !== ',' && char !== '\n' && char !== '\r' && !/\s/.test(char)) {
      return null;
    }

    if (char === ',') {
      pushField();
      continue;
    }
    if (char === '\n') {
      pushRow();
      continue;
    }
    if (char === '\r') {
      if (text[index + 1] === '\n') index += 1;
      pushRow();
      continue;
    }
    field += char;
  }

  if (inQuotes) return null;
  if (field.length > 0 || row.length > 0) {
    pushRow();
  }
  return rows;
}

function normalizeVoiceInputDictionaryAlias(value: unknown, fallbackTimestamp: number): VoiceInputDictionaryAlias | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<VoiceInputDictionaryAlias>;
  const text = normalizeVoiceInputDictionaryEntryText(candidate.text);
  if (!text) return null;
  return {
    text,
    count: Math.max(1, Math.floor(typeof candidate.count === 'number' ? candidate.count : 1)),
    lastSeenAt: typeof candidate.lastSeenAt === 'number' ? candidate.lastSeenAt : fallbackTimestamp,
  };
}

function normalizeVoiceInputDictionaryAliases(
  value: unknown,
  fallbackTimestamp: number,
): VoiceInputDictionaryAlias[] {
  if (!Array.isArray(value)) return [];
  const byText = new Map<string, VoiceInputDictionaryAlias>();
  value.forEach((rawAlias) => {
    const alias = normalizeVoiceInputDictionaryAlias(rawAlias, fallbackTimestamp);
    if (!alias) return;
    const key = dictionaryTextKey(alias.text);
    const existing = byText.get(key);
    if (existing) {
      byText.set(key, {
        text: existing.text,
        count: existing.count + alias.count,
        lastSeenAt: Math.max(existing.lastSeenAt, alias.lastSeenAt),
      });
      return;
    }
    byText.set(key, alias);
  });
  return Array.from(byText.values())
    .sort((a, b) => b.count - a.count || b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_VOICE_INPUT_DICTIONARY_ALIASES);
}

function mergeVoiceInputDictionaryAlias(
  aliases: ReadonlyArray<VoiceInputDictionaryAlias>,
  aliasText: string,
  timestamp: number,
): VoiceInputDictionaryAlias[] {
  const normalizedAlias = normalizeVoiceInputDictionaryEntryText(aliasText);
  if (!normalizedAlias) return normalizeVoiceInputDictionaryAliases(aliases, timestamp);
  const byText = new Map<string, VoiceInputDictionaryAlias>();
  normalizeVoiceInputDictionaryAliases(aliases, timestamp).forEach((alias) => {
    byText.set(dictionaryTextKey(alias.text), alias);
  });
  const key = dictionaryTextKey(normalizedAlias);
  const existing = byText.get(key);
  byText.set(key, {
    text: existing?.text ?? normalizedAlias,
    count: (existing?.count ?? 0) + 1,
    lastSeenAt: timestamp,
  });
  return Array.from(byText.values())
    .sort((a, b) => b.count - a.count || b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_VOICE_INPUT_DICTIONARY_ALIASES);
}

function mergeVoiceInputDictionaryAliases(
  aliases: ReadonlyArray<VoiceInputDictionaryAlias>,
  aliasTexts: string[],
  timestamp: number,
): VoiceInputDictionaryAlias[] {
  return aliasTexts.reduce(
    (nextAliases, aliasText) => mergeVoiceInputDictionaryAlias(nextAliases, aliasText, timestamp),
    normalizeVoiceInputDictionaryAliases(aliases, timestamp),
  );
}

function createVoiceInputDictionaryEntry(
  text: string,
  source: VoiceInputDictionaryEntrySource,
  timestamp: number,
  options?: {
    frequency?: number;
    aliases?: VoiceInputDictionaryAlias[];
  },
): VoiceInputDictionaryEntry {
  return {
    id: createId('dict', timestamp, text),
    text,
    source,
    frequency: Math.max(1, Math.floor(options?.frequency ?? 1)),
    aliases: normalizeVoiceInputDictionaryAliases(options?.aliases, timestamp),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function normalizeVoiceInputDictionaryEntries(value: unknown): VoiceInputDictionaryEntry[] {
  if (typeof value === 'string') {
    const timestamp = Date.now();
    return value
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => normalizeVoiceInputDictionaryEntryText(line))
      .filter(Boolean)
      .slice(0, MAX_VOICE_INPUT_DICTIONARY_ENTRIES)
      .map((text) => createVoiceInputDictionaryEntry(text, 'manual', timestamp));
  }

  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const candidate = entry as Partial<VoiceInputDictionaryEntry>;
      const text = normalizeVoiceInputDictionaryEntryText(candidate.text);
      if (!text) return null;
      const source: VoiceInputDictionaryEntrySource =
        candidate.source === 'automatic' ? 'automatic' : 'manual';
      const now = Date.now();
      const createdAt = typeof candidate.createdAt === 'number' ? candidate.createdAt : now;
      const updatedAt = typeof candidate.updatedAt === 'number' ? candidate.updatedAt : createdAt;
      const frequency = Math.max(1, Math.floor(typeof candidate.frequency === 'number' ? candidate.frequency : 1));
      const aliases = normalizeVoiceInputDictionaryAliases(candidate.aliases, updatedAt);
      const id = typeof candidate.id === 'string' && candidate.id.trim()
        ? candidate.id.trim()
        : `dict-${createdAt}-${text}`;
      const dedupeKey = `${source}:${text.toLocaleLowerCase()}`;
      if (seen.has(dedupeKey)) return null;
      seen.add(dedupeKey);
      return {
        id,
        text,
        source,
        frequency,
        aliases,
        createdAt,
        updatedAt,
      };
    })
    .filter((entry): entry is VoiceInputDictionaryEntry => Boolean(entry))
    .slice(0, MAX_VOICE_INPUT_DICTIONARY_ENTRIES);
}

function normalizeVoiceInputDictionaryCandidates(value: unknown): VoiceInputDictionaryCandidate[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const candidate = entry as Partial<VoiceInputDictionaryCandidate>;
      const text = normalizeVoiceInputDictionaryEntryText(candidate.text);
      if (!text) return null;
      const key = dictionaryTextKey(text);
      if (seen.has(key)) return null;
      seen.add(key);
      const now = Date.now();
      const createdAt = typeof candidate.createdAt === 'number' ? candidate.createdAt : now;
      const updatedAt = typeof candidate.updatedAt === 'number' ? candidate.updatedAt : createdAt;
      const aliases = normalizeVoiceInputDictionaryAliases(candidate.aliases, updatedAt);
      const evidenceCount = Math.max(
        1,
        Math.floor(
          typeof candidate.evidenceCount === 'number'
            ? candidate.evidenceCount
            : aliases.reduce((sum, alias) => sum + alias.count, 0) || 1,
        ),
      );
      return {
        text,
        evidenceCount,
        aliases,
        createdAt,
        updatedAt,
      };
    })
    .filter((entry): entry is VoiceInputDictionaryCandidate => Boolean(entry))
    .sort((a, b) => b.evidenceCount - a.evidenceCount || b.updatedAt - a.updatedAt)
    .slice(0, MAX_VOICE_INPUT_DICTIONARY_CANDIDATES);
}

function normalizeSuppressedAutomaticDictionaryTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .map((text) => normalizeVoiceInputDictionaryEntryText(text))
    .filter((text) => {
      if (!text) return false;
      const key = dictionaryTextKey(text);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_VOICE_INPUT_DICTIONARY_ENTRIES);
}

function normalizeVoiceInputHistoryEntry(raw: unknown): VoiceInputHistoryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<VoiceInputHistoryEntry>;
  const text = typeof candidate.text === 'string' ? candidate.text.trim() : '';
  const createdAt = Number(candidate.createdAt);
  if (!text || !Number.isFinite(createdAt) || createdAt <= 0) return null;
  return {
    id: typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id : createId('voice'),
    text,
    createdAt,
  };
}

function createId(prefix: string, timestamp = Date.now(), seed = ''): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const suffix = seed ? `-${seed}` : `-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${timestamp}${suffix}`;
}
