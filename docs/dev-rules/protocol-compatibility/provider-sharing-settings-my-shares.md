# 设置页中我分享的供应商

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

Desktop 的本机分享命令与既有同账号供应商管理通道增量支持 `shared-provider-ids`，
只返回当前电脑已建立分享的供应商 ID 与就绪状态，包含已暂停的成员，不含仅有链接或申请的项。
查询读取分享运行时快照，不延长快速轮询窗口，不计算用量；原来的 `owned` 与分享管理页行为不变。
新控制端遇到旧电脑不认识此命令时，回退到 `owned`，两次读取至少相隔 90 秒，避免持续续期
60 秒快速轮询窗口；页面隐藏时停止定时与事件读取，重新可见后刷新。
不增加 IPC channel、设备权限、分享授权、重试或持久化；旧控制端继续使用原命令，双方可独立升级。
回归入口：`providerShareManagement.test.ts`、供应商组 `ipc.test.ts`、`OwnRemoteProviders.test.tsx`。
