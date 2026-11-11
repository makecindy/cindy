# Select：焦点、菜单层次与连续高亮

- 日期：2026-10-18。初版在 `2681b5b892d8` 上完成并实机检查；提交前对齐最新 main，高亮改为复用 main 已有的菜单共用滑动高亮（见下文「对齐 main 的修订」）。
- 依据：用户本轮组件级意见；`DESIGN.md` §4 Select & Dropdown、§5、§14.4。
- 参考：<https://www.fluidfunctionalism.com/docs/select>；已实际打开并操作。用户随后明确要求同步网站；Select 页已于 2026-10-18 发布本次组件修订，页面标明客户端尚未合入 main，其他页面保留原冻结快照。

## 改动与覆盖

标准 `ui/select.tsx` 与复合 API `SelectParts` 共用焦点、面板和高亮实现。源码扫描确认 Desktop 对 `@radix-ui/react-select` 的直接引用只剩 `ui/select-parts.tsx`。语言、辅助模型、终端、用量设备与时间、存储年龄、Xbox、Work Louder、目标上限、SkillHub 发布等 10 处旧实现接入同一套部件。既有标准 Select 的消费者自动继承。

保留值、回调、选项禁用、分组、文字查找、描述/错误语义与本地主题 alias。通用高亮改用已有 `button-secondary-hover`，修复 Cindy Dark 中 `surface-hover` 与浮层底色仅相差 2/255 的情况。设置/模型局部覆盖仍通过组件局部变量传入；未修改用户主题文件或主题 Token ID。

面板复用 `shadow-menu` 与现有 `float-in` / `float-out`；不增加动画依赖。高亮只移动一块背景，选中勾不随鼠标改变；按真实小数行高测量，反算面板入场缩放，滚动/分组/长说明均不依赖固定行高。

## 对齐 main 的修订（提交 PR 前）

最新 main 已有菜单共用滑动高亮（`dropdown-menu-highlight.ts` + `menu-row.tsx`）。为避免 Select 与菜单两套高亮并存，经用户确认：Select 的滚动视口改为挂载共用的 `MenuHighlightLayer`，选项标记为菜单行；高亮颜色、节奏、移出淡出与减少动态效果均与菜单一致（`--sidebar-item-hover`、`--motion-instant`）。移除自研底板、`--select-option-hover` / `--select-option-selected` 局部别名以及已选行底色；已选值由勾选标记与调用方的选中文字样式表示。调用方自带 `data-[highlighted]:` / `hover:` / `focus:` 底色的行保留原效果。main 新增的 `UsageFilterSelect` 同步接入 `SelectParts`。

下表中焦点环、阴影、入出场、宽度与碰撞翻转的结论仍适用；**关于底板颜色、帧采样与几何差值的记录针对的是被替换的初版底板，修订后的共用高亮尚未在真实客户端重新目检。**

## 真实客户端检查（初版）

macOS Electron 开发版，Global `select-ui` 隔离沙箱、被动调度；`desktop:whoami --all` 确认当前 checkout。使用真实设置页面和 CDP 鼠标/键盘操作，截图不入仓。窗口初始处于隐藏状态，恢复显示后才采样连续动效；未以隐藏窗口的暂停动画证明流畅。

| 场景 | 结果 |
| --- | --- |
| 语言菜单，Cindy Light / Dark | 触发器与菜单均 320px；12px 面板、8px 高亮。柔和阴影分别为 0 4px 16px / 黑色 15%、50%。两模式均已目检。 |
| 鼠标关闭 | 焦点返回触发器，`:focus-visible=false`，`box-shadow=none`。 |
| Tab 进入、Enter 打开、方向键浏览、Esc 取消 | 取消保留原值，焦点返回且保留 2px 软蓝环。 |
| 连续高亮移动 | 实际帧采样显示同一底板经过中间坐标后到达目标；时长 150ms / 既有 ease-out，不延迟选择。 |
| 用量设备的两行说明，Dark | 53.5px 行高；底板与目标行的 x/y/width/height 实测差值均为 0。高亮约 RGB 45.5，面板 RGB 31。 |
| 用量时间 / 设备列表 | 190px 等宽，6px 面板内边距；选择/取消和说明布局保留。 |
| Cindy Make 制作历史标准 Select，Dark | 168px 等宽，复用相同面板/高亮；Button 自有焦点与错误样式不被复合 Trigger 覆盖。 |
| 屏幕下缘 | 自动向上展开，transform-origin 位于面板底部，未超出视口。 |
| 小窗口滚动（1100 × 400） | 面板高度 180.914px、上缘 8px；选项仍为 36px。End 能到最后一项，视口 scrollTop=63 / scrollHeight=226；底板与目标行四项几何差值均为 0。 |
| 减少动态效果 | 面板 `animation-name=none`，高亮 `transition-duration=0s`，选择/关闭仍可用。 |

应用退出后重新启动同一隔离沙箱，补验最终代码并重新采集 `select-light-final.png`、`select-dark-final.png`、`language-small-window-scroll.png`；此前临时目录已被清理，旧截图不再作为可下载附件。提交 PR 时应外置最终图片并补链接。真实截图仅证明以上场景，Windows、其它主题、未连接硬件的专属设置以及全部业务入口尚未逐页实机验证。

## 自动验证

- 修订后（最新 main 上）：共享 Select 与 17 个调用处相关测试文件，共 18 个文件、243 项通过；新测试覆盖键盘跳过禁用项、选择只提交一次、取消保留值、单一共用高亮层跟随键盘、自带高亮的行退出共用层。
- `check:design-inventory` 通过（53 个 surface）；`git diff --check` 通过。
- 初版另跑过 `check:dev-docs`、台账生成器测试等；不将本地定向验证等同完整 CI 或设计师批准。
