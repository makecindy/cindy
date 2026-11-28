# 允许我的其他设备 SSH 到这台电脑（2026-11-26，未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

Cindy 云电脑（腾讯云轻量实例）加入主人的设备列表后，主人的其它 Cindy 电脑无需手动操作就能 SSH 进去；
其它 macOS / Linux 电脑可在「这台电脑」卡片里打开同一能力。被控端（TARGET）只接受同账号、通过现有远程控制准入
的电脑各自登记的一把 Cindy 专用 ed25519 公钥。协议定义与双端共用的有效／无效样例在
`packages/device-link/src/sshAccess.ts`（`SSH_ACCESS_EXAMPLES`）。

## invoke `device-link:ssh-access:v1`（控制端 → 被控端）

- **准入**：进远程调用白名单（准入论证同 `desktop-cmd:run`：同账号 + 被控端打开「允许同账号设备控制本机」且未撤销时，
  控制端本就能在被控端执行任意命令）；后台优先级（`invokePolicy.ts`）。被控端 dispatch 拦截执行，沿用 REMOTE_DISABLED /
  ACCESS_REVOKED 的既有准入；共享任务访客、供应商分享受邀者与自报为手机的设备返回 CHANNEL_NOT_ALLOWED；被控端还没建好
  （未登录、Host 未装配）返回 `[SSH_ACCESS_UNAVAILABLE]`。
- **请求**：`{action:'status'}`（只读）；`{action:'enroll', requestId, publicKey}`（幂等，替换调用方自己那一行）；
  `{action:'withdraw', requestId}`。`requestId` 为 8–64 位字母数字、`_`、`-`；`publicKey` 必须正好是
  `ssh-ed25519 <base64>`（不带注释、选项、换行）。字段值严格校验，未知字段忽略。
- **回包**（三种 action 相同）：`{version:1, enabled, blocked, authorized, revision, endpoint}`。
  `blocked` 为 `null` / `SSHD_UNREACHABLE` / `REMOTE_LOGIN_OFF` / `AUTHORIZED_KEYS_UNSUPPORTED` /
  `PLATFORM_UNSUPPORTED`，旧控制端读到不认识的值按 `UNKNOWN` 处理。`authorized` 表示调用方的公钥此刻在授权文件里。
  `revision` 是不透明整数：`enabled`、`blocked`、`endpoint` 任一变化它就变，只比较是否相等，不排序、不持久化（重启后同一状态
  可能得到不同值）。`endpoint` 在关闭或被阻断时为 `null`，否则为 `{user, port, addresses:[{kind:'public'|'lan'|'mdns', host}]
  ≤8, hostKeys:string[]≤6}`；控制端会把这些值写进 SSH 配置，解析时 `user`、`port` 不合法则整个 endpoint 为 null，
  单个地址或主机密钥不合法（换行、空格、未知 kind）只丢那一项。未知字段忽略。
- **错误**：在既有 IPC_ERROR 的 message 里以 `[SSH_ACCESS_DISABLED|INVALID|KEY_IN_USE|UNAVAILABLE|WRITE_FAILED]` 携带，
  `sshAccessErrorCode()` 解析；其它异常一律回 `[SSH_ACCESS_UNAVAILABLE]`，不带路径。`KEY_IN_USE`：这把公钥已属于另一台设备
  或一条手动公钥（一个指纹对应一台设备）。`WRITE_FAILED`：记录已保存但授权文件没写成，被控端按 30 秒、2 分钟、10 分钟重试。

## push `device-link:ssh-access:announce`（被控端 → 每台在线的同账号电脑）

`{version:1, enabled, revision, authorized}`。进共享客户端的免链路 push 清单（`UNLINKED_LEGACY_PUSH_CHANNELS`），
不需要控制链路。被控端启动或上线、某台电脑上线时发给它；`revision` 或某台电脑自己的 `authorized` 变化时发给相关电脑；
1 秒内的连续变化合并为一次，与上次发给这台的内容相同则不发。访问关闭时不发，只有这台电脑在被控端还有公钥、或曾被告知
「已打开」时收到一次 `enabled:false`，让它把主机标为不可用。只发给自报为电脑的同账号设备，不发给手机与撤销过的设备。

## 旧端与混用

旧被控端没有这个通道，返回 CHANNEL_NOT_ALLOWED：控制端按对方 app 版本记住「需要更新」，版本变化前不再重试，不用版本号
猜能力。旧控制端丢弃不认识的 push，被控端行为不变。手机不参与（不登记公钥、收不到 announce）。

## 中转（含自建）

没有新帧、能力位或中转行为：invoke 仍受目标 `remoteControlEnabled` 的 CONTROL_KINDS 门禁，push 原样转发，
`packages/device-link-relay` 与服务端无需修改（中转只认连接层帧与路由头，不解析 channel）。2026-11-26
`pnpm --filter @cindy/device-link-relay run interop` 通过（2/2）；互通用例在真实自建中转上额外确认：控制端远控关闭时
announce 仍以签名 push 送达，`device-link:ssh-access:v1` 的请求与回包原样往返并按共享样例解析（`scripts/device-link/interop.test.ts`）。

## 被控端落盘（决定 9、12 与 2026-11-26 补充）

- 正本是 `owners/<owner>/ssh-access.json`（公钥、指纹、设备 id、标签）；授权文件由它派生，每次变化与启动时重写。
- 云电脑：sshd 只读 `~/.ssh/cindy-owner-authorized-keys`，首行必须正好是
  `# Managed by Cindy SSH access; manual edits are overwritten.`（镜像的开机闸门只暂扣以它开头的文件）。没有这行的文件视为
  手工维护：访问关闭时不动它；打开时先把其中合法的 ed25519 行导入为手动公钥（标签 `imported`）再接管；含无法导入的行
  （其它类型、带选项）时不接管，回 `AUTHORIZED_KEYS_UNSUPPORTED`。启动时最多等 10 秒读取设备列表；若未成功读到，
  设备公钥暂不写回，已暂扣的文件继续保留。后续首次成功读到列表时只恢复仍在账号内的设备公钥，写入成功后才删除
  以标记行开头的 `~/.ssh/cindy-owner-authorized-keys.held`。手动公钥不受设备列表约束。
- 其它电脑：`~/.ssh/authorized_keys` 顶部的标记段，用户自己的字节（含缺失的末尾换行）原样保留；冲突检查的原子写、0600，
  `~/.ssh` 缺失时以 0700 创建；符号链接、非普通文件或损坏的标记段不改写，回 `AUTHORIZED_KEYS_UNSUPPORTED`。
- 每个 Cindy profile 各写自己的标记段（`# >>> Cindy SSH access <profileKey> >>>`），同机的正式版与开发版、桌面与 Host 互不覆盖。
- 共享的 `authorized_keys` 与 `cindy_known_hosts` 写入使用现有跨进程锁保护比较和原子替换；锁忙时不绕过冲突检查。
- SSH 服务暂时未启动时，被控端每 30 秒仅在本机重探；可用后广播变化。控制端从回包的多个地址并行探测 SSH banner，
  按回包顺序选首个可达地址，仍按固定主机密钥验证真正连接；暂时都不可达时按现有有界重试处理。
- 设置只存用户的选择：`device-link-settings.json` 的可选 `sshAccessEnabled`，恢复默认即删除；默认值云电脑开、其它关。
  主开关关闭时整个能力关闭、授权文件清空，记录保留。登出清空本 profile 的标记段。
- 公钥离开授权文件时（撤销、从账号移除、换账号、关闭）结束用这把公钥登录的同用户 SSH 会话（Linux；优先 `SSH_USER_AUTH`，
  其次 sshd 日志）；设备自己撤回或换公钥不结束；映射不到的会话只报告。

## 控制端的主机与别名（决定 6、8 与 2026-11-28 补充）

- 每台被控设备在 `~/.ssh/cindy.conf` 里有一个 Cindy 管理的 Host 块，它的别名同时是终端里的 `ssh <别名>` 和「SSH 远程主机」
  的 hostId。主机密钥固定在 `HostKeyAlias cindy-device-<设备 id>` 下（`~/.ssh/cindy_known_hosts` 与 Cindy 自己的
  host-key store），与别名无关。
- 别名跟着设备名走：按 `deviceAliasSlug` 生成 `cindy-<名字>`；名字没有 ASCII 字母数字，或这个别名已被其它主机占用时，
  按 `chooseDeviceAlias` 改用设备 id 前缀（仍被占用再加长、再加编号）。设备在设备列表里改名后（目录、presence 或启动时的
  缓存名），控制端用已记录的地址把这个 Host 块原地改成新别名，不调用被控端、不重新核对指纹；旧别名随即失效，
  主机的本地偏好（显示名、代理设置）随别名迁移。
- 用户删过的主机不因改名被加回；仍有远端会话引用旧别名时暂不改名，下一次写入主机时再试。
- 被控端「这台电脑」卡片按自己当前的名字显示 `ssh cindy-<名字>`，规则与控制端相同；新名字在某台控制端上已被别的主机占用时，
  那台控制端用的别名会不同，卡片不知道这一点（没有为此加协议字段）。

## 通道预算（server-channel-review.md）

1 台云电脑 + 5 台电脑：云电脑启动时 5 条 push + 至多 5 次登记（控制端同一目标同时只有一次登记在途）；平时中转上零流量。
被控端在访问打开且至少有一把设备公钥时，按 Agent-Net 设备列表同一套调度读 `/api/device-link/devices`（`AgentNetMembership`：
同一时间一次、间隔不少于 10 秒、平时每 5 分钟 ±20%，即约 12 次／小时；读失败按 10 秒起翻倍退避到 5 分钟，首小时最多约 16 次），
复用 relay 上线时已有的完整目录读取；读取走共享的目录限流账本，部分（单腿）结果不当作移除依据。

## 实现与回归

协议 `packages/device-link/src/sshAccess.ts`（`__tests__/sshAccess.test.ts`）；准入 `apps/desktop/src/main/device-link/dispatch.ts`
（`device-link/__tests__/cloudPrivateInvoke.test.ts`）；被控端 `apps/desktop/src/main/ssh-access/`（`sshAccessTargetCore.ts`、
`authorizedKeysFile.ts`、`sshAccessRecord.ts`、`sshdProbe.ts`、`cloudComputer.ts`、`sessionTerminator.ts` 及同名测试）；
桌面装配 `sshAccessTarget.desktop.ts`、设置 IPC `ipc.desktop.ts`；Host `apps/host/src/ssh-access.ts` 与
`cindy-host remote ssh-access status|on|off|default`、`ssh-key add <file> [label] | remove <fingerprint>`。
