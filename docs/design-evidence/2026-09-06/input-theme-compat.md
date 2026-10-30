# DS-4 旧设置输入主题兼容验证

日期：2026-09-06。平台：Desktop / macOS arm64。基点：`5fc5881101753aba47922d089f3b3246e9b9ffce`，加本批次未提交修复。未使用真实用户主题、凭证或数据库。

本批恢复此前消费 settings 域 alias 的输入框，不改变通用 Input 的 Tier-1 默认。原 SettingsTextInput 消费者与 AgentResource / Collaboration 的四个数字框共用同一标准组件；旧局部覆盖仅在设置封装内生效。

**自动验证**

- `inputThemeCompatibility.test.tsx`：真实临时主题文件 → main loader → renderer bootstrap / normalize → 实际 React 控件的 Token 消费表达式 → 生产 registry 解析。覆盖 Light/Dark、局部/全局覆盖、旧 placeholder 归一化、完整主题副本、重复加载和磁盘字节不变。
- 所有内置主题没有局部覆盖时，标准 Input 与 SettingsTextInput 四项颜色逐值相同。
- 错误态边框与 focus 环优先于局部兼容样式。四个数字框的现有渲染测试保留交互验证并增加局部 alias 消费断言。
- jsdom 测试不声称验证 Tailwind 最终 CSS；浏览器测量见下。

**真实 Desktop 构建内的组件对照**

使用独立 dev 沙箱，包装启动与 `desktop-whoami` 均返回 ready / MATCH。通过 CDP 在该构建内挂载实际 Input / SettingsTextInput，以生产 Tailwind 和 ThemeService 渲染，读取 `getComputedStyle`（含 placeholder 伪元素）并采集 Light/Dark 截图。

对照左侧是仍保持 Tier-1 默认的通用 Input（也即修复前直接 re-export 的效果），右侧是本批局部兼容封装。同屏使用故意不同的全局和局部覆盖，以证明作用域。这些数值是验证输入，不是新设计裁决。

| 模式 | 项目 | 通用 Input | 兼容设置输入 |
| --- | --- | --- | --- |
| Light | 文字 RGB | 35,69,103 | 101,67,33 |
| Light | 边框 RGB | 86,120,154 | 135,101,67 |
| Light | focus 边框 RGB | 52,86,120 | 169,135,101 |
| Light | placeholder RGB | 120,154,188 | 170,136,102 |
| Dark | 文字 RGB | 170,204,238 | 238,203,170 |
| Dark | 边框 RGB | 136,170,204 | 187,153,119 |
| Dark | focus 边框 RGB | 187,221,255 | 255,221,187 |
| Dark | placeholder RGB | 120,154,188 | 170,136,102 |

两模式错误边框保持生产 error token；禁用 opacity 均为 0.6；focus 环仍为原来的 65,124,221（RGB）、2px。两张截图均已目检。

**证据边界与待交接**

- 这是实际 Desktop 构建中的受控组件样例，非 SSR、非手绘；不是登录后的完整设置页端到端验证。新沙箱没有同意登录协议，本次未代用户同意。完整设置页以及全部内置主题的实机检查未执行。
- 没有宣称全局/局部同时覆盖时零视觉变化：有意恢复设置域旧覆盖；无局部覆盖的默认值由自动测试逐值核对。
- 截图与 CDP 复现/测量脚本随桌面执行记录本地交付，栅格文件不入仓。尚未创建 PR 或上传附件；提交 PR 时需补真实可访问的附件链接，此项目前不记为完成。
- 09-04 日志提出的跨 surface alias 全族收敛没有在本批执行。本批只处理已经迁移的既有输入框；通用标准件保持 Tier-1，旧局部 override 不提升成全局 semantic。

采集时代码 SHA-256（便于核对未提交修改，不把基点当成采集版本）：

| 文件 | SHA-256 |
| --- | --- |
| `components/ui/input.tsx` | `88527dd4fb758d9ff7c1fe425f43d67bcc4770abb79f329ad913f95bfd53dba8` |
| `components/settings/SettingsTextInput.tsx` | `fc25cad5aec84abd783904138d88448ec350795c15dd6e2b233c77832c088a57` |
| `components/settings/AgentResourceSection.tsx` | `6f1a9700998f06e69aabbc33f8f78a3b574ad0d138acff9a584d8664f931e909` |
| `components/settings/CollaborationSection.tsx` | `49ce0ba642e6d079b8d609843908279797f95d08ae16a63b6c261983c783d208` |
