# cindy-host：systemd user unit 安装与运行

`cindy-host` 是长期运行的 Agent runtime。它不依赖任何客户端连接：关闭浏览器与
`cindy-desktop` 后，host 仍持有会话、存储与 Agent 生命周期。

单元文件：[`apps/host/cindy-host.service`](../../apps/host/cindy-host.service)。

## 前置条件

1. 要运行任务，先用 [`cindy-host login`](README.md#快速开始) 登录。登录命令与单元应使用同一个资料目录。
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
| `Environment=CINDY_HOST_REGION` | 注释掉 | 从 checkout 运行（本单元的 `ExecStart`）时选择版本：`cn` 或 `global`，不写按 global。安装的 Host 发布包按区域各一个，版本在构建时定死，不需要这一行；写了而且和包的版本不同，Host 拒绝启动（`HOST_REGION_MISMATCH`）。装国内版包的，删掉这一行或写 `cn` |
| `CINDY_HOST_DATA_DIR` | 注释掉 | 指定后直接使用该目录，等价于 Desktop 的 `XDT_USER_DATA_DIR` |
| `CINDY_HOST_OWNER` | 注释掉 | 资料目录里有多个账号数据库时，用它明确选择账号。它不能替代登录。 |

`Restart=always` + `RestartSec=3` 保证崩溃后自动恢复；`KillSignal=SIGTERM` 让 host
先释放 runtime 锁并关闭数据库。`StartLimitIntervalSec=0` 关闭启动频率限制，避免
反复崩溃时限流把服务永久停在 failed。

## 当前边界（未完成项）

- 尚未登录的空资料目录也可启动，`/health` 可用，但账号运行时和存储尚未就绪。无图形 Linux 的
  实机验收进度见[云端 Cindy 验收结果](cloud-cindy-status.md)。
- 本单元用于 Linux 用户服务。macOS 用 [LaunchAgent](launchd.md)，Windows 的服务或启动项仍在设计。
  后台作为独立进程运行，`cindy-desktop` 不托管这个进程，也不自动拉起第二个实例。
