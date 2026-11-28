const MAX_ACTIVE_APP_CHARS = 80;
const ACTIVE_APP_CATEGORIES = new Set<ActiveAppCategory>([
  'code_editor', 'terminal', 'chat', 'email', 'document', 'browser',
]);

export type ActiveAppDescriptor =
  | string
  | {
      processName?: string | null;
      bundleId?: string | null;
    }
  | null
  | undefined;

export type ActiveAppCategory =
  | 'code_editor'
  | 'terminal'
  | 'chat'
  | 'email'
  | 'document'
  | 'browser';

const BUNDLE_ID_CATEGORIES: Array<{ prefix: string; category: ActiveAppCategory }> = [
  { prefix: 'com.microsoft.vscode', category: 'code_editor' },
  { prefix: 'com.todesktop.230313mzl4w4u92', category: 'code_editor' }, // Cursor
  { prefix: 'com.exafunction.windsurf', category: 'code_editor' },
  { prefix: 'dev.zed.zed', category: 'code_editor' },
  { prefix: 'com.apple.dt.xcode', category: 'code_editor' },
  { prefix: 'com.jetbrains.', category: 'code_editor' },
  { prefix: 'com.sublimetext.', category: 'code_editor' },
  { prefix: 'com.google.android.studio', category: 'code_editor' },
  { prefix: 'com.apple.terminal', category: 'terminal' },
  { prefix: 'com.googlecode.iterm2', category: 'terminal' },
  { prefix: 'dev.warp.warp', category: 'terminal' },
  { prefix: 'com.mitchellh.ghostty', category: 'terminal' },
  { prefix: 'com.github.wez.wezterm', category: 'terminal' },
  { prefix: 'org.alacritty', category: 'terminal' },
  { prefix: 'net.kovidgoyal.kitty', category: 'terminal' },
  { prefix: 'com.tinyspeck.slackmacgap', category: 'chat' },
  { prefix: 'com.tencent.xinwechat', category: 'chat' },
  { prefix: 'com.electron.lark', category: 'chat' },
  { prefix: 'com.bytedance.lark', category: 'chat' },
  { prefix: 'com.hnc.discord', category: 'chat' },
  { prefix: 'ru.keepcoder.telegram', category: 'chat' },
  { prefix: 'com.apple.mobilesms', category: 'chat' },
  { prefix: 'com.alibaba.dingtalkmac', category: 'chat' },
  { prefix: 'com.microsoft.teams', category: 'chat' },
  { prefix: 'net.whatsapp.whatsapp', category: 'chat' },
  { prefix: 'com.apple.mail', category: 'email' },
  { prefix: 'com.microsoft.outlook', category: 'email' },
  { prefix: 'com.readdle.spark', category: 'email' },
  { prefix: 'com.superhuman.electron', category: 'email' },
  { prefix: 'com.mimestream.mimestream', category: 'email' },
  { prefix: 'org.mozilla.thunderbird', category: 'email' },
  { prefix: 'notion.id', category: 'document' },
  { prefix: 'md.obsidian', category: 'document' },
  { prefix: 'com.apple.notes', category: 'document' },
  { prefix: 'com.apple.iwork.pages', category: 'document' },
  { prefix: 'com.microsoft.word', category: 'document' },
  { prefix: 'com.linear', category: 'document' },
  { prefix: 'com.figma.desktop', category: 'document' },
  { prefix: 'abnerworks.typora', category: 'document' },
  { prefix: 'com.google.chrome', category: 'browser' },
  { prefix: 'com.apple.safari', category: 'browser' },
  { prefix: 'company.thebrowser.browser', category: 'browser' }, // Arc
  { prefix: 'org.mozilla.firefox', category: 'browser' },
  { prefix: 'com.brave.browser', category: 'browser' },
  { prefix: 'com.microsoft.edgemac', category: 'browser' },
];

const PROCESS_NAME_CATEGORIES: Record<string, ActiveAppCategory> = {
  cursor: 'code_editor',
  code: 'code_editor',
  'visual studio code': 'code_editor',
  windsurf: 'code_editor',
  zed: 'code_editor',
  xcode: 'code_editor',
  'intellij idea': 'code_editor',
  webstorm: 'code_editor',
  pycharm: 'code_editor',
  goland: 'code_editor',
  clion: 'code_editor',
  'android studio': 'code_editor',
  'sublime text': 'code_editor',
  terminal: 'terminal',
  iterm2: 'terminal',
  iterm: 'terminal',
  warp: 'terminal',
  ghostty: 'terminal',
  wezterm: 'terminal',
  alacritty: 'terminal',
  kitty: 'terminal',
  windowsterminal: 'terminal',
  slack: 'chat',
  wechat: 'chat',
  微信: 'chat',
  feishu: 'chat',
  飞书: 'chat',
  lark: 'chat',
  discord: 'chat',
  telegram: 'chat',
  messages: 'chat',
  信息: 'chat',
  dingtalk: 'chat',
  钉钉: 'chat',
  teams: 'chat',
  whatsapp: 'chat',
  mail: 'email',
  邮件: 'email',
  outlook: 'email',
  spark: 'email',
  superhuman: 'email',
  mimestream: 'email',
  thunderbird: 'email',
  notion: 'document',
  obsidian: 'document',
  notes: 'document',
  备忘录: 'document',
  pages: 'document',
  'microsoft word': 'document',
  winword: 'document',
  linear: 'document',
  figma: 'document',
  typora: 'document',
  'google chrome': 'browser',
  chrome: 'browser',
  safari: 'browser',
  arc: 'browser',
  firefox: 'browser',
  brave: 'browser',
  'microsoft edge': 'browser',
  msedge: 'browser',
};

/**
 * Classifies a foreground desktop application into a coarse scene category
 * using only its bundle identifier or process name (never window titles).
 */
export function classifyActiveAppCategory(
  processName?: string | null,
  bundleId?: string | null,
): ActiveAppCategory | undefined {
  const normalizedBundle = typeof bundleId === 'string' ? bundleId.trim().toLowerCase() : '';
  if (normalizedBundle) {
    for (const entry of BUNDLE_ID_CATEGORIES) {
      if (normalizedBundle === entry.prefix || normalizedBundle.startsWith(entry.prefix)) {
        return entry.category;
      }
    }
  }
  const normalizedName = normalizeRawAppName(processName)?.toLowerCase() ?? '';
  if (!normalizedName) return undefined;
  return PROCESS_NAME_CATEGORIES[normalizedName];
}

/**
 * Sanitizes a foreground application descriptor into a compact, privacy-safe
 * `activeApp` string suitable for dictation refinement context.
 *
 * Guarantees:
 * - Never includes window titles, URLs, or full file paths.
 * - Strips control characters and executable extensions (`.app`, `.exe`).
 * - Appends a coarse scene category when recognized (e.g. `Cursor (code_editor)`).
 * - Enforces a strict 80-character cap.
 */
export function sanitizeActiveAppContext(descriptor: ActiveAppDescriptor): string | undefined {
  if (!descriptor) return undefined;
  if (typeof descriptor === 'string') {
    const trimmed = descriptor.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!trimmed) return undefined;
    // Preserve an already-classified label such as "Cursor (code_editor)" while
    // still sanitizing unexpected path/URL characters and enforcing the cap.
    const openingParen = trimmed.lastIndexOf('(');
    const existingCategory = openingParen > 0 && trimmed.endsWith(')')
      ? trimmed.slice(openingParen + 1, -1)
      : '';
    if (ACTIVE_APP_CATEGORIES.has(existingCategory as ActiveAppCategory)) {
      const cleanName = normalizeRawAppName(trimmed.slice(0, openingParen).trimEnd());
      if (!cleanName) return undefined;
      return formatActiveAppLabel(cleanName, existingCategory as ActiveAppCategory);
    }
    const cleanName = normalizeRawAppName(trimmed);
    if (!cleanName) return undefined;
    return formatActiveAppLabel(cleanName, classifyActiveAppCategory(cleanName));
  }

  const cleanName = normalizeRawAppName(descriptor.processName);
  if (!cleanName) return undefined;
  const category = classifyActiveAppCategory(cleanName, descriptor.bundleId);
  return formatActiveAppLabel(cleanName, category);
}

function normalizeRawAppName(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  let cleaned = value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  if (!cleaned) return undefined;
  // Drop URLs or explicit window title separators if a caller ever passed one.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned)) return undefined;
  // Take basename only when a filesystem path is passed.
  const pathSegments = cleaned.split(/[\\/]/).filter(Boolean);
  if (pathSegments.length > 1) {
    cleaned = pathSegments[pathSegments.length - 1] ?? '';
  }
  cleaned = cleaned.replace(/\.(app|exe)$/i, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.length > MAX_ACTIVE_APP_CHARS ? cleaned.slice(0, MAX_ACTIVE_APP_CHARS).trim() : cleaned;
}

function formatActiveAppLabel(name: string, category?: ActiveAppCategory): string {
  if (!category) return name;
  const suffix = ` (${category})`;
  const maxNameChars = Math.max(1, MAX_ACTIVE_APP_CHARS - suffix.length);
  const boundedName = name.length > maxNameChars ? name.slice(0, maxNameChars).trim() : name;
  return `${boundedName}${suffix}`;
}
