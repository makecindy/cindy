> 后续样式调整：用户选择原「浏览器自动化目标」的无外框轨道与浮起选中胶囊。下文分段组件截图及颜色测量属于此前方案，不作为最终样式证据；用量图形证据仍适用。

# 设置分段选项与用量图表验证

日期：2026-09-07。平台：Desktop / macOS arm64。基点：`f6c037cc9f493a6e6b2512fceef1bd76322788ed`，加本批未提交修复。

设计依据：`DESIGN.md §4` Settings segmented controls / Usage data graphics、§5 用量数据图形例外、§15.16 卡片锚定色。用户选定恢复方格和细柱，保留灰度配色及点击日期筛选；未将自动测试或截图视作最终视觉批准。

## 自动检查

- 根 `pnpm test:unit:related` 通过；覆盖既有资源预设、关闭窗口行为、热力图日期窗口/分桶/金额与 token 口径、以及新增分段选择/键盘/禁用与图形交互测试。
- `pnpm --filter desktop run typecheck` 通过；变更组件与新增测试的定向 ESLint 通过。
- `pnpm check:design-inventory`、`git diff --check` 通过。
- 原测试锁定的 24px 热力图命中区、24px 最小柱宽和 pill 图形按本轮用户裁决改为紧凑数据形状断言；保留数据、日期、点击、可访问名称与选中态断言。

## 真实 Desktop 构建内的生产组件

包装命令启动独立命名沙箱，`DESKTOP_DEV_VERDICT=ready`；`desktop:whoami` 返回 `MATCH`，region=global。通过该实例的独立 CDP 端口挂载实际 `SettingsSegmentedControl`、`UsageHeatmap`、`UsageTokenBars`，使用生产 Tailwind 与 ThemeService，传入合成 140 天 / 30 天数据。未访问真实用量数据库或代用户同意登录协议。

两模式截图均已目检。截图采集将样例内的 CSS transition 完成到终点，避免后台窗口截到换肤中间帧；未验证换肤动画时序。CDP `getComputedStyle` 实测如下：

| 主题 | 卡片背景 | 选中背景 | 选中边框 | 选中文字 |
| --- | --- | --- | --- | --- |
| CINDY light | rgb(253, 253, 248) | rgb(246, 246, 241) | rgb(228, 228, 223) | rgb(26, 26, 26) |
| CINDY dark | rgb(31, 31, 31) | rgb(40, 40, 40) | rgb(49, 49, 49) | rgb(212, 212, 212) |

- 热力方格实测 12×12px、圆角 2px；周列节距 15px。最左格距滚动裁切边界 3px，完整容纳 2px outline + 1px offset。
- 760px 卡片的柱图绘图区为 690px；480px 窄卡片为 410px。两者均显示完整 30 根柱，无横向溢出。零值柱视觉 2px，透明点击高度仍为 24px。
- CDP 实际按右方向键可移动分段选中与焦点；点击热力格和在日期柱上按 Enter 均回传对应日期并更新选中描边。
- 选中分段除了卡片专用填充还有边框；未选悬停与持久选择不再仅靠字重区分。禁用态保留标记并禁止选择。

## 证据边界

这是实际 Desktop 构建里的受控生产组件样例，不是登录后的完整设置页端到端测试；未检查所有社区/自定义主题。CINDY Light/Dark 已实机目检，窄宽度额外检查。

截图 `light.png`、`dark.png`、`dark-narrow.png` 与 CDP 脚本在本轮本地交付目录，栅格不入 Git。截图未上传至 PR；最终分段样式已在开发窗口热更新并检查组件接入，Light/Dark token 消费测试通过，未重新采集最终样式的双模式截图。

采集版本源码 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `components/settings/SettingsSegmentedControl.tsx` | `a766e056ec7634215349fbe1e5969ffca2335d42b6a4a4b128413be3ddd11602` |
| `components/new-chat/UsageHeatmap.tsx` | `c8aef5639c18237ce602c3cdabbe473fb0e4df03d4a563b659789f880aecdfc8` |
| `components/settings/usage/UsageTokenBars.tsx` | `2c6ca497b1aa9cd7b3baab3b41905b63ca0f4f03332c043d14239bd4054b0aa4` |
