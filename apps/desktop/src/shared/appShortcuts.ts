/**
 * 应用级快捷键 registry —— 全部应用级快捷键的单一事实来源。
 *
 * 与 applicationMenuCommands.ts 并列且职责分离: commands 描述「菜单点击派发
 * 什么指令」, 本文件描述「什么按键组合触发什么动作」。两者在消费端 (菜单
 * click / renderer handler) 衔接, 互不合并。
 *
 * 纯常量 + 纯函数, 零 Electron / DOM 依赖 (platform 一律作参数传入),
 * main / preload / renderer 三端可 import。内部规范表示以 KeyboardEvent.code
 * 为基准 (物理键位, 布局无关, 与 voice-input 快捷键体系一致); Electron
 * accelerator 字符串与 before-input-event Input 均通过本文件的转换/匹配函数
 * 与该表示互通, 保证双端判定不漂移。
 *
 * 用户 override 只存差异 (见 main/app-shortcuts/AppShortcutStore), 默认值由
 * 本 registry 随版本演进; getEffectiveAppShortcuts 负责合并。
 */

/** 规范化组合键: code 为 W3C KeyboardEvent.code, key 仅供显示兜底不参与匹配。 */
export interface AppShortcutCombo {
  code: string;
  key?: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

/**
 * 冲突检测域: app 与一切重叠; workdir-doc 与 browser / composer 也重叠, 因为
 * 文件预览可同屏挂载右侧浏览器和 chat rail, 且在 window capture 阶段消费快捷键。
 * 仅用于改绑冲突判定, 不做展示分组。
 */
export type AppShortcutScope = 'app' | 'workdir-doc' | 'browser' | 'composer';

export const APP_SHORTCUT_IDS = [
  'toggle-sidebar',
  'open-settings',
  'new-maker',
  'close-tab-or-window',
  'right-tab-prev',
  'right-tab-next',
  'find-in-page',
  'search-in-project',
  'save-file',
  'open-terminal',
  'zoom-in',
  'zoom-out',
  'zoom-reset',
  'browser-focus-url',
  'browser-back',
  'browser-forward',
  'browser-reload',
  'cycle-permission-mode',
  'switch-session-1',
  'switch-session-2',
  'switch-session-3',
  'switch-session-4',
  'switch-session-5',
  'switch-session-6',
  'switch-session-7',
  'switch-session-8',
  'switch-session-9',
] as const;

export type AppShortcutId = (typeof APP_SHORTCUT_IDS)[number];

/**
 * 侧边栏对话切换槽位: mod+1..9 跳转到侧边栏第 N 个可见对话(含置顶区, 按渲染
 * 顺序, 与 getVisibleSidebarSessionIds 同一口径)。逐 id 注册以完整复用改绑 /
 * 冲突检测 / accelerator 转换体系; 消费端与按住修饰键浮现的序号徽标见
 * renderer CCAgentSidebarUpper。数组序 = 槽位序 (index 0 ↔ 数字键 1)。
 */
export const SWITCH_SESSION_SHORTCUT_IDS = [
  'switch-session-1',
  'switch-session-2',
  'switch-session-3',
  'switch-session-4',
  'switch-session-5',
  'switch-session-6',
  'switch-session-7',
  'switch-session-8',
  'switch-session-9',
] as const satisfies readonly AppShortcutId[];

export interface AppShortcutDefinition {
  id: AppShortcutId;
  scope: AppShortcutScope;
  /** i18n key: settings.shortcuts.items.<id>.label */
  labelKey: string;
  /** i18n key: settings.shortcuts.items.<id>.description (设置页条目说明) */
  descriptionKey: string;
  rebindable: boolean;
  /** true = 不在设置页快捷键列表展示 (仍正常生效, 如 ⌘, 打开设置)。 */
  hiddenInSettings?: boolean;
  /**
   * true = 本条目的默认组合对用户既有绑定让位: 与其它 id 的 override 或
   * registry 之外体系的用户键位 (yieldToCombos) 撞键时, 默认组合被压制
   * (该槽位等效无绑定), 写入侧 findAppShortcutConflict 也不把它算作占用。
   * 只用于「批量占键的次要便捷槽位」(switch-session-*): 它们隐藏在设置页
   * 之外, 用户看不到也解不开, 不让位就会一次按键双动作。save-file / ⌘, 等
   * 惯例键虽也 hiddenInSettings 但**不得**设本字段 —— 否则用户把别的键改绑
   * 到 ⌘S 会被放行并静默丢失保存快捷键。
   */
  yieldsToUserBindings?: boolean;
  /**
   * true = darwin 上唯一触发路径是应用菜单 accelerator (无 renderer /
   * before-input-event fallback)。改绑时必须能转换为 Electron accelerator
   * (comboToElectronAccelerator 非 null), 否则 UI 显示已绑定但按键永不生效
   * —— store 与设置页双端都按此校验拦截。
   */
  menuBacked?: boolean;
  /** 缺省 = 全平台可用。 */
  platforms?: ReadonlyArray<'darwin' | 'win32' | 'linux'>;
  /**
   * 平台默认组合, 支持多默认 (如 reload = mod+R 与 F5)。用户 override 时以
   * 单个 combo 整体替换整个默认列表。
   */
  getDefaultCombos(platform: string): AppShortcutCombo[];
}

type ComboModifiers = Partial<Pick<AppShortcutCombo, 'meta' | 'ctrl' | 'alt' | 'shift'>>;

function combo(code: string, modifiers: ComboModifiers = {}): AppShortcutCombo {
  return {
    code,
    meta: Boolean(modifiers.meta),
    ctrl: Boolean(modifiers.ctrl),
    alt: Boolean(modifiers.alt),
    shift: Boolean(modifiers.shift),
  };
}

/** darwin 上 mod = ⌘, 其它平台 mod = Ctrl。 */
function modCombo(code: string, platform: string, extra: ComboModifiers = {}): AppShortcutCombo {
  return platform === 'darwin'
    ? combo(code, { ...extra, meta: true })
    : combo(code, { ...extra, ctrl: true });
}

// 数组顺序即设置页展示顺序: 高频动作在前 (新对话 → 侧边栏 → 权限模式 →
// 命令行 → 查找 → 缩放 → 浏览器)。hiddenInSettings 项不展示但仍正常生效。
export const APP_SHORTCUT_DEFINITIONS: ReadonlyArray<AppShortcutDefinition> = [
  {
    id: 'new-maker',
    scope: 'app',
    labelKey: 'settings.shortcuts.items.new-maker.label',
    descriptionKey: 'settings.shortcuts.items.new-maker.description',
    rebindable: true,
    menuBacked: true,
    getDefaultCombos: (platform) => [modCombo('KeyN', platform)],
  },
  {
    id: 'toggle-sidebar',
    scope: 'app',
    labelKey: 'settings.shortcuts.items.toggle-sidebar.label',
    descriptionKey: 'settings.shortcuts.items.toggle-sidebar.description',
    rebindable: true,
    getDefaultCombos: (platform) => [modCombo('KeyB', platform)],
  },
  {
    id: 'cycle-permission-mode',
    scope: 'composer',
    labelKey: 'settings.shortcuts.items.cycle-permission-mode.label',
    descriptionKey: 'settings.shortcuts.items.cycle-permission-mode.description',
    rebindable: true,
    getDefaultCombos: () => [combo('Tab', { shift: true })],
  },
  // ⌘W / Ctrl+W 是系统级惯例键 (keyboardReserved 保留组合), 不开放改绑与设置页
  // 展示。行为按焦点分派: 焦点在右侧栏内 → 关激活 tab; 否则 mac 关(隐藏)当前
  // 窗口 (对齐原生菜单 role close), win/linux 不消费 (关窗惯例是 Alt+F4, 且主窗
  // 关闭 = 退出 app, 不能挂在 Ctrl+W 上)。菜单 Window > Close 改为
  // registerAccelerator: false 后按键流到 renderer, 由 MainLayout /
  // SidebarWindowLayout 消费; webview guest 内按键由 main 端 webview-security
  // 的 before-input-event 拦截转发。
  {
    id: 'close-tab-or-window',
    scope: 'app',
    labelKey: 'settings.shortcuts.items.close-tab-or-window.label',
    descriptionKey: 'settings.shortcuts.items.close-tab-or-window.description',
    rebindable: false,
    hiddenInSettings: true,
    getDefaultCombos: (platform) => [modCombo('KeyW', platform)],
  },
  {
    id: 'right-tab-prev',
    scope: 'app',
    labelKey: 'settings.shortcuts.items.right-tab-prev.label',
    descriptionKey: 'settings.shortcuts.items.right-tab-prev.description',
    rebindable: true,
    getDefaultCombos: (platform) =>
      platform === 'darwin'
        ? [combo('BracketLeft', { meta: true, shift: true }), combo('Tab', { ctrl: true, shift: true })]
        : [combo('PageUp', { ctrl: true }), combo('Tab', { ctrl: true, shift: true })],
  },
  {
    id: 'right-tab-next',
    scope: 'app',
    labelKey: 'settings.shortcuts.items.right-tab-next.label',
    descriptionKey: 'settings.shortcuts.items.right-tab-next.description',
    rebindable: true,
    getDefaultCombos: (platform) =>
      platform === 'darwin'
        ? [combo('BracketRight', { meta: true, shift: true }), combo('Tab', { ctrl: true })]
        : [combo('PageDown', { ctrl: true }), combo('Tab', { ctrl: true })],
  },
  {
    id: 'open-terminal',
    scope: 'app',
    labelKey: 'settings.shortcuts.items.open-terminal.label',
    descriptionKey: 'settings.shortcuts.items.open-terminal.description',
    rebindable: true,
    getDefaultCombos: () => [combo('Backquote', { ctrl: true })],
  },
  // ⌘, 打开设置是 macOS 系统惯例, 不在设置页暴露改绑入口 (仍正常生效)。
  {
    id: 'open-settings',
    scope: 'app',
    labelKey: 'settings.shortcuts.items.open-settings.label',
    descriptionKey: 'settings.shortcuts.items.open-settings.description',
    rebindable: true,
    hiddenInSettings: true,
    menuBacked: true,
    platforms: ['darwin'],
    getDefaultCombos: () => [combo('Comma', { meta: true })],
  },
  {
    id: 'find-in-page',
    scope: 'app',
    labelKey: 'settings.shortcuts.items.find-in-page.label',
    descriptionKey: 'settings.shortcuts.items.find-in-page.description',
    rebindable: true,
    getDefaultCombos: (platform) => [modCombo('KeyF', platform)],
  },
  {
    id: 'search-in-project',
    scope: 'workdir-doc',
    labelKey: 'settings.shortcuts.items.search-in-project.label',
    descriptionKey: 'settings.shortcuts.items.search-in-project.description',
    rebindable: true,
    getDefaultCombos: (platform) => [modCombo('KeyF', platform, { shift: true })],
  },
  // 保存是文档编辑的通用惯例键 (⌘S), 不在设置页暴露改绑入口 (仍正常生效)。
  {
    id: 'save-file',
    scope: 'workdir-doc',
    labelKey: 'settings.shortcuts.items.save-file.label',
    descriptionKey: 'settings.shortcuts.items.save-file.description',
    rebindable: true,
    hiddenInSettings: true,
    getDefaultCombos: (platform) => [modCombo('KeyS', platform)],
  },
  // 缩放三键: macOS 由系统菜单 role (resetZoom/zoomIn/zoomOut) 承担, 仅
  // win/linux 走 renderer 监听。多默认覆盖主键区与数字键盘 (与迁移前
  // MainLayout 按 e.key 匹配的行为对齐)。
  {
    id: 'zoom-in',
    scope: 'app',
    labelKey: 'settings.shortcuts.items.zoom-in.label',
    descriptionKey: 'settings.shortcuts.items.zoom-in.description',
    rebindable: true,
    platforms: ['win32', 'linux'],
    getDefaultCombos: () => [
      combo('Equal', { ctrl: true }),
      combo('Equal', { ctrl: true, shift: true }),
      combo('NumpadAdd', { ctrl: true }),
    ],
  },
  {
    id: 'zoom-out',
    scope: 'app',
    labelKey: 'settings.shortcuts.items.zoom-out.label',
    descriptionKey: 'settings.shortcuts.items.zoom-out.description',
    rebindable: true,
    platforms: ['win32', 'linux'],
    getDefaultCombos: () => [
      combo('Minus', { ctrl: true }),
      combo('NumpadSubtract', { ctrl: true }),
    ],
  },
  {
    id: 'zoom-reset',
    scope: 'app',
    labelKey: 'settings.shortcuts.items.zoom-reset.label',
    descriptionKey: 'settings.shortcuts.items.zoom-reset.description',
    rebindable: true,
    platforms: ['win32', 'linux'],
    getDefaultCombos: () => [
      combo('Digit0', { ctrl: true }),
      combo('Numpad0', { ctrl: true }),
    ],
  },
  {
    id: 'browser-focus-url',
    scope: 'browser',
    labelKey: 'settings.shortcuts.items.browser-focus-url.label',
    descriptionKey: 'settings.shortcuts.items.browser-focus-url.description',
    rebindable: true,
    getDefaultCombos: (platform) => [modCombo('KeyL', platform)],
  },
  {
    id: 'browser-back',
    scope: 'browser',
    labelKey: 'settings.shortcuts.items.browser-back.label',
    descriptionKey: 'settings.shortcuts.items.browser-back.description',
    rebindable: true,
    getDefaultCombos: () => [combo('ArrowLeft', { alt: true })],
  },
  {
    id: 'browser-forward',
    scope: 'browser',
    labelKey: 'settings.shortcuts.items.browser-forward.label',
    descriptionKey: 'settings.shortcuts.items.browser-forward.description',
    rebindable: true,
    getDefaultCombos: () => [combo('ArrowRight', { alt: true })],
  },
  {
    id: 'browser-reload',
    scope: 'browser',
    labelKey: 'settings.shortcuts.items.browser-reload.label',
    descriptionKey: 'settings.shortcuts.items.browser-reload.description',
    rebindable: true,
    getDefaultCombos: (platform) => [modCombo('KeyR', platform), combo('F5')],
  },
  // 对话切换 9 槽位 (见 SWITCH_SESSION_SHORTCUT_IDS 注释)。设置页不逐条展示
  // (9 行同构条目刷屏), 但 label/description i18n 仍需齐全 —— 改绑冲突提示
  // 会引用占用者 label。
  ...SWITCH_SESSION_SHORTCUT_IDS.map(
    (id, index): AppShortcutDefinition => ({
      id,
      scope: 'app',
      labelKey: `settings.shortcuts.items.${id}.label`,
      descriptionKey: `settings.shortcuts.items.${id}.description`,
      rebindable: true,
      hiddenInSettings: true,
      yieldsToUserBindings: true,
      getDefaultCombos: (platform) => [modCombo(`Digit${index + 1}`, platform)],
    }),
  ),
];

const DEFINITION_MAP: ReadonlyMap<AppShortcutId, AppShortcutDefinition> = new Map(
  APP_SHORTCUT_DEFINITIONS.map((def) => [def.id, def]),
);

export function isAppShortcutId(value: unknown): value is AppShortcutId {
  return typeof value === 'string' && DEFINITION_MAP.has(value as AppShortcutId);
}

export function getAppShortcutDefinition(id: AppShortcutId): AppShortcutDefinition {
  const def = DEFINITION_MAP.get(id);
  if (!def) throw new Error(`unknown app shortcut id: ${id}`);
  return def;
}

export function isAppShortcutAvailableOnPlatform(id: AppShortcutId, platform: string): boolean {
  const def = DEFINITION_MAP.get(id);
  if (!def) return false;
  if (!def.platforms) return true;
  return (def.platforms as readonly string[]).includes(platform);
}

/** 用户 override 集合: 只含用户显式改过的 id。 */
/**
 * 用户 override 值: combo = 改绑到新组合; null = 删除绑定 (该快捷键禁用,
 * 生效组合为空列表, 所有消费端自然不匹配)。
 */
export type AppShortcutOverrideValue = AppShortcutCombo | null;
export type AppShortcutOverrides = Partial<Record<AppShortcutId, AppShortcutOverrideValue>>;

/** 校验并规整单个 combo; 结构非法返回 null。 */
export function normalizeAppShortcutCombo(raw: unknown): AppShortcutCombo | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<AppShortcutCombo>;
  if (typeof candidate.code !== 'string' || candidate.code.trim().length === 0) return null;
  if (MODIFIER_CODES.has(candidate.code)) return null;
  return {
    code: candidate.code,
    key: typeof candidate.key === 'string' ? candidate.key : undefined,
    meta: Boolean(candidate.meta),
    ctrl: Boolean(candidate.ctrl),
    alt: Boolean(candidate.alt),
    shift: Boolean(candidate.shift),
  };
}

/**
 * 非可改绑快捷键的默认组合是"代码保留键" (如 close-tab-or-window 的 mod+W)。
 * 历史版本存下的 override 可能与之撞键 —— 该保留键引入前, 用户把 toggle-sidebar /
 * open-terminal / browser-* 等改绑到同一组合是合法写入, 而冲突只在新写入时校验,
 * load 不重查。撞键的存量 override 必须在归一化时丢弃 (该 id 自愈回默认值),
 * 否则消费端各自独立的监听 (renderer useAppShortcut / guest before-input-event)
 * 会让旧动作与保留键动作并发触发。
 */
function collidesWithNonRebindableDefault(
  comboValue: AppShortcutCombo,
  platform: string,
): boolean {
  for (const def of APP_SHORTCUT_DEFINITIONS) {
    if (def.rebindable) continue;
    if (!isAppShortcutAvailableOnPlatform(def.id, platform)) continue;
    if (def.getDefaultCombos(platform).some((c) => appShortcutCombosEqual(c, comboValue))) {
      return true;
    }
  }
  return false;
}

/**
 * 规整 override 集合: 丢弃未知 id、不可改绑 id、当前平台不可用 id、非法
 * combo、与不可改绑快捷键默认组合撞键的存量 combo。null 值 (删除绑定) 原样
 * 保留。版本升级删除某 id 后, 存量 override 在 load 时自动自愈。
 */
export function normalizeAppShortcutOverrides(raw: unknown, platform: string): AppShortcutOverrides {
  if (!raw || typeof raw !== 'object') return {};
  const result: AppShortcutOverrides = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isAppShortcutId(key)) continue;
    const def = DEFINITION_MAP.get(key);
    if (!def || !def.rebindable) continue;
    if (!isAppShortcutAvailableOnPlatform(key, platform)) continue;
    if (value === null) {
      result[key] = null;
      continue;
    }
    const normalized = normalizeAppShortcutCombo(value);
    if (!normalized) continue;
    if (collidesWithNonRebindableDefault(normalized, platform)) continue;
    result[key] = normalized;
  }
  return result;
}

/**
 * 默认值 + override 合并出每个 id 的生效组合列表。override 为单 combo 时
 * 整体替换默认列表; null (删除绑定) → 空列表; 平台不可用的 id 不出现在
 * 结果里 (消费端对 undefined / 空列表自动不挂监听)。
 *
 * yieldsToUserBindings 条目的默认组合对用户既有绑定让位: 冲突只在写入时
 * 校验, 历史版本合法写下的绑定可能与后续版本新增的批量默认撞键 (如
 * switch-session-* 一次性占入 mod+1..9)。这些槽位不在设置页出现, 用户
 * 看不到占用者也无法解绑, 若不让位则一次按键触发两个动作。让位后该槽位
 * 等效无绑定 (消费端与序号徽标端对空组合天然兼容); 其余条目 —— 包括
 * save-file / open-settings 等同样 hiddenInSettings 的惯例键 —— 不让位,
 * 维持既有行为 (见 yieldsToUserBindings 字段注释)。让位对象有两类:
 * 1. 本 registry 内其它 id 的用户 override (overrides 参数);
 * 2. registry 之外体系的用户键位 (yieldToCombos 参数, 如语音输入的键盘
 *    快捷键) —— 由知道该体系的消费端传入; 无此类消费的调用点 (如 main 的
 *    菜单 accelerator, 这些隐藏槽位本就不进菜单) 不传即可, 行为不变。
 */
export function getEffectiveAppShortcuts(
  overrides: AppShortcutOverrides,
  platform: string,
  yieldToCombos: ReadonlyArray<AppShortcutCombo> = [],
): Map<AppShortcutId, AppShortcutCombo[]> {
  const overrideEntries: Array<{ scope: AppShortcutScope; combo: AppShortcutCombo }> = [];
  for (const def of APP_SHORTCUT_DEFINITIONS) {
    if (!isAppShortcutAvailableOnPlatform(def.id, platform)) continue;
    const override = overrides[def.id];
    if (override) overrideEntries.push({ scope: def.scope, combo: override });
  }
  const result = new Map<AppShortcutId, AppShortcutCombo[]>();
  for (const def of APP_SHORTCUT_DEFINITIONS) {
    if (!isAppShortcutAvailableOnPlatform(def.id, platform)) continue;
    const override = overrides[def.id];
    if (override === null) {
      result.set(def.id, []);
      continue;
    }
    if (override) {
      result.set(def.id, [override]);
      continue;
    }
    let combos = def.getDefaultCombos(platform);
    if (def.yieldsToUserBindings) {
      combos = combos.filter(
        (c) =>
          !overrideEntries.some(
            (o) => appShortcutScopesOverlap(def.scope, o.scope) && appShortcutCombosEqual(o.combo, c),
          ) && !yieldToCombos.some((y) => appShortcutCombosEqual(y, c)),
      );
    }
    result.set(def.id, combos);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 匹配
// ---------------------------------------------------------------------------

interface PressedKeyState {
  code: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

/** 双端共用的核心判定 —— renderer / main 两个入口都摊平到这里, 物理上不会漂移。 */
function matchesNormalized(pressed: PressedKeyState, comboValue: AppShortcutCombo): boolean {
  return (
    pressed.code === comboValue.code &&
    pressed.meta === comboValue.meta &&
    pressed.ctrl === comboValue.ctrl &&
    pressed.alt === comboValue.alt &&
    pressed.shift === comboValue.shift
  );
}

/** renderer KeyboardEvent 形态匹配 (结构化参数, 不依赖 DOM 类型)。 */
export function matchesKeyboardEvent(
  event: { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  comboValue: AppShortcutCombo,
): boolean {
  return matchesNormalized(
    {
      code: event.code,
      meta: event.metaKey,
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
    },
    comboValue,
  );
}

/** main 进程 before-input-event Input 形态匹配。 */
export function matchesElectronInput(
  input: { code: string; meta: boolean; control: boolean; alt: boolean; shift: boolean },
  comboValue: AppShortcutCombo,
): boolean {
  return matchesNormalized(
    {
      code: input.code,
      meta: input.meta,
      ctrl: input.control,
      alt: input.alt,
      shift: input.shift,
    },
    comboValue,
  );
}

export function matchesAnyCombo<E>(
  event: E,
  combos: AppShortcutCombo[] | undefined,
  matcher: (event: E, comboValue: AppShortcutCombo) => boolean,
): boolean {
  if (!combos || combos.length === 0) return false;
  return combos.some((c) => matcher(event, c));
}

// ---------------------------------------------------------------------------
// Electron accelerator 转换
// ---------------------------------------------------------------------------

/** code → Electron accelerator key 部分的显式映射 (仅可安全映射的键)。 */
const ACCELERATOR_KEY_BY_CODE: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Quote: "'",
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Enter',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
};

/**
 * combo → Electron accelerator 字符串。无法映射的 code 返回 null: 该组合的
 * 菜单项静默降级为无 accelerator (点击仍可用), 实际按键由匹配路径生效。
 */
export function comboToElectronAccelerator(
  comboValue: AppShortcutCombo,
  platform: string,
): string | null {
  const keyPart = acceleratorKeyForCode(comboValue.code);
  if (!keyPart) return null;
  const parts: string[] = [];
  if (comboValue.ctrl) parts.push('Ctrl');
  if (comboValue.alt) parts.push('Alt');
  if (comboValue.shift) parts.push('Shift');
  if (comboValue.meta) parts.push(platform === 'darwin' ? 'Command' : 'Super');
  parts.push(keyPart);
  return parts.join('+');
}

function acceleratorKeyForCode(code: string): string | null {
  const letter = code.match(/^Key([A-Z])$/)?.[1];
  if (letter) return letter;
  const digit = code.match(/^Digit([0-9])$/)?.[1];
  if (digit) return digit;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return ACCELERATOR_KEY_BY_CODE[code] ?? null;
}

// ---------------------------------------------------------------------------
// 显示格式化
// ---------------------------------------------------------------------------

/** code → 人类可读键名 (显示用)。 */
const DISPLAY_KEY_LABELS: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Quote: "'",
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Enter',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num -',
  Numpad0: 'Num 0',
};

/**
 * 跨平台显示格式化: mac 用 ⌃⌥⇧⌘ 无分隔符 (Apple 惯例顺序), 其它平台
 * Ctrl+Alt+Shift+Meta+Key。与 RolePillDropdown 既有的 '⌘N' / 'Ctrl+N' 呈现一致。
 */
export function formatAppShortcutCombo(comboValue: AppShortcutCombo, platform: string): string {
  const keyLabel = displayKeyForCode(comboValue.code, comboValue.key);
  if (platform === 'darwin') {
    const parts: string[] = [];
    if (comboValue.ctrl) parts.push('⌃');
    if (comboValue.alt) parts.push('⌥');
    if (comboValue.shift) parts.push('⇧');
    if (comboValue.meta) parts.push('⌘');
    parts.push(keyLabel);
    return parts.join('');
  }
  const parts: string[] = [];
  if (comboValue.ctrl) parts.push('Ctrl');
  if (comboValue.alt) parts.push('Alt');
  if (comboValue.shift) parts.push('Shift');
  if (comboValue.meta) parts.push('Meta');
  parts.push(keyLabel);
  return parts.join('+');
}

function displayKeyForCode(code: string, key?: string): string {
  const explicit = DISPLAY_KEY_LABELS[code];
  if (explicit) return explicit;
  const letter = code.match(/^Key([A-Z])$/)?.[1];
  if (letter) return letter;
  const digit = code.match(/^Digit([0-9])$/)?.[1];
  if (digit) return digit;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (key && key.length === 1 && key !== ' ') return key.toUpperCase();
  return key || code;
}

// ---------------------------------------------------------------------------
// 录制与合法性
// ---------------------------------------------------------------------------

const MODIFIER_CODES = new Set([
  'AltLeft',
  'AltRight',
  'ControlLeft',
  'ControlRight',
  'MetaLeft',
  'MetaRight',
  'ShiftLeft',
  'ShiftRight',
  'Fn',
  'FnLock',
  'CapsLock',
]);

/** 设置页录制用: 纯修饰键事件返回 null (等用户按出主键)。 */
export function createAppShortcutComboFromEvent(event: {
  code: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): AppShortcutCombo | null {
  if (!event.code || MODIFIER_CODES.has(event.code)) return null;
  return {
    code: event.code,
    key: event.key,
    meta: event.metaKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
  };
}

/** Shift 单修饰时允许的非打印键 (Shift+字母/数字是正常输入, 不许占用)。 */
const SHIFT_ONLY_ALLOWED_CODES = /^(Tab|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|F([1-9]|1[0-9]|2[0-4]))$/;

/**
 * 裸键限制: 无修饰键仅允许 F1-F24; 仅 Shift 时只允许非打印键 (如 Shift+Tab);
 * 含 meta/ctrl/alt 任意一个即合法。
 */
export function isAppShortcutComboBindable(comboValue: AppShortcutCombo): boolean {
  if (comboValue.meta || comboValue.ctrl || comboValue.alt) return true;
  if (comboValue.shift) return SHIFT_ONLY_ALLOWED_CODES.test(comboValue.code);
  return /^F([1-9]|1[0-9]|2[0-4])$/.test(comboValue.code);
}

export function appShortcutCombosEqual(a: AppShortcutCombo, b: AppShortcutCombo): boolean {
  return (
    a.code === b.code &&
    a.meta === b.meta &&
    a.ctrl === b.ctrl &&
    a.alt === b.alt &&
    a.shift === b.shift
  );
}

const OVERLAPPING_SCOPE_PAIRS = new Set(['browser:workdir-doc', 'composer:workdir-doc']);

/** 冲突检测域判定: app 与一切重叠; workdir-doc 与 browser / composer 同屏重叠。 */
export function appShortcutScopesOverlap(a: AppShortcutScope, b: AppShortcutScope): boolean {
  if (a === 'app' || b === 'app' || a === b) return true;
  const pair = [a, b].sort().join(':');
  return OVERLAPPING_SCOPE_PAIRS.has(pair);
}

/**
 * 跨 id 冲突检测: 给 id 绑 comboValue 时, 是否与其它 id 在重叠 scope 域内的
 * 生效组合 (默认 + overrides 合并后) 撞键。返回占用者 id, 无冲突返回 null。
 * renderer 设置页预检与 main store 写入兜底共用本函数, 校验口径不漂移。
 */
export function findAppShortcutConflict(
  id: AppShortcutId,
  comboValue: AppShortcutCombo,
  overrides: AppShortcutOverrides,
  platform: string,
): AppShortcutId | null {
  const selfDef = DEFINITION_MAP.get(id);
  if (!selfDef) return null;
  const effective = getEffectiveAppShortcuts(overrides, platform);
  for (const def of APP_SHORTCUT_DEFINITIONS) {
    if (def.id === id) continue;
    if (!appShortcutScopesOverlap(selfDef.scope, def.scope)) continue;
    // 未被 override 的让位槽位默认不构成占用: 用户显式改绑获胜 ——
    // getEffectiveAppShortcuts 会让该槽位的默认让位。否则用户想绑这些
    // 组合时会被一个设置页里看不到、也无法解绑的条目永久卡死。范围严格
    // 限定 yieldsToUserBindings, 不含 save-file 等惯例隐藏键 (那些仍占用,
    // 新绑定照常报冲突)。
    if (def.yieldsToUserBindings && overrides[def.id] === undefined) continue;
    const combos = effective.get(def.id);
    if (combos?.some((c) => appShortcutCombosEqual(c, comboValue))) return def.id;
  }
  return null;
}
