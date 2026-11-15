# Mobile 群聊文本附件预览（#6881 / PR #7400）

2026-10-27 在独立系统模拟器 `Cindy6881PR-iPhone17Pro-20261027` 上采集：
iPhone 17 Pro / iOS 26.5，Global 原生开发客户端 `com.xd.cindy`，版本
`0.1.0 (2026072301)`。未使用 UI mock；从已登录群聊的历史附件入口实际点开。

Metro 来自本 PR worktree；采集基于 `d0cc4525e9` 加本次安全区修正，经 Fast Refresh
加载。`mobile:sim:whoami` 在修正前确认该 worktree 的 Metro、源码和已安装原生指纹匹配。
修正后的页面已目检，并实际点击关闭返回群聊。没有发送群消息或修改附件。

| 格式 | 历史附件 | 浅色截图 |
| --- | --- | --- |
| HTML | `research-evidence.html` | [端内 HTML 预览](ios-html-light.png) |
| Markdown | `execution-plan.md` | [端内 Markdown 预览](ios-markdown-light.png) |
| JSON | `2026-10-22-PAYATHON小红书选题证据.json` | [带行号的 JSON 预览](ios-json-light.png) |

JSON 截图的来源 URL 行已用实色块遮盖，避免发布来源链接的签名查询参数；其余内容未修改。
HTML 与 Markdown 截图未做内容编辑。截图不包含群成员列表、群时间线或登录凭据。

验收时发现全屏预览标题和关闭按钮进入 iOS 状态栏区域；本次在 Modal 内增加独立
`SafeAreaProvider`，修正后重新采集上述截图，标题与关闭按钮均位于安全区内。

已验证：三种格式的历史附件端内打开、正文显示和关闭返回；三种格式浅色目检；
JSON 深色目检。HTML 作者页面在系统深色下的正文样式也已查看，但不据此声称
HTML / Markdown 的完整深色界面已验证。

自动检查：Mobile typecheck、两个定向测试文件（30 项）和设计台账检查通过。
尚未验证 Android、物理真机、新消息路径、弱网、完整冷缓存与重启矩阵。
