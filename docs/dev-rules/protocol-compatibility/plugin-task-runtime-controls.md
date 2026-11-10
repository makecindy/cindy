# 任务运行时插件控制点（未发布）

`subscribe.hooks` 追加 `will-start-turn`、`will-model-request`；管子裁决追加
`transform` 和 `request`（供应商 JSON 正文），`route` 在这两个新节点支持 `fastMode`。
旧节点及旧插件行为保持不变；未知 hook 仍原样保留且不自动授权。安装／更新确认的新节点
沿用 `approvedControlPoints`，不新增 grant、授权账本或申请状态。

新增本机任务设置 IPC `maker:runtime-plugins`，任务选择保存在账号独立的
`runtime-plugin-prefs.json`，不改数据库 schema。未选择时无插件调用；选择不写入新任务草稿、
不自动继承到分叉任务，不进 device-link allowlist。手机／另一台电脑的设置入口暂不支持，
执行电脑仍在统一发送入口应用其已保存的选择。官方及自建中转无新帧、relay 或服务端改动。
逐请求控制只支持本机 Pi；Claude Code、Codex、SSH／设备托管 Pi 明确不支持。
Pi 通过进程内 Symbol 接收宿主回调，能力不从 Renderer／远程 JSON 选项取得。
