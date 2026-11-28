/**
 * 系统保留快捷键表 —— 判定某个「修饰键 + 物理键」组合是否会与 OS 级快捷键冲突。
 *
 * 从 renderer/voice-input/shortcut.ts 抽出为 shared 纯数据 + 纯函数,
 * 供语音输入快捷键与应用级快捷键 (appShortcuts) 两套体系共用同一份保留键
 * 判定。零 DOM / Electron 依赖, main / renderer 均可 import。
 *
 * 判定基准是 W3C KeyboardEvent.code (物理键位, 布局无关)。
 */

/** 保留键判定的输入形状 —— 任何 combo 模型都可摊平成这个结构参与判定。 */
export interface ReservedShortcutInput {
  code: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

/**
 * macOS 上不可占用的保留组合: 系统编辑惯例键 (⌘A/C/V/X/Z、⇧⌘Z、⌘,) +
 * 应用菜单原生 role 的 accelerator (⌘Q 退出、⌘H 隐藏、⌥⌘H 隐藏其他、
 * ⌘M 最小化、⌘W 关窗、⌘0 重置缩放、⌃⌘F 全屏)。后者由系统在
 * renderer 收到按键前分发, 绑定给应用快捷键会形同虚设甚至直接退出应用。
 * ⌘=/⌘- 缩放改由 renderer 分发, 以便编辑器聚焦时局部调整字号。
 */
export function isMacReservedShortcut(input: ReservedShortcutInput): boolean {
  const onlyCommand = input.meta && !input.ctrl && !input.alt && !input.shift;
  const commandShift = input.meta && input.shift && !input.ctrl && !input.alt;
  const commandAlt = input.meta && input.alt && !input.ctrl && !input.shift;
  const commandCtrl = input.meta && input.ctrl && !input.alt && !input.shift;
  if (onlyCommand) {
    return new Set([
      'KeyA',
      'KeyC',
      'KeyV',
      'KeyX',
      'KeyZ',
      'Comma',
      'KeyQ',
      'KeyH',
      'KeyM',
      'KeyW',
      'Digit0',
    ]).has(input.code);
  }
  if (commandShift) {
    return input.code === 'KeyZ';
  }
  if (commandAlt) {
    return input.code === 'KeyH'; // hideOthers
  }
  if (commandCtrl) {
    return input.code === 'KeyF'; // togglefullscreen
  }
  return false;
}

/** Windows 上不可占用的系统保留组合 (Win 键组合、Alt+Tab 族、输入法切换等)。 */
export function isWindowsReservedShortcut(input: ReservedShortcutInput): boolean {
  const code = input.code;
  const ctrlOnly = input.ctrl && !input.alt && !input.shift && !input.meta;
  const altOnly = input.alt && !input.ctrl && !input.shift && !input.meta;
  const ctrlAlt = input.ctrl && input.alt && !input.shift && !input.meta;

  if (ctrlOnly && code === 'Space') return true;
  if (altOnly && new Set(['Tab', 'F4', 'Escape']).has(code)) return true;
  if (ctrlAlt && code === 'Delete') return true;

  if (!input.meta) return false;
  const onlyMeta = !input.ctrl && !input.alt && !input.shift;
  const metaShift = input.shift && !input.ctrl && !input.alt;
  const metaCtrl = input.ctrl && !input.shift && !input.alt;
  const metaAlt = input.alt && !input.ctrl && !input.shift;
  const metaCtrlShift = input.ctrl && input.shift && !input.alt;

  if (onlyMeta) {
    if (/^Digit[0-9]$/.test(code)) return true;
    return new Set([
      'KeyA',
      'KeyC',
      'KeyD',
      'KeyE',
      'KeyF',
      'KeyG',
      'KeyH',
      'KeyI',
      'KeyJ',
      'KeyK',
      'KeyL',
      'KeyM',
      'KeyN',
      'KeyO',
      'KeyP',
      'KeyQ',
      'KeyR',
      'KeyS',
      'KeyT',
      'KeyV',
      'KeyW',
      'KeyX',
      'KeyZ',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Comma',
      'Period',
      'Semicolon',
      'Slash',
      'Tab',
      'Space',
      'Home',
      'Escape',
      'Minus',
      'Equal',
      'PrintScreen',
      'Pause',
    ]).has(code);
  }

  if (metaShift) {
    return new Set([
      'KeyA',
      'KeyS',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Enter',
    ]).has(code);
  }

  if (metaCtrl) {
    return new Set([
      'KeyC',
      'KeyD',
      'KeyF',
      'KeyQ',
      'KeyV',
      'Enter',
      'Space',
      'ArrowLeft',
      'ArrowRight',
      'F4',
    ]).has(code);
  }

  if (metaAlt) {
    return new Set(['KeyB', 'KeyD', 'KeyH', 'KeyK', 'ArrowUp', 'ArrowDown']).has(code);
  }

  if (metaCtrlShift) {
    return code === 'KeyB';
  }

  return false;
}

/** 按平台派发保留键判定;非 mac / windows 平台一律视为不保留。 */
export function isSystemReservedShortcut(
  input: ReservedShortcutInput,
  platform: 'mac' | 'windows' | 'other',
): boolean {
  if (platform === 'mac') return isMacReservedShortcut(input);
  if (platform === 'windows') return isWindowsReservedShortcut(input);
  return false;
}
