# cindy-host：systemd user unit 安装与运行

`cindy-host` 是长期运行的 Agent runtime。它不依赖任何客户端连接：关闭浏览器与
`cindy-desktop` 后，host 仍持有会话、存储与 Agent 生命周期。

单元文件：[`apps/host/cindy-host.service`](../../apps/host/cindy-host.service)。

## 前置条件

1. 已完成登录（阶段 2 之前，`cindy-host` 需要显式 owner；见下文 `CINDY_HOST_OWNER`）。
2. 本机存在可用的 Node 与 pnpm，仓库依赖已安装（`pnpm install`）。
3. `cindy-host` 自己会取得 `<dataDir>/cindy-host-runtime-<owner>.lock.db` 的独占锁；
   同一 profile 的第二个 host 会以 `runtime.state=blocked` 启动失败，不会成为第二个 runtime。

## 安装

```bash
mkdir -p ~/.config/systemd/user
cp apps/host/cindy-host.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable cindy-host
systemctl --user start cindy-host
systemctl --user status cindy-host
```

调试日志：

```bash
journalctl --user -u cindy-host -f
curl -s http://127.0.0.1:3456/health
```

停止与移除：

```bash
systemctl --user stop cindy-host
systemctl --user disable cindy-host
rm ~/.config/systemd/user/cindy-host.service
systemctl --user daemon-reload
```

## 必须按安装位置修改的字段

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `WorkingDirectory` | `%h/development/cindy` | 你的 checkout 绝对路径 |
| `ExecStart` | `/usr/bin/env pnpm start-host` | 建议改成绝对路径，避免 systemd 的 PATH 与登录 shell 不同 |
| `Environment=CINDY_HOST_REGION` | `global` | `cn` 或 `global`；不写按 global |
| `CINDY_HOST_DATA_DIR` | 注释掉 | 指定后直接使用该目录，等价于 Desktop 的 `XDT_USER_DATA_DIR` |
| `CINDY_HOST_OWNER` | 注释掉 | 登录阶段完成前必须显式给出 owner id；否则 host 只提供 `/health`，不打开数据库 |

`Restart=always` + `RestartSec=3` 保证崩溃后自动恢复；`KillSignal=SIGTERM` 让 host
先释放 runtime 锁并关闭数据库。`StartLimitIntervalSec=0` 关闭启动频率限制，避免
反复崩溃时限流把服务永久停在 failed。

## 当前边界（未完成项）

- 尚未实现 `cindy-host login`，因此 `CINDY_HOST_OWNER` 仍需手工提供。
- 尚未实现 HTTP API 与 Web 前端；此刻 `/health` 报告 `runtime.state`、`storage` 与
  `sessions` 计数，是最小可验证面。
- 单元模板只覆盖 Linux user systemd。macOS（`launchd`）与 Windows（服务/启动项）的
  host 生命周期仍在设计，当前约定是：host 作为独立常驻进程，`cindy-desktop` 不托管、
  不自动拉起第二个 host。
