# 伙伴导入的消息机器人分类

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`companion-import` Remote Resource 的 client primitives 可追加 `companion-import-bots-v1`。只有声明它的控制端
（以及本机界面与 `import_agent`）的预览才会收到 `category: 'bots'` 条目及其可选 `platform` / `owner` 字段，导入时
会先在来源 Agent 里停用这些机器人再由伙伴连接；旧控制端的预览校验不认识新分类，所以照旧把 Telegram / Discord
放在 `connections`、不停来源，也不出现飞书 / 企业微信 / 钉钉条目。分类随预览快照与加密检查点保存，开始导入和恢复
都按当时的分类执行。不改 relay 帧、服务端 schema 或 Mobile 原生指纹。

Cindy AI 设置卡片保留可选读取返回的 `unlimited` 状态，显示“未设置个人限额”；它不代表部门或企业没有限制。`invalidated` 清除该状态，有限额快照覆盖该状态，切换账号不复用上一账号结果。旧 `null` push 无法区分失效与不限额，本地卡片收到后通过既有可选读取核对；同一账号的多个组件共享在途读取，收到读取自身的广播时复用该请求，避免多窗口之间反复触发刷新。主进程跨窗口共享在途读取，已知不限额参与既有节流，重复不限额结果不重复广播。IPC payload 与远程消费者保持兼容。
