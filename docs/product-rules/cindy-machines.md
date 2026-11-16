# Cindy 的机器：账号下的电脑都是它的身体

> 新增或修改 `list_machines`、`maker:machine:status`，或让 Agent 使用多台机器的能力前必须先读本文。
> 主力电脑、接手与资料随行见 [云端伙伴](cloud-companions.md)。

## 1. 产品方向（2026-11-02 用户确认）

- 账号下所有电脑和 SSH 设备都是 Agent 的身体。第一阶段只把 Cindy 伙伴做成不需要编排设备；用户自建的伙伴继续沿用
  主力电脑与协同，不改成无设备概念。
- **宿主暴露情况，不替大脑做资源决策。** Agent 是能看懂情况的高级模型：让它看到每台机器、每个模型的真实资源和后果，
  由它决定开多少任务、用哪台、什么时候收手。不写死「最多几个」这类决策上限，也不做替它挑机器的打分调度。

- 两类用户走两条路（2026-11-02 用户确认）：普通多机用户装了 Cindy 就能用，不要求打开 SSH；服务器和测试机批量用户走 SSH，
  不要求装 Cindy，也不因此被要求升级。SSH 不是普通用户的默认路径。
- 第一个里程碑：多设备 Cindy 的自我管理、记忆与技能快速同步、模型表与账号同步。大脑自动接手和集群在它之后。

## 2. 三类数字

| 类型 | 例子 | 处理 |
|---|---|---|
| 决策限制 | 最多几个 Worker、几个并发 | 不写；改成暴露情况 |
| 客观事实 | 服务端单值上限、机器内存 | 作为数据给 Agent；碰到时如实报错，说明缺了什么、下一步怎么办 |
| 内部防崩 | 解析器内存上限、传输超时 | 保留；不能影响 Agent 的能力或静默截断结果 |

跨账号是授权，不是决策限制：分享给别人的额度由主人设置。结果不完整时必须明说，禁止静默截断。

以下三件事仍由宿主做，且都不写资源数字：独占资源的抢占必须原子；模型额度耗尽、上下文爆满或宿主关机时大脑无法自救，
由宿主接住；边界不能由模型自己决定（权限档、用户设的预算、全部停止）。

## 3. list_machines（2026-11-02）

- 是 `cindy_helper` 的顶层工具，能用 `cindy_helper` 的任务都直接可见；SSH 普通任务同样可用：Claude Code 注入绑定任务实例的 helper，Codex 在每条已绑定任务上启用 helper，共享 daemon 配置仍默认关闭；Pi 沿用原有宿主桥接（2026-11-02 用户裁决：`list_tools` 二级入口不稳，Agent 想不到去查就等于没有，只适合放不重要的能力；
  多机器相关的基础能力放一级）。Pi 由 bridge 注册同名原生工具，不经 `cindy_mcp_list_tools`。与「用户能在设备列表看到」同权；共享任务里拒绝（`PERMISSION_DENIED`），
  访客不能经 Agent 看到账号下的机器。
- SSH 普通任务只沿用 helper 的既有远程自省能力面；不因此开放本机更新、控制或伙伴专属工具。实例缺失／失效、工具停用与共享任务拒绝仍按原规则处理。
- 调用时向在线电脑问一次 `maker:machine:status`，不定时上报，不花模型额度。这是普通只读 invoke，不新增协议帧，
  中转（含自建）只转发，不需要适配。读取走后台链路，不让对方进入受控状态。旧版本返回 `CHANNEL_NOT_ALLOWED` 或不支持后台链路（`UNSUPPORTED_CAPABILITY`），都显示 `update_required`。
- 读不到的电脑不从结果消失，写明原因：`offline`、`remote_control_off`、`control_off`、`update_required`、`unreachable`。
  一台卡住按传输超时算 `unreachable`，不拖住其他机器。手机不在其中。
- 每项独立失败，读不到是 `null`，不用近似值冒充。macOS 的可用内存取 `vm_stat` 的空闲、非活跃与预读页之和，
  因为 `os.freemem()` 不含可回收缓存，会把健康的电脑读成内存见底。
- SSH 主机列这台电脑配置的，同样带实时资源（2026-11-02 用户裁决）。命令写死、只读、不接受输入，风险等同读本机状态，不走 `ssh_exec` 审批；
  只用已配置的密钥或 ssh-agent，不弹密码框。各主机并行读取，连不上按 `unreachable` 带错误码，能连上但跑不了命令（如 Windows）为 `unreadable`，都不拖住其他机器。
  只连接密钥已被信任过的主机：**自动读取不做首次信任**（`unverified`，不连接）。Cindy 的密钥库独立于 `~/.ssh/known_hosts`，首次连接默认信任，
  曾因此把一台 OpenSSH 已拒绝的改密钥主机记为可信（2026-11-02 验收发现）。密钥变化报 `host_key_changed`，不得说成账号或密码问题，也不自动更新记录。
  地址相同的条目用 `sameAddressAs` 标出，不替用户合并，一个入口连不上不代表机器有问题。读取后连接留在连接池。其他电脑上配置的 SSH 主机不在其中。

## 4. 实现位置

- 协议：`packages/device-link/src/machineStatus.ts`，登记于 `allowlist.ts`（不进共享任务访客白名单）。
- Desktop：`apps/desktop/src/main/machines/`（`localStatus.ts` 读本机，`sshStatus.ts` 读 SSH，`directory.ts` 汇总），
  工具接线在 `mcp-integrations/mcp-providers.ts`，channel 处理在 `maker-ipc/register.ts`。
- 工具：`packages/lizi-mcps/src/xdt-helper/list_machines.ts`。

## 5. 验收注意

沙箱里的新任务可能落到上次控制的电脑，侧栏的「本机」只筛选列表，不决定任务发到哪台。登录真实账号验收跨电脑工具前，
先在沙箱里关掉对真实电脑的控制，确认工具结果里 `isSelf` 是这个沙箱，否则消息会发到真实电脑上的旧版本。

## 6. 后续

按机器执行（`shell` / `read_file` / `await_shell` / `copy_file`）、账号级模型资源、失败时换到另一台、大脑租约按顺序另行交付，
不在当前实现内。

## 请求远程控制授权（2026-11-10）

`request_remote_control` 使用 `list_machines` 返回的精确设备 ID 和工作目的，向同账号在线
电脑发起本机确认。CC/Codex 顶层可见，统一 helper 目录也提供 `devices.remote-consent`
发现与 `call_tool` 入口（包含 Pi）。共享任务拒绝；手机、SSH、离线与撤权设备不可请求。
用户点「开启远程控制」后复用现有持久设置与 presence 广播；提示说明运行任务、访问文件
及持续有效的范围。Agent 等明确 enabled 后继续原工作，其余结果不授予权限。
旧版／网络无响应如实报告，不猜测已批准，也不自动重复弹窗。拒绝、到期、并发请求与重复
请求的处理见 [协议说明](../dev-rules/protocol-compatibility/device-link-remote-control-consent.md)。
