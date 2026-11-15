import { TASK_TAG_COLORS } from "./taskTags.js";
/** Project artwork is content; controls remain on the application's semantic palette. */
export const PROJECT_SYMBOLS = [
  { name: "Folder", keywords: "文件夹 目录" },
  { name: "FolderOpen", keywords: "" },
  { name: "Code", keywords: "代码 编程" },
  { name: "CodeXml", keywords: "" },
  { name: "Terminal", keywords: "终端 命令" },
  { name: "SquareTerminal", keywords: "" },
  { name: "Braces", keywords: "" },
  { name: "FileCode", keywords: "" },
  { name: "Files", keywords: "" },
  { name: "GitBranch", keywords: "分支 版本" },
  { name: "Github", keywords: "" },
  { name: "Globe", keywords: "网络 网站" },
  { name: "Monitor", keywords: "电脑 桌面" },
  { name: "Smartphone", keywords: "手机 移动" },
  { name: "Tablet", keywords: "" },
  { name: "Server", keywords: "服务器 后端" },
  { name: "Database", keywords: "数据库 数据" },
  { name: "Cloud", keywords: "云" },
  { name: "Box", keywords: "" },
  { name: "Package", keywords: "包 软件" },
  { name: "Layers", keywords: "" },
  { name: "LayoutGrid", keywords: "" },
  { name: "AppWindow", keywords: "" },
  { name: "PanelsTopLeft", keywords: "" },
  { name: "Rocket", keywords: "火箭 发布" },
  { name: "Sparkles", keywords: "闪光 智能 AI" },
  { name: "Lightbulb", keywords: "灵感 想法" },
  { name: "FlaskConical", keywords: "实验 科学" },
  { name: "Microscope", keywords: "" },
  { name: "Atom", keywords: "" },
  { name: "Cpu", keywords: "芯片" },
  { name: "CircuitBoard", keywords: "" },
  { name: "Bug", keywords: "错误 虫" },
  { name: "Wrench", keywords: "工具" },
  { name: "Hammer", keywords: "" },
  { name: "Settings", keywords: "" },
  { name: "Palette", keywords: "设计 调色" },
  { name: "Paintbrush", keywords: "" },
  { name: "PenTool", keywords: "" },
  { name: "Pencil", keywords: "" },
  { name: "Camera", keywords: "相机 摄影" },
  { name: "Image", keywords: "图片 照片" },
  { name: "Film", keywords: "电影 视频" },
  { name: "Music", keywords: "音乐" },
  { name: "Headphones", keywords: "" },
  { name: "Gamepad2", keywords: "游戏 手柄" },
  { name: "BookOpen", keywords: "书 阅读 文档" },
  { name: "GraduationCap", keywords: "学习 教育" },
  { name: "NotebookPen", keywords: "" },
  { name: "Briefcase", keywords: "工作 商业" },
  { name: "Building2", keywords: "" },
  { name: "ShoppingBag", keywords: "" },
  { name: "ShoppingCart", keywords: "" },
  { name: "CreditCard", keywords: "" },
  { name: "ChartNoAxesCombined", keywords: "" },
  { name: "ChartPie", keywords: "图表 分析" },
  { name: "TrendingUp", keywords: "" },
  { name: "Heart", keywords: "心 健康" },
  { name: "Leaf", keywords: "叶 自然" },
  { name: "Sprout", keywords: "" },
  { name: "Mountain", keywords: "" },
  { name: "Sun", keywords: "" },
  { name: "Moon", keywords: "" },
  { name: "Star", keywords: "星 收藏" },
  { name: "Zap", keywords: "" },
  { name: "Shield", keywords: "安全" },
  { name: "Lock", keywords: "" },
  { name: "KeyRound", keywords: "" },
  { name: "Users", keywords: "人 团队" },
  { name: "MessageCircle", keywords: "聊天 消息" },
  { name: "Mail", keywords: "邮件" },
  { name: "Calendar", keywords: "日历" },
  { name: "CheckCheck", keywords: "" },
  { name: "Target", keywords: "目标" },
  { name: "Compass", keywords: "指南针" },
  { name: "MapPin", keywords: "" },
  { name: "Coffee", keywords: "咖啡" },
] as const;
/** Stable user-selected identity colors, not task status. Default inherits the theme. */
export const PROJECT_ICON_COLORS = ["default", ...TASK_TAG_COLORS] as const;
export type ProjectIconColor = (typeof PROJECT_ICON_COLORS)[number];
export function parseProjectSymbol(value: string | null | undefined): {
  name: (typeof PROJECT_SYMBOLS)[number]["name"];
  color: ProjectIconColor;
} | null {
  if (!value?.startsWith("symbol:")) return null;
  const parts = value.split(":");
  const symbol = PROJECT_SYMBOLS.find((item) => item.name === parts[1]);
  const color = parts[2] ?? "default";
  if (
    !symbol ||
    parts.length > 3 ||
    !PROJECT_ICON_COLORS.some((item) => item === color)
  )
    return null;
  return { name: symbol.name, color: color as ProjectIconColor };
}
export function projectSymbolValue(
  name: string,
  color: ProjectIconColor,
): string {
  return color === "default" ? `symbol:${name}` : `symbol:${name}:${color}`;
}

/** Optional color extends the legacy text:<letters> representation. */
export function parseProjectLetters(value: string | null | undefined): {
  text: string;
  color: ProjectIconColor;
} | null {
  if (!value?.startsWith("text:")) return null;
  const parts = value.split(":");
  const text = parts[1] ?? "";
  const color = parts[2] ?? "default";
  if (
    parts.length > 3 ||
    !/^[\p{L}\p{N}]{1,2}$/u.test(text) ||
    !PROJECT_ICON_COLORS.some((item) => item === color)
  )
    return null;
  return { text, color: color as ProjectIconColor };
}
export function projectLettersValue(
  text: string,
  color: ProjectIconColor,
): string {
  return color === "default" ? `text:${text}` : `text:${text}:${color}`;
}

export const PROJECT_EMOJIS = Array.from(
  "📁 💻 🚀 🎨 🎮 📚 🧪 🌐 🛠️ 🎵 ⭐ 🌱 📝 📊 📦 🔧 ⚙️ 🔬 💡 ✨ 🎯 🧭 🗺️ 📍 🏠 🏢 🏗️ 🛒 💳 📷 🎬 🎧 🎹 📖 🎓 🗓️ 💬 📮 🔒 🛡️ 🔑 🤖 🧠 ❤️ ☀️ 🌙 🌈 🌊 🌳 🌸 🍀 🔥 ⚡ ☕ 🍎 🐱 🐶 🐼 🦊 🐳 🦋 🐝 🦄 🪴 🏔️ 🏕️ 🏝️ 🛰️ 🪐 🔭 🧩 🎲 🏆 🥇 🏀 ⚽ 🎾 🚲 🚗 ✈️ ⛵ 🛫 📡 🧰 🧱 🖌️ 🖋️ ✏️ 📐 🗂️ 📎 📌 ✅ 💎 🎁 🎈 🎉".split(
    " ",
  ),
);
export const PROJECT_ICON_OPTIONS = PROJECT_EMOJIS;
export const PROJECT_ICON_IMAGE_CHANNEL =
  "sidebar-settings:get-project-icon-image";
export const PROJECT_ICON_UPLOAD_LIMIT = 300_000;
export function isProjectImage(
  value: unknown,
): value is `cindy-media://blobs/${string}.png` {
  return (
    typeof value === "string" &&
    /^cindy-media:\/\/blobs\/[a-f0-9]{64}\.png$/.test(value)
  );
}
export function isProjectImageDraft(
  value: unknown,
): value is `data:image/${string}` {
  return (
    typeof value === "string" &&
    value.length <= PROJECT_ICON_UPLOAD_LIMIT &&
    /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}
export function validProjectIcon(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 160) return false;
  if (isProjectImage(value)) return true;
  if (value.startsWith("symbol:")) return parseProjectSymbol(value) !== null;
  if (value.startsWith("text:")) return parseProjectLetters(value) !== null;
  // Hermes has no Intl.Segmenter. Accept one emoji sequence, including flags,
  // keycaps, skin tones and ZWJ families, rather than arbitrary display text.
  return (
    value.length <= 32 &&
    /^(?:\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}[\uFE0E\uFE0F]?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}[\uFE0E\uFE0F]?\p{Emoji_Modifier}?)*(?:[\u{E0020}-\u{E007E}]+\u{E007F})?)$/u.test(
      value,
    )
  );
}
export function projectDirectoryName(directory: string): string {
  let end = directory.length;
  while (end > 0 && (directory[end - 1] === "/" || directory[end - 1] === "\\"))
    end--;
  if (end === 0) return directory;
  let start = end;
  while (
    start > 0 &&
    directory[start - 1] !== "/" &&
    directory[start - 1] !== "\\"
  )
    start--;
  return directory.slice(start, end);
}

export const PROJECT_AUTO_ICON_CHANNEL =
  "sidebar-settings:get-project-auto-icon";
export interface AutomaticProjectIcon {
  image: string | null;
  source: string;
  kind: "local" | "website" | "github" | "none";
  candidate: boolean;
}
export function parseAutomaticProjectIcon(
  value: unknown,
): AutomaticProjectIcon | null {
  if (!value || typeof value !== "object") return null;
  const v = value as AutomaticProjectIcon;
  return (v.image === null || isProjectImageDraft(v.image)) &&
    typeof v.source === "string" &&
    v.source.length <= 2048 &&
    ["local", "website", "github", "none"].includes(v.kind) &&
    typeof v.candidate === "boolean"
    ? v
    : null;
}

/** Shared by desktop and mobile; generated initials are an editable picker draft. */
export function defaultProjectLetters(name: string): string {
  const words =
    name
      .normalize("NFKC")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!words.length) return "P";
  const first = Array.from(words[0]!);
  const initials =
    words.length > 1
      ? first[0]! + Array.from(words[words.length - 1]!)[0]!
      : first
          .slice(
            0,
            /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
              first[0]!,
            )
              ? 2
              : 1,
          )
          .join("");
  return Array.from(initials.toUpperCase()).slice(0, 2).join("");
}

/** Stable project identity; keep the palette order fixed across clients and releases.
 * White is an explicit choice only: it cannot distinguish automatic project identities.
 */
const AUTOMATIC_PROJECT_COLORS = ["red", "orange", "yellow", "green", "blue", "purple", "gray", "pink", "coral", "teal", "indigo"] as const;
export function defaultProjectColor(name: string): ProjectIconColor {
  const seed = name.normalize("NFKC").trim().toLocaleLowerCase("en-US") || "project";
  let index = 0;
  for (const glyph of seed) index = (index * 31 + glyph.codePointAt(0)!) % AUTOMATIC_PROJECT_COLORS.length;
  return AUTOMATIC_PROJECT_COLORS[index]!;
}

/** Native equivalent of the CSS 80% identity-color / 20% black-or-white mix. */
export function projectIconInk(hex: string, dark: boolean): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const target = dark ? 255 : 0;
  return '#' + [1, 3, 5].map(offset => Math.round(parseInt(hex.slice(offset, offset + 2), 16) * 0.8 + target * 0.2).toString(16).padStart(2, '0')).join('');
}
