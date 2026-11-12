# 实验性 Host 网页适配层（2026-11-10，未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

网页 shim 与显式 `CINDY_HOST_API` 桌面代理共用 `hostChannelContract`；这是客户端
参数与返回形状的统一，不新增 HTTP 路径、认证方式、Device Link 帧或 relay 要求。
`maker.resolveInteraction` 保留 preload 的 `{ accepted: boolean }`，不把请求成功的
`ok` 当作回答已接受；`input.steer` 返回布尔值；`authRefresh` 只认认证状态，不认一般
`ok`。旧 Host 已提供相应字段，新客户端仍可连接；普通桌面 IPC 实现保持原行为。
消息查询保留可选 `before`，旧调用不传时保持默认。网页新增调用已有的任务改动摘要接口，
不再把 `maker.listTurnChangeSets` 当作空占位；后端 API 不变。
共享脚本仅在实验 Host 中编译和提供，未实现的网页写操作明确拒绝。
接口与恢复验收见 [Host 维护计划](../../host/maintenance-plan.md)。

## 实验性 Host 事件恢复

Host SSE v2 由 `protocol=2` 和 `x-cindy-event-protocol: 2` 双向确认，新增 start/ready
控制帧携带进程运行标识、序号和恢复原因。只有同一运行且游标仍在历史窗口内才补收事件；
重启或缺口必须读权威快照。旧客户端不请求 v2 时仍收到原事件格式，新客户端连接旧 Host
时每次重连补读快照。浏览器和显式 Host 桌面客户端共用 `hostEventStream`，不各写一套解析器。

连接恢复仅重试读取：不重发输入、不重放点击、不延长配对授权。renderer 的恢复读取须同时
受连接、账号、任务窗口代次约束，不能让旧连接结果覆盖新状态。RPC/SSE 401 保留原页面并
等待显式重新配对，恢复不以刷新页面或清空草稿为手段。普通桌面默认启动不安装 Host 连接处理器。

## 后台 Host 与原生窗口平台合同（未发布）

同机原生客户端新增 `/control/platform/socket`，复用 profile bearer，并要求
`x-cindy-host-instance` 与 Host 当前实例一致。拒绝浏览器 Origin 连接，窗口身份绑定
账号、客户端 ID 和 PID。HTTP/SSE 的实例头为可选增量；旧显式客户端不带头时继续原协议，
不启用新平台能力。平台桥的消息格式与取消语义共用 `hostPlatformRpc.ts`。

`POST /control/platform` 的 `status`、`prepare`、`cancel` 为本机控制操作，冻结前检查在途请求和
输入占用；活跃 webview 拒绝交接。只有未派发请求能等候新窗口，派发后断线返回未知结果，
不重放点击或其他副作用。Host 实例或账号变化后旧请求失效。

新增侧栏页签 `/api/right-sidebar-tabs/*` 与 `right_sidebar_tabs_changed` 事件沿用
桌面记录形状，旧客户端忽略未知事件。此合同不改变 Device Link 帧、relay、官方或自建
中转 API：网络传输仍走原有实现，没有新增必须由中转识别的字段。

升级工具必须继续尊重 `client-migration.json` / `clientHandoffReady: false`；本 PR 不实施
profile 所有权迁移或开启日常桌面迁移。实现与验证边界见
[窗口交接地基](../../host/client-handoff-foundation.md)。
