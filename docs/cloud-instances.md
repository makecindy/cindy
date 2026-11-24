# 云实例

云实例是运行在容器里的 Cindy，归一个账号所有，由云实例服务（下称 CIS，不在本仓）分配、休眠、唤醒和升级。
本仓包含三部分：控制端界面、实例里的运行时、镜像配方（[`deploy/linux-desktop`](../deploy/linux-desktop/README.md)）。

## 启用条件

- 入口是端点清单的可选字段 `cloudInstanceApiBaseUrl`。只接受 `https:`，不能带用户名密码、query 或 fragment。
  仓内公开清单不含此字段。
- 总开关是 `cloudInstancesEnabled()`（`main/cloud-settings-client/enabled.ts`）：本应用就是云实例，或任一区域的清单
  配了该字段。未启用时不注册云实例 IPC、不给窗口云桥、不建登录窗口、不监听、不发请求。
- 启用不影响启动：启动过程不访问 CIS，未登录或处于本地模式时也不访问。主窗口可用且已登录后才查询准入；
  不可达、超时（8 秒）、拒绝或返回非法内容都只是隐藏入口，稍后自动重试。登录窗口只为已准入的账号预热。
- 实例模式由 `--cloud-instance` 加 `CINDY_POD_*` 环境变量进入（`main/instance-runtime/config.ts`，仅 Linux），
  参数不全直接拒绝启动。普通桌面不注册实例运行时的任何调用。

源码联调把含该字段的完整清单放仓库外，每次启动传 `--endpoints-file=<绝对路径>`，
见 [Desktop 开发规则](dev-rules/desktop-development.md)。

## 控制端

- **准入**：`CloudInstanceAccessProvider` 经 Main 调用 `GET /client/access`。结果不落盘，换账号立即丢弃；
  它只决定是否显示，每次操作由 CIS 重新校验准入和归属。
- **运维**：云实例是「设置 → 远程连接 → 我的设备」里的一台设备（`AdmittedCloudDeviceDirectory`）。可领取、休眠、唤醒、
  立即更新和改维护策略。结果未知的请求只回读，不重发；打开设置或读取状态不会唤醒实例。
- **登录**：实例待登录时打开独立非模态窗口（`main/cloud-settings-client/login-window.ts`），复用本机登录界面，
  只持有不透明句柄。凭证写回在 CIS 与实例之间完成，本机登录态不复制到云端。换账号、关窗或改选实例取消旧尝试。
- **设置页**：`/cloud-settings?deviceId=<id>`。展示组件与本机设置页共用（`*View` 或 `settingsTarget`），取值、候选项、
  默认值和写入全部来自目标实例；不调用本机配置 IPC，没有远端合同的设置不画假控件，由「更多设置」打开云端桌面。
- **隔离**：Main 持有 Access Token、服务地址和会话 ID，Renderer 只拿绑定 webContents 的句柄。请求统一
  `credentials: 'omit'`、`redirect: 'error'`、`no-store`，限制响应大小，不把错误正文或凭证转给界面。

```text
设置页 → preload 封闭方法 → Main → CIS 设置会话 → settingsWeb 队列 → 实例
设置页 → DeviceLink 私有通道 cloud:* → 实例
```

有意不提供：退出 / 切换账号（托管身份由 CIS 绑定）、应用更新与 Beta 通道（由镜像升级承接）、关闭窗口与保持唤醒、
只影响实例自身窗口的外观类设置、控制端本地硬件（麦克风、Android、Agent Island 等）。

## 实例运行时

代码在 `main/instance-runtime` 与 `main/host-settings`，只在云实例注册。

- **身份**：固定 device 与 membership，从一次性 bootstrap 或既有凭证库恢复，拒绝本机账号操作
  （`assertInstanceAuthMutationAllowed`）。凭证或设备登记失效时状态为 `login-required`，主人重新登录后经
  `/tmp/cindy-auth-recovery/control.sock` 恢复，不重建实例。
- **状态**：`status.ts` 原子写状态文件，供镜像健康检查和 CIS 读取。
- **设置**：设置属于运行任务的实例。写入带 revision 与 operationId，单领域提交，冲突不覆盖，结果未知先查回执。
  写入沿用本机各设置域的实现；新任务默认值、个人指令、桌面偏好和模型显示仍由应用窗口保存。
- **settingsWeb**：实例用自己的 Access Token 轮询 CIS 领取主人提交的命令（`webTransport.ts`）。命令是封闭集合：
  `read` / `readBatch` / `update` / `receipt` / `manage` / `channel` / `desktop` / `desktopIce`；过期不执行，
  回执失败只重送同一回执。能力按注册声明协商，旧服务端不认识的可选项逐个去掉重试。
- **私有通道**：`cloud:personalization:v1`、`cloud:im-settings:v1`、`cloud:storage-usage:v1`、
  `cloud:provider-settings:v1`，只接受实例主人；普通桌面返回 `CHANNEL_NOT_ALLOWED`。密钥不经 DeviceLink，
  走 `manage` 票据，只写不回显。
- **授权**：第三方授权页在发起操作的控制端打开，回调只接受该次登录创建的 redirect 与 state；
  PKCE、换票和凭证保存都在实例内。
- **只读快照**：`snapshotPublisher.ts` 在就绪后约每分钟上报一份脱敏设置快照，目录与上限见
  `shared/settingsReadCatalog.ts`、`shared/settingsSnapshot*.ts`。读取无副作用（不修复、不迁移、不联网）；
  不含提示词正文、凭据、URL、路径、设备身份和私有模型名。v2 的字段集合冻结，新增字段须协商新版本。

## 维护

- 新增或改动设置项时，决定云设置页是否提供。共用展示组件由类型检查提醒补齐远端适配；新增持久设置须登记到
  `settingsReadCatalog.ts`（有守卫测试）。
- wire 定义在 `shared/settingsWeb.ts`、`settingsManagement.ts`、`settingsEditableCatalog.ts`、`settingsSnapshot*.ts`，
  字段只增不改：实例可能比控制端旧或新。
- 实例从云设置页接收的设置保存和管理操作经 `instance-runtime/maintenance.ts` 计入维护在途，维护开始后返回可重试的
  `CLOUD_MAINTENANCE_RETRY`；新增会改状态的云端入口也要接入。
- UI 场景在 `apps/desktop/scripts/fixtures/cloud-*`，不连真实服务或账号。
