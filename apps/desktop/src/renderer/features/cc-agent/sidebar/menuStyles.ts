/**
 * menuStyles —— 侧栏菜单(DropdownMenu / 右键菜单)在共享 DropdownMenu 默认值之上的差异。
 * ---------------------------------------------------------------------------
 * 面板(12px 圆角、--cmd-palette-bg / --cmd-palette-border、登记阴影、p-1)、分隔线、
 * 行文字 / 字重 / 滑动高亮都由 components/ui/dropdown-menu.tsx 提供,这里只保留侧栏
 * 菜单行比共享默认更高、带图标间距的那部分。调用方需要宽度时直接写 w-* / min-w-*。
 *
 * 不覆盖:对话搜索那张 640px 命令面板(PopoverContent,刻意保留较软的
 * `--cmd-palette-shadow`)与 ConfirmDialog 等模态。
 */

/** 普通菜单项:32px 行高 + 8px 图标间距。 */
export const MENU_ITEM_CLASS = 'h-8 gap-2';

/** 含子菜单的触发行:同上,且沿用侧栏的手型光标(共享 SubTrigger 默认为箭头)。 */
export const MENU_ROW_CLASS = 'h-8 gap-2 cursor-pointer';
