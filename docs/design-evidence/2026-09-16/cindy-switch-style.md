# Cindy Switch：蓝色轨道、亮滑块与轻微形变

2026-09-16。用户逐轮试用 HTML 后批准实施（按压收敛为 18×14，悬停 17×16）。
类别：有意可见变化；规范：DESIGN.md §14.4 / §15.17。

首次实机验证的 checkout HEAD：`6f56e4cd78aec8947ec4c621cd60fe115e2a072e`，加本地未提交 Switch 改动。
当时尚未提交或推送。DS-11 #4455 现已合并，本次 Switch 以独立分支交付。

## 实现与兼容

共享 Desktop Radix Switch 保留 checked/defaultChecked、onCheckedChange、ref、原生标签、
键盘和表单路径。拖动后仅通过原有 click 路径提交一次，随后抑制原生指针产生的重复 click；
同侧拖动、取消、Escape、丢失捕获与禁用不提交。未接受更新的受控组件回到当前状态。

新增 switch-thumb-on 默认别名为 hsl(var(--background))；原主题的 background 自定义仍有效。
CINDY Dark 对开、关滑块均覆盖为 #FCFCFC。CINDY Light 保留 background / surface-on-card
别名。DTCG 源、生成物、独立预期与历史分类索引同步更新；旧 ID 与用户主题文件不变。
共享动效适用于 Desktop 各主题；Mobile 不在本次范围。

## 验证

- Desktop 主题目录 + Switch 组件：17 个测试文件、231 项通过。
- design-tokens：47 项覆盖；首次发现新 ID 尚未登记到历史分类索引，补齐后定向重跑
  classification.test.ts 的 9 项全部通过，其余 38 项在本轮全包执行中通过。
- Desktop 与 design-tokens typecheck 均通过；生成新鲜度检查通过。
- Switch 组件和输入测试的 ESLint 通过；git diff --check 通过。
- 首次实机验证阶段未执行提交门禁；主干整合后的门禁结果见下方补记。

## 真实 Electron 验证

macOS，Global 隔离 dev2-ds11-review profile；实际设置页（通知开关），CDP 9331。
复用当前 checkout 的 Vite HMR，不重启。实例启动 SHA 为
`46e44879d32b9a5c75f06530fc30e6a46a408905`，与当前 HEAD 不同；已通过生产 DOM 中
cindy-switch 类、加载的生产主题模块及下列 computed style 确认当前 Renderer 改动生效。
此记录不声称重新构建 main/preload 或验证 packaged 版本。

| 项目 | CINDY Light | CINDY Dark |
| --- | --- | --- |
| 开启轨道 | #417CDD | #417CDD |
| 开启滑块 | rgb(242,242,237)，保留原 background | #FCFCFC |
| 关闭滑块 | #FFFFFF | #FCFCFC |
| 轨道尺寸 | 36×20 | 36×20 |
| 静止 / 悬停 / 按住滑块 | 16×16 / 17×16 / 18×14 | 16×16 / 17×16 / 18×14 |
| 几何过渡 | 150ms，cubic-bezier(0.16,1,0.3,1) | 同左 |
| 减少动态效果 | CSS 已实现、静态检查 | 实机确认过渡时长为 0s |

两模式均实测拖动关闭/开启与 Space 切换。未见可见滑块阴影（原 ring-0 产生的
box-shadow 长度均为 0）；未改变原焦点环。验证结束恢复通知设置与原主题。
静止设置页截图已目检；Windows/Linux 和触摸硬件未实机验证。

截图、逐状态 computed 值与验证脚本位于本机临时目录，不入 Git：

`/var/folders/yh/nrp07sr92331p22044y8zl440000gn/T/cindy-switch-implementation-8ryxm2t4/`

- cindy-light-settings.png / cindy-dark-settings.png
- cindy-light-pressed.png / cindy-dark-pressed.png
- runtime-verification.json / runtime-check.cjs

尚未上传 PR 附件，以上路径仅是本地证据，不代表跨机器可访问的长期链接。
回退时整体回退本次 Switch 组件/CSS、主题源与生成物、独立预期和规范条目，不改写用户主题。

## DS-11 合并后的独立提交验证

基于 main `5a5ad0eff234c6555d2b46335231b1c7253289d7`，分支 `ui/cindy-switch-blue-motion`。
Switch 补丁可无冲突应用；本分支仅收录 Switch 代码、主题与证据，不含设计站点。

- `pnpm test:unit:related` 通过（Desktop 与 design-tokens 相关单测；runner 543 项通过、2 项既有跳过）。
- Desktop / design-tokens 类型检查、Token 生成物新鲜度、Switch ESLint 与 diff 空白检查通过。
- client-ci 静态预检：设计台账、端点、i18n / 品牌 / 术语、Mobile 类型与 scope、migration、scheduler，以及 device-link 编译与集成测试均通过。
- 新分支未重启宿主；上方实机证据对应相同 Switch 实现，不能当作新 main/preload 构建的证明。
- 可交互确认稿：https://cindy-design-lab.workers.xd.team/#/switch ，这是设计稿，非实机截图。

提交前按用户要求由主 Agent 自查，取消本地双审。自查复现并修复了取消拖动后残留点击抑制
导致下一次关联标签点击失效的问题；新增回归测试，Switch 输入测试共 12 项通过。
该修复只清理交互标记，不改变上方已目检的配色、尺寸和动效；修复后的标签路径通过组件测试验证。
