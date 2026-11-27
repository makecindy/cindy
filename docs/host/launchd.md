# cindy-host：macOS 登录自启与运维

使用 [LaunchAgent 模板](../../apps/host/app.cindy.host.plist) 让 `cindy-host` 在 macOS
用户登录后启动。关闭客户端或终端，后台仍继续运行。macOS 用户退出登录后，服务随登录会话结束。

## 准备

- 在运行后台的 macOS 用户已登录图形桌面时安装。使用该用户的 `gui/<uid>` 域，以便后台的
  Electron 凭据辅助进程访问登录钥匙串。无需 `sudo`。钥匙串仍须可用，已有的访问授权照常生效。
- 模板从源码运行，使用与 `pnpm start-host` 相同的入口。先完成
  [依赖和源码验收准备](cloud-cindy-status.md#从源码验收时的准备)。使用重启后仍保留的源码、资料和
  日志目录，例如用户主目录下的专用目录；避开 `/private/tmp`。
- 新实例使用单独的资料和配置目录。同一份资料只运行一个后台实例。使用
  [现有登录流程](README.md#快速开始)时，给 CLI 和服务配置相同的 `CINDY_HOST_DATA_DIR`、
  `CINDY_HOST_APP_DATA_DIR` 和对应区域。需要完成账号登录时，使用 CLI 发起，再在浏览器确认。

## 安装

在源码根目录复制模板，准备专用目录。下面的变量也用于后续命令。

```bash
state="$HOME/Library/Application Support/CindyHostService"
domain="gui/$(id -u)"
service="$domain/app.cindy.host"
plist="$HOME/Library/LaunchAgents/app.cindy.host.plist"

mkdir -p "$HOME/Library/LaunchAgents"
install -d -m 700 "$state" "$state/profile" "$state/app-data" "$state/logs"
cp -n apps/host/app.cindy.host.plist "$plist"
```

编辑上面的 `plist`，替换模板中的绝对路径占位符。LaunchAgent 不会读取日常 shell 的启动文件，
plist 中的 `~` 和 `$HOME` 也不会展开。

| 字段 | 填法 |
| --- | --- |
| `ProgramArguments` 的第一项 | 已安装的 Node 可执行文件的绝对路径。剩余参数使用源码入口。 |
| `WorkingDirectory` | Cindy 源码根目录的绝对路径。 |
| `EnvironmentVariables` | `PATH` 填运行所需的工具目录。`CINDY_HOST_DATA_DIR` 和 `CINDY_HOST_APP_DATA_DIR` 分别指向准备好的 `profile` 和 `app-data`。`CINDY_HOST_REGION` 选 `cn` 或 `global`。`CINDY_HOST_PORT=0` 由系统分配回环端口，也可以填空闲的固定端口。 |
| `StandardOutPath`、`StandardErrorPath` | 各自指向已建好的 `logs` 目录下的文件。 |

保存后校验并加载。以后用户每次登录 macOS，`RunAtLoad` 都会让后台启动。进程异常退出时
`KeepAlive.SuccessfulExit=false` 会自动拉起。`ThrottleInterval=30` 让两次自动启动至少间隔
30 秒，所以刚启动就崩溃也要等约 30 秒才恢复。空资料实例在启动后立即被终止，实测
29.9 秒恢复 `/health`。

```bash
plutil -lint "$plist"
launchctl bootstrap "$domain" "$plist"
launchctl print "$service"
```

## 启停和查看日志

- **状态**用 `launchctl print "$service"` 查看进程 PID 和上次退出状态。要看后台运行状态和
  回环地址，用同一份配置运行 `cindy-host status --json`。从源码运行时，在源码根目录复用
  模板里的 Node 启动命令，把终端命令末尾的 `serve` 换成 `status --json`。
- **停止**用 `launchctl bootout "$service"`。它卸载当前会话中的任务，防止停止过程中异常退出
  又被拉起。用 `launchctl print "$service"` 确认任务已消失，再执行重新加载。plist 仍在时，
  下一次登录会再次启动。
- **启动**已卸载的任务用 `launchctl bootstrap "$domain" "$plist"`。任务仍已加载、进程因正常退出
  停在原地时，用 `launchctl kickstart "$service"`。
- **改配置**先 `bootout`，修改并用 `plutil -lint` 校验，再 `bootstrap`。
- **日志**见 plist 指定的 `host.stdout.log` 和 `host.stderr.log`，应用日志另在资料目录的
  `logs/`。连续启动失败时，先用 `launchctl print` 看退出状态，再查日志中的路径、区域和凭据错误。

用同一份配置执行 `cindy-host stop` 并正常退出后，macOS 服务会保持停止。[Linux 的 systemd
单元](systemd.md)用 `Restart=always`，进程正常退出也会拉起。要停止 Linux 服务，使用
`systemctl --user stop cindy-host`。

macOS 13 及以后，加载时系统可能显示「已添加后台项目」通知。在「系统设置 → 通用 → 登录项」
（较新版本为「登录项与扩展」）中检查「允许在后台」，此项目可能显示为 `node`。关闭后该后台项
将无法运行。见 [Apple 的后台项目说明](https://support.apple.com/guide/deployment/depdca572563/web)。

## 卸载

执行 `launchctl bootout "$service"` 停止并卸载当前任务（已卸载时跳过），再执行
`rm -- "$plist"` 取消后续登录自启。资料、应用配置和日志可在决定不再使用该实例后单独清理。
