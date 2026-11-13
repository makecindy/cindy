# 远程插件管理页面验收 fixture

仅用于开发时的 headful Chrome 视觉验收，使用生产组件、主题和 i18n。
`preview.tsx` 在这个独立入口注入虚构 Electron API、电脑、市场与操作回执，
页面始终标注“生产组件 · 隔离测试数据”。不读取真实账号、凭证或插件目录。

启动本 worktree Desktop Vite 后，在本地 Chrome 打开：

```
http://localhost:<Vite 端口>/@fs/<worktree 绝对路径>/apps/desktop/scripts/fixtures/remote-plugins/index.html?theme=light
```

`theme=dark` 查看 Dark。两台电脑的 root 插件版本不同，org 与 root 使用同一插件 ID。
`skills` 打开技能页；切换插件/技能保持同一电脑。`old&skills` 展示旧 Host 的能力缺失提示。
两台电脑的全局技能版本不同，同名项目技能具有独立身份与开关。
“断开测试连接”只改变 fixture 连接状态；安装确认只更新 fixture 内存清单。
技能确认弹窗是 fixture 对原生 IPC 的替身，弹窗内明确标注，不能作为实际原生确认框的验收证据。
这不是实际双电脑安装或 OAuth 验收，也不是产品入口。

页面标题右侧只有一个电脑下拉；“更多”子菜单选择所选电脑的全局/项目范围，选项目后同一触发器显示项目名。
文件安装入口位于顶部“添加插件”菜单，文案为“从文件安装…”，菜单内显示目标电脑。
文件选择与传输也是 fixture 替身，不打开或安装真实文件。技能公开/团队仅切换推荐，保留已装清单。
在线状态由同一个生产 hook 持续观察，详情隐藏下拉时仍能验证断线禁写。

`old-plugins` 使用旧 Host 的插件 list/get，不提供新增的管理能力；列表和详情仍使用
正式卡片、图标、工具、权限和信息组件，仅提供只读操作。以下参数可组合：

- `old-empty`：目标电脑的已装列表为空。
- `missing-plugin-facts`：详情缺少结构化工具、权限和信息，保留已知名称、版本和实例标识。
- `fail-plugin-list` / `fail-plugin-detail`：对应读取首次失败，刷新后恢复。
- `offline`：初始离线；页面保留所选电脑，刷新与写操作不可用。
