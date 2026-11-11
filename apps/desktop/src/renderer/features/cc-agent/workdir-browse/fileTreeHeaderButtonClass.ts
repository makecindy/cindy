/**
 * 文件树标题行图标钮的统一类名。
 *
 * 一行里的动作按钮 —— 搜索 / 显示被忽略的目录 / 收起 / 刷新,外加搜索态的 X ——
 * 共用这一份定义。两个宿主(RSB 文件浏览器 FileBrowserBody 的 TreeHeader、
 * doc 模式侧栏 WorkdirBrowseSidebar)以前各自复制了一行类名,新增「显示被忽略的
 * 目录」时新按钮走 pill、三个旧按钮还是 6px,同一行就出现了两种圆角。
 *
 * 为什么是 pill(DESIGN.md §5):控件框(含 transient hover / pressed 表面)登记在
 * Step 2 的 pill 档;6px 不在受治理取值里(`No 3px / 6px / 10px`)。抽成常量后
 * 后续新按钮只能拿到同一个值,不会再各写一份。
 *
 * focus-visible 环必须自己带:G3 全局规则(globals.css)把非输入元素的 outline
 * 一律去掉了(Chromium 默认环在 Esc/点击后跳焦时会闪橙色),所以不显式补环的
 * 纯图标钮在键盘 Tab 时没有任何可见焦点指示 —— 包括新增的「显示被忽略的目录」
 * 开关(评审 P1)。
 */
export const FILE_TREE_HEADER_ICON_BUTTON_CLASS =
  'flex size-5 items-center justify-center rounded-full text-sidebar-action-icon hover:bg-sidebar-item-active hover:text-sidebar-item-active-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';
